//! Typesense engine adapter (M30): implements the shared `Connector` /
//! [`SearchConnection`](crate::shared::search::SearchConnection) ports over the
//! Typesense HTTP API with `reqwest` — the same pure-Rust transport the
//! ClickHouse adapter uses, so no new dependency enters the tree.
//!
//! Typesense is a **search engine**, not a table store: collections replace
//! databases, documents are JSON, and every read is a search call. That is why
//! it implements [`crate::shared::search`] rather than being bent into the
//! relational or any NoSQL port family.
//!
//! # Threading model
//!
//! The transport is a `reqwest::Client` (internally an `Arc` pool), so it is
//! `Send + Sync` and needs no mutex. The only mutable state is the term-dictionary
//! cache behind an `RwLock` — see [`terms`] for why that cache exists.
//!
//! # API key / protocol / SSH
//!
//! The API key arrives as a transient
//! [`ConnectSecret`](crate::shared::engine::ConnectSecret) (from the OS keychain
//! or the connect form) and is held only inside [`http::TypesenseHttp`], which
//! attaches it as `X-TYPESENSE-API-KEY` per request. It is never returned, never
//! logged, and never placed on a DTO. There is no TLS negotiation — the
//! [`Protocol`] scheme is the whole choice — and a tunnelled connection opens an
//! SSH local-forward first, exactly like the other server adapters.
//!
//! # Key scope
//!
//! [`probe_capabilities`] runs once at connect: `GET /debug` for the version and
//! `GET /collections` to decide whether the key is admin or search-only. That
//! verdict rides on the connection so every view can degrade up front rather
//! than discovering a 401 per panel.

mod error;
mod http;
mod reader;
mod terms;
mod writer;

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override, SshTunnel};
use crate::shared::engine::{
    ConnectSecret, ConnectionParams, Connector, Engine, EngineInfo, OpenConnection,
};
use crate::shared::error::AppError;
use crate::shared::search::{SearchConnection, ServerCapabilities};

use http::TypesenseHttp;
use terms::TermDictionary;

/// Per-request timeout. Search is interactive (the playground fires on every
/// keystroke), so a stuck node must fail fast rather than freeze the panel.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Budget for a peer status probe. Short on purpose: peers are cosmetic (the
/// node table), so a dead one should render as unhealthy quickly rather than
/// hold the dashboard.
const PEER_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Opens Typesense connections. Stateless; registered once in `lib.rs`.
pub struct TypesenseConnector;

#[async_trait]
impl Connector for TypesenseConnector {
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError> {
        self.test_with_secret(params, None).await
    }

    async fn open(&self, params: &ConnectionParams) -> Result<OpenConnection, AppError> {
        self.open_with_secret(params, None).await
    }

    async fn test_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<EngineInfo, AppError> {
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let (http, ..) = connect_http(params, db_password(secret), host_over, port_over)?;
        let capabilities = probe_capabilities(&http, default_collection(params)).await?;
        // MILESTONE_30 Task 5b: the test must report *which key scope* was
        // detected, because a search-only key connects perfectly well yet
        // reaches only a fraction of the workspace. `EngineInfo` carries no
        // capability field, and widening the shared port for one engine would be
        // the wrong trade — so the verdict rides in the version line the connect
        // footer already shows ("Connection OK · 30.1 · admin key").
        Ok(EngineInfo {
            server_version: format!(
                "{} · {}",
                engine_info(&capabilities).server_version,
                key_scope_label(capabilities.admin_key)
            ),
            ..engine_info(&capabilities)
        })
    }

    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        // Open the SSH tunnel (if any) before the client, and keep its handle on
        // the connection so the tunnel lives exactly as long as the session.
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let (http, host, port) = connect_http(params, db_password(secret), host_over, port_over)?;
        let capabilities = probe_capabilities(&http, default_collection(params)).await?;

        // Peer transports for the dashboard's node table. Skipped entirely when
        // tunnelling: the tunnel forwards only the primary node, so probing
        // peers directly would fail and paint the cluster red for no reason.
        let peers = if tunnel.is_some() {
            Vec::new()
        } else {
            build_peer_transports(params, db_password(secret), (&host, port))?
        };

        Ok(OpenConnection::search(TypesenseConnection {
            info: engine_info(&capabilities),
            http,
            capabilities,
            host,
            port,
            peers,
            term_cache: RwLock::new(HashMap::new()),
            _tunnel: tunnel,
        }))
    }
}

/// Parse the connection's comma-separated peer list into `(host, port)` pairs.
///
/// Accepts `host:port`, a bare `host` (defaulting to `default_port`), and a full
/// `http(s)://host:port` URL, because people paste whatever their `--nodes`
/// file or client config contains. The primary host is filtered out so it is
/// never probed twice.
fn parse_peers(raw: &str, primary: (&str, u16), default_port: u16) -> Vec<(String, u16)> {
    let mut peers = Vec::new();
    for entry in raw.split(',') {
        let entry = entry.trim().trim_end_matches('/');
        if entry.is_empty() {
            continue;
        }
        // Drop a scheme if one was pasted; the connection's own protocol wins.
        let entry = entry
            .strip_prefix("https://")
            .or_else(|| entry.strip_prefix("http://"))
            .unwrap_or(entry);
        let (host, port) = match entry.rsplit_once(':') {
            Some((h, p)) => match p.parse::<u16>() {
                Ok(port) => (h, port),
                // `host:not-a-port` — treat the whole thing as a host.
                Err(_) => (entry, default_port),
            },
            None => (entry, default_port),
        };
        if host.is_empty() {
            continue;
        }
        let peer = (host.to_string(), port);
        if peer.0 == primary.0 && peer.1 == primary.1 {
            continue;
        }
        if !peers.contains(&peer) {
            peers.push(peer);
        }
    }
    peers
}

/// The configured default collection, if any.
fn default_collection(params: &ConnectionParams) -> Option<String> {
    match params {
        ConnectionParams::Typesense {
            default_collection, ..
        } => default_collection.clone(),
        _ => None,
    }
}

/// Build the transport from [`ConnectionParams::Typesense`], returning it with
/// the real host/port (which stay the user's, even when tunnelled).
fn connect_http(
    params: &ConnectionParams,
    api_key: Option<&str>,
    host_override: Option<&str>,
    port_override: Option<u16>,
) -> Result<(TypesenseHttp, String, u16), AppError> {
    let ConnectionParams::Typesense {
        protocol,
        host,
        port,
        ..
    } = params
    else {
        return Err(AppError::Invalid(format!(
            "the Typesense connector received {} parameters",
            params.engine().display_name()
        )));
    };

    // Both tunnel overrides are Some together (or both None); pair them.
    let socket_override = host_override.zip(port_override);
    let http = TypesenseHttp::new(
        protocol.as_scheme(),
        host,
        *port,
        api_key.unwrap_or(""),
        socket_override,
        REQUEST_TIMEOUT,
    )?;
    Ok((http, host.clone(), *port))
}

/// One transport per configured peer, so the node table can report each one.
fn build_peer_transports(
    params: &ConnectionParams,
    api_key: Option<&str>,
    primary: (&str, u16),
) -> Result<Vec<(String, u16, TypesenseHttp)>, AppError> {
    let ConnectionParams::Typesense {
        protocol,
        port,
        nodes,
        ..
    } = params
    else {
        return Ok(Vec::new());
    };
    let Some(raw) = nodes.as_deref().filter(|n| !n.trim().is_empty()) else {
        return Ok(Vec::new());
    };

    let mut transports = Vec::new();
    for (host, peer_port) in parse_peers(raw, primary, *port) {
        let http = TypesenseHttp::new(
            protocol.as_scheme(),
            &host,
            peer_port,
            api_key.unwrap_or(""),
            None,
            // A peer that is down must not stall the dashboard behind the full
            // interactive timeout, so probes get a much shorter budget.
            PEER_PROBE_TIMEOUT,
        )?;
        transports.push((host, peer_port, http));
    }
    Ok(transports)
}

/// One connect-time probe: the server version, and whether the key is admin.
///
/// `GET /health` first, so an unreachable node or a wrong protocol fails with a
/// transport sentence rather than a confusing auth one. Then `/debug` for the
/// version, then `/collections` purely as the key-scope test — a 401 there is
/// the *expected* answer for a search-only key and must not fail the connect.
async fn probe_capabilities(
    http: &TypesenseHttp,
    default_collection: Option<String>,
) -> Result<ServerCapabilities, AppError> {
    let health = http.get_value("/health", None).await?;
    if !health.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Err(AppError::Database(
            "The Typesense node answered /health but reported itself unhealthy.".into(),
        ));
    }

    // `/debug` needs a key with debug scope; a search-only key gets nothing, so
    // an absent version is not fatal.
    let version = http
        .get_optional("/debug")
        .await?
        .and_then(|d| d.get("version").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let major_version = parse_major(&version);

    let admin_key = http.get_optional("/collections").await?.is_some();

    Ok(ServerCapabilities {
        version,
        major_version,
        admin_key,
        default_collection,
        // v30 is where synonyms/curation became top-level resources. An unknown
        // version (search-only key) assumes the legacy dialect, which the
        // curation views cannot reach anyway without an admin key.
        curation_sets_api: major_version >= 30,
    })
}

/// Leading integer of a version string (`"30.1"` → 30). 0 when unknown.
fn parse_major(version: &str) -> u32 {
    version
        .trim()
        .split('.')
        .next()
        .and_then(|major| major.parse().ok())
        .unwrap_or(0)
}

/// How the connect footer names the detected key scope.
fn key_scope_label(admin_key: bool) -> &'static str {
    if admin_key {
        "admin key"
    } else {
        "search-only key"
    }
}

fn engine_info(capabilities: &ServerCapabilities) -> EngineInfo {
    EngineInfo {
        engine: Engine::Typesense,
        server_version: if capabilities.version.is_empty() {
            "unknown".to_string()
        } else {
            capabilities.version.clone()
        },
    }
}

/// One open Typesense connection: the HTTP transport, the connect-time
/// capability verdict, and the term-dictionary cache. When reached through an
/// SSH bastion, the live tunnel is held here so it lives exactly as long as the
/// session.
/// Fields are module-private: `reader` and `writer` are descendants of this
/// module, so they reach them without widening the visibility of the transport
/// (which holds the API key) beyond this adapter.
pub struct TypesenseConnection {
    http: TypesenseHttp,
    info: EngineInfo,
    capabilities: ServerCapabilities,
    /// The real (untunnelled) host/port, for the node table's display.
    host: String,
    port: u16,
    /// Transports for the peers named on the connection — see the `nodes` field
    /// on [`ConnectionParams::Typesense`] for why the client has to be told.
    peers: Vec<(String, u16, TypesenseHttp)>,
    /// Sampled term dictionaries, keyed by collection + field set. See
    /// [`terms`] for why the empty-state panel needs one.
    term_cache: RwLock<HashMap<String, TermDictionary>>,
    _tunnel: Option<SshTunnel>,
}

#[async_trait]
impl SearchConnection for TypesenseConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    fn capabilities(&self) -> ServerCapabilities {
        self.capabilities.clone()
    }

    async fn close(&self) -> Result<(), AppError> {
        // `reqwest::Client` is Drop-managed; nothing to release explicitly.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::Protocol;

    #[test]
    fn major_version_drives_the_curation_dialect() {
        assert_eq!(parse_major("30.1"), 30);
        assert_eq!(parse_major("29.0"), 29);
        assert_eq!(parse_major("0.25.2"), 0);
        assert_eq!(parse_major(""), 0);
        assert_eq!(parse_major("not-a-version"), 0);
    }

    #[test]
    fn the_connector_rejects_another_engines_parameters() {
        let wrong = ConnectionParams::Sqlite {
            path: "/tmp/x.db".into(),
        };
        // `expect_err` would need Debug on the transport (which deliberately has
        // none — it holds the API key), so destructure instead.
        let Err(err) = connect_http(&wrong, None, None, None) else {
            panic!("the Typesense connector accepted SQLite parameters");
        };
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(err.to_string().contains("SQLite"));
    }

    #[test]
    fn the_transport_keeps_the_real_host_when_tunnelled() {
        let params = ConnectionParams::Typesense {
            protocol: Protocol::Https,
            host: "search.internal".into(),
            port: 8108,
            default_collection: Some("products".into()),
            nodes: None,
            ssh: None,
        };
        let (http, host, port) =
            connect_http(&params, Some("key"), Some("127.0.0.1"), Some(45123)).expect("build");
        assert_eq!(host, "search.internal");
        assert_eq!(port, 8108);
        // The displayed URL is the user's node, never the tunnel endpoint.
        assert_eq!(
            http.url_for("/collections"),
            "https://search.internal:8108/collections"
        );
    }

    #[test]
    fn default_collection_is_read_off_the_params() {
        let params = ConnectionParams::Typesense {
            protocol: Protocol::Http,
            host: "localhost".into(),
            port: 8108,
            default_collection: Some("products".into()),
            nodes: None,
            ssh: None,
        };
        assert_eq!(default_collection(&params).as_deref(), Some("products"));
    }

    #[test]
    fn peers_parse_from_whatever_people_paste() {
        let primary = ("localhost", 8108);
        // host:port, bare host, a pasted URL, and stray whitespace.
        assert_eq!(
            parse_peers(
                " localhost:8118, ts-3 ,http://localhost:8128/ ",
                primary,
                8108
            ),
            vec![
                ("localhost".into(), 8118),
                ("ts-3".into(), 8108),
                ("localhost".into(), 8128),
            ]
        );
    }

    #[test]
    fn the_primary_node_is_never_listed_as_its_own_peer() {
        // The `--nodes` file lists every member including this one, so pasting
        // it verbatim must not double up the dialled node.
        let peers = parse_peers(
            "localhost:8108,localhost:8118,localhost:8128",
            ("localhost", 8108),
            8108,
        );
        assert_eq!(
            peers,
            vec![("localhost".into(), 8118), ("localhost".into(), 8128)]
        );
    }

    #[test]
    fn duplicate_and_empty_peer_entries_are_dropped() {
        assert_eq!(
            parse_peers("a:1,,a:1, ,b", ("z", 9), 8108),
            vec![("a".into(), 1), ("b".into(), 8108)]
        );
        assert!(parse_peers("   ", ("z", 9), 8108).is_empty());
    }

    #[test]
    fn the_test_footer_names_the_detected_key_scope() {
        assert_eq!(key_scope_label(true), "admin key");
        assert_eq!(key_scope_label(false), "search-only key");
    }

    #[test]
    fn an_unknown_version_still_yields_engine_info() {
        let info = engine_info(&ServerCapabilities {
            version: String::new(),
            major_version: 0,
            admin_key: false,
            default_collection: None,
            curation_sets_api: false,
        });
        assert_eq!(info.engine, Engine::Typesense);
        assert_eq!(info.server_version, "unknown");
    }
}
