//! Live Redis integration tests for the M13 key-value adapter
//! (`engines::redis`).
//!
//! Gated behind `BYTETABLE_TEST_REDIS_URL` exactly like the M12 SQL
//! integration tests are behind `BYTETABLE_TEST_PG_URL` — the default
//! `cargo test` (and CI without a server) skips them with an `eprintln!`
//! notice. Run against the live server with:
//!
//! ```sh
//! BYTETABLE_TEST_REDIS_URL='redis://:bytetable@127.0.0.1:63790' \
//!   cargo test --test redis_integration -- --nocapture
//! ```
//!
//! The tests exercise the PUBLIC adapter surface (the `Connector` +
//! key-value port traits via `OpenConnection`), set up their own fixtures
//! across all six Redis types (some with TTL, one key in db1), assert reads /
//! writes / scans / typed CLI replies / db isolation, and clean up after
//! themselves (no `FLUSHDB` — they only delete the keys they created, under a
//! unique prefix, so a shared dev server is safe).

use std::sync::Arc;

use bytetable_lib::engines::redis::RedisConnector;
use bytetable_lib::shared::engine::{ConnectSecret, ConnectionParams, Connector, Engine, TlsMode};
use bytetable_lib::shared::keyvalue::{KeyType, KeyValueConnection, KvValue, RespReply};

/// Parse `redis://[:password]@host:port` into params + secret. Only the subset
/// the test server uses is handled (no ACL user, no TLS, no path).
fn parse_url(url: &str) -> (ConnectionParams, Option<ConnectSecret>) {
    let rest = url.strip_prefix("redis://").expect("redis:// scheme");
    let (auth, hostport) = match rest.split_once('@') {
        Some((auth, hp)) => (Some(auth), hp),
        None => (None, rest),
    };
    let password = auth.and_then(|a| {
        // `:password` (no username) or `user:password`.
        let pw = a.split_once(':').map(|(_, p)| p).unwrap_or(a);
        if pw.is_empty() {
            None
        } else {
            Some(pw.to_string())
        }
    });
    let (host, port) = hostport.split_once(':').expect("host:port");
    let params = ConnectionParams::Redis {
        host: host.to_string(),
        port: port.parse().expect("port"),
        db_index: 0,
        user: None,
        tls_mode: TlsMode::Disable,
        ssh: None,
    };
    (params, password.map(ConnectSecret::new))
}

/// The gate: `Some((params, secret))` when the env var is set, else `None`
/// after a skip notice.
fn gate(test: &str) -> Option<(ConnectionParams, Option<ConnectSecret>)> {
    match std::env::var("BYTETABLE_TEST_REDIS_URL") {
        Ok(url) if !url.is_empty() => Some(parse_url(&url)),
        _ => {
            eprintln!("SKIP {test}: BYTETABLE_TEST_REDIS_URL not set (live Redis required)");
            None
        }
    }
}

async fn open_kv(
    params: &ConnectionParams,
    secret: &Option<ConnectSecret>,
) -> Arc<dyn KeyValueConnection> {
    RedisConnector
        .open_with_secret(params, secret.as_ref())
        .await
        .expect("open redis connection")
        .into_kv()
        .expect("kv connection")
}

/// A unique key prefix per test run so a shared dev server stays clean.
fn prefix() -> String {
    format!("bttest:{}:", uuid_like())
}

/// Tiny unique-ish token without pulling a uuid dep into the test crate.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos:x}")
}

/// Seed all six types in db0 (+ a couple with TTL) and one key in db1, then
/// return the list of (db, key) pairs to clean up.
async fn seed(conn: &Arc<dyn KeyValueConnection>, p: &str) -> Vec<(u8, String)> {
    let mut created = Vec::new();
    let mut mk = |db: u8, k: String| {
        created.push((db, k.clone()));
        k
    };

    // string (with TTL via run_command SET EX so we exercise the raw path too)
    let str_key = mk(0, format!("{p}str"));
    conn.run_command(
        0,
        vec![
            "SET".into(),
            str_key.clone(),
            "hello".into(),
            "EX".into(),
            "500".into(),
        ],
    )
    .await
    .expect("SET EX");

    // hash
    let hash_key = mk(0, format!("{p}hash"));
    conn.run_command(
        0,
        vec![
            "HSET".into(),
            hash_key.clone(),
            "name".into(),
            "Ada".into(),
            "role".into(),
            "admin".into(),
        ],
    )
    .await
    .expect("HSET");

    // list
    let list_key = mk(0, format!("{p}list"));
    conn.run_command(
        0,
        vec![
            "RPUSH".into(),
            list_key.clone(),
            "a".into(),
            "b".into(),
            "c".into(),
        ],
    )
    .await
    .expect("RPUSH");

    // set
    let set_key = mk(0, format!("{p}set"));
    conn.run_command(
        0,
        vec![
            "SADD".into(),
            set_key.clone(),
            "x".into(),
            "y".into(),
            "z".into(),
        ],
    )
    .await
    .expect("SADD");

    // zset (with TTL)
    let zset_key = mk(0, format!("{p}zset"));
    conn.run_command(
        0,
        vec![
            "ZADD".into(),
            zset_key.clone(),
            "1".into(),
            "low".into(),
            "9".into(),
            "high".into(),
        ],
    )
    .await
    .expect("ZADD");
    conn.expire(0, &zset_key, 600).await.expect("EXPIRE zset");

    // stream
    let stream_key = mk(0, format!("{p}stream"));
    conn.run_command(
        0,
        vec![
            "XADD".into(),
            stream_key.clone(),
            "*".into(),
            "event".into(),
            "created".into(),
        ],
    )
    .await
    .expect("XADD");

    // one key in db1 for the isolation test
    let db1_key = format!("{p}db1only");
    created.push((1, db1_key.clone()));
    conn.set_string(1, &db1_key, "secret")
        .await
        .expect("db1 SET");

    created
}

async fn cleanup(conn: &Arc<dyn KeyValueConnection>, keys: &[(u8, String)]) {
    for (db, key) in keys {
        let _ = conn.delete_key(*db, key).await;
    }
}

#[tokio::test]
async fn redis_full_surface_against_live_server() {
    let Some((params, secret)) = gate("redis_full_surface_against_live_server") else {
        return;
    };
    let conn = open_kv(&params, &secret).await;
    let p = prefix();
    let created = seed(&conn, &p).await;

    // --- connect + server_info -------------------------------------------
    let info = conn.engine_info();
    assert_eq!(info.engine, Engine::Redis);
    assert!(info.server_version.starts_with("Redis "), "got {info:?}");
    let sinfo = conn.server_info().await.expect("server_info");
    assert!(!sinfo.server_version.is_empty());
    assert_eq!(sinfo.mode, "standalone");
    assert_eq!(sinfo.resp_version, 3);

    // --- keyspace counts --------------------------------------------------
    let keyspace = conn.keyspace().await.expect("keyspace");
    let db0 = keyspace.iter().find(|d| d.index == 0).expect("db0 present");
    assert!(db0.key_count >= 6, "db0 should have our 6+ keys: {db0:?}");
    assert!(
        keyspace.iter().any(|d| d.index == 1 && d.key_count >= 1),
        "db1 should have our key: {keyspace:?}"
    );

    // --- scan: MATCH ------------------------------------------------------
    let page = conn
        .scan(
            0,
            bytetable_lib::shared::keyvalue::ScanRequest {
                pattern: format!("{p}*"),
                count: 100,
                ..Default::default()
            },
        )
        .await
        .expect("scan match");
    // SCAN may need multiple rounds; gather all under our prefix.
    let mut all = page.keys.clone();
    let mut cursor = page.cursor.clone();
    while cursor != "0" {
        let next = conn
            .scan(
                0,
                bytetable_lib::shared::keyvalue::ScanRequest {
                    pattern: format!("{p}*"),
                    count: 100,
                    cursor: cursor.clone(),
                    ..Default::default()
                },
            )
            .await
            .expect("scan page");
        all.extend(next.keys);
        cursor = next.cursor;
    }
    assert_eq!(all.len(), 6, "six keys under our prefix in db0: {all:?}");
    // type + ttl enrichment: the string carries our ~500s TTL, the hash has none.
    let str_entry = all
        .iter()
        .find(|k| k.name.ends_with("str"))
        .expect("str key");
    assert_eq!(str_entry.key_type, KeyType::String);
    assert!(str_entry.ttl > 0 && str_entry.ttl <= 500);
    let hash_entry = all
        .iter()
        .find(|k| k.name.ends_with("hash"))
        .expect("hash key");
    assert_eq!(hash_entry.key_type, KeyType::Hash);
    assert_eq!(hash_entry.ttl, -1);

    // --- scan: TYPE filter ------------------------------------------------
    let zsets = conn
        .scan(
            0,
            bytetable_lib::shared::keyvalue::ScanRequest {
                pattern: format!("{p}*"),
                type_filter: Some(KeyType::Zset),
                count: 100,
                ..Default::default()
            },
        )
        .await
        .expect("scan type filter");
    // The type filter is server-side; everything returned must be a zset.
    assert!(zsets.keys.iter().all(|k| k.key_type == KeyType::Zset));
    assert!(zsets.keys.iter().any(|k| k.name.ends_with("zset")));

    // --- get_key per type -------------------------------------------------
    let v = conn.get_key(0, &format!("{p}str")).await.expect("get str");
    assert_eq!(v.key_type, KeyType::String);
    assert!(v.encoding.is_some());
    assert!(v.memory.is_some());
    assert!(v.idle.is_some());
    assert!(v.ttl > 0);
    assert_eq!(
        v.value,
        KvValue::Str {
            value: "hello".into()
        }
    );

    let v = conn
        .get_key(0, &format!("{p}hash"))
        .await
        .expect("get hash");
    match v.value {
        KvValue::Hash { fields } => {
            assert!(fields.iter().any(|f| f.field == "name" && f.value == "Ada"));
            assert!(fields
                .iter()
                .any(|f| f.field == "role" && f.value == "admin"));
        }
        other => panic!("expected hash, got {other:?}"),
    }

    let v = conn
        .get_key(0, &format!("{p}list"))
        .await
        .expect("get list");
    assert_eq!(
        v.value,
        KvValue::List {
            items: vec!["a".into(), "b".into(), "c".into()]
        }
    );

    let v = conn.get_key(0, &format!("{p}set")).await.expect("get set");
    match v.value {
        KvValue::Set { mut members } => {
            members.sort();
            assert_eq!(members, vec!["x", "y", "z"]);
        }
        other => panic!("expected set, got {other:?}"),
    }

    let v = conn
        .get_key(0, &format!("{p}zset"))
        .await
        .expect("get zset");
    match v.value {
        KvValue::Zset { entries } => {
            // ascending by score: low(1) then high(9)
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].member, "low");
            assert_eq!(entries[0].score, 1.0);
            assert_eq!(entries[1].member, "high");
            assert_eq!(entries[1].score, 9.0);
        }
        other => panic!("expected zset, got {other:?}"),
    }

    let v = conn
        .get_key(0, &format!("{p}stream"))
        .await
        .expect("get stream");
    match v.value {
        KvValue::Stream { entries } => {
            assert_eq!(entries.len(), 1);
            assert!(entries[0]
                .fields
                .iter()
                .any(|f| f.field == "event" && f.value == "created"));
        }
        other => panic!("expected stream, got {other:?}"),
    }

    // missing key
    let v = conn
        .get_key(0, &format!("{p}does-not-exist"))
        .await
        .expect("get missing");
    assert_eq!(v.value, KvValue::Missing {});
    assert_eq!(v.ttl, -2);

    // --- writes (each verified via re-read) -------------------------------
    let wkey = format!("{p}w");
    conn.set_string(0, &wkey, "v1").await.expect("set_string");
    assert_eq!(
        conn.get_key(0, &wkey).await.unwrap().value,
        KvValue::Str { value: "v1".into() }
    );

    let hkey = format!("{p}wh");
    conn.hash_set(0, &hkey, "f", "fv").await.expect("hash_set");
    assert!(matches!(
        conn.get_key(0, &hkey).await.unwrap().value,
        KvValue::Hash { ref fields } if fields.iter().any(|x| x.field == "f" && x.value == "fv")
    ));
    assert!(conn.hash_del(0, &hkey, "f").await.expect("hash_del"));

    // list_set overwrites index 0 of our seeded list
    conn.list_set(0, &format!("{p}list"), 0, "A")
        .await
        .expect("list_set");
    assert_eq!(
        conn.get_key(0, &format!("{p}list")).await.unwrap().value,
        KvValue::List {
            items: vec!["A".into(), "b".into(), "c".into()]
        }
    );

    let skey = format!("{p}ws");
    assert!(conn.set_add(0, &skey, "m").await.expect("set_add"));
    assert!(conn.set_remove(0, &skey, "m").await.expect("set_remove"));

    let zkey = format!("{p}wz");
    conn.zset_add(0, &zkey, "m", 3.5).await.expect("zset_add");
    assert!(conn.zset_remove(0, &zkey, "m").await.expect("zset_remove"));

    // expire + persist on the hash key
    assert!(conn
        .expire(0, &format!("{p}hash"), 999)
        .await
        .expect("expire"));
    assert!(conn.get_key(0, &format!("{p}hash")).await.unwrap().ttl > 0);
    assert!(conn.persist(0, &format!("{p}hash")).await.expect("persist"));
    assert_eq!(conn.get_key(0, &format!("{p}hash")).await.unwrap().ttl, -1);

    // rename + delete
    let rfrom = format!("{p}rfrom");
    let rto = format!("{p}rto");
    conn.set_string(0, &rfrom, "x")
        .await
        .expect("set for rename");
    conn.rename_key(0, &rfrom, &rto).await.expect("rename");
    assert_eq!(
        conn.get_key(0, &rfrom).await.unwrap().value,
        KvValue::Missing {}
    );
    assert!(conn.delete_key(0, &rto).await.expect("delete renamed"));

    // create_key for each type materializes a key of that type
    for (suffix, kt) in [
        ("cs", KeyType::String),
        ("cl", KeyType::List),
        ("cse", KeyType::Set),
        ("ch", KeyType::Hash),
        ("cz", KeyType::Zset),
        ("cx", KeyType::Stream),
    ] {
        let ck = format!("{p}{suffix}");
        conn.create_key(0, &ck, kt, Some("seed"))
            .await
            .unwrap_or_else(|e| panic!("create_key {kt:?}: {e}"));
        assert_eq!(conn.get_key(0, &ck).await.unwrap().key_type, kt);
        conn.delete_key(0, &ck).await.expect("cleanup created");
    }

    // --- run_command typed replies ---------------------------------------
    assert_eq!(
        conn.run_command(0, vec!["PING".into()]).await.unwrap(),
        RespReply::Status {
            value: "PONG".into()
        }
    );
    assert_eq!(
        conn.run_command(0, vec!["GET".into(), format!("{p}str")])
            .await
            .unwrap(),
        RespReply::Bulk {
            value: Some("hello".into())
        }
    );
    // INCR on a fresh counter → Int
    let ckey = format!("{p}counter");
    assert_eq!(
        conn.run_command(0, vec!["INCR".into(), ckey.clone()])
            .await
            .unwrap(),
        RespReply::Int { value: 1 }
    );
    conn.delete_key(0, &ckey).await.ok();
    // HGETALL → Array (flat field,value)
    match conn
        .run_command(0, vec!["HGETALL".into(), format!("{p}hash")])
        .await
        .unwrap()
    {
        RespReply::Array { items } => {
            assert!(items.len() >= 4);
            assert!(items.iter().all(|r| matches!(r, RespReply::Bulk { .. })));
        }
        other => panic!("HGETALL should be an array, got {other:?}"),
    }
    // GET on a missing key → nil bulk
    assert_eq!(
        conn.run_command(0, vec!["GET".into(), format!("{p}nope")])
            .await
            .unwrap(),
        RespReply::Bulk { value: None }
    );
    // WRONGTYPE: GET on the hash key → error reply (NOT an AppError)
    match conn
        .run_command(0, vec!["GET".into(), format!("{p}hash")])
        .await
        .unwrap()
    {
        RespReply::Error { value } => assert!(value.starts_with("WRONGTYPE"), "got {value}"),
        other => panic!("expected WRONGTYPE error reply, got {other:?}"),
    }
    // unknown command → error reply
    match conn
        .run_command(0, vec!["NOTACOMMAND".into()])
        .await
        .unwrap()
    {
        RespReply::Error { value } => assert!(value.starts_with("ERR"), "got {value}"),
        other => panic!("expected unknown-command error reply, got {other:?}"),
    }

    // --- db isolation: the db1 key is invisible in db0 --------------------
    let db1_key = format!("{p}db1only");
    assert_eq!(
        conn.get_key(0, &db1_key).await.unwrap().value,
        KvValue::Missing {},
        "db1 key must not be visible in db0"
    );
    let in_db1 = conn.get_key(1, &db1_key).await.unwrap();
    assert_eq!(
        in_db1.value,
        KvValue::Str {
            value: "secret".into()
        }
    );

    // --- cleanup ----------------------------------------------------------
    cleanup(&conn, &created).await;
    let _ = conn.delete_key(0, &wkey).await;
    let _ = conn.delete_key(0, &hkey).await;
    conn.close().await.expect("close");
}

/// A second, independent check that `test`/`test_with_secret` works (the
/// "Test connection" button path) without keeping a connection open.
#[tokio::test]
async fn redis_test_connection_reports_version() {
    let Some((params, secret)) = gate("redis_test_connection_reports_version") else {
        return;
    };
    let info = RedisConnector
        .test_with_secret(&params, secret.as_ref())
        .await
        .expect("test connection");
    assert_eq!(info.engine, Engine::Redis);
    assert!(info.server_version.starts_with("Redis "));
}
