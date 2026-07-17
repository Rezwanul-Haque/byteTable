//! Cassandra write path: insert, update, delete and DDL apply
//! (`WideColumnWriter`). Mirrors the `ports::widecolumn` write surface.

use async_trait::async_trait;

use crate::shared::error::AppError;
use crate::shared::widecolumn::*;

use super::error::db_err;
use super::value::json_to_cql;
use super::{primary_key_string, quote_ident, CassandraConnection};

#[async_trait]
impl WideColumnWriter for CassandraConnection {
    async fn insert_row(&self, req: CassInsertRow) -> Result<(), AppError> {
        let table = self.table_meta(&req.keyspace, &req.table).await?;
        // Every primary-key column must be present (Cassandra requires it).
        for k in Self::full_key(&table) {
            if !req.row.contains_key(&k) {
                return Err(AppError::Invalid(format!(
                    "INSERT is missing primary-key column '{k}'"
                )));
            }
        }
        let mut cols = Vec::new();
        let mut placeholders = Vec::new();
        let mut values = Vec::new();
        for col in &table.columns {
            if let Some(v) = req.row.get(&col.name) {
                cols.push(quote_ident(&col.name));
                placeholders.push("?");
                values.push(json_to_cql(v, &col.data_type)?);
            }
        }
        let cql = format!(
            "INSERT INTO {}.{} ({}) VALUES ({})",
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            cols.join(", "),
            placeholders.join(", ")
        );
        self.session
            .query_unpaged(cql, values)
            .await
            .map_err(|e| db_err("Insert failed", e))?;
        Ok(())
    }

    async fn update_row(&self, req: CassUpdateRow) -> Result<(), AppError> {
        let table = self.table_meta(&req.keyspace, &req.table).await?;
        let key_cols = Self::full_key(&table);
        // Require the FULL primary key — no partial-key UPDATE.
        for k in &key_cols {
            if !req.key.contains_key(k) {
                return Err(AppError::Invalid(format!(
                    "UPDATE requires the full primary key (missing '{k}')"
                )));
            }
        }
        if req.set.is_empty() {
            return Err(AppError::Invalid("UPDATE has no columns to set".into()));
        }
        let col_type = |name: &str| {
            table
                .columns
                .iter()
                .find(|c| c.name == name)
                .map(|c| c.data_type.clone())
        };

        let mut set_parts = Vec::new();
        let mut values = Vec::new();
        for (name, val) in &req.set {
            if key_cols.contains(name) {
                return Err(AppError::Invalid(format!(
                    "Cannot UPDATE primary-key column '{name}' (delete + re-insert to change a key)"
                )));
            }
            let ty = col_type(name)
                .ok_or_else(|| AppError::Invalid(format!("Unknown column '{name}'")))?;
            set_parts.push(format!("{} = ?", quote_ident(name)));
            values.push(json_to_cql(val, &ty)?);
        }
        let mut where_parts = Vec::new();
        for k in &key_cols {
            let ty = col_type(k).unwrap_or_else(|| "text".into());
            where_parts.push(format!("{} = ?", quote_ident(k)));
            values.push(json_to_cql(&req.key[k], &ty)?);
        }
        let cql = format!(
            "UPDATE {}.{} SET {} WHERE {}",
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            set_parts.join(", "),
            where_parts.join(" AND ")
        );
        self.session
            .query_unpaged(cql, values)
            .await
            .map_err(|e| db_err("Update failed", e))?;
        Ok(())
    }

    async fn delete_row(&self, req: CassDeleteRow) -> Result<(), AppError> {
        let table = self.table_meta(&req.keyspace, &req.table).await?;
        let key_cols = Self::full_key(&table);
        for k in &key_cols {
            if !req.key.contains_key(k) {
                return Err(AppError::Invalid(format!(
                    "DELETE requires the full primary key (missing '{k}')"
                )));
            }
        }
        let col_type = |name: &str| {
            table
                .columns
                .iter()
                .find(|c| c.name == name)
                .map(|c| c.data_type.clone())
        };
        let mut where_parts = Vec::new();
        let mut values = Vec::new();
        for k in &key_cols {
            let ty = col_type(k).unwrap_or_else(|| "text".into());
            where_parts.push(format!("{} = ?", quote_ident(k)));
            values.push(json_to_cql(&req.key[k], &ty)?);
        }
        let cql = format!(
            "DELETE FROM {}.{} WHERE {}",
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            where_parts.join(" AND ")
        );
        self.session
            .query_unpaged(cql, values)
            .await
            .map_err(|e| db_err("Delete failed", e))?;
        Ok(())
    }

    async fn delete_rows(&self, req: CassDeleteRows) -> Result<u64, AppError> {
        let mut deleted = 0u64;
        for key in req.keys {
            self.delete_row(CassDeleteRow {
                keyspace: req.keyspace.clone(),
                table: req.table.clone(),
                key,
            })
            .await?;
            deleted += 1;
        }
        Ok(deleted)
    }

    async fn create_index(&self, req: CassCreateIndex) -> Result<(), AppError> {
        let cql = format!(
            "CREATE INDEX {} ON {}.{} ({})",
            quote_ident(&req.name),
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            quote_ident(&req.target)
        );
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Create index failed", e))?;
        Ok(())
    }

    async fn drop_index(&self, keyspace: &str, name: &str) -> Result<(), AppError> {
        let cql = format!("DROP INDEX {}.{}", quote_ident(keyspace), quote_ident(name));
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Drop index failed", e))?;
        Ok(())
    }

    async fn create_mv(&self, req: CassCreateMv) -> Result<(), AppError> {
        if req.partition_key.is_empty() {
            return Err(AppError::Invalid(
                "A materialized view needs at least one partition-key column".into(),
            ));
        }
        let pk = req
            .partition_key
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let clustering = if req.clustering.is_empty() {
            String::new()
        } else {
            format!(
                ", {}",
                req.clustering
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let not_null = req
            .partition_key
            .iter()
            .chain(req.clustering.iter())
            .map(|c| format!("{} IS NOT NULL", quote_ident(c)))
            .collect::<Vec<_>>()
            .join(" AND ");
        let cql = format!(
            "CREATE MATERIALIZED VIEW {}.{} AS SELECT * FROM {}.{} WHERE {} PRIMARY KEY (({}){})",
            quote_ident(&req.keyspace),
            quote_ident(&req.name),
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            not_null,
            pk,
            clustering
        );
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Create materialized view failed", e))?;
        Ok(())
    }

    async fn drop_mv(&self, keyspace: &str, name: &str) -> Result<(), AppError> {
        let cql = format!(
            "DROP MATERIALIZED VIEW {}.{}",
            quote_ident(keyspace),
            quote_ident(name)
        );
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Drop materialized view failed", e))?;
        Ok(())
    }

    async fn create_keyspace(&self, req: CassCreateKeyspace) -> Result<(), AppError> {
        // Build the replication map literal: every value rendered as a CQL string.
        let mut entries: Vec<String> = Vec::new();
        if let Some(class) = req.replication.get("class") {
            entries.push(format!("'class': '{}'", json_scalar_str(class)));
        }
        for (k, v) in &req.replication {
            if k == "class" {
                continue;
            }
            entries.push(format!("'{}': '{}'", k, json_scalar_str(v)));
        }
        let cql = format!(
            "CREATE KEYSPACE {} WITH replication = {{{}}} AND durable_writes = {}",
            quote_ident(&req.name),
            entries.join(", "),
            req.durable_writes
        );
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Create keyspace failed", e))?;
        Ok(())
    }

    async fn create_table(&self, req: CassCreateTable) -> Result<(), AppError> {
        if req.partition_key.is_empty() {
            return Err(AppError::Invalid(
                "A table needs at least one partition-key column".into(),
            ));
        }
        let mut lines: Vec<String> = req
            .columns
            .iter()
            .map(|c| {
                let stat = if c.kind == ColumnKind::Static {
                    " static"
                } else {
                    ""
                };
                format!("  {} {}{}", quote_ident(&c.name), c.data_type, stat)
            })
            .collect();
        let clustering_names: Vec<String> = req.clustering.iter().map(|c| c.name.clone()).collect();
        lines.push(format!(
            "  PRIMARY KEY {}",
            primary_key_string(&req.partition_key, &clustering_names)
        ));
        let mut cql = format!(
            "CREATE TABLE {}.{} (\n{}\n)",
            quote_ident(&req.keyspace),
            quote_ident(&req.name),
            lines.join(",\n")
        );
        let mut withs: Vec<String> = Vec::new();
        if !req.clustering.is_empty() {
            let order = req
                .clustering
                .iter()
                .map(|c| format!("{} {}", quote_ident(&c.name), c.order))
                .collect::<Vec<_>>()
                .join(", ");
            withs.push(format!("CLUSTERING ORDER BY ({order})"));
        }
        if let Some(comment) = &req.comment {
            if !comment.is_empty() {
                withs.push(format!("comment = '{}'", comment.replace('\'', "''")));
            }
        }
        if !withs.is_empty() {
            cql.push_str(&format!(" WITH {}", withs.join(" AND ")));
        }
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Create table failed", e))?;
        Ok(())
    }
}

/// Render a JSON scalar as a bare string for a CQL map literal value.
pub(super) fn json_scalar_str(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
