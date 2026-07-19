//! MSSQL structure editing: native `ALTER TABLE` statement generation and
//! transactional apply for a batch of [`AlterOp`]s.

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::humanize;
use super::introspect::{ensure_schema_exists, table_meta};
use super::sql::{qualified, quote_ident};
use super::{exec_batch, TdsClient};

// ---------------------------------------------------------------------------
// alter_table (M8) — transactional apply (SQL Server DDL is transactional)
// ---------------------------------------------------------------------------

pub(super) async fn alter_table(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
    apply: bool,
) -> Result<AlterResult, AppError> {
    ensure_schema_exists(client, schema).await?;
    let meta = table_meta(client, schema, table).await?;

    if ops.is_empty() {
        return Err(AppError::Invalid(
            "No structure changes to apply.".to_string(),
        ));
    }
    validate_ops(&meta, table, ops)?;

    let statements: Vec<String> = ops
        .iter()
        .map(|op| alter_statement(schema, table, op, &meta))
        .collect::<Result<Vec<_>, _>>()?;

    if !apply {
        return Ok(AlterResult {
            statements,
            applied: false,
        });
    }

    exec_batch(client, "BEGIN TRANSACTION").await?;
    for statement in &statements {
        if let Err(err) = exec_batch(client, statement.clone()).await {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(AppError::Database(format!(
                "{} The change failed at: {}. The whole batch was rolled back.",
                humanize(&err.to_string()),
                statement
            )));
        }
    }
    exec_batch(client, "COMMIT").await?;

    Ok(AlterResult {
        statements,
        applied: true,
    })
}

/// Validate each op; pk columns are protected from drop/retype.
pub(super) fn validate_ops(meta: &TableMeta, table: &str, ops: &[AlterOp]) -> Result<(), AppError> {
    for op in ops {
        if let Some(column) = op.target_column() {
            let Some(info) = meta.columns.iter().find(|c| c.name == column) else {
                let listing: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
                return Err(AppError::Database(format!(
                    "Column '{column}' does not exist on '{table}' (columns: {}).",
                    listing.join(", ")
                )));
            };
            if info.pk && op.rejected_on_pk() {
                return Err(AppError::Database(format!(
                    "Column '{column}' is part of the primary key of '{table}' and cannot be \
                     dropped or retyped here."
                )));
            }
        }
    }
    Ok(())
}

/// The T-SQL statement (or small batch) for one op. Dialect specifics: `ADD`
/// (no `COLUMN`) for add; `sp_rename` for rename; `ALTER COLUMN` (with the
/// nullability repeated) for type/nullable; a drop-then-add default *constraint*
/// for defaults (T-SQL has no `SET DEFAULT`); `DROP INDEX … ON t` for indexes.
pub(super) fn alter_statement(
    schema: &str,
    table: &str,
    op: &AlterOp,
    meta: &TableMeta,
) -> Result<String, AppError> {
    let q = qualified(schema, table);
    let current_type = |column: &str| -> Option<String> {
        meta.columns
            .iter()
            .find(|c| c.name == column)
            .map(|c| c.data_type.clone())
    };
    let current_nullable = |column: &str| -> bool {
        meta.columns
            .iter()
            .find(|c| c.name == column)
            .map(|c| c.nullable)
            .unwrap_or(true)
    };
    let null_kw = |nullable: bool| if nullable { "NULL" } else { "NOT NULL" };

    let stmt = match op {
        AlterOp::AddColumn {
            name,
            data_type,
            nullable,
            default_value,
        } => {
            let mut s = format!("ALTER TABLE {q} ADD {} {data_type}", quote_ident(name));
            s.push_str(&format!(" {}", null_kw(*nullable)));
            if let Some(default) = default_value {
                s.push_str(&format!(" DEFAULT {default}"));
            }
            s
        }
        // sp_rename takes the OLD name schema.table.col and the NEW bare name.
        AlterOp::RenameColumn { from, to } => format!(
            "EXEC sp_rename '{}.{}.{}', '{}', 'COLUMN'",
            schema, table, from, to
        ),
        AlterOp::ChangeType { column, new_type } => format!(
            "ALTER TABLE {q} ALTER COLUMN {} {new_type} {}",
            quote_ident(column),
            null_kw(current_nullable(column))
        ),
        AlterOp::SetNullable { column, nullable } => {
            let ty = current_type(column).ok_or_else(|| {
                AppError::Database(format!(
                    "Cannot change nullability of '{column}': its current type is unknown."
                ))
            })?;
            format!(
                "ALTER TABLE {q} ALTER COLUMN {} {ty} {}",
                quote_ident(column),
                null_kw(*nullable)
            )
        }
        // T-SQL defaults are named constraints: drop any existing one for the
        // column, then (for Some) add a fresh unnamed default constraint.
        AlterOp::SetDefault {
            column,
            default_value,
        } => {
            let drop = drop_default_batch(schema, table, column);
            match default_value {
                Some(default) => format!(
                    "{drop} ALTER TABLE {q} ADD DEFAULT ({default}) FOR {};",
                    quote_ident(column)
                ),
                None => drop,
            }
        }
        AlterOp::DropColumn { name } => {
            format!("ALTER TABLE {q} DROP COLUMN {}", quote_ident(name))
        }
        // SQL Server column comments (MS_Description extended properties) are not
        // implemented yet; the editor doesn't offer them on MSSQL, so this arm is
        // a guard rather than a reachable path.
        AlterOp::SetComment { column, .. } => {
            return Err(AppError::Database(format!(
                "Editing the comment of '{column}' isn't supported for SQL Server yet."
            )));
        }
        AlterOp::AddIndex {
            name,
            columns,
            unique,
        } => format!(
            "CREATE {}INDEX {} ON {q} ({})",
            if *unique { "UNIQUE " } else { "" },
            quote_ident(name),
            quote_idents(columns)
        ),
        // T-SQL drops indexes with `DROP INDEX name ON table`.
        AlterOp::DropIndex { name } => {
            format!("DROP INDEX {} ON {q}", quote_ident(name))
        }
        AlterOp::AddForeignKey {
            name,
            columns,
            ref_table,
            ref_columns,
            on_delete,
        } => {
            let mut s = format!(
                "ALTER TABLE {q} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
                quote_ident(name),
                quote_idents(columns),
                quote_ident(schema),
                quote_ident(ref_table),
                quote_idents(ref_columns)
            );
            if let Some(action) = on_delete {
                s.push_str(&format!(" ON DELETE {action}"));
            }
            s
        }
        AlterOp::DropForeignKey { name, .. } => {
            format!("ALTER TABLE {q} DROP CONSTRAINT {}", quote_ident(name))
        }
    };
    Ok(stmt)
}

/// A T-SQL batch that drops the (auto-named) default constraint on a column, if
/// one exists — resolved dynamically by name from `sys.default_constraints`.
pub(super) fn drop_default_batch(schema: &str, table: &str, column: &str) -> String {
    let object = format!(
        "{}.{}",
        schema.replace('\'', "''"),
        table.replace('\'', "''")
    );
    let col = column.replace('\'', "''");
    format!(
        "DECLARE @df sysname; \
         SELECT @df = dc.name FROM sys.default_constraints dc \
         JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id \
         WHERE dc.parent_object_id = OBJECT_ID('{object}') AND c.name = '{col}'; \
         IF @df IS NOT NULL EXEC('ALTER TABLE {} DROP CONSTRAINT [' + @df + ']');",
        qualified(schema, table)
    )
}

/// Quote and comma-join identifiers (index / FK column lists).
pub(super) fn quote_idents(names: &[String]) -> String {
    names
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ")
}
