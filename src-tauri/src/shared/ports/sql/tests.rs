// Serde round-trips, wire-format, and helper tests for the engine types.

use super::*;

#[test]
fn binary_to_json_inlines_small_as_hex_and_placeholders_large() {
    assert_eq!(binary_to_json(&[]), serde_json::json!("0x"));
    assert_eq!(
        binary_to_json(&[0x00, 0xab, 0xff]),
        serde_json::json!("0x00abff")
    );
    // 16-byte UUID-shaped value → 0x + 32 hex chars.
    let uuid = [0x12u8; 16];
    assert_eq!(
        binary_to_json(&uuid),
        serde_json::json!("0x12121212121212121212121212121212")
    );
    // Exactly at the limit still inlines; one over falls back to placeholder.
    assert_eq!(
        binary_to_json(&[0u8; INLINE_BINARY_MAX_BYTES])
            .as_str()
            .unwrap()
            .len(),
        2 + INLINE_BINARY_MAX_BYTES * 2
    );
    assert_eq!(
        binary_to_json(&[0u8; INLINE_BINARY_MAX_BYTES + 1]),
        serde_json::json!(format!("[{} bytes]", INLINE_BINARY_MAX_BYTES + 1))
    );
}

#[test]
fn count_statements_counts_terminated_and_trailing() {
    // Two terminated statements.
    assert_eq!(
        count_statements("CREATE TABLE t (id INT); INSERT INTO t VALUES (1);"),
        2
    );
    // A trailing statement with no final `;` still counts.
    assert_eq!(count_statements("SELECT 1; SELECT 2"), 2);
    // Empty / whitespace-only / pure-comment scripts count zero.
    assert_eq!(count_statements(""), 0);
    assert_eq!(count_statements("   \n\t  "), 0);
    assert_eq!(count_statements(";;;"), 0);
    assert_eq!(count_statements("-- just a comment\n"), 0);
    assert_eq!(count_statements("/* block only */"), 0);
}

#[test]
fn count_statements_ignores_semicolons_in_strings_and_comments() {
    // A `;` inside a single-quoted literal is not a boundary.
    assert_eq!(
        count_statements("INSERT INTO t VALUES ('a;b;c'); SELECT 1;"),
        2
    );
    // Doubled quote inside a literal stays inside.
    assert_eq!(
        count_statements("INSERT INTO t VALUES ('O''Brien; Jr'); SELECT 1;"),
        2
    );
    // `;` inside a line comment is ignored; the statement spans the comment.
    assert_eq!(count_statements("SELECT 1 -- a; b; c\n; SELECT 2;"), 2);
    // `;` inside a block comment is ignored.
    assert_eq!(count_statements("SELECT 1 /* ; ; ; */; SELECT 2;"), 2);
    // Backtick identifiers (MySQL) may legally contain `;`.
    assert_eq!(count_statements("SELECT `we;ird`; SELECT 2;"), 2);
    // Double-quoted identifier with a `;` inside.
    assert_eq!(count_statements("SELECT \"a;b\"; SELECT 2;"), 2);
}

#[test]
fn split_statements_splits_and_trims_and_matches_count() {
    let script = "CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);";
    let parts = split_statements(script);
    assert_eq!(parts.len(), 3);
    assert_eq!(parts.len() as u64, count_statements(script));
    assert_eq!(parts[0], "CREATE TABLE t (id INT)");
    assert_eq!(parts[1], "INSERT INTO t VALUES (1)");
    assert_eq!(parts[2], "INSERT INTO t VALUES (2)");
}

#[test]
fn split_statements_keeps_semicolons_inside_literals() {
    let parts = split_statements("INSERT INTO t VALUES ('a;b'); SELECT 1");
    assert_eq!(parts, vec!["INSERT INTO t VALUES ('a;b')", "SELECT 1"]);
}

#[test]
fn split_statements_drops_empty_and_comment_only_segments() {
    // Leading comment, blank segments, trailing statement without `;`.
    let parts = split_statements("-- header\n;; CREATE TABLE t (id INT) ;\n  ; SELECT 1");
    assert_eq!(parts, vec!["CREATE TABLE t (id INT)", "SELECT 1"]);
    assert_eq!(
        parts.len() as u64,
        count_statements("-- header\n;; CREATE TABLE t (id INT) ;\n  ; SELECT 1")
    );
    // Pure comment → no statements.
    assert!(split_statements("/* nothing here */").is_empty());
}

#[test]
fn import_result_wire_shape_is_camel_case() {
    assert_eq!(
        serde_json::to_value(ImportResult { statements: 3 }).unwrap(),
        serde_json::json!({ "statements": 3 })
    );
}

#[test]
fn engine_serializes_lowercase_matching_renderer() {
    assert_eq!(serde_json::to_value(Engine::Sqlite).unwrap(), "sqlite");
    assert_eq!(serde_json::to_value(Engine::Mysql).unwrap(), "mysql");
    assert_eq!(serde_json::to_value(Engine::Postgres).unwrap(), "postgres");
}

#[test]
fn sqlite_params_wire_shape_is_engine_tagged_camel_case() {
    let params = ConnectionParams::Sqlite {
        path: "/tmp/db.sqlite".into(),
    };
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        serde_json::json!({ "engine": "sqlite", "path": "/tmp/db.sqlite" })
    );
}

#[test]
fn server_params_round_trip_and_report_their_engine() {
    let params = ConnectionParams::Mysql {
        host: "db.internal".into(),
        port: 3306,
        database: Some("shop".into()),
        user: Some("app".into()),
        tls_mode: TlsMode::Require,
        ssh: None,
    };
    assert_eq!(params.engine(), Engine::Mysql);
    assert!(params.ssh().is_none());
    let json = serde_json::to_value(&params).unwrap();
    // `tlsMode` is the canonical wire field; `ssh` is omitted when None.
    assert_eq!(json["tlsMode"], serde_json::json!("require"));
    assert!(json.get("ssh").is_none());
    let back: ConnectionParams = serde_json::from_value(json).unwrap();
    assert_eq!(back, params);
}

#[test]
fn tls_mode_tokens_round_trip_and_default_is_prefer() {
    for (mode, token) in [
        (TlsMode::Disable, "disable"),
        (TlsMode::Prefer, "prefer"),
        (TlsMode::Require, "require"),
        (TlsMode::VerifyCa, "verify-ca"),
        (TlsMode::VerifyFull, "verify-full"),
    ] {
        assert_eq!(serde_json::to_value(mode).unwrap(), token);
        assert_eq!(mode.as_token(), token);
        let back: TlsMode = serde_json::from_value(serde_json::json!(token)).unwrap();
        assert_eq!(back, mode);
    }
    assert_eq!(TlsMode::default(), TlsMode::Prefer);
}

#[test]
fn legacy_tls_bool_migrates_to_tls_mode() {
    // Old saved connection: `tls: true` → Prefer.
    let old_true: ConnectionParams = serde_json::from_value(serde_json::json!({
        "engine": "postgres",
        "host": "db", "port": 5432, "database": "app", "user": "u",
        "tls": true
    }))
    .unwrap();
    assert!(matches!(
        old_true,
        ConnectionParams::Postgres {
            tls_mode: TlsMode::Prefer,
            ..
        }
    ));
    // `tls: false` → Disable.
    let old_false: ConnectionParams = serde_json::from_value(serde_json::json!({
        "engine": "mysql",
        "host": "db", "port": 3306, "database": "app", "user": "u",
        "tls": false
    }))
    .unwrap();
    assert!(matches!(
        old_false,
        ConnectionParams::Mysql {
            tls_mode: TlsMode::Disable,
            ..
        }
    ));
    // Neither field present → default (Prefer).
    let neither: ConnectionParams = serde_json::from_value(serde_json::json!({
        "engine": "postgres",
        "host": "db", "port": 5432, "database": "app", "user": "u"
    }))
    .unwrap();
    assert!(matches!(
        neither,
        ConnectionParams::Postgres {
            tls_mode: TlsMode::Prefer,
            ..
        }
    ));
}

#[test]
fn server_params_with_ssh_round_trip() {
    let params = ConnectionParams::Postgres {
        host: "bt-pg".into(),
        port: 5432,
        database: Some("bytetable".into()),
        user: Some("postgres".into()),
        tls_mode: TlsMode::Disable,
        ssh: Some(SshConfig {
            host: "bastion".into(),
            port: 22,
            user: "tunnel".into(),
            auth: SshAuth::Key {
                key_path: "~/.ssh/id_ed25519".into(),
            },
        }),
    };
    let json = serde_json::to_value(&params).unwrap();
    assert_eq!(
        json["ssh"],
        serde_json::json!({
            "host": "bastion",
            "port": 22,
            "user": "tunnel",
            "auth": { "method": "key", "keyPath": "~/.ssh/id_ed25519" }
        })
    );
    let back: ConnectionParams = serde_json::from_value(json).unwrap();
    assert_eq!(back, params);
    assert_eq!(back.ssh().map(|s| s.host.as_str()), Some("bastion"));

    // Password + agent auth shapes round-trip.
    for auth in [SshAuth::Password, SshAuth::Agent] {
        let p = ConnectionParams::Mysql {
            host: "h".into(),
            port: 3306,
            database: Some("d".into()),
            user: Some("u".into()),
            tls_mode: TlsMode::Prefer,
            ssh: Some(SshConfig {
                host: "b".into(),
                port: 2222,
                user: "t".into(),
                auth: auth.clone(),
            }),
        };
        let back: ConnectionParams =
            serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }
}

#[test]
fn engine_redis_serializes_lowercase() {
    assert_eq!(serde_json::to_value(Engine::Redis).unwrap(), "redis");
    let back: Engine = serde_json::from_value(serde_json::json!("redis")).unwrap();
    assert_eq!(back, Engine::Redis);
    assert_eq!(Engine::Redis.display_name(), "Redis");
}

#[test]
fn redis_params_wire_shape_is_camel_case_and_round_trips() {
    let params = ConnectionParams::Redis {
        host: "cache.byteshop.io".into(),
        port: 6379,
        db_index: 0,
        user: None,
        tls_mode: TlsMode::Disable,
        ssh: None,
    };
    assert_eq!(params.engine(), Engine::Redis);
    assert!(params.ssh().is_none());
    let json = serde_json::to_value(&params).unwrap();
    assert_eq!(json["engine"], serde_json::json!("redis"));
    assert_eq!(json["dbIndex"], serde_json::json!(0));
    assert_eq!(json["tlsMode"], serde_json::json!("disable"));
    // `user` and `ssh` are omitted when None.
    assert!(json.get("user").is_none());
    assert!(json.get("ssh").is_none());
    // No relational `database` field exists on the Redis variant.
    assert!(json.get("database").is_none());
    let back: ConnectionParams = serde_json::from_value(json).unwrap();
    assert_eq!(back, params);
}

#[test]
fn redis_params_defaults_port_db_index_and_user() {
    // Minimal payload: only engine + host. port→6379, dbIndex→0, user→None.
    let params: ConnectionParams =
        serde_json::from_value(serde_json::json!({ "engine": "redis", "host": "h" })).unwrap();
    assert_eq!(
        params,
        ConnectionParams::Redis {
            host: "h".into(),
            port: 6379,
            db_index: 0,
            user: None,
            tls_mode: TlsMode::Prefer,
            ssh: None,
        }
    );
    // An ACL user + non-zero db index + legacy tls bool.
    let params: ConnectionParams = serde_json::from_value(serde_json::json!({
        "engine": "redis", "host": "h", "port": 63790,
        "dbIndex": 3, "user": "app", "tls": true
    }))
    .unwrap();
    assert!(matches!(
        params,
        ConnectionParams::Redis {
            db_index: 3,
            tls_mode: TlsMode::Prefer,
            ..
        }
    ));
    if let ConnectionParams::Redis { user, .. } = &params {
        assert_eq!(user.as_deref(), Some("app"));
    }
}

#[test]
fn connection_kind_serializes_lowercase() {
    assert_eq!(serde_json::to_value(ConnectionKind::Sql).unwrap(), "sql");
    assert_eq!(serde_json::to_value(ConnectionKind::Kv).unwrap(), "kv");
    // M19: the Cassandra family's wire token is "cassandra" (the engine the
    // renderer routes on), not the internal `WideColumn` family name.
    assert_eq!(
        serde_json::to_value(ConnectionKind::WideColumn).unwrap(),
        "cassandra"
    );
}

#[test]
fn cassandra_params_wire_shape_is_camel_case_and_round_trips() {
    let params = ConnectionParams::Cassandra {
        contact_points: "127.0.0.1".into(),
        port: 9042,
        keyspace: Some("byteshop".into()),
        local_datacenter: Some("dc1".into()),
        user: None,
        tls_mode: TlsMode::Disable,
    };
    assert_eq!(params.engine(), Engine::Cassandra);
    assert!(params.ssh().is_none());
    let json = serde_json::to_value(&params).unwrap();
    assert_eq!(json["engine"], serde_json::json!("cassandra"));
    assert_eq!(json["contactPoints"], serde_json::json!("127.0.0.1"));
    assert_eq!(json["keyspace"], serde_json::json!("byteshop"));
    assert_eq!(json["localDatacenter"], serde_json::json!("dc1"));
    assert_eq!(json["tlsMode"], serde_json::json!("disable"));
    // `user` is omitted when None; no relational `database` field exists.
    assert!(json.get("user").is_none());
    assert!(json.get("database").is_none());
    let back: ConnectionParams = serde_json::from_value(json).unwrap();
    assert_eq!(back, params);
}

#[test]
fn cassandra_params_default_port_optional_fields_and_legacy_tls() {
    // Minimal payload: engine + contactPoints. port→9042; keyspace / dc /
    // user → None; missing tlsMode defaults to Prefer.
    let params: ConnectionParams =
        serde_json::from_value(serde_json::json!({ "engine": "cassandra", "contactPoints": "h" }))
            .unwrap();
    assert_eq!(
        params,
        ConnectionParams::Cassandra {
            contact_points: "h".into(),
            port: 9042,
            keyspace: None,
            local_datacenter: None,
            user: None,
            tls_mode: TlsMode::Prefer,
        }
    );
    // Full payload with the legacy `tls` bool tolerated.
    let params: ConnectionParams = serde_json::from_value(serde_json::json!({
        "engine": "cassandra", "contactPoints": "10.0.0.1,10.0.0.2", "port": 9043,
        "keyspace": "ks", "localDatacenter": "dc2", "user": "cassandra", "tls": true
    }))
    .unwrap();
    assert!(matches!(
        params,
        ConnectionParams::Cassandra {
            port: 9043,
            tls_mode: TlsMode::Prefer,
            ..
        }
    ));
    if let ConnectionParams::Cassandra {
        user,
        local_datacenter,
        ..
    } = &params
    {
        assert_eq!(user.as_deref(), Some("cassandra"));
        assert_eq!(local_datacenter.as_deref(), Some("dc2"));
    }
}

#[test]
fn db_object_info_enriched_round_trips_camelcase() {
    let mut info = DbObjectInfo::bare(
        "trg_users_audit".into(),
        DbObjectKind::Trigger,
        Some("users".into()),
    );
    info.owner = Some("app_rw".into());
    info.table = Some("users".into());
    info.timing = Some("BEFORE".into());
    info.events = vec!["INSERT".into(), "UPDATE".into()];
    info.enabled = Some(true);
    let json = serde_json::to_value(&info).unwrap();
    // camelCase on the wire; unset numeric metadata serializes as null.
    assert_eq!(json["argCount"], serde_json::Value::Null);
    assert_eq!(json["events"][0], "INSERT");
    assert_eq!(json["owner"], "app_rw");
    let back: DbObjectInfo = serde_json::from_value(json).unwrap();
    assert_eq!(back, info);
}

#[test]
fn db_object_wire_shapes_round_trip() {
    let info = DbObjectInfo::bare("active_users".into(), DbObjectKind::View, None);
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["kind"], "view");
    assert_eq!(json["name"], "active_users");
    let back: DbObjectInfo = serde_json::from_value(json).unwrap();
    assert_eq!(back, info);

    let mv = serde_json::to_value(DbObjectKind::MaterializedView).unwrap();
    assert_eq!(mv, "materialized_view");

    let def = DbObjectDefinition::ddl_only(
        "f".into(),
        DbObjectKind::Function,
        "CREATE FUNCTION f() …".into(),
    );
    let dj = serde_json::to_value(&def).unwrap();
    assert_eq!(dj["kind"], "function");
    assert_eq!(dj["args"], serde_json::json!([]));
    assert_eq!(
        serde_json::from_value::<DbObjectDefinition>(dj).unwrap(),
        def
    );
}

#[test]
fn table_meta_wire_shape_is_camel_case_with_nullable_fk() {
    let meta = TableMeta {
        columns: vec![
            ColumnInfo {
                name: "author_id".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                pk: false,
                default_value: None,
                fk: Some(FkRef {
                    table: "authors".into(),
                    column: "id".into(),
                }),
            },
            ColumnInfo {
                name: "note".into(),
                data_type: String::new(),
                nullable: true,
                pk: true,
                default_value: Some("'n/a'".into()),
                fk: None,
            },
        ],
        ..Default::default()
    };
    let json = serde_json::to_value(&meta).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "columns": [
                {
                    "name": "author_id",
                    "dataType": "INTEGER",
                    "nullable": false,
                    "pk": false,
                    "default": null,
                    "fk": { "table": "authors", "column": "id" }
                },
                {
                    "name": "note",
                    "dataType": "",
                    "nullable": true,
                    "pk": true,
                    "default": "'n/a'",
                    "fk": null
                }
            ],
            // M7 additions: always present on the wire, empty/null by default.
            "comment": null,
            "indexes": [],
            "foreignKeys": [],
            "referencedBy": [],
            "ddl": null
        })
    );
    // And the shape round-trips.
    let back: TableMeta = serde_json::from_value(json).unwrap();
    assert_eq!(back, meta);
}

#[test]
fn table_meta_m7_structure_fields_wire_shape_round_trips() {
    let meta = TableMeta {
        columns: vec![ColumnInfo {
            name: "id".into(),
            data_type: "INTEGER".into(),
            nullable: true,
            pk: true,
            default_value: None,
            fk: None,
        }],
        comment: Some("the books table".into()),
        indexes: vec![
            IndexInfo {
                name: "sqlite_autoindex_books_1".into(),
                columns: vec!["id".into()],
                unique: true,
                primary: true,
                origin: Some("pk".into()),
            },
            IndexInfo {
                name: "idx_books_author_title".into(),
                columns: vec!["author_id".into(), "title".into()],
                unique: false,
                primary: false,
                origin: Some("c".into()),
            },
        ],
        foreign_keys: vec![ForeignKeyInfo {
            name: None,
            columns: vec!["author_id".into()],
            ref_table: "authors".into(),
            ref_columns: vec!["id".into()],
            on_delete: Some("CASCADE".into()),
            on_update: Some("NO ACTION".into()),
        }],
        referenced_by: vec![InboundFkInfo {
            table: "reviews".into(),
            columns: vec!["book_id".into()],
            ref_columns: vec!["id".into()],
            on_delete: Some("SET NULL".into()),
        }],
        ddl: Some("CREATE TABLE books (id INTEGER PRIMARY KEY)".into()),
    };
    let json = serde_json::to_value(&meta).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "columns": [
                { "name": "id", "dataType": "INTEGER", "nullable": true, "pk": true, "default": null, "fk": null }
            ],
            "comment": "the books table",
            "indexes": [
                {
                    "name": "sqlite_autoindex_books_1",
                    "columns": ["id"],
                    "unique": true,
                    "primary": true,
                    "origin": "pk"
                },
                {
                    "name": "idx_books_author_title",
                    "columns": ["author_id", "title"],
                    "unique": false,
                    "primary": false,
                    "origin": "c"
                }
            ],
            "foreignKeys": [
                {
                    "name": null,
                    "columns": ["author_id"],
                    "refTable": "authors",
                    "refColumns": ["id"],
                    "onDelete": "CASCADE",
                    "onUpdate": "NO ACTION"
                }
            ],
            "referencedBy": [
                {
                    "table": "reviews",
                    "columns": ["book_id"],
                    "refColumns": ["id"],
                    "onDelete": "SET NULL"
                }
            ],
            "ddl": "CREATE TABLE books (id INTEGER PRIMARY KEY)"
        })
    );
    let back: TableMeta = serde_json::from_value(json).unwrap();
    assert_eq!(back, meta);
}

#[test]
fn query_options_default_limit_and_camel_case_wire_field() {
    let opts: QueryOptions = serde_json::from_str("{}").unwrap();
    assert_eq!(opts.row_limit, 500);
    assert_eq!(opts.schema, None);
    let opts: QueryOptions = serde_json::from_str(r#"{"rowLimit": 10}"#).unwrap();
    assert_eq!(opts.row_limit, 10);
}

#[test]
fn sort_direction_serializes_lowercase_and_maps_to_sql_keywords() {
    assert_eq!(serde_json::to_value(SortDirection::Asc).unwrap(), "asc");
    assert_eq!(serde_json::to_value(SortDirection::Desc).unwrap(), "desc");
    assert_eq!(SortDirection::Asc.sql_keyword(), "ASC");
    assert_eq!(SortDirection::Desc.sql_keyword(), "DESC");
}

#[test]
fn fetch_rows_request_wire_shape_is_camel_case_and_round_trips() {
    let req = FetchRowsRequest {
        schema: "main".into(),
        table: "users".into(),
        sort: Some(SortSpec {
            column: "name".into(),
            direction: SortDirection::Desc,
        }),
        filter: None,
        offset: 100,
        limit: 50,
    };
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "schema": "main",
            "table": "users",
            "sort": { "column": "name", "direction": "desc" },
            "filter": null,
            "offset": 100,
            "limit": 50
        })
    );
    let back: FetchRowsRequest = serde_json::from_value(json).unwrap();
    assert_eq!(back, req);

    // A sortless request keeps `sort: null` on the wire and round-trips.
    let unsorted = FetchRowsRequest {
        sort: None,
        ..req.clone()
    };
    let json = serde_json::to_value(&unsorted).unwrap();
    assert_eq!(json["sort"], serde_json::Value::Null);
    let back: FetchRowsRequest = serde_json::from_value(json).unwrap();
    assert_eq!(back, unsorted);

    // `filter` is optional on the wire: an absent key deserializes to None.
    let no_filter_key: FetchRowsRequest = serde_json::from_value(serde_json::json!({
        "schema": "main",
        "table": "users",
        "sort": null,
        "offset": 0,
        "limit": 10
    }))
    .unwrap();
    assert_eq!(no_filter_key.filter, None);
}

#[test]
fn filter_op_wire_tokens_are_camel_case_and_round_trip() {
    let cases = [
        (FilterOp::Eq, "eq"),
        (FilterOp::Ne, "ne"),
        (FilterOp::Gt, "gt"),
        (FilterOp::Gte, "gte"),
        (FilterOp::Lt, "lt"),
        (FilterOp::Lte, "lte"),
        (FilterOp::Contains, "contains"),
        (FilterOp::NotContains, "notContains"),
        (FilterOp::BeginsWith, "beginsWith"),
        (FilterOp::EndsWith, "endsWith"),
        (FilterOp::InList, "inList"),
        (FilterOp::IsNull, "isNull"),
        (FilterOp::IsNotNull, "isNotNull"),
    ];
    for (op, token) in cases {
        assert_eq!(serde_json::to_value(op).unwrap(), token);
        let back: FilterOp = serde_json::from_value(serde_json::json!(token)).unwrap();
        assert_eq!(back, op);
    }
    assert!(FilterOp::Eq.needs_value());
    assert!(!FilterOp::IsNull.needs_value());
    assert!(!FilterOp::IsNotNull.needs_value());
}

#[test]
fn combinator_serializes_lowercase_and_maps_to_keywords() {
    assert_eq!(serde_json::to_value(Combinator::And).unwrap(), "and");
    assert_eq!(serde_json::to_value(Combinator::Or).unwrap(), "or");
    assert_eq!(Combinator::And.sql_keyword(), "AND");
    assert_eq!(Combinator::Or.sql_keyword(), "OR");
}

#[test]
fn filter_value_untagged_distinguishes_scalar_from_list() {
    // A JSON array → List; a bare scalar → Scalar.
    let list: FilterValue = serde_json::from_value(serde_json::json!(["DE", "FR"])).unwrap();
    assert_eq!(
        list,
        FilterValue::List(vec![serde_json::json!("DE"), serde_json::json!("FR")])
    );
    let scalar: FilterValue = serde_json::from_value(serde_json::json!(42)).unwrap();
    assert_eq!(scalar, FilterValue::Scalar(serde_json::json!(42)));
    let text: FilterValue = serde_json::from_value(serde_json::json!("paid")).unwrap();
    assert_eq!(text, FilterValue::Scalar(serde_json::json!("paid")));
}

#[test]
fn filter_spec_conditions_mode_wire_shape_round_trips() {
    let spec = FilterSpec::Conditions {
        items: vec![
            Condition {
                column: "status".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!("paid"))),
                binary: false,
            },
            Condition {
                column: "deleted_at".into(),
                op: FilterOp::IsNull,
                value: None,
                binary: false,
            },
            Condition {
                column: "country".into(),
                op: FilterOp::InList,
                value: Some(FilterValue::List(vec![
                    serde_json::json!("DE"),
                    serde_json::json!("FR"),
                ])),
                binary: false,
            },
        ],
        combinator: Combinator::And,
    };
    let json = serde_json::to_value(&spec).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "mode": "conditions",
            "items": [
                { "column": "status", "op": "eq", "value": "paid" },
                { "column": "deleted_at", "op": "isNull", "value": null },
                { "column": "country", "op": "inList", "value": ["DE", "FR"] }
            ],
            "combinator": "and"
        })
    );
    let back: FilterSpec = serde_json::from_value(json).unwrap();
    assert_eq!(back, spec);
}

#[test]
fn filter_spec_raw_mode_wire_shape_round_trips() {
    let spec = FilterSpec::Raw {
        sql: "total > 100 AND country IN ('DE', 'FR')".into(),
    };
    let json = serde_json::to_value(&spec).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "mode": "raw",
            "sql": "total > 100 AND country IN ('DE', 'FR')"
        })
    );
    let back: FilterSpec = serde_json::from_value(json).unwrap();
    assert_eq!(back, spec);
}

#[test]
fn row_lookup_request_wire_shape_is_camel_case_and_round_trips() {
    let req = RowLookupRequest {
        schema: "main".into(),
        table: "authors".into(),
        column: "id".into(),
        value: serde_json::json!(42),
        binary: false,
    };
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "schema": "main",
            "table": "authors",
            "column": "id",
            "value": 42
        })
    );
    let back: RowLookupRequest = serde_json::from_value(json).unwrap();
    assert_eq!(back, req);
}

#[test]
fn row_lookup_wire_shape_is_camel_case_and_round_trips() {
    let found = RowLookup {
        columns: vec![ColumnMeta {
            name: "id".into(),
            type_hint: "INTEGER".into(),
        }],
        row: Some(vec![serde_json::json!(42), serde_json::json!("Ada")]),
        match_count: 1,
    };
    let json = serde_json::to_value(&found).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "columns": [{ "name": "id", "typeHint": "INTEGER" }],
            "row": [42, "Ada"],
            "matchCount": 1
        })
    );
    let back: RowLookup = serde_json::from_value(json).unwrap();
    assert_eq!(back, found);

    // A miss keeps `row: null` on the wire.
    let miss = RowLookup {
        row: None,
        match_count: 0,
        ..found
    };
    let json = serde_json::to_value(&miss).unwrap();
    assert_eq!(json["row"], serde_json::Value::Null);
    assert_eq!(json["matchCount"], serde_json::json!(0));
}

#[test]
fn column_stats_request_wire_shape_is_camel_case_and_round_trips() {
    let req = ColumnStatsRequest {
        schema: "main".into(),
        table: "products".into(),
        column: "qty".into(),
        filter: Some(FilterSpec::Conditions {
            items: vec![Condition {
                column: "status".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!("paid"))),
                binary: false,
            }],
            combinator: Combinator::And,
        }),
    };
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "schema": "main",
            "table": "products",
            "column": "qty",
            "filter": {
                "mode": "conditions",
                "items": [{ "column": "status", "op": "eq", "value": "paid" }],
                "combinator": "and"
            }
        })
    );
    let back: ColumnStatsRequest = serde_json::from_value(json).unwrap();
    assert_eq!(back, req);

    // `filter` is optional on the wire: an absent key deserializes to None.
    let no_filter: ColumnStatsRequest = serde_json::from_value(serde_json::json!({
        "schema": "main",
        "table": "products",
        "column": "qty"
    }))
    .unwrap();
    assert_eq!(no_filter.filter, None);
}

#[test]
fn column_stats_wire_shape_is_camel_case_and_round_trips() {
    let stats = ColumnStats {
        total: 4,
        distinct: 3,
        nulls: 1,
        min: Some(serde_json::json!(0)),
        max: Some(serde_json::json!(10)),
        avg: Some(5.0),
        numeric: true,
        top: vec![
            FreqEntry {
                value: serde_json::json!(5),
                count: 2,
            },
            FreqEntry {
                value: serde_json::json!(0),
                count: 1,
            },
        ],
    };
    let json = serde_json::to_value(&stats).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "total": 4,
            "distinct": 3,
            "nulls": 1,
            "min": 0,
            "max": 10,
            "avg": 5.0,
            "numeric": true,
            "top": [
                { "value": 5, "count": 2 },
                { "value": 0, "count": 1 }
            ]
        })
    );
    let back: ColumnStats = serde_json::from_value(json).unwrap();
    assert_eq!(back, stats);

    // A text column: avg None, min/max present, numeric false.
    let text = ColumnStats {
        total: 2,
        distinct: 2,
        nulls: 0,
        min: Some(serde_json::json!("apple")),
        max: Some(serde_json::json!("banana")),
        avg: None,
        numeric: false,
        top: vec![],
    };
    let json = serde_json::to_value(&text).unwrap();
    assert_eq!(json["avg"], serde_json::Value::Null);
    assert_eq!(json["numeric"], serde_json::json!(false));
    assert_eq!(json["top"], serde_json::json!([]));
}

#[test]
fn rows_page_wire_shape_is_camel_case_and_round_trips() {
    let page = RowsPage {
        columns: vec![ColumnMeta {
            name: "id".into(),
            type_hint: "INTEGER".into(),
        }],
        rows: vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
        offset: 0,
        limit: 100,
        total_rows: Some(42),
        elapsed_ms: 3,
    };
    let json = serde_json::to_value(&page).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "columns": [{ "name": "id", "typeHint": "INTEGER" }],
            "rows": [[1], [2]],
            "offset": 0,
            "limit": 100,
            "totalRows": 42,
            "elapsedMs": 3
        })
    );
    let back: RowsPage = serde_json::from_value(json).unwrap();
    assert_eq!(back, page);
}

#[test]
fn update_cell_request_wire_shape_is_camel_case_and_round_trips() {
    let req = UpdateCellRequest {
        schema: "main".into(),
        table: "users".into(),
        column: "name".into(),
        value: serde_json::json!("Ada"),
        pk: vec![PkPredicate {
            column: "id".into(),
            value: serde_json::json!(42),
            binary: false,
        }],
        binary: false,
    };
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "schema": "main",
            "table": "users",
            "column": "name",
            "value": "Ada",
            "pk": [{ "column": "id", "value": 42 }]
        })
    );
    let back: UpdateCellRequest = serde_json::from_value(json).unwrap();
    assert_eq!(back, req);

    // A null new value round-trips (the "set to NULL" case).
    let null_value = UpdateCellRequest {
        value: serde_json::Value::Null,
        ..req.clone()
    };
    let json = serde_json::to_value(&null_value).unwrap();
    assert_eq!(json["value"], serde_json::Value::Null);
    let back: UpdateCellRequest = serde_json::from_value(json).unwrap();
    assert_eq!(back, null_value);

    // A composite-pk request carries one predicate per pk column.
    let composite = UpdateCellRequest {
        pk: vec![
            PkPredicate {
                column: "a".into(),
                value: serde_json::json!(1),
                binary: false,
            },
            PkPredicate {
                column: "b".into(),
                value: serde_json::json!("x"),
                binary: false,
            },
        ],
        ..req
    };
    let json = serde_json::to_value(&composite).unwrap();
    assert_eq!(
        json["pk"],
        serde_json::json!([
            { "column": "a", "value": 1 },
            { "column": "b", "value": "x" }
        ])
    );
    let back: UpdateCellRequest = serde_json::from_value(json).unwrap();
    assert_eq!(back, composite);
}

#[test]
fn update_result_wire_shape_is_camel_case_and_round_trips() {
    let result = UpdateResult {
        affected: 1,
        statement: r#"UPDATE "main"."users" SET "name" = 'Ada' WHERE "id" = 42"#.into(),
    };
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "affected": 1,
            "statement": r#"UPDATE "main"."users" SET "name" = 'Ada' WHERE "id" = 42"#
        })
    );
    let back: UpdateResult = serde_json::from_value(json).unwrap();
    assert_eq!(back, result);
}
