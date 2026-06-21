//! MongoDB engine adapter (M18): the infrastructure implementation of the
//! MongoDB port family in [`crate::shared::mongo`]. Uses the official `mongodb`
//! driver on Tauri's tokio runtime — no `spawn_blocking`, mirroring the
//! sqlx/redis/dynamo adapters.
//!
//! # Connection (MILESTONE_18 §18.0)
//!
//! Built from [`ConnectionParams::Mongodb`]:
//! - **Connection-string mode** (`uri` is `Some`): parsed straight through
//!   `ClientOptions::parse`, accepting both `mongodb://` and `mongodb+srv://`
//!   (Atlas SRV). Credentials in the URI are honored as-is.
//! - **Host/port mode**: a [`ClientOptions`] is assembled from
//!   host/port/database/user + TLS, and the password (from the transient
//!   [`ConnectSecret`] / keychain) is injected into the credential.
//!
//! The reachability check is a `listDatabases` round-trip (which forces the
//! lazily-connecting driver to actually reach the server).
//!
//! # Safety (MILESTONE_18 "Notes / safety")
//!
//! - Counts come from `estimatedDocumentCount` / `collStats` — never a full
//!   scan to count.
//! - Every `find` is bounded by a default limit + `skip` paging.
//! - ObjectId / ISODate survive read → edit → write via the `{$oid}`/`{$date}`
//!   tags (see [`value`]).

mod value;

use std::time::{Duration, Instant};

use async_trait::async_trait;
use mongodb::bson::{doc, Document};
use mongodb::options::{ClientOptions, Credential, IndexOptions, ServerAddress, Tls, TlsOptions};
use mongodb::{Client, IndexModel};
use serde_json::Value;

use crate::shared::engine::{
    ConnectSecret, ConnectionParams, Connector, Engine, EngineInfo, OpenConnection, TlsMode,
};
use crate::shared::error::AppError;
use crate::shared::mongo::{
    AggregateResult, CollectionDescriptor, CreateIndexSpec, DeleteResult, ExplainResult,
    FindRequest, FindResult, IndexInfo, InsertManyResult, MongoConnection, MongoReader,
    MongoWriter, SchemaField, WriteResult,
};

use value::{bson_to_json, doc_to_json, json_bson_type, json_to_bson, json_to_doc};

/// Internal databases the driver exposes but the sidebar hides.
const HIDDEN_DBS: [&str; 3] = ["admin", "local", "config"];

/// Sample size for `inferSchema` (MILESTONE_18 §18.5) — bounded so a huge
/// collection never scans fully for the schema view.
const SCHEMA_SAMPLE: i64 = 200;

/// Map a driver error to a §5 human sentence.
fn db_err(context: &str, error: mongodb::error::Error) -> AppError {
    AppError::Database(format!("{context}: {error}"))
}

/// Read a numeric BSON field (`Int32`/`Int64`/`Double`) as `u64`, defaulting to
/// 0 — used for the `collStats` numbers, which vary in BSON number type.
fn bson_u64(d: &Document, key: &str) -> u64 {
    match d.get(key) {
        Some(mongodb::bson::Bson::Int32(i)) => (*i).max(0) as u64,
        Some(mongodb::bson::Bson::Int64(i)) => (*i).max(0) as u64,
        Some(mongodb::bson::Bson::Double(f)) => f.max(0.0) as u64,
        _ => 0,
    }
}

/// Opens and tests MongoDB connections. Stateless; registered once in `lib.rs`.
pub struct MongoConnector;

#[async_trait]
impl Connector for MongoConnector {
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
        let client = build_client(params, secret).await?;
        // Round-trip check: listDatabases forces a real connection (the driver
        // connects lazily otherwise) — MILESTONE_18 §18.0 acceptance.
        client
            .list_database_names()
            .await
            .map_err(|e| db_err("MongoDB connection failed", e))?;
        Ok(read_engine_info(&client).await)
    }

    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        let client = build_client(params, secret).await?;
        client
            .list_database_names()
            .await
            .map_err(|e| db_err("MongoDB connection failed", e))?;
        let info = read_engine_info(&client).await;
        Ok(OpenConnection::mongo(MongoDbConnection { client, info }))
    }
}

/// Build the driver [`Client`] for `params`, honoring connection-string vs
/// host/port mode and injecting the password secret for host/port auth.
async fn build_client(
    params: &ConnectionParams,
    secret: Option<&ConnectSecret>,
) -> Result<Client, AppError> {
    let (uri, host, port, database, user, tls_mode) = match params {
        ConnectionParams::Mongodb {
            uri,
            host,
            port,
            database,
            user,
            tls_mode,
        } => (uri, host, *port, database, user, *tls_mode),
        other => {
            return Err(AppError::Invalid(format!(
                "MongoDB connector received {} params",
                other.engine().display_name()
            )))
        }
    };

    let mut options = if let Some(uri) = uri {
        // Connection-string mode: parse `mongodb://` or `mongodb+srv://` as-is.
        ClientOptions::parse(uri)
            .await
            .map_err(|e| db_err("Invalid MongoDB connection string", e))?
    } else {
        // Host/port mode: assemble options from the discrete fields.
        let mut options = ClientOptions::default();
        options.hosts = vec![ServerAddress::Tcp {
            host: host.clone(),
            port: Some(port),
        }];
        options.default_database = database.clone();
        if let Some(user) = user {
            let mut credential = Credential::default();
            credential.username = Some(user.clone());
            credential.password = secret
                .and_then(ConnectSecret::password)
                .map(str::to_string)
                .or(Some(String::new()));
            // Default the auth source to the target db (or "admin") — the
            // common case; a URI connection carries its own authSource.
            credential.source = database.clone().or_else(|| Some("admin".into()));
            options.credential = Some(credential);
        }
        options.tls = tls_for(tls_mode);
        options
    };

    options.app_name = Some("ByteTable".into());
    // Fail fast on an unreachable server rather than hanging the test button.
    options.server_selection_timeout = Some(Duration::from_secs(8));
    options.connect_timeout = Some(Duration::from_secs(8));

    Client::with_options(options).map_err(|e| db_err("Could not build MongoDB client", e))
}

/// Translate the modal's TLS mode into the driver's TLS config. MongoDB has no
/// "prefer" — local plaintext maps `disable`/`prefer` to no TLS; the verify
/// modes enable TLS, with `require` accepting an invalid/self-signed cert.
fn tls_for(mode: TlsMode) -> Option<Tls> {
    match mode {
        TlsMode::Disable | TlsMode::Prefer => None,
        TlsMode::Require => {
            let mut options = TlsOptions::default();
            options.allow_invalid_certificates = Some(true);
            Some(Tls::Enabled(options))
        }
        TlsMode::VerifyCa | TlsMode::VerifyFull => Some(Tls::Enabled(TlsOptions::default())),
    }
}

/// Read the server version (`buildInfo`) into [`EngineInfo`]; best-effort — a
/// version that can't be read still yields a usable "MongoDB" label.
async fn read_engine_info(client: &Client) -> EngineInfo {
    let version = client
        .database("admin")
        .run_command(doc! { "buildInfo": 1 })
        .await
        .ok()
        .and_then(|d| d.get_str("version").ok().map(str::to_string));
    EngineInfo {
        engine: Engine::Mongodb,
        server_version: match version {
            Some(v) => format!("MongoDB {v}"),
            None => "MongoDB".into(),
        },
    }
}

/// One open MongoDB connection: the driver client plus the resolved engine info.
/// The client is `Clone`/`Drop`-managed (an internal connection pool), so there
/// is no per-db handle cache and `close` is a no-op.
pub struct MongoDbConnection {
    client: Client,
    info: EngineInfo,
}

impl MongoDbConnection {
    /// The `<db>.<coll>` typed-as-`Document` collection handle.
    fn coll(&self, db: &str, coll: &str) -> mongodb::Collection<Document> {
        self.client.database(db).collection::<Document>(coll)
    }

    /// `listIndexes` → [`IndexInfo`] rows.
    async fn indexes(&self, db: &str, coll: &str) -> Result<Vec<IndexInfo>, AppError> {
        let mut cursor = self
            .coll(db, coll)
            .list_indexes()
            .await
            .map_err(|e| db_err(&format!("List indexes for '{coll}'"), e))?;
        let mut out = Vec::new();
        while cursor
            .advance()
            .await
            .map_err(|e| db_err("Read index", e))?
        {
            let model = cursor
                .deserialize_current()
                .map_err(|e| db_err("Decode index", e))?;
            let opts = model.options.unwrap_or_default();
            let name = opts
                .name
                .unwrap_or_else(|| index_name_from_keys(&model.keys));
            out.push(IndexInfo {
                name,
                keys: doc_to_json(&model.keys),
                unique: opts.unique,
                sparse: opts.sparse,
            });
        }
        Ok(out)
    }

    /// Collect a cursor of documents into tagged JSON values (bounded by the
    /// caller's limit) via the `advance`/`deserialize_current` API — no
    /// `futures` dependency.
    async fn drain(
        cursor: &mut mongodb::Cursor<Document>,
        context: &str,
    ) -> Result<Vec<Value>, AppError> {
        let mut docs = Vec::new();
        while cursor.advance().await.map_err(|e| db_err(context, e))? {
            let d = cursor
                .deserialize_current()
                .map_err(|e| db_err(context, e))?;
            docs.push(doc_to_json(&d));
        }
        Ok(docs)
    }
}

/// Derive a Mongo-style index name from its key pattern (`{category:1,price:-1}`
/// → `category_1_price_-1`) — used when the driver omits an explicit name.
fn index_name_from_keys(keys: &Document) -> String {
    keys.iter()
        .map(|(k, v)| {
            let dir = v
                .as_i32()
                .or_else(|| v.as_i64().map(|n| n as i32))
                .unwrap_or(1);
            format!("{k}_{dir}")
        })
        .collect::<Vec<_>>()
        .join("_")
}

/// `mongo-engine.js` `chooseIndex`: the first index whose leading key appears in
/// the filter (ignoring `$`-prefixed top-level operators).
fn choose_index(indexes: &[IndexInfo], filter: &Value) -> Option<String> {
    let keys: Vec<&str> = filter
        .as_object()
        .map(|o| {
            o.keys()
                .filter(|k| !k.starts_with('$'))
                .map(String::as_str)
                .collect()
        })
        .unwrap_or_default();
    if keys.is_empty() {
        return None;
    }
    for idx in indexes {
        if let Some(lead) = idx.keys.as_object().and_then(|o| o.keys().next()) {
            if keys.contains(&lead.as_str()) {
                return Some(idx.name.clone());
            }
        }
    }
    None
}

#[async_trait]
impl MongoReader for MongoDbConnection {
    async fn list_databases(&self) -> Result<Vec<String>, AppError> {
        let names = self
            .client
            .list_database_names()
            .await
            .map_err(|e| db_err("List databases", e))?;
        Ok(names
            .into_iter()
            .filter(|n| !HIDDEN_DBS.contains(&n.as_str()))
            .collect())
    }

    async fn list_collections(&self, db: &str) -> Result<Vec<CollectionDescriptor>, AppError> {
        let database = self.client.database(db);
        let mut cursor = database
            .list_collections()
            .await
            .map_err(|e| db_err(&format!("List collections in '{db}'"), e))?;

        let mut out = Vec::new();
        while cursor
            .advance()
            .await
            .map_err(|e| db_err("Read collection", e))?
        {
            let spec = cursor
                .deserialize_current()
                .map_err(|e| db_err("Decode collection", e))?;
            // Skip views/system collections — only real collections list.
            let name = spec.name;
            let validator = spec.options.validator.as_ref().map(doc_to_json);

            // Fast, scan-free count + size from collStats / estimatedDocumentCount.
            let count = self
                .coll(db, &name)
                .estimated_document_count()
                .await
                .unwrap_or(0);
            let stats = database.run_command(doc! { "collStats": &name }).await.ok();
            let (storage_bytes, avg_doc_bytes) = stats
                .as_ref()
                .map(|s| {
                    let storage = bson_u64(s, "storageSize").max(bson_u64(s, "size"));
                    (storage, bson_u64(s, "avgObjSize"))
                })
                .unwrap_or((0, 0));

            let indexes = self.indexes(db, &name).await.unwrap_or_default();

            out.push(CollectionDescriptor {
                name,
                count,
                indexes,
                validator,
                storage_bytes,
                avg_doc_bytes,
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn find(&self, db: &str, coll: &str, req: FindRequest) -> Result<FindResult, AppError> {
        let collection = self.coll(db, coll);
        let filter = json_to_doc(&req.filter);
        let started = Instant::now();

        // Accurate matched count: an empty filter uses the scan-free estimate;
        // a real filter uses countDocuments (MILESTONE_18 safety note).
        let matched = if filter.is_empty() {
            collection.estimated_document_count().await
        } else {
            collection.count_documents(filter.clone()).await
        }
        .map_err(|e| db_err(&format!("Count '{coll}'"), e))?;

        let mut action = collection.find(filter);
        if let Some(projection) = &req.projection {
            action = action.projection(json_to_doc(projection));
        }
        if let Some(sort) = &req.sort {
            action = action.sort(json_to_doc(sort));
        }
        if let Some(limit) = req.limit {
            action = action.limit(limit as i64);
        }
        if req.skip > 0 {
            action = action.skip(req.skip as u64);
        }
        let mut cursor = action
            .await
            .map_err(|e| db_err(&format!("Find in '{coll}'"), e))?;
        let docs = Self::drain(&mut cursor, "Read document").await?;

        let used_index = {
            let indexes = self.indexes(db, coll).await.unwrap_or_default();
            choose_index(&indexes, &req.filter)
        };

        Ok(FindResult {
            returned: docs.len() as u64,
            docs,
            matched,
            ms: started.elapsed().as_secs_f64() * 1000.0,
            used_index,
        })
    }

    async fn count_documents(&self, db: &str, coll: &str, filter: Value) -> Result<u64, AppError> {
        let collection = self.coll(db, coll);
        let filter = json_to_doc(&filter);
        if filter.is_empty() {
            collection.estimated_document_count().await
        } else {
            collection.count_documents(filter).await
        }
        .map_err(|e| db_err(&format!("Count '{coll}'"), e))
    }

    async fn aggregate(
        &self,
        db: &str,
        coll: &str,
        pipeline: Vec<Value>,
    ) -> Result<AggregateResult, AppError> {
        let stages: Vec<Document> = pipeline.iter().map(json_to_doc).collect();
        let stage_names: Vec<String> = pipeline
            .iter()
            .filter_map(|s| s.as_object().and_then(|o| o.keys().next()).cloned())
            .collect();
        let started = Instant::now();
        let mut cursor = self
            .coll(db, coll)
            .aggregate(stages)
            .await
            .map_err(|e| db_err(&format!("Aggregate '{coll}'"), e))?;
        let docs = Self::drain(&mut cursor, "Read aggregation result").await?;
        Ok(AggregateResult {
            returned: docs.len() as u64,
            docs,
            ms: started.elapsed().as_secs_f64() * 1000.0,
            stages: stage_names,
        })
    }

    async fn explain(
        &self,
        db: &str,
        coll: &str,
        filter: Value,
        sort: Option<Value>,
    ) -> Result<ExplainResult, AppError> {
        let database = self.client.database(db);
        let mut find_cmd = doc! { "find": coll, "filter": json_to_doc(&filter) };
        if let Some(sort) = &sort {
            find_cmd.insert("sort", json_to_doc(sort));
        }
        let out = database
            .run_command(doc! {
                "explain": find_cmd,
                "verbosity": "executionStats",
            })
            .await
            .map_err(|e| db_err(&format!("Explain '{coll}'"), e))?;

        let query_planner = out.get_document("queryPlanner").ok();
        let winning_plan = query_planner.and_then(|q| q.get_document("winningPlan").ok());
        let (stage, index_name) = winning_plan
            .map(plan_stage)
            .unwrap_or(("COLLSCAN".into(), None));

        let exec = out.get_document("executionStats").ok();
        let n_returned = exec.map(|e| bson_u64(e, "nReturned")).unwrap_or(0);
        let docs_examined = exec.map(|e| bson_u64(e, "totalDocsExamined")).unwrap_or(0);
        let keys_examined = exec.map(|e| bson_u64(e, "totalKeysExamined")).unwrap_or(0);
        let ms = exec
            .map(|e| bson_u64(e, "executionTimeMillis") as f64)
            .unwrap_or(0.0);

        let total_docs = self
            .coll(db, coll)
            .estimated_document_count()
            .await
            .unwrap_or(0);

        Ok(ExplainResult {
            namespace: format!("{db}.{coll}"),
            stage,
            index_name,
            n_returned,
            docs_examined,
            keys_examined,
            total_docs,
            ratio: n_returned as f64 / docs_examined.max(1) as f64,
            ms,
            plan: winning_plan.map(doc_to_json).unwrap_or(Value::Null),
        })
    }

    async fn infer_schema(&self, db: &str, coll: &str) -> Result<Vec<SchemaField>, AppError> {
        let mut cursor = self
            .coll(db, coll)
            .find(doc! {})
            .limit(SCHEMA_SAMPLE)
            .await
            .map_err(|e| db_err(&format!("Sample '{coll}'"), e))?;
        let docs = Self::drain(&mut cursor, "Read sample document").await?;
        Ok(infer_schema_rows(&docs))
    }

    async fn list_indexes(&self, db: &str, coll: &str) -> Result<Vec<IndexInfo>, AppError> {
        self.indexes(db, coll).await
    }
}

/// Walk a `winningPlan` stage tree for the leaf access stage: an `IXSCAN`
/// (returns its `indexName`) anywhere in the tree means an index was used,
/// otherwise it is a `COLLSCAN`.
fn plan_stage(plan: &Document) -> (String, Option<String>) {
    if let Ok(stage) = plan.get_str("stage") {
        if stage == "IXSCAN" {
            let name = plan.get_str("indexName").ok().map(str::to_string);
            return ("IXSCAN".into(), name);
        }
    }
    if let Ok(input) = plan.get_document("inputStage") {
        return plan_stage(input);
    }
    // Some plans nest under `inputStages` (e.g. OR); take the first index found.
    if let Ok(inputs) = plan.get_array("inputStages") {
        for s in inputs {
            if let Some(d) = s.as_document() {
                let (stage, name) = plan_stage(d);
                if stage == "IXSCAN" {
                    return (stage, name);
                }
            }
        }
    }
    ("COLLSCAN".into(), None)
}

/// Field-union schema inference over sampled docs, mirroring `mongo-engine.js`
/// `inferSchema` (nested objects → `a.b`; array-of-object → `a[].b`).
fn infer_schema_rows(docs: &[Value]) -> Vec<SchemaField> {
    // Insertion-ordered field table: path → (type→count, present count).
    let mut order: Vec<String> = Vec::new();
    let mut table: std::collections::HashMap<
        String,
        (std::collections::HashMap<&'static str, u32>, u32),
    > = std::collections::HashMap::new();

    fn walk(
        obj: &serde_json::Map<String, Value>,
        prefix: &str,
        order: &mut Vec<String>,
        table: &mut std::collections::HashMap<
            String,
            (std::collections::HashMap<&'static str, u32>, u32),
        >,
    ) {
        for (k, v) in obj {
            let path = if prefix.is_empty() {
                k.clone()
            } else {
                format!("{prefix}.{k}")
            };
            let entry = table.entry(path.clone()).or_insert_with(|| {
                order.push(path.clone());
                (std::collections::HashMap::new(), 0)
            });
            entry.1 += 1;
            *entry.0.entry(json_bson_type(v)).or_insert(0) += 1;
            // Recurse into plain objects and array-of-object.
            if json_bson_type(v) == "object" {
                if let Some(o) = v.as_object() {
                    walk(o, &path, order, table);
                }
            } else if let Some(a) = v.as_array() {
                if let Some(Value::Object(first)) = a.first() {
                    walk(first, &format!("{path}[]"), order, table);
                }
            }
        }
    }

    for d in docs {
        if let Some(o) = d.as_object() {
            walk(o, "", &mut order, &mut table);
        }
    }

    let n = docs.len().max(1) as f64;
    order
        .into_iter()
        .map(|path| {
            let (types, present) = &table[&path];
            let mut type_list: Vec<(&str, u32)> = types.iter().map(|(t, c)| (*t, *c)).collect();
            // Most-common type first. `sort_by_key(Reverse(..))` rather than a
            // `sort_by` closure to satisfy clippy::unnecessary_sort_by (newer
            // toolchains, e.g. CI's Rust 1.96).
            type_list.sort_by_key(|b| std::cmp::Reverse(b.1));
            let depth = path.matches('.').count() + path.matches("[]").count();
            SchemaField {
                presence: ((*present as f64 / n) * 100.0).round() as u32,
                types: type_list.into_iter().map(|(t, _)| t.to_string()).collect(),
                depth: depth as u32,
                path,
            }
        })
        .collect()
}

#[async_trait]
impl MongoWriter for MongoDbConnection {
    async fn insert_one(&self, db: &str, coll: &str, doc: Value) -> Result<Value, AppError> {
        if !doc.is_object() {
            return Err(AppError::Invalid("document must be a JSON object".into()));
        }
        let res = self
            .coll(db, coll)
            .insert_one(json_to_doc(&doc))
            .await
            .map_err(|e| db_err(&format!("Insert into '{coll}'"), e))?;
        Ok(bson_to_json(&res.inserted_id))
    }

    async fn replace_one(
        &self,
        db: &str,
        coll: &str,
        id: Value,
        doc: Value,
    ) -> Result<WriteResult, AppError> {
        let filter = doc! { "_id": json_to_bson(&id) };
        let res = self
            .coll(db, coll)
            .replace_one(filter, json_to_doc(&doc))
            .await
            .map_err(|e| db_err(&format!("Replace in '{coll}'"), e))?;
        Ok(WriteResult {
            matched: res.matched_count,
            modified: res.modified_count,
        })
    }

    async fn delete_one(&self, db: &str, coll: &str, id: Value) -> Result<DeleteResult, AppError> {
        let res = self
            .coll(db, coll)
            .delete_one(doc! { "_id": json_to_bson(&id) })
            .await
            .map_err(|e| db_err(&format!("Delete from '{coll}'"), e))?;
        Ok(DeleteResult {
            deleted: res.deleted_count,
        })
    }

    async fn delete_many(
        &self,
        db: &str,
        coll: &str,
        ids: Vec<Value>,
    ) -> Result<DeleteResult, AppError> {
        let id_bsons: Vec<_> = ids.iter().map(json_to_bson).collect();
        let res = self
            .coll(db, coll)
            .delete_many(doc! { "_id": { "$in": id_bsons } })
            .await
            .map_err(|e| db_err(&format!("Delete from '{coll}'"), e))?;
        Ok(DeleteResult {
            deleted: res.deleted_count,
        })
    }

    async fn insert_many(
        &self,
        db: &str,
        coll: &str,
        docs: Vec<Value>,
    ) -> Result<InsertManyResult, AppError> {
        const CHUNK: usize = 500;
        let collection = self.coll(db, coll);
        let mut inserted = 0u64;
        for chunk in docs.chunks(CHUNK) {
            let batch: Vec<Document> = chunk
                .iter()
                .filter(|v| v.is_object())
                .map(json_to_doc)
                .collect();
            if batch.is_empty() {
                continue;
            }
            let res = collection
                .insert_many(batch)
                .await
                .map_err(|e| db_err(&format!("Insert into '{coll}'"), e))?;
            inserted += res.inserted_ids.len() as u64;
        }
        Ok(InsertManyResult { inserted })
    }

    async fn create_index(
        &self,
        db: &str,
        coll: &str,
        spec: CreateIndexSpec,
    ) -> Result<String, AppError> {
        let mut options = IndexOptions::default();
        options.name = spec.name;
        options.unique = spec.unique;
        options.sparse = spec.sparse;
        let model = IndexModel::builder()
            .keys(json_to_doc(&spec.keys))
            .options(options)
            .build();
        let res = self
            .coll(db, coll)
            .create_index(model)
            .await
            .map_err(|e| db_err(&format!("Create index on '{coll}'"), e))?;
        Ok(res.index_name)
    }

    async fn set_validator(
        &self,
        db: &str,
        coll: &str,
        validator: Option<Value>,
    ) -> Result<(), AppError> {
        let validator_doc = validator.as_ref().map(json_to_doc).unwrap_or_default();
        self.client
            .database(db)
            .run_command(doc! {
                "collMod": coll,
                "validator": validator_doc,
            })
            .await
            .map_err(|e| db_err(&format!("Update validator on '{coll}'"), e))?;
        Ok(())
    }
}

#[async_trait]
impl MongoConnection for MongoDbConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn close(&self) -> Result<(), AppError> {
        // The driver client is Drop-managed (internal pool); nothing explicit.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choose_index_picks_first_leading_key_match() {
        let indexes = vec![
            IndexInfo {
                name: "email_1".into(),
                keys: serde_json::json!({ "email": 1 }),
                unique: Some(true),
                sparse: None,
            },
            IndexInfo {
                name: "country_1".into(),
                keys: serde_json::json!({ "country": 1 }),
                unique: None,
                sparse: None,
            },
        ];
        assert_eq!(
            choose_index(&indexes, &serde_json::json!({ "country": "US" })),
            Some("country_1".into())
        );
        assert_eq!(choose_index(&indexes, &serde_json::json!({})), None);
        assert_eq!(
            choose_index(&indexes, &serde_json::json!({ "name": "x" })),
            None
        );
    }

    #[test]
    fn infer_schema_walks_nested_and_array_of_object() {
        let docs = vec![
            serde_json::json!({
                "_id": { "$oid": "64a1b00c0d0e0f1011121314" },
                "address": { "city": "Austin" },
                "items": [{ "productId": { "$oid": "64a1b00c0d0e0f1011121315" } }],
            }),
            serde_json::json!({ "_id": { "$oid": "64a1b00c0d0e0f1011121316" }, "address": { "city": "Berlin" } }),
        ];
        let rows = infer_schema_rows(&docs);
        let city = rows.iter().find(|r| r.path == "address.city").unwrap();
        assert_eq!(city.presence, 100);
        assert!(city.types.contains(&"string".to_string()));
        let nested = rows.iter().find(|r| r.path == "items[].productId").unwrap();
        assert_eq!(nested.types, vec!["objectId".to_string()]);
        assert!(nested.depth >= 1);
    }

    #[test]
    fn index_name_derived_from_keys() {
        let keys = doc! { "category": 1, "price": -1 };
        assert_eq!(index_name_from_keys(&keys), "category_1_price_-1");
    }
}
