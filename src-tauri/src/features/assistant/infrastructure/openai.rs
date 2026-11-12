//! OpenAI-compatible adapter (Task A4): `/models` and `/chat/completions`
//! streaming SSE, optional bearer key. Serves LM Studio (`aiLmUrl`), a Custom
//! URL (`aiCustomUrl` + `aiCustomModel`) and the OpenAI-compatible key
//! provider.

use async_trait::async_trait;
use futures_util::stream::StreamExt;

use super::super::ports::{ModelInfo, ModelProvider, ProviderError, TokenStream};
use super::http;

pub struct OpenAiProvider {
    client: reqwest::Client,
    base: String,
    host: String,
    /// Empty = use the first model the endpoint reports (LM Studio).
    model: String,
    key: Option<String>,
}

impl OpenAiProvider {
    pub fn new(
        client: reqwest::Client,
        base: &str,
        host: &str,
        model: &str,
        key: Option<String>,
    ) -> Self {
        Self {
            client,
            base: base.trim_end_matches('/').to_string(),
            host: host.to_string(),
            model: model.trim().to_string(),
            key,
        }
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.key {
            Some(k) => req.bearer_auth(k),
            None => req,
        }
    }
}

/// One SSE line of `/chat/completions`: `Some(Ok(fragment))`, `Some(Err)` on a
/// streamed error, `None` for keep-alives, `[DONE]` and empty deltas.
pub(super) fn chat_fragment(line: &str) -> Option<Result<String, ProviderError>> {
    let data = http::sse_data(line)?;
    if data == "[DONE]" || data.is_empty() {
        return None;
    }
    let v: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return None,
    };
    if let Some(err) = v.pointer("/error/message").and_then(|m| m.as_str()) {
        return Some(Err(ProviderError::Failed(err.to_string())));
    }
    v.pointer("/choices/0/delta/content")
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty())
        .map(|c| Ok(c.to_string()))
}

pub(super) fn parse_models(v: &serde_json::Value) -> Vec<ModelInfo> {
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    Some(ModelInfo {
                        name: m.get("id")?.as_str()?.to_string(),
                        size: None,
                        tag: m.get("state").and_then(|s| s.as_str()).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl ModelProvider for OpenAiProvider {
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let resp = self
            .auth(self.client.get(format!("{}/models", self.base)))
            .send()
            .await
            .map_err(|e| http::transport(&self.host, e))?;
        let resp = http::check(&self.host, resp).await?;
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ProviderError::Failed(format!("{}: {e}", self.host)))?;
        Ok(parse_models(&v))
    }

    async fn ping(&self) -> Result<(), ProviderError> {
        self.list_models().await.map(|_| ())
    }

    async fn complete(&self, prompt: &str) -> Result<TokenStream, ProviderError> {
        let model = if self.model.is_empty() {
            self.list_models()
                .await?
                .into_iter()
                .next()
                .map(|m| m.name)
                .ok_or_else(|| {
                    ProviderError::Failed(format!("{} has no model loaded", self.host))
                })?
        } else {
            self.model.clone()
        };
        let body = serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": true,
        });
        let resp = self
            .auth(self.client.post(format!("{}/chat/completions", self.base)))
            .json(&body)
            .send()
            .await
            .map_err(|e| http::transport(&self.host, e))?;
        let resp = http::check(&self.host, resp).await?;
        Ok(http::lines(self.host.clone(), resp)
            .filter_map(|line| async move {
                match line {
                    Ok(l) => chat_fragment(&l),
                    Err(e) => Some(Err(e)),
                }
            })
            .boxed())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sse_fragments() {
        let l = r#"data: {"id":"x","choices":[{"index":0,"delta":{"content":"SELECT"}}]}"#;
        assert_eq!(chat_fragment(l).unwrap().unwrap(), "SELECT");
        assert!(chat_fragment("data: [DONE]").is_none());
        assert!(chat_fragment(": keep-alive").is_none());
        assert!(chat_fragment(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#).is_none());
        assert!(chat_fragment(r#"data: {"error":{"message":"overloaded"}}"#)
            .unwrap()
            .is_err());
    }

    #[test]
    fn reads_models() {
        let v = serde_json::json!({"data":[{"id":"qwen2.5-coder-7b-instruct","object":"model"}]});
        assert_eq!(parse_models(&v)[0].name, "qwen2.5-coder-7b-instruct");
    }
}
