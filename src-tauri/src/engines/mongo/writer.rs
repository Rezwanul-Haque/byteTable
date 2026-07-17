//! MongoDB write path: insert, update, delete and index management
//! (`MongoWriter`). Mirrors the `ports::mongo` write surface.

use async_trait::async_trait;
use mongodb::bson::{doc, Document};
use mongodb::options::IndexOptions;
use mongodb::IndexModel;
use serde_json::Value;

use crate::shared::error::AppError;
use crate::shared::mongo::*;

use super::error::db_err;
use super::value::{bson_to_json, json_to_bson, json_to_doc};
use super::MongoDbConnection;

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
