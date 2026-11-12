//! The assistant's view of each engine: which language it speaks, how its
//! structure becomes a [`SchemaSnapshot`], and how a sample of its rows is
//! read when the user turns rows on. One place per engine, behind one enum, so
//! the use-cases in `application` never branch on the engine themselves.
//!
//! Structure only, everywhere: names, types and keys. MongoDB has no declared
//! schema, so its fields come from `infer_schema` (the driver samples documents
//! locally; only paths and types go into the prompt). Redis has none either:
//! its "schema" is the shape of its key names, with every id-like segment
//! masked (see [`key_pattern`]) — and its values are never sent at all.

use std::collections::BTreeMap;
use std::sync::Arc;

use futures_util::stream::{self, StreamExt};

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{Engine, EngineConnection, FetchRowsRequest, TableMeta};
use crate::shared::error::AppError;
use crate::shared::widecolumn::{ColumnKind, WideColumnConnection};

use super::domain::key_pattern;
use super::domain::prompt::{
    ColumnSnap, IndexSnap, Language, RowSample, SchemaSnapshot, TableSnap,
};

/// Introspect at most this many tables / collections concurrently.
const META_CONCURRENCY: usize = 8;
/// Collections whose fields are inferred (each infer samples documents).
const MONGO_MAX_COLLECTIONS: usize = 100;
/// Redis keys sampled with SCAN to find the key patterns.
const REDIS_SAMPLE_KEYS: usize = 1000;
/// Key patterns listed, most common first.
const REDIS_MAX_PATTERNS: usize = 60;

/// An open handle, as the engine family it is.
pub enum Conn {
    Sql(Arc<dyn EngineConnection>),
    Wide(Arc<dyn WideColumnConnection>),
    Doc(Arc<dyn crate::shared::document::DocumentStoreConnection>),
    Mongo(Arc<dyn crate::shared::mongo::MongoConnection>),
    Search(Arc<dyn crate::shared::search::SearchConnection>),
    Kv(Arc<dyn crate::shared::keyvalue::KeyValueConnection>),
}

impl Conn {
    /// The connection behind `handle`, whichever family it is. A closed handle
    /// reports the SQL accessor's "not open" error.
    pub async fn open(
        manager: &ConnectionManager,
        handle: &ConnectionHandleId,
    ) -> Result<Self, AppError> {
        let sql = manager.get_sql(handle).await;
        if let Ok(c) = sql {
            return Ok(Self::Sql(c));
        }
        if let Ok(c) = manager.get_wide_column(handle).await {
            return Ok(Self::Wide(c));
        }
        if let Ok(c) = manager.get_document(handle).await {
            return Ok(Self::Doc(c));
        }
        if let Ok(c) = manager.get_mongo(handle).await {
            return Ok(Self::Mongo(c));
        }
        if let Ok(c) = manager.get_search(handle).await {
            return Ok(Self::Search(c));
        }
        if let Ok(c) = manager.get_kv(handle).await {
            return Ok(Self::Kv(c));
        }
        Err(sql
            .err()
            .unwrap_or_else(|| AppError::NotFound("connection".into())))
    }

    pub fn language(&self) -> Language {
        match self {
            Self::Sql(_) => Language::Sql,
            Self::Wide(_) => Language::Cql,
            Self::Doc(_) => Language::PartiQl,
            Self::Mongo(_) => Language::Mongo,
            Self::Search(_) => Language::Typesense,
            Self::Kv(_) => Language::Redis,
        }
    }

    /// The engine and version named in `[system]`: `PostgreSQL 16.4`.
    pub fn dialect(&self) -> String {
        let info = match self {
            Self::Sql(c) => c.engine_info(),
            Self::Wide(c) => c.engine_info(),
            Self::Doc(c) => c.engine_info(),
            Self::Mongo(c) => c.engine_info(),
            Self::Search(c) => c.engine_info(),
            Self::Kv(c) => c.engine_info(),
        };
        dialect(info.engine, &info.server_version)
    }

    /// Every table / collection / key pattern of `scope` — a SQL schema, a
    /// Cassandra keyspace, a MongoDB database, a Redis db number; DynamoDB and
    /// Typesense have one namespace and ignore it.
    pub async fn snapshot(&self, scope: &str) -> Result<SchemaSnapshot, AppError> {
        let tables = match self {
            Self::Sql(c) => sql_tables(c, scope).await?,
            Self::Wide(c) => wide_tables(c, scope).await?,
            Self::Doc(c) => doc_tables(c).await?,
            Self::Mongo(c) => mongo_tables(c, scope).await?,
            Self::Search(c) => search_tables(c).await?,
            Self::Kv(c) => kv_patterns(c, db_of(scope)).await?,
        };
        let name = match self {
            Self::Doc(_) => "DynamoDB".to_string(),
            Self::Search(_) => "Typesense".to_string(),
            Self::Kv(_) => format!("db{}", db_of(scope)),
            _ => scope.to_string(),
        };
        Ok(SchemaSnapshot { name, tables })
    }

    /// Up to `n` sample rows / documents of one table. Redis never has any:
    /// the caller refuses rows for it before getting here.
    pub async fn rows(&self, scope: &str, table: &str, n: u32) -> Result<RowSample, AppError> {
        let doc_sample = |docs: Vec<serde_json::Value>| RowSample {
            table: table.to_string(),
            total: None,
            rows: docs.into_iter().map(|d| vec![d]).collect(),
            docs: true,
        };
        Ok(match self {
            Self::Sql(c) => {
                let page = c
                    .fetch_rows(FetchRowsRequest {
                        schema: scope.to_string(),
                        table: table.to_string(),
                        sort: None,
                        filter: None,
                        offset: 0,
                        limit: n,
                    })
                    .await?;
                RowSample {
                    table: table.to_string(),
                    total: page.total_rows,
                    rows: page.rows,
                    docs: false,
                }
            }
            Self::Wide(c) => {
                let cql = format!("SELECT * FROM \"{}\" LIMIT {n}", table.replace('"', "\"\""));
                match c.run_cql(scope, &cql, None).await? {
                    crate::shared::widecolumn::CassCqlResult::Rows { rows, .. } => doc_sample(rows),
                    _ => doc_sample(Vec::new()),
                }
            }
            Self::Doc(c) => {
                let req = crate::shared::document::ScanRequest {
                    limit: n,
                    ..Default::default()
                };
                doc_sample(c.scan(table, req).await?.items)
            }
            Self::Mongo(c) => {
                let req = crate::shared::mongo::FindRequest {
                    limit: Some(n),
                    ..Default::default()
                };
                doc_sample(c.find(scope, table, req).await?.docs)
            }
            Self::Search(c) => doc_sample(c.documents(table, 1, n).await?.documents),
            Self::Kv(_) => {
                return Err(AppError::Unsupported(
                    "Redis values are never sent to the assistant.".into(),
                ))
            }
        })
    }
}

/// The dialect named in `[system]`.
pub fn dialect(engine: Engine, server_version: &str) -> String {
    let name = match engine {
        Engine::Postgres => "PostgreSQL",
        Engine::Mysql => "MySQL",
        Engine::Sqlite => "SQLite",
        Engine::Mssql => "SQL Server",
        Engine::Clickhouse => "ClickHouse",
        Engine::Cassandra => "Apache Cassandra",
        Engine::Dynamodb => "DynamoDB",
        Engine::Mongodb => "MongoDB",
        Engine::Typesense => "Typesense",
        Engine::Redis => "Redis",
        #[allow(unreachable_patterns)]
        _ => "SQL",
    };
    // The first version-looking word, wherever the engine put it.
    let version = server_version
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|w| w.trim_end_matches([',', ';', ')']));
    match version {
        Some(v) => format!("{name} {v}"),
        None => name.to_string(),
    }
}

fn db_of(scope: &str) -> u8 {
    scope.trim().trim_start_matches("db").parse().unwrap_or(0)
}

fn col(name: &str, data_type: &str, pk: bool, tag: Option<String>) -> ColumnSnap {
    ColumnSnap {
        name: name.to_string(),
        data_type: data_type.to_string(),
        pk,
        unique: false,
        fk: None,
        comment: None,
        tag,
    }
}

fn idx(name: &str) -> IndexSnap {
    IndexSnap {
        name: name.to_string(),
        primary: false,
    }
}

/// Convert SQL introspection into the snapshot the prompt prints.
pub fn table_snap(name: &str, meta: &TableMeta) -> TableSnap {
    let unique_single = |col: &str| {
        meta.indexes
            .iter()
            .any(|i| i.unique && !i.primary && i.columns.len() == 1 && i.columns[0] == col)
    };
    TableSnap {
        name: name.to_string(),
        comment: meta.comment.clone(),
        columns: meta
            .columns
            .iter()
            .map(|c| ColumnSnap {
                name: c.name.clone(),
                data_type: c.data_type.clone(),
                pk: c.pk,
                unique: !c.pk && unique_single(&c.name),
                fk: c.fk.as_ref().map(|f| format!("{}.{}", f.table, f.column)),
                comment: c.comment.clone(),
                tag: None,
            })
            .collect(),
        indexes: meta
            .indexes
            .iter()
            .map(|i| IndexSnap {
                name: i.name.clone(),
                primary: i.primary,
            })
            .collect(),
        note: None,
    }
}

async fn sql_tables(
    conn: &Arc<dyn EngineConnection>,
    schema: &str,
) -> Result<Vec<TableSnap>, AppError> {
    let tables = conn.list_tables(schema).await?;
    // Futures are built up front (owned data only) so the buffered stream
    // holds no borrowing closure — that keeps the command future `Send`.
    let futures: Vec<_> = tables
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let conn = Arc::clone(conn);
            let schema = schema.to_string();
            let name = t.name.clone();
            async move {
                // A table whose metadata can't be read still appears by name;
                // the prompt just lists no columns for it.
                let meta = conn.table_meta(&schema, &name).await.unwrap_or_default();
                (i, table_snap(&name, &meta))
            }
        })
        .collect();
    let mut metas: Vec<(usize, TableSnap)> = stream::iter(futures)
        .buffer_unordered(META_CONCURRENCY)
        .collect()
        .await;
    metas.sort_by_key(|(i, _)| *i);
    Ok(metas.into_iter().map(|(_, t)| t).collect())
}

/// Cassandra: columns tagged with their key role, so the model knows what a
/// WHERE may restrict; secondary indexes and materialized views by name.
async fn wide_tables(
    conn: &Arc<dyn WideColumnConnection>,
    keyspace: &str,
) -> Result<Vec<TableSnap>, AppError> {
    Ok(conn
        .list_tables(keyspace)
        .await?
        .into_iter()
        .map(|d| {
            let order = |name: &str| {
                d.clustering
                    .iter()
                    .find(|c| c.name == name)
                    .map(|c| c.order.to_lowercase())
                    .unwrap_or_else(|| "asc".into())
            };
            TableSnap {
                name: d.name.clone(),
                comment: d.comment.clone().filter(|c| !c.is_empty()),
                columns: d
                    .columns
                    .iter()
                    .map(|c| {
                        // The key role is the tag ("partition key", "clustering
                        // desc") — a bare `pk` would say less, twice.
                        let tag = match c.kind {
                            ColumnKind::PartitionKey => Some("partition key".to_string()),
                            ColumnKind::Clustering => {
                                Some(format!("clustering {}", order(&c.name)))
                            }
                            ColumnKind::Static => Some("static".to_string()),
                            ColumnKind::Regular => None,
                        };
                        col(&c.name, &c.data_type, false, tag)
                    })
                    .collect(),
                indexes: d
                    .indexes
                    .iter()
                    .map(|i| idx(&i.name))
                    .chain(
                        d.mvs
                            .iter()
                            .map(|m| idx(&format!("{} (materialized view)", m.name))),
                    )
                    .collect(),
                note: None,
            }
        })
        .collect())
}

/// DynamoDB declares only keys: the table's partition / sort key and each
/// index's, with their attribute types.
async fn doc_tables(
    conn: &Arc<dyn crate::shared::document::DocumentStoreConnection>,
) -> Result<Vec<TableSnap>, AppError> {
    let ty = |t: Option<&String>| match t.map(String::as_str) {
        Some("S") => "string".to_string(),
        Some("N") => "number".to_string(),
        Some("B") => "binary".to_string(),
        Some(other) => other.to_lowercase(),
        None => "any".to_string(),
    };
    Ok(conn
        .list_tables()
        .await?
        .into_iter()
        .map(|d| {
            let mut columns = vec![col(
                &d.key_schema.pk,
                &ty(d.attr_types.get(&d.key_schema.pk)),
                false,
                Some("partition key".into()),
            )];
            if let Some(sk) = &d.key_schema.sk {
                columns.push(col(
                    sk,
                    &ty(d.attr_types.get(sk)),
                    false,
                    Some("sort key".into()),
                ));
            }
            for ix in d.gsis.iter().chain(d.lsis.iter()) {
                for key in std::iter::once(&ix.pk).chain(ix.sk.iter()) {
                    if !columns.iter().any(|c| &c.name == key) {
                        columns.push(col(
                            key,
                            &ty(d.attr_types.get(key)),
                            false,
                            Some(format!("key of index {}", ix.name)),
                        ));
                    }
                }
            }
            TableSnap {
                name: d.name.clone(),
                comment: None,
                columns,
                indexes: d
                    .gsis
                    .iter()
                    .chain(d.lsis.iter())
                    .map(|i| idx(&i.name))
                    .collect(),
                note: None,
            }
        })
        .collect())
}

/// MongoDB: each collection's field paths and the types seen in a local
/// sample (`infer_schema`). Paths and types only — never a value.
async fn mongo_tables(
    conn: &Arc<dyn crate::shared::mongo::MongoConnection>,
    db: &str,
) -> Result<Vec<TableSnap>, AppError> {
    let colls = conn.list_collections(db).await?;
    let futures: Vec<_> = colls
        .into_iter()
        .take(MONGO_MAX_COLLECTIONS)
        .enumerate()
        .map(|(i, c)| {
            let conn = Arc::clone(conn);
            let db = db.to_string();
            async move {
                let fields = conn.infer_schema(&db, &c.name).await.unwrap_or_default();
                let columns = fields
                    .iter()
                    .map(|f| col(&f.path, &f.types.join("|"), f.path == "_id", None))
                    .collect();
                let indexes = c
                    .indexes
                    .iter()
                    .filter(|ix| ix.name != "_id_")
                    .map(|ix| idx(&ix.name))
                    .collect();
                (
                    i,
                    TableSnap {
                        name: c.name.clone(),
                        comment: None,
                        columns,
                        indexes,
                        note: None,
                    },
                )
            }
        })
        .collect();
    let mut out: Vec<(usize, TableSnap)> = stream::iter(futures)
        .buffer_unordered(META_CONCURRENCY)
        .collect()
        .await;
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, t)| t).collect())
}

/// Typesense: each collection's fields with what they can be used for.
async fn search_tables(
    conn: &Arc<dyn crate::shared::search::SearchConnection>,
) -> Result<Vec<TableSnap>, AppError> {
    Ok(conn
        .collections()
        .await?
        .into_iter()
        .map(|c| TableSnap {
            name: c.name.clone(),
            comment: None,
            columns: c
                .fields
                .iter()
                .map(|f| {
                    let mut roles = Vec::new();
                    if f.facet {
                        roles.push("facet");
                    }
                    if f.sort {
                        roles.push("sort");
                    }
                    if !f.index {
                        roles.push("not indexed");
                    }
                    let tag = (!roles.is_empty()).then(|| roles.join(" "));
                    col(&f.name, &f.ty, false, tag)
                })
                .collect(),
            indexes: Vec::new(),
            note: None,
        })
        .collect())
}

/// Redis: the shape of the key names, from a SCAN sample — `user:*:session`
/// with its type and how many sampled keys share it. Values are never read.
async fn kv_patterns(
    conn: &Arc<dyn crate::shared::keyvalue::KeyValueConnection>,
    db: u8,
) -> Result<Vec<TableSnap>, AppError> {
    let mut cursor = "0".to_string();
    let mut seen: BTreeMap<(String, &'static str), u64> = BTreeMap::new();
    let mut total = 0usize;
    loop {
        let req = crate::shared::keyvalue::ScanRequest {
            cursor: cursor.clone(),
            count: 500,
            ..Default::default()
        };
        let page = conn.scan(db, req).await?;
        for k in &page.keys {
            *seen
                .entry((key_pattern(&k.name), k.key_type.as_token()))
                .or_default() += 1;
        }
        total += page.keys.len();
        cursor = page.cursor;
        if cursor == "0" || total >= REDIS_SAMPLE_KEYS {
            break;
        }
    }
    let mut patterns: Vec<((String, &'static str), u64)> = seen.into_iter().collect();
    patterns.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(patterns
        .into_iter()
        .take(REDIS_MAX_PATTERNS)
        .map(|((name, ty), n)| TableSnap {
            name,
            comment: None,
            columns: Vec::new(),
            indexes: Vec::new(),
            note: Some(format!(
                "{ty} · {n} {} in the sample",
                if n == 1 { "key" } else { "keys" }
            )),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialects_name_every_engine() {
        assert_eq!(dialect(Engine::Postgres, "16.4"), "PostgreSQL 16.4");
        assert_eq!(
            dialect(Engine::Cassandra, "Cassandra 4.1.3"),
            "Apache Cassandra 4.1.3"
        );
        assert_eq!(dialect(Engine::Mongodb, "MongoDB 7.0.9"), "MongoDB 7.0.9");
        assert_eq!(dialect(Engine::Dynamodb, "DynamoDB (AWS SDK)"), "DynamoDB");
        assert_eq!(dialect(Engine::Sqlite, ""), "SQLite");
    }

    #[test]
    fn redis_db_scope_parses() {
        assert_eq!(db_of("3"), 3);
        assert_eq!(db_of("db2"), 2);
        assert_eq!(db_of(""), 0);
    }
}
