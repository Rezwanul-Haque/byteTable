//! ClickHouse structure editing: staged [`AlterOp`]s → `ALTER TABLE …`
//! statements. Column add/modify/drop/rename and data-skipping index add/drop
//! are native; ClickHouse has no foreign keys, so FK ops are a §5 error.
//!
//! Sort-key / engine / partition changes require a table rebuild in ClickHouse
//! and are intentionally NOT emitted here (the Structure view surfaces them
//! read-only) — only column and secondary-index edits are staged.
//!
//! No DDL transaction: ClickHouse `ALTER` auto-commits per statement (like
//! MySQL), so on apply a mid-batch failure leaves earlier statements applied and
//! the §5 error names the offending one.

use std::collections::HashMap;

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::AlterResult;
use crate::shared::error::AppError;

use super::http::ClickHouseHttp;
use super::sql::{qualified, quote_ident, to_clickhouse_type};
use super::value::{as_string, as_u64};

/// Preview (`apply == false`) or apply (`apply == true`) a batch of structure
/// edits against one ClickHouse table.
pub async fn alter_table(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
    apply: bool,
) -> Result<AlterResult, AppError> {
    let columns = column_map(http, schema, table).await?;
    let target = qualified(schema, table);

    let mut statements = Vec::with_capacity(ops.len());
    for op in ops {
        // Primary-key protection (retype / drop a sort-key column) — same guard
        // as the other engines, using the introspected pk membership.
        if let Some(col) = op.target_column() {
            if op.rejected_on_pk() && columns.get(col).map(|c| c.pk).unwrap_or(false) {
                return Err(AppError::Database(format!(
                    "'{col}' is part of the sort key (primary key); it cannot be dropped or retyped \
                     without rebuilding the table."
                )));
            }
        }
        statements.push(statement_for(&target, op, &columns)?);
    }

    if apply {
        for stmt in &statements {
            http.execute(stmt, &[("mutations_sync", "1".to_string())])
                .await?;
        }
    }
    Ok(AlterResult {
        statements,
        applied: apply,
    })
}

/// One introspected column: its ClickHouse type and whether it is a sort-key
/// (primary-key) member.
struct ColMeta {
    ty: String,
    pk: bool,
}

/// Build the ClickHouse `ALTER TABLE …` statement for one op.
fn statement_for(
    target: &str,
    op: &AlterOp,
    columns: &HashMap<String, ColMeta>,
) -> Result<String, AppError> {
    Ok(match op {
        AlterOp::AddColumn {
            name,
            data_type,
            nullable,
            default_value,
        } => {
            let ty = to_clickhouse_type(data_type, *nullable);
            let mut s = format!("ALTER TABLE {target} ADD COLUMN {} {ty}", quote_ident(name));
            if let Some(d) = default_value.as_deref().filter(|d| !d.is_empty()) {
                s.push_str(&format!(" DEFAULT {d}"));
            }
            s
        }
        AlterOp::RenameColumn { from, to } => format!(
            "ALTER TABLE {target} RENAME COLUMN {} TO {}",
            quote_ident(from),
            quote_ident(to)
        ),
        AlterOp::ChangeType { column, new_type } => format!(
            "ALTER TABLE {target} MODIFY COLUMN {} {}",
            quote_ident(column),
            // The type dropdown already emits ClickHouse types; pass through
            // (wrapping only if a generic type slipped in).
            to_clickhouse_type(new_type, false)
        ),
        AlterOp::SetNullable { column, nullable } => {
            // Re-state the column with/without the Nullable(...) wrapper around
            // its current base type.
            let current = columns
                .get(column)
                .map(|c| c.ty.as_str())
                .unwrap_or("String");
            let base = current
                .strip_prefix("Nullable(")
                .and_then(|s| s.strip_suffix(')'))
                .unwrap_or(current);
            let ty = if *nullable {
                format!("Nullable({base})")
            } else {
                base.to_string()
            };
            format!(
                "ALTER TABLE {target} MODIFY COLUMN {} {ty}",
                quote_ident(column)
            )
        }
        AlterOp::SetDefault {
            column,
            default_value,
        } => match default_value.as_deref().filter(|d| !d.is_empty()) {
            Some(d) => format!(
                "ALTER TABLE {target} MODIFY COLUMN {} DEFAULT {d}",
                quote_ident(column)
            ),
            None => format!(
                "ALTER TABLE {target} MODIFY COLUMN {} REMOVE DEFAULT",
                quote_ident(column)
            ),
        },
        AlterOp::DropColumn { name } => {
            format!("ALTER TABLE {target} DROP COLUMN {}", quote_ident(name))
        }
        AlterOp::SetComment { column, comment } => format!(
            "ALTER TABLE {target} COMMENT COLUMN {} {}",
            quote_ident(column),
            super::sql::ch_string_literal(comment.as_deref().unwrap_or(""))
        ),
        AlterOp::AddIndex {
            name,
            columns: cols,
            ..
        } => {
            // ClickHouse data-skipping index (no UNIQUE concept); a `minmax`
            // index is the sensible default the DDL generator also emits.
            let col_list = cols
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "ALTER TABLE {target} ADD INDEX {} ({col_list}) TYPE minmax GRANULARITY 4",
                quote_ident(name)
            )
        }
        AlterOp::DropIndex { name } => {
            format!("ALTER TABLE {target} DROP INDEX {}", quote_ident(name))
        }
        AlterOp::AddForeignKey { .. } | AlterOp::DropForeignKey { .. } => {
            return Err(AppError::Unsupported(
                "ClickHouse has no foreign keys.".into(),
            ))
        }
    })
}

/// Introspect a table's columns → `{ name: {type, pk} }`.
async fn column_map(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, ColMeta>, AppError> {
    let result = http
        .query(
            &format!(
                "SELECT name, type, is_in_primary_key FROM system.columns \
                 WHERE database = {} AND table = {}",
                super::sql::ch_string_literal(schema),
                super::sql::ch_string_literal(table)
            ),
            &[],
        )
        .await?;
    Ok(result
        .data
        .into_iter()
        .filter_map(|row| {
            let name = row.first().map(as_string)?;
            let ty = row.get(1).map(as_string).unwrap_or_default();
            let pk = row.get(2).and_then(as_u64).unwrap_or(0) == 1;
            Some((name, ColMeta { ty, pk }))
        })
        .collect())
}
