//! Shared HTTP plumbing for the model adapters: error typing and a line
//! splitter over a streamed body (NDJSON and SSE are both line protocols).

use futures_util::stream::{self, BoxStream, StreamExt};

use super::super::ports::ProviderError;

/// Type a transport error. A connect failure (refused, DNS, no route, connect
/// timeout) means the request never left this machine — `Unreachable`, which
/// the UI reports as "nothing was sent".
pub fn transport(host: &str, err: reqwest::Error) -> ProviderError {
    if err.is_connect() || (err.is_timeout() && !err.is_body()) {
        ProviderError::Unreachable(format!("Can't reach {host}"))
    } else {
        ProviderError::Failed(format!("{host}: {}", without_url(&err)))
    }
}

/// reqwest's Display includes the URL; keep messages free of query strings.
fn without_url(err: &reqwest::Error) -> String {
    let mut s = err.to_string();
    if let Some(url) = err.url() {
        s = s.replace(url.as_str(), "");
    }
    s.replace(" for url ()", "").trim().to_string()
}

/// Turn a non-2xx response into an error, reading the body for the message.
pub async fn check(
    host: &str,
    resp: reqwest::Response,
) -> Result<reqwest::Response, ProviderError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    let msg = if detail.is_empty() {
        format!("{host} answered {status}")
    } else {
        format!("{host} answered {status}: {detail}")
    };
    if status.as_u16() == 401 || status.as_u16() == 403 {
        Err(ProviderError::Auth(msg))
    } else {
        Err(ProviderError::Failed(msg))
    }
}

/// Split a streamed body into lines (without the trailing `\n` / `\r\n`).
pub fn lines(
    host: String,
    resp: reqwest::Response,
) -> BoxStream<'static, Result<String, ProviderError>> {
    let body = resp.bytes_stream().boxed();
    stream::unfold(
        (body, Vec::<u8>::new(), false, host),
        |(mut body, mut buf, mut done, host)| async move {
            loop {
                if let Some(at) = buf.iter().position(|b| *b == b'\n') {
                    let mut line: Vec<u8> = buf.drain(..=at).collect();
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    let text = String::from_utf8_lossy(&line).into_owned();
                    return Some((Ok(text), (body, buf, done, host)));
                }
                if done {
                    if buf.is_empty() {
                        return None;
                    }
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    buf.clear();
                    return Some((Ok(text), (body, buf, done, host)));
                }
                match body.next().await {
                    Some(Ok(chunk)) => buf.extend_from_slice(&chunk),
                    Some(Err(e)) => {
                        done = true;
                        buf.clear();
                        let err =
                            ProviderError::Failed(format!("{host}: the reply was cut off ({e})"));
                        return Some((Err(err), (body, buf, done, host)));
                    }
                    None => done = true,
                }
            }
        },
    )
    .boxed()
}

/// SSE: the payload of a `data:` line, or `None` for any other line.
pub fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(str::trim_start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_data_lines() {
        assert_eq!(sse_data("data: {\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(sse_data("data:[DONE]"), Some("[DONE]"));
        assert_eq!(sse_data("event: ping"), None);
        assert_eq!(sse_data(""), None);
    }
}
