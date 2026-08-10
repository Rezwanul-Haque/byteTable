//! The [`SearchIndexWriter`] implementation — deliberately two operations.
//!
//! MILESTONE_30 scopes writes to document **upsert** and **delete**. Schema
//! changes (`PATCH /collections/{c}`), collection truncate/drop, delete-by-filter
//! and reindex are the milestone's explicit "Deferred" list: they are destructive
//! in ways that need a confirm flow (listing every `query_by` / `facet_by` /
//! `sort_by` / curation rule that references a dropped field) or a multi-step job
//! (reindex is create → import → verify → **manual** alias swap → drop). Nothing
//! here can destroy a collection.

use async_trait::async_trait;
use serde_json::Value;

use crate::shared::error::AppError;
use crate::shared::search::SearchIndexWriter;

use super::TypesenseConnection;

#[async_trait]
impl SearchIndexWriter for TypesenseConnection {
    async fn upsert_document(&self, collection: &str, document: Value) -> Result<Value, AppError> {
        if !document.is_object() {
            return Err(AppError::Invalid(
                "A Typesense document must be a JSON object.".into(),
            ));
        }
        // Typesense requires an `id`; without one it would *create* a new
        // document on every save rather than replacing the edited one, which
        // silently duplicates. Catch it here with a sentence that says why.
        if document.get("id").and_then(Value::as_str).is_none() {
            return Err(AppError::Invalid(
                "This document has no string `id` field. Typesense identifies documents by `id`, \
                 and an upsert without one would create a duplicate rather than replace it."
                    .into(),
            ));
        }

        self.http
            .post_json(
                &format!("/collections/{collection}/documents?action=upsert"),
                &document,
            )
            .await
    }

    async fn delete_document(&self, collection: &str, id: &str) -> Result<(), AppError> {
        if id.trim().is_empty() {
            return Err(AppError::Invalid(
                "Cannot delete a document without an id.".into(),
            ));
        }
        self.http
            .delete(&format!("/collections/{collection}/documents/{id}"))
            .await
    }
}
