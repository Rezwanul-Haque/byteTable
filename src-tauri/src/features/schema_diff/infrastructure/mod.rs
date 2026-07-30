//! Infrastructure adapter: reads a structural snapshot off an open SQL
//! connection using the existing introspection surface
//! ([`EngineConnection::list_tables`] + [`EngineConnection::table_meta`]).
//!
//! No new driver code and no new SQL: every engine that already powers the
//! sidebar can be diffed, and the adapter inherits each engine's own catalog
//! queries. `list_tables` returns **base tables** only (views and routines
//! come from `list_objects`), which is exactly the set the differ wants.

use std::sync::Arc;

use async_trait::async_trait;

use crate::shared::engine::EngineConnection;
use crate::shared::error::AppError;

use super::domain::{ColumnSchema, IndexSchema, SchemaSnapshot, TableSchema};
use super::ports::SchemaReader;

/// [`SchemaReader`] over an open SQL connection.
pub struct EngineSchemaReader {
    conn: Arc<dyn EngineConnection>,
}

impl EngineSchemaReader {
    pub fn new(conn: Arc<dyn EngineConnection>) -> Self {
        Self { conn }
    }
}

#[async_trait]
impl SchemaReader for EngineSchemaReader {
    async fn read_schema(&self, schema: &str) -> Result<SchemaSnapshot, AppError> {
        let tables = self.conn.list_tables(schema).await?;
        // Sequential on purpose: `table_meta` is one catalog round trip per
        // table, and firing them all at once would hand a shared pool a
        // thundering herd for what is an interactive, once-per-comparison read.
        let mut out = Vec::with_capacity(tables.len());
        for t in tables {
            let meta = self.conn.table_meta(schema, &t.name).await?;
            out.push(TableSchema {
                name: t.name,
                columns: meta
                    .columns
                    .into_iter()
                    .map(|c| ColumnSchema {
                        name: c.name,
                        data_type: c.data_type,
                        pk: c.pk,
                        nullable: c.nullable,
                    })
                    .collect(),
                indexes: meta
                    .indexes
                    .into_iter()
                    .map(|i| IndexSchema {
                        name: i.name,
                        columns: i.columns,
                        unique: i.unique,
                        primary: i.primary,
                    })
                    .collect(),
            });
        }
        Ok(SchemaSnapshot {
            schema: schema.to_string(),
            tables: out,
        })
    }
}
