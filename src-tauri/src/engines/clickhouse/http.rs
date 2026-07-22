//! The ClickHouse HTTP transport. Wraps a `reqwest::Client` and speaks the
//! ClickHouse HTTP interface: SQL goes in the POST body, results come back as
//! `FORMAT JSONCompact` (`{ meta:[{name,type}], data:[[…]], rows }`), whose
//! values already map onto the [`QueryResult`](crate::shared::engine::QueryResult)
//! JSON contract — 64-bit ints/decimals arrive as strings (precision-safe),
//! Nullable NULL as JSON null, arrays/tuples as JSON arrays. Statements with no
//! result set (DDL / mutations) return an empty body.
//!
//! # Auth / TLS
//!
//! User + password travel as `X-ClickHouse-User` / `X-ClickHouse-Key` headers.
//! The `tls_mode` token selects the scheme: `disable`/`prefer` → `http://`;
//! `require` → `https://` accepting a self-signed cert; `verify-ca`/`verify-full`
//! → `https://` validating the certificate chain (rustls). An SSH tunnel points
//! the socket at a local endpoint via the `host_override`/`port_override`.

use serde::Deserialize;

use crate::shared::error::AppError;

use super::error::{map_connect_error, map_query_error};

/// One column's name + ClickHouse type from a `FORMAT JSONCompact` `meta` entry.
#[derive(Debug, Clone, Deserialize)]
pub(super) struct ChColumnMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// A parsed `FORMAT JSONCompact` response. `data` is row-major, each value a raw
/// `serde_json::Value` — no per-type decoding needed (see the module note).
#[derive(Debug, Default, Deserialize)]
pub(super) struct ChResult {
    #[serde(default)]
    pub meta: Vec<ChColumnMeta>,
    #[serde(default)]
    pub data: Vec<Vec<serde_json::Value>>,
    /// ClickHouse embeds an error here when a query fails AFTER the 200 headers
    /// were already sent (a streaming error), so the body is a valid JSON result
    /// shape with an extra `exception` field. `query` surfaces it as a §5 error.
    #[serde(default)]
    pub exception: Option<String>,
}

/// One open ClickHouse HTTP transport. Cheap to clone-through (`reqwest::Client`
/// is an `Arc` internally); one per open connection.
pub(super) struct ClickHouseHttp {
    client: reqwest::Client,
    /// The base URL to POST to, e.g. `http://127.0.0.1:8123/`.
    endpoint: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    /// The connection's default database for unqualified names.
    pub database: String,
}

impl ClickHouseHttp {
    /// Build the transport. `host`/`port` are the *real* target (for error
    /// messages and the URL host); `socket_override` points the socket at a local
    /// SSH-tunnel `(host, port)` endpoint when tunnelling.
    pub fn new(
        host: &str,
        port: u16,
        user: &str,
        password: &str,
        database: &str,
        tls_token: &str,
        socket_override: Option<(&str, u16)>,
    ) -> Result<Self, AppError> {
        let (scheme, accept_invalid) = match tls_token.trim().to_ascii_lowercase().as_str() {
            "disable" | "prefer" => ("http", false),
            "require" => ("https", true),
            // verify-ca / verify-full / anything else secure → validate the chain.
            _ => ("https", false),
        };
        let (sock_host, sock_port) = socket_override.unwrap_or((host, port));
        let endpoint = format!("{scheme}://{sock_host}:{sock_port}/");

        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(accept_invalid)
            .build()
            .map_err(|e| AppError::Database(format!("Could not build the HTTP client ({e}).")))?;

        Ok(Self {
            client,
            endpoint,
            host: host.to_string(),
            port,
            user: user.to_string(),
            password: password.to_string(),
            database: database.to_string(),
        })
    }

    /// Run `sql` and parse a `FORMAT JSONCompact` result. `settings` are extra
    /// URL query params (e.g. `max_result_rows`). A statement with no result set
    /// (DDL / mutation) yields an empty [`ChResult`]. Errors are §5 human
    /// sentences (unreachable host, or the server's `DB::Exception`).
    pub async fn query(
        &self,
        sql: &str,
        settings: &[(&str, String)],
    ) -> Result<ChResult, AppError> {
        let text = self.post(sql, settings, true).await?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(ChResult::default());
        }
        let result = serde_json::from_str::<ChResult>(trimmed).map_err(|e| {
            AppError::Database(format!("Could not parse the ClickHouse response ({e})."))
        })?;
        // A streaming error (HTTP 200 but the body carries an `exception`).
        if let Some(exception) = &result.exception {
            return Err(map_query_error(exception.clone()));
        }
        Ok(result)
    }

    /// Run a statement whose result (if any) is discarded — DDL / mutations.
    pub async fn execute(&self, sql: &str, settings: &[(&str, String)]) -> Result<(), AppError> {
        self.post(sql, settings, false).await.map(|_| ())
    }

    /// Convenience: run a single-cell scalar query returning the first value of
    /// the first row (e.g. `SELECT count() …`), or `None` when empty.
    pub async fn scalar(&self, sql: &str) -> Result<Option<serde_json::Value>, AppError> {
        let result = self.query(sql, &[]).await?;
        Ok(result.data.into_iter().next().and_then(|mut r| {
            if r.is_empty() {
                None
            } else {
                Some(r.swap_remove(0))
            }
        }))
    }

    /// POST `sql` to the HTTP interface. `json_format` appends
    /// `default_format=JSONCompact` so a SELECT comes back parseable. Returns the
    /// raw body on 2xx, else maps the error body / transport failure.
    async fn post(
        &self,
        sql: &str,
        settings: &[(&str, String)],
        json_format: bool,
    ) -> Result<String, AppError> {
        let mut req = self
            .client
            .post(&self.endpoint)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .query(&[("database", self.database.as_str())]);
        if json_format {
            req = req.query(&[("default_format", "JSONCompact")]);
        }
        if !settings.is_empty() {
            req = req.query(settings);
        }
        let response = req.body(sql.to_string()).send().await.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                map_connect_error(&self.host, self.port, e)
            } else {
                map_query_error(e.to_string())
            }
        })?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| map_query_error(e.to_string()))?;
        if status.is_success() {
            Ok(body)
        } else {
            Err(map_query_error(body))
        }
    }
}
