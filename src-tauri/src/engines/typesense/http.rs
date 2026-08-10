//! The Typesense HTTP transport. Wraps a `reqwest::Client` and speaks the
//! Typesense API: JSON in, JSON out, with the API key on every request as the
//! `X-TYPESENSE-API-KEY` header.
//!
//! # The key never leaves this module
//!
//! The key is held here and attached per request. It is never returned to a
//! caller, never put on a DTO, and never echoed into an error message — the
//! renderer only ever sees URLs built by [`Self::url_for`], which is
//! key-free by construction.
//!
//! # Protocol
//!
//! Typesense has no TLS negotiation, so there is no `tls_mode` here — the
//! [`Protocol`](crate::shared::engine::Protocol) scheme is the whole choice.
//! `https` always validates the certificate chain (rustls); a self-signed node
//! is expected to be reached over an SSH tunnel on `http` instead.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::shared::error::AppError;

use super::error::{map_connect_error, map_status};

/// A raw response: the status plus the body, already read to a string.
pub(super) struct RawResponse {
    pub status: u16,
    pub body: String,
}

impl RawResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// One open Typesense HTTP transport. Cheap to hold (`reqwest::Client` is an
/// `Arc` internally); one per open connection.
pub(super) struct TypesenseHttp {
    client: reqwest::Client,
    /// Base URL with no trailing slash, e.g. `http://127.0.0.1:8108`.
    base: String,
    /// The real target host/port, for error messages and the displayed URL —
    /// which stay the user's host even when the socket goes via a tunnel.
    host: String,
    port: u16,
    /// The user-facing base URL (never the tunnel endpoint).
    display_base: String,
    api_key: String,
}

impl TypesenseHttp {
    /// Build the transport. `host`/`port` are the *real* target;
    /// `socket_override` points the socket at a local SSH-tunnel endpoint.
    pub fn new(
        scheme: &str,
        host: &str,
        port: u16,
        api_key: &str,
        socket_override: Option<(&str, u16)>,
        timeout: Duration,
    ) -> Result<Self, AppError> {
        let (sock_host, sock_port) = socket_override.unwrap_or((host, port));
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| AppError::Database(format!("Could not build the HTTP client ({e}).")))?;

        Ok(Self {
            client,
            base: format!("{scheme}://{sock_host}:{sock_port}"),
            host: host.to_string(),
            port,
            display_base: format!("{scheme}://{host}:{port}"),
            api_key: api_key.to_string(),
        })
    }

    /// The user-facing URL for a path — what the request panel and the `curl`
    /// builder show. Carries no API key.
    pub fn url_for(&self, path: &str) -> String {
        format!("{}{}", self.display_base, path)
    }

    /// GET a path and deserialize the JSON body. `needs_admin` names the view
    /// for the scope error (see [`map_status`]).
    pub async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        needs_admin: Option<&str>,
    ) -> Result<T, AppError> {
        let response = self.send("GET", path, None).await?;
        self.decode(path, response, needs_admin)
    }

    /// GET a path as untyped JSON (routes whose shape varies by version).
    pub async fn get_value(
        &self,
        path: &str,
        needs_admin: Option<&str>,
    ) -> Result<Value, AppError> {
        self.get_json(path, needs_admin).await
    }

    /// GET a path, mapping a 401/403/404 to `Ok(None)` rather than an error —
    /// for optional resources (analytics rules, per-node debug info) whose
    /// absence is normal and must not fail the surrounding view.
    pub async fn get_optional(&self, path: &str) -> Result<Option<Value>, AppError> {
        let response = self.send("GET", path, None).await?;
        if matches!(response.status, 401 | 403 | 404) {
            return Ok(None);
        }
        self.decode(path, response, None).map(Some)
    }

    /// POST a JSON body and deserialize the response.
    pub async fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
    ) -> Result<T, AppError> {
        let response = self.send("POST", path, Some(body.to_string())).await?;
        self.decode(path, response, None)
    }

    /// DELETE a path, discarding the body.
    pub async fn delete(&self, path: &str) -> Result<(), AppError> {
        let response = self.send("DELETE", path, None).await?;
        if response.is_success() {
            Ok(())
        } else {
            Err(map_status(response.status, path, &response.body, None))
        }
    }

    /// Send an arbitrary request and hand back the raw status + body — the HTTP
    /// console's passthrough, which must report failures verbatim rather than
    /// mapping them to an [`AppError`].
    pub async fn raw(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<RawResponse, AppError> {
        self.send(method, path, body).await
    }

    /// Fetch a JSONL export stream (`/documents/export`) as raw text. Used to
    /// sample documents for the empty-state term dictionary.
    pub async fn get_text(
        &self,
        path: &str,
        needs_admin: Option<&str>,
    ) -> Result<String, AppError> {
        let response = self.send("GET", path, None).await?;
        if response.is_success() {
            Ok(response.body)
        } else {
            Err(map_status(
                response.status,
                path,
                &response.body,
                needs_admin,
            ))
        }
    }

    /// Parse a successful body, or map the failure.
    fn decode<T: DeserializeOwned>(
        &self,
        path: &str,
        response: RawResponse,
        needs_admin: Option<&str>,
    ) -> Result<T, AppError> {
        if !response.is_success() {
            return Err(map_status(
                response.status,
                path,
                &response.body,
                needs_admin,
            ));
        }
        serde_json::from_str(&response.body).map_err(|e| {
            AppError::Serialization(format!(
                "Could not read the Typesense response from '{path}' ({e})."
            ))
        })
    }

    /// The one place the API key is attached to a request.
    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<RawResponse, AppError> {
        let url = format!("{}{}", self.base, path);
        let verb = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| AppError::Invalid(format!("'{method}' is not an HTTP method.")))?;

        let mut request = self
            .client
            .request(verb, url)
            .header("X-TYPESENSE-API-KEY", &self.api_key);
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body);
        }

        let response = request
            .send()
            .await
            .map_err(|e| map_connect_error(&self.host, self.port, &e))?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|e| {
            AppError::Database(format!("Could not read the Typesense response ({e})."))
        })?;
        Ok(RawResponse { status, body })
    }
}
