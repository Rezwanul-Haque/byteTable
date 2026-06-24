//! Live DynamoDB integration tests for the M17 document-store adapter
//! (`engines::dynamo`).
//!
//! Gated behind `BYTETABLE_TEST_DYNAMODB_URL` — the default `cargo test`
//! (and CI without a server) skips them with an `eprintln!` notice. Run
//! against the Docker DynamoDB Local instance with:
//!
//! ```sh
//! BYTETABLE_TEST_DYNAMODB_URL='dynamodb://localhost:8000' \
//!   cargo test --test dynamo_integration -- --nocapture
//! ```
//!
//! Requires the seed from `test-fixtures/seed/seed-dynamo.sh` to have been run
//! (creates `ShopApp`, `Sessions`, `EventLog`, `WideDemo`).

use bytetable_lib::engines::dynamo::DynamoConnector;

use bytetable_lib::shared::engine::{ConnectSecret, ConnectionParams, Connector, DynamoAuth, Engine};

/// Parse `dynamodb://host:port` into `(ConnectionParams, secret)`. The URL
/// may carry an optional `/region` suffix (defaults to `us-east-1`).
fn parse_url(url: &str) -> (ConnectionParams, Option<ConnectSecret>) {
    let rest = url.strip_prefix("dynamodb://").expect("dynamodb:// scheme");
    let (hostport, region) = rest.split_once('/').unwrap_or((rest, ""));
    let region = if region.is_empty() {
        "us-east-1"
    } else {
        region
    };
    let (host, port_str) = hostport.split_once(':').expect("host:port");
    let port: u16 = port_str.parse().expect("port");

    let params = ConnectionParams::Dynamodb {
        region: region.to_string(),
        endpoint: Some(format!("http://{host}:{port}")),
        auth: DynamoAuth::Keys {
            access_key_id: "local".to_string(),
        },
    };
    (params, Some(ConnectSecret::new("local")))
}

/// The gate: `Some((params, secret))` when the env var is set, else `None`
/// after a skip notice.
fn gate() -> Option<(ConnectionParams, Option<ConnectSecret>)> {
    match std::env::var("BYTETABLE_TEST_DYNAMODB_URL") {
        Ok(url) if !url.is_empty() => Some(parse_url(&url)),
        _ => {
            eprintln!("SKIP: BYTETABLE_TEST_DYNAMODB_URL not set (DynamoDB Local required)");
            None
        }
    }
}

/// Open a document-store connection from params + secret.
async fn open_doc(
    params: &ConnectionParams,
    secret: &Option<ConnectSecret>,
) -> std::sync::Arc<dyn bytetable_lib::shared::document::DocumentStoreConnection> {
    DynamoConnector
        .open_with_secret(params, secret.as_ref())
        .await
        .expect("open dynamodb connection")
        .into_document()
        .expect("document-store connection")
}

const SEEDED_TABLES: &[&str] = &["ShopApp", "Sessions", "EventLog", "WideDemo"];

/// The main integration test: opens a connection, calls both `list_table_names`
/// and `list_tables`, and asserts the results are consistent.
#[tokio::test]
async fn dynamo_list_tables_against_local_server() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open_doc(&params, &secret).await;

    // ---- list_table_names (lightweight, names only) ----
    let names = conn
        .list_table_names()
        .await
        .expect("list_table_names");
    for expected in SEEDED_TABLES {
        assert!(
            names.iter().any(|n| n == expected),
            "list_table_names should include {expected}, got: {names:?}"
        );
    }

    // ---- list_tables (full descriptors with key schema, GSIs, etc.) ----
    let descriptors = conn.list_tables().await.expect("list_tables");
    assert_eq!(descriptors.len(), names.len());

    for desc in &descriptors {
        assert!(
            names.contains(&desc.name),
            "every descriptor name must appear in list_table_names: {}",
            desc.name
        );
        // Full descriptors carry a non-empty partition-key name.
        assert!(
            !desc.key_schema.pk.is_empty(),
            "list_tables must return a real PK for {}, got empty",
            desc.name
        );
        match desc.name.as_str() {
            "Sessions" => {
                // Sessions has PROVISIONED billing with 5 RCU / 5 WCU.
                assert_eq!(desc.billing, "PROVISIONED");
            }
            _ => {
                // The other three (ShopApp, EventLog, WideDemo) are PAY_PER_REQUEST.
                assert_eq!(desc.billing, "PAY_PER_REQUEST");
            }
        }
        // Every table should have at least some items (the seed populated them).
        assert!(
            desc.item_count > 0,
            "{} should have items after seeding",
            desc.name
        );
    }

    // Verify session-level info.
    let info = conn.engine_info();
    assert_eq!(info.engine, Engine::Dynamodb);
    assert!(!info.server_version.is_empty());

    conn.close().await.expect("close");
}

/// Test that `test_with_secret` (the "Test connection" button path) works
/// against a live endpoint.
#[tokio::test]
async fn dynamo_test_connection_reports_engine() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let info = DynamoConnector
        .test_with_secret(&params, secret.as_ref())
        .await
        .expect("test connection");
    assert_eq!(info.engine, Engine::Dynamodb);
    assert!(!info.server_version.is_empty());
}
