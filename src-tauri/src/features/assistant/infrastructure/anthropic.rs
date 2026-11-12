//! Anthropic adapter (Task A5): the Messages API with streaming SSE, key from
//! the keychain.

use async_trait::async_trait;
use futures_util::stream::StreamExt;

use super::super::ports::{ModelInfo, ModelProvider, ProviderError, TokenStream};
use super::http;

const VERSION: &str = "2023-06-01";
/// Room for a long explanation or a large statement; the prompts ask for short
/// answers, so this is a ceiling rather than a target.
const MAX_TOKENS: u32 = 2048;

pub struct AnthropicProvider {
    client: reqwest::Client,
    base: String,
    host: String,
    model: String,
    key: String,
}

impl AnthropicProvider {
    pub fn new(client: reqwest::Client, base: &str, host: &str, model: &str, key: String) -> Self {
        Self {
            client,
            base: base.trim_end_matches('/').to_string(),
            host: host.to_string(),
            model: model.to_string(),
            key,
        }
    }

    fn headers(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header("x-api-key", &self.key)
            .header("anthropic-version", VERSION)
    }
}

/// One SSE line of a streamed Messages reply.
pub(super) fn message_fragment(line: &str) -> Option<Result<String, ProviderError>> {
    let data = http::sse_data(line)?;
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("content_block_delta") => v
            .pointer("/delta/text")
            .and_then(|t| t.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| Ok(t.to_string())),
        Some("error") => Some(Err(ProviderError::Failed(
            v.pointer("/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("Anthropic reported an error")
                .to_string(),
        ))),
        _ => None,
    }
}

#[async_trait]
impl ModelProvider for AnthropicProvider {
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let resp = self
            .headers(self.client.get(format!("{}/models", self.base)))
            .send()
            .await
            .map_err(|e| http::transport(&self.host, e))?;
        let resp = http::check(&self.host, resp).await?;
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ProviderError::Failed(format!("{}: {e}", self.host)))?;
        Ok(super::openai::parse_models(&v))
    }

    async fn ping(&self) -> Result<(), ProviderError> {
        self.list_models().await.map(|_| ())
    }

    async fn complete(&self, prompt: &str) -> Result<TokenStream, ProviderError> {
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": true,
        });
        let resp = self
            .headers(self.client.post(format!("{}/messages", self.base)))
            .json(&body)
            .send()
            .await
            .map_err(|e| http::transport(&self.host, e))?;
        let resp = http::check(&self.host, resp).await?;
        Ok(http::lines(self.host.clone(), resp)
            .filter_map(|line| async move {
                match line {
                    Ok(l) => message_fragment(&l),
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
    fn reads_text_deltas() {
        let l = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#;
        assert_eq!(message_fragment(l).unwrap().unwrap(), "Hi");
        assert!(message_fragment(r#"data: {"type":"message_stop"}"#).is_none());
        assert!(message_fragment("event: content_block_delta").is_none());
        let e =
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        assert!(message_fragment(e).unwrap().is_err());
    }
}
