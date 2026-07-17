//! MongoDB read path: list databases/collections, schema inference, find,
//! aggregate and explain (`MongoReader`). Mirrors the `ports::mongo` read surface.

use std::time::Instant;

use async_trait::async_trait;
use mongodb::bson::{doc, Document};
use serde_json::Value;

use crate::shared::error::AppError;
use crate::shared::mongo::*;

use super::error::db_err;
use super::value::{doc_to_json, json_bson_type, json_to_doc};
use super::MongoDbConnection;

/// Internal databases the driver exposes but the sidebar hides.
const HIDDEN_DBS: [&str; 3] = ["admin", "local", "config"];

/// Sample size for `inferSchema` (MILESTONE_18 §18.5) — bounded so a huge
/// collection never scans fully for the schema view.
const SCHEMA_SAMPLE: i64 = 200;

/// Read a numeric BSON field (`Int32`/`Int64`/`Double`) as `u64`, defaulting to
/// 0 — used for the `collStats` numbers, which vary in BSON number type.
pub(super) fn bson_u64(d: &Document, key: &str) -> u64 {
    match d.get(key) {
        Some(mongodb::bson::Bson::Int32(i)) => (*i).max(0) as u64,
        Some(mongodb::bson::Bson::Int64(i)) => (*i).max(0) as u64,
        Some(mongodb::bson::Bson::Double(f)) => f.max(0.0) as u64,
        _ => 0,
    }
}

/// `mongo-engine.js` `chooseIndex`: the first index whose leading key appears in
/// the filter (ignoring `$`-prefixed top-level operators).
pub(super) fn choose_index(indexes: &[IndexInfo], filter: &Value) -> Option<String> {
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
pub(super) fn plan_stage(plan: &Document) -> (String, Option<String>) {
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
pub(super) fn infer_schema_rows(docs: &[Value]) -> Vec<SchemaField> {
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
}
