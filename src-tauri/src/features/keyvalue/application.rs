//! Use-cases for the key-value slice. Each thin function resolves the open
//! key-value connection behind a handle (via the connections feature's
//! `ConnectionManager::get_kv`) and delegates to a port-trait method. No Tauri,
//! no drivers. The kind-mismatch / closed-handle §5 errors come from `get_kv`.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::error::AppError;
use crate::shared::keyvalue::{
    KeyType, KeyView, KvDbInfo, KvServerInfo, KvServerStats, RespReply, ScanPage, ScanRequest,
};

/// Server identity for the dashboard header (`INFO server`/`replication`).
pub async fn server_info(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<KvServerInfo, AppError> {
    manager.get_kv(handle).await?.server_info().await
}

/// Dashboard stat-grid counters.
pub async fn server_stats(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<KvServerStats, AppError> {
    manager.get_kv(handle).await?.server_stats().await
}

/// Per-database key counts (`INFO keyspace`).
pub async fn keyspace(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<KvDbInfo>, AppError> {
    manager.get_kv(handle).await?.keyspace().await
}

/// One cursor page of keys in a db, enriched with type + TTL.
pub async fn scan(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    req: ScanRequest,
) -> Result<ScanPage, AppError> {
    manager.get_kv(handle).await?.scan(db, req).await
}

/// Full typed view of one key.
pub async fn get_key(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
) -> Result<KeyView, AppError> {
    manager.get_kv(handle).await?.get_key(db, key).await
}

// -- writers ----------------------------------------------------------------

pub async fn set_string(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    manager
        .get_kv(handle)
        .await?
        .set_string(db, key, value)
        .await
}

pub async fn hash_set(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    field: &str,
    value: &str,
) -> Result<(), AppError> {
    manager
        .get_kv(handle)
        .await?
        .hash_set(db, key, field, value)
        .await
}

pub async fn hash_del(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    field: &str,
) -> Result<bool, AppError> {
    manager.get_kv(handle).await?.hash_del(db, key, field).await
}

pub async fn list_set(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    index: i64,
    value: &str,
) -> Result<(), AppError> {
    manager
        .get_kv(handle)
        .await?
        .list_set(db, key, index, value)
        .await
}

pub async fn set_add(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    member: &str,
) -> Result<bool, AppError> {
    manager.get_kv(handle).await?.set_add(db, key, member).await
}

pub async fn set_remove(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    member: &str,
) -> Result<bool, AppError> {
    manager
        .get_kv(handle)
        .await?
        .set_remove(db, key, member)
        .await
}

pub async fn zset_add(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    member: &str,
    score: f64,
) -> Result<(), AppError> {
    manager
        .get_kv(handle)
        .await?
        .zset_add(db, key, member, score)
        .await
}

pub async fn zset_remove(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    member: &str,
) -> Result<bool, AppError> {
    manager
        .get_kv(handle)
        .await?
        .zset_remove(db, key, member)
        .await
}

pub async fn delete_key(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
) -> Result<bool, AppError> {
    manager.get_kv(handle).await?.delete_key(db, key).await
}

pub async fn rename_key(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    new_key: &str,
) -> Result<(), AppError> {
    manager
        .get_kv(handle)
        .await?
        .rename_key(db, key, new_key)
        .await
}

pub async fn expire(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    seconds: i64,
) -> Result<bool, AppError> {
    manager.get_kv(handle).await?.expire(db, key, seconds).await
}

pub async fn persist(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
) -> Result<bool, AppError> {
    manager.get_kv(handle).await?.persist(db, key).await
}

pub async fn create_key(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    key: &str,
    key_type: KeyType,
    initial: Option<&str>,
) -> Result<(), AppError> {
    manager
        .get_kv(handle)
        .await?
        .create_key(db, key, key_type, initial)
        .await
}

// -- command runner ---------------------------------------------------------

/// Run a raw command in a db and return the typed reply (CLI console).
pub async fn run_command(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: u8,
    args: Vec<String>,
) -> Result<RespReply, AppError> {
    manager.get_kv(handle).await?.run_command(db, args).await
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::shared::engine::{Engine, EngineInfo, OpenConnection};
    use crate::shared::keyvalue::{
        CommandRunner, KeyValueConnection, KeyspaceReader, KeyspaceWriter, KvValue,
    };

    /// A minimal fake key-value connection: records the last command and echoes
    /// fixed typed replies, so the use-cases + the `get_kv` seam are exercised
    /// without a live server.
    struct FakeKv;

    #[async_trait]
    impl KeyspaceReader for FakeKv {
        async fn server_info(&self) -> Result<KvServerInfo, AppError> {
            Ok(KvServerInfo {
                server_version: "7.4.0".into(),
                mode: "standalone".into(),
                role: "master".into(),
                resp_version: 3,
            })
        }
        async fn server_stats(&self) -> Result<KvServerStats, AppError> {
            Ok(KvServerStats::default())
        }
        async fn keyspace(&self) -> Result<Vec<KvDbInfo>, AppError> {
            Ok(vec![KvDbInfo {
                index: 0,
                key_count: 3,
            }])
        }
        async fn scan(&self, _db: u8, req: ScanRequest) -> Result<ScanPage, AppError> {
            // Echo the pattern back as a single key name so the test can assert
            // the request reached the port.
            Ok(ScanPage {
                cursor: "0".into(),
                keys: vec![crate::shared::keyvalue::KeyEntry {
                    name: req.pattern,
                    key_type: KeyType::String,
                    ttl: -1,
                }],
            })
        }
        async fn get_key(&self, _db: u8, key: &str) -> Result<KeyView, AppError> {
            Ok(KeyView {
                key_type: KeyType::String,
                ttl: -1,
                encoding: Some("embstr".into()),
                memory: Some(48),
                idle: Some(0),
                value: KvValue::Str { value: key.into() },
            })
        }
    }

    #[async_trait]
    impl KeyspaceWriter for FakeKv {
        async fn set_string(&self, _db: u8, _k: &str, _v: &str) -> Result<(), AppError> {
            Ok(())
        }
        async fn hash_set(&self, _: u8, _: &str, _: &str, _: &str) -> Result<(), AppError> {
            Ok(())
        }
        async fn hash_del(&self, _: u8, _: &str, _: &str) -> Result<bool, AppError> {
            Ok(true)
        }
        async fn list_set(&self, _: u8, _: &str, _: i64, _: &str) -> Result<(), AppError> {
            Ok(())
        }
        async fn set_add(&self, _: u8, _: &str, _: &str) -> Result<bool, AppError> {
            Ok(true)
        }
        async fn set_remove(&self, _: u8, _: &str, _: &str) -> Result<bool, AppError> {
            Ok(true)
        }
        async fn zset_add(&self, _: u8, _: &str, _: &str, _: f64) -> Result<(), AppError> {
            Ok(())
        }
        async fn zset_remove(&self, _: u8, _: &str, _: &str) -> Result<bool, AppError> {
            Ok(true)
        }
        async fn delete_key(&self, _: u8, _: &str) -> Result<bool, AppError> {
            Ok(true)
        }
        async fn rename_key(&self, _: u8, _: &str, _: &str) -> Result<(), AppError> {
            Ok(())
        }
        async fn expire(&self, _: u8, _: &str, _: i64) -> Result<bool, AppError> {
            Ok(true)
        }
        async fn persist(&self, _: u8, _: &str) -> Result<bool, AppError> {
            Ok(true)
        }
        async fn create_key(
            &self,
            _: u8,
            _: &str,
            _: KeyType,
            _: Option<&str>,
        ) -> Result<(), AppError> {
            Ok(())
        }
    }

    #[async_trait]
    impl CommandRunner for FakeKv {
        async fn run_command(&self, _db: u8, args: Vec<String>) -> Result<RespReply, AppError> {
            // Echo PING → PONG, anything else → the joined args as a bulk.
            if args.first().map(|c| c.eq_ignore_ascii_case("PING")) == Some(true) {
                Ok(RespReply::Status {
                    value: "PONG".into(),
                })
            } else {
                Ok(RespReply::Bulk {
                    value: Some(args.join(" ")),
                })
            }
        }
    }

    #[async_trait]
    impl KeyValueConnection for FakeKv {
        fn engine_info(&self) -> EngineInfo {
            EngineInfo {
                engine: Engine::Redis,
                server_version: "Redis 7.4.0".into(),
            }
        }
        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn use_cases_reach_the_kv_connection_behind_the_handle() {
        let manager = ConnectionManager::new();
        let handle = manager.insert(OpenConnection::kv(FakeKv)).await;

        let info = server_info(&manager, &handle).await.expect("server info");
        assert_eq!(info.resp_version, 3);

        let dbs = keyspace(&manager, &handle).await.expect("keyspace");
        assert_eq!(dbs[0].key_count, 3);

        let page = scan(
            &manager,
            &handle,
            0,
            ScanRequest {
                pattern: "user:*".into(),
                ..Default::default()
            },
        )
        .await
        .expect("scan");
        assert_eq!(page.keys[0].name, "user:*");

        let view = get_key(&manager, &handle, 0, "k").await.expect("get_key");
        assert!(matches!(view.value, KvValue::Str { .. }));

        let reply = run_command(&manager, &handle, 0, vec!["PING".into()])
            .await
            .expect("run");
        assert_eq!(
            reply,
            RespReply::Status {
                value: "PONG".into()
            }
        );

        assert!(set_string(&manager, &handle, 0, "k", "v").await.is_ok());
        assert!(delete_key(&manager, &handle, 0, "k").await.unwrap());
    }

    #[tokio::test]
    async fn kv_use_case_on_a_sql_handle_is_a_kind_mismatch_error() {
        use crate::shared::engine::{EngineConnection, QueryOptions, QueryResult};
        use crate::shared::engine::{FetchRowsRequest, RowsPage, SchemaInfo, TableInfo, TableMeta};

        struct SqlOnly;
        #[async_trait]
        impl EngineConnection for SqlOnly {
            fn engine_info(&self) -> EngineInfo {
                EngineInfo {
                    engine: Engine::Sqlite,
                    server_version: "SQLite".into(),
                }
            }
            async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
                Ok(vec![])
            }
            async fn list_tables(&self, _: &str) -> Result<Vec<TableInfo>, AppError> {
                Ok(vec![])
            }
            async fn table_meta(&self, _: &str, _: &str) -> Result<TableMeta, AppError> {
                Ok(TableMeta::default())
            }
            async fn run_query(&self, _: &str, _: QueryOptions) -> Result<QueryResult, AppError> {
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    row_count: 0,
                    truncated: false,
                    elapsed_ms: 0,
                })
            }
            async fn fetch_rows(&self, _: FetchRowsRequest) -> Result<RowsPage, AppError> {
                Ok(RowsPage {
                    columns: vec![],
                    rows: vec![],
                    offset: 0,
                    limit: 0,
                    total_rows: Some(0),
                    elapsed_ms: 0,
                })
            }
            async fn close(&self) -> Result<(), AppError> {
                Ok(())
            }
        }

        let manager = ConnectionManager::new();
        let handle = manager.insert(OpenConnection::sql(SqlOnly)).await;
        let err = server_info(&manager, &handle).await.unwrap_err();
        assert!(matches!(err, AppError::Unsupported(_)));
        assert!(err.to_string().contains("key-value"));
    }
}
