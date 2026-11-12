//! Ollama adapter (Task A3): `/api/tags` for models, `/api/chat` streaming
//! NDJSON. The base URL comes from `aiOllamaUrl`.

use async_trait::async_trait;
use futures_util::stream::StreamExt;

use super::super::ports::{ModelInfo, ModelProvider, ProviderError, TokenStream};
use super::http;

pub struct OllamaProvider {
    client: reqwest::Client,
    base: String,
    host: String,
    model: String,
}

impl OllamaProvider {
    pub fn new(client: reqwest::Client, base: &str, host: &str, model: &str) -> Self {
        Self {
            client,
            base: base.trim_end_matches('/').to_string(),
            host: host.to_string(),
            model: model.to_string(),
        }
    }
}

/// One NDJSON line of `/api/chat`: the fragment it carries, if any.
pub(super) fn chat_fragment(line: &str) -> Result<Option<String>, ProviderError> {
    if line.trim().is_empty() {
        return Ok(None);
    }
    let v: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| ProviderError::Failed(format!("Ollama sent something unreadable ({e})")))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(ProviderError::Failed(format!("Ollama: {err}")));
    }
    Ok(v.pointer("/message/content")
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty())
        .map(str::to_string))
}

pub(super) fn parse_tags(v: &serde_json::Value) -> Vec<ModelInfo> {
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let name = m
                        .get("name")
                        .or_else(|| m.get("model"))?
                        .as_str()?
                        .to_string();
                    let size = m.get("size").and_then(|s| s.as_u64());
                    let tag = m
                        .pointer("/details/parameter_size")
                        .and_then(|s| s.as_str())
                        .map(str::to_string);
                    Some(ModelInfo { name, size, tag })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl ModelProvider for OllamaProvider {
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let resp = self
            .client
            .get(format!("{}/api/tags", self.base))
            .send()
            .await
            .map_err(|e| http::transport(&self.host, e))?;
        let resp = http::check(&self.host, resp).await?;
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ProviderError::Failed(format!("{}: {e}", self.host)))?;
        Ok(parse_tags(&v))
    }

    async fn ping(&self) -> Result<(), ProviderError> {
        self.list_models().await.map(|_| ())
    }

    async fn complete(&self, prompt: &str) -> Result<TokenStream, ProviderError> {
        let body = serde_json::json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": true,
        });
        let resp = self
            .client
            .post(format!("{}/api/chat", self.base))
            .json(&body)
            .send()
            .await
            .map_err(|e| http::transport(&self.host, e))?;
        let resp = http::check(&self.host, resp).await?;
        Ok(http::lines(self.host.clone(), resp)
            .filter_map(|line| async move {
                match line {
                    Ok(l) => chat_fragment(&l).transpose(),
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
    fn reads_chat_fragments() {
        let l = r#"{"model":"m","message":{"role":"assistant","content":"SEL"},"done":false}"#;
        assert_eq!(chat_fragment(l).unwrap(), Some("SEL".into()));
        let done = r#"{"model":"m","message":{"role":"assistant","content":""},"done":true}"#;
        assert_eq!(chat_fragment(done).unwrap(), None);
        assert!(chat_fragment(r#"{"error":"model not found"}"#).is_err());
    }

    #[test]
    fn reads_tags() {
        let v = serde_json::json!({"models":[{"name":"qwen2.5-coder:7b","size":4683087332u64,"details":{"parameter_size":"7.6B"}}]});
        let m = parse_tags(&v);
        assert_eq!(m[0].name, "qwen2.5-coder:7b");
        assert_eq!(m[0].size, Some(4683087332));
        assert_eq!(m[0].tag.as_deref(), Some("7.6B"));
    }
}
