//! Adapters for the assistant's ports: three HTTP model providers and the
//! JSONL prompt log. API keys use the connections slice's keychain adapter
//! under the assistant's own service ([`KEYCHAIN_SERVICE`]).

mod anthropic;
mod http;
mod key_index;
mod log_file;
mod ollama;
mod openai;

pub use anthropic::AnthropicProvider;
pub use key_index::{InMemoryKeyIndex, JsonKeyIndex};
pub use log_file::JsonlPromptLog;
pub use ollama::OllamaProvider;
pub use openai::OpenAiProvider;

/// Keychain service for the assistant's API keys (Task A6).
pub const KEYCHAIN_SERVICE: &str = "bytetable.assistant";

/// The keychain's name on this OS, for "in macOS Keychain".
pub fn keychain_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(target_os = "windows") {
        "Windows Credential Manager"
    } else {
        "the system keyring"
    }
}

/// One shared HTTP client for every provider. Connect timeout is short so an
/// unreachable host is reported as such quickly; there is no overall timeout,
/// because a local model can take a while to stream a long answer.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default()
}

#[cfg(test)]
mod wire_tests {
    //! The real adapters over real HTTP, against a one-shot server on
    //! 127.0.0.1 that streams a canned body in several chunks.

    use futures_util::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::super::ports::{ModelProvider, ProviderError};
    use super::*;

    /// Serve one request with `body` (chunked), return the base URL and a
    /// handle yielding the raw request the client sent.
    async fn serve(chunks: Vec<&'static str>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 16384];
            let mut req = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len = text[..h]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if req.len() >= h + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            for c in chunks {
                sock.write_all(format!("{:x}\r\n{c}\r\n", c.len()).as_bytes())
                    .await
                    .unwrap();
                sock.flush().await.unwrap();
            }
            sock.write_all(b"0\r\n\r\n").await.unwrap();
            String::from_utf8_lossy(&req).to_string()
        });
        (format!("http://{addr}"), task)
    }

    async fn drain(p: &dyn ModelProvider, prompt: &str) -> String {
        let mut s = p.complete(prompt).await.unwrap();
        let mut out = String::new();
        while let Some(t) = s.next().await {
            out.push_str(&t.unwrap());
        }
        out
    }

    #[tokio::test]
    async fn ollama_streams_ndjson_split_across_chunks() {
        let (base, req) = serve(vec![
            "{\"message\":{\"content\":\"SEL\"},\"done\":false}\n{\"message\":{\"con",
            "tent\":\"ECT 1\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"\"},\"done\":true}\n",
        ])
        .await;
        let p = OllamaProvider::new(http_client(), &base, "localhost", "m");
        assert_eq!(drain(&p, "[system]\nexact").await, "SELECT 1");
        let sent = req.await.unwrap();
        assert!(sent.starts_with("POST /api/chat"), "{sent}");
        assert!(sent.contains(r#""content":"[system]\nexact""#), "{sent}");
    }

    #[tokio::test]
    async fn openai_streams_sse_with_a_bearer_key() {
        let (base, req) = serve(vec![
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n\ndata: [DONE]\n\n",
        ])
        .await;
        let p = OpenAiProvider::new(
            http_client(),
            &(base + "/v1"),
            "localhost",
            "m",
            Some("sk-test".into()),
        );
        assert_eq!(drain(&p, "q").await, "Hi there");
        let sent = req.await.unwrap();
        assert!(sent.starts_with("POST /v1/chat/completions"), "{sent}");
        assert!(
            sent.to_ascii_lowercase()
                .contains("authorization: bearer sk-test"),
            "{sent}"
        );
    }

    #[tokio::test]
    async fn anthropic_streams_text_deltas() {
        let (base, req) = serve(vec![
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ])
        .await;
        let p = AnthropicProvider::new(http_client(), &base, "api", "claude", "k".into());
        assert_eq!(drain(&p, "q").await, "ok");
        let sent = req.await.unwrap().to_ascii_lowercase();
        assert!(sent.starts_with("post /messages"));
        assert!(sent.contains("x-api-key: k") && sent.contains("anthropic-version: 2023-06-01"));
    }

    #[tokio::test]
    async fn a_closed_port_is_unreachable_before_anything_is_sent() {
        // Bind then drop: the port is free and nothing listens on it.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let p = OllamaProvider::new(
            http_client(),
            &format!("http://127.0.0.1:{port}"),
            "127.0.0.1",
            "m",
        );
        assert!(matches!(
            p.complete("q").await,
            Err(ProviderError::Unreachable(_))
        ));
        assert!(matches!(
            p.list_models().await,
            Err(ProviderError::Unreachable(_))
        ));
    }
}
