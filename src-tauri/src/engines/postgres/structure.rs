//! Postgres structure editing: native `ALTER TABLE` statement generation and
//! transactional apply for a batch of [`AlterOp`]s.

use sqlx::postgres::PgPool;

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::introspect::{ensure_schema_exists, table_meta};
use super::sql::{qualified, quote_ident};

// ---------------------------------------------------------------------------
// alter_table (native ALTER — no rebuild)
// ---------------------------------------------------------------------------

/// Preview or apply a batch of structure edits via native `ALTER TABLE`
/// statements (module docs). Preview = the real ALTER SQL; apply = run them in
/// a transaction, rolling back on any error. pk-protection per the policy.
pub(super) async fn alter_table(
    pool: &PgPool,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
    apply: bool,
) -> Result<AlterResult, AppError> {
    ensure_schema_exists(pool, schema).await?;
    let meta = table_meta(pool, schema, table).await?;

    if ops.is_empty() {
        return Err(AppError::Invalid(
            "No structure changes to apply.".to_string(),
        ));
    }
    validate_ops(&meta, table, ops)?;

    let qualified = qualified(schema, table);
    let statements: Vec<String> = ops
        .iter()
        .map(|op| alter_statement(schema, &qualified, op))
        .collect();

    if !apply {
        return Ok(AlterResult {
            statements,
            applied: false,
        });
    }

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    for statement in &statements {
        if let Err(err) = sqlx::query(statement).execute(&mut *tx).await {
            let _ = tx.rollback().await;
            return Err(map_query_error(err));
        }
    }
    tx.commit().await.map_err(map_query_error)?;

    Ok(AlterResult {
        statements,
        applied: true,
    })
}

/// Validate each op against the introspected columns; pk columns are protected
/// from drop/retype (same as the SQLite adapter).
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

/// The native `ALTER TABLE` statement for one op. Postgres supports every op
/// directly; `default` expressions are the verbatim SQL text the user supplied
/// (never re-quoted), consistent with `ColumnInfo.default_value`.
pub(super) fn alter_statement(schema: &str, qualified: &str, op: &AlterOp) -> String {
    match op {
        AlterOp::AddColumn {
            name,
            data_type,
            nullable,
            default_value,
        } => {
            let mut s = format!(
                "ALTER TABLE {qualified} ADD COLUMN {} {data_type}",
                quote_ident(name)
            );
            if !nullable {
                s.push_str(" NOT NULL");
            }
            if let Some(default) = default_value {
                s.push_str(&format!(" DEFAULT {default}"));
            }
            s
        }
        AlterOp::RenameColumn { from, to } => format!(
            "ALTER TABLE {qualified} RENAME COLUMN {} TO {}",
            quote_ident(from),
            quote_ident(to)
        ),
        AlterOp::ChangeType { column, new_type } => format!(
            "ALTER TABLE {qualified} ALTER COLUMN {} TYPE {new_type} USING {}::{new_type}",
            quote_ident(column),
            quote_ident(column)
        ),
        AlterOp::SetNullable { column, nullable } => {
            let action = if *nullable {
                "DROP NOT NULL"
            } else {
                "SET NOT NULL"
            };
            format!(
                "ALTER TABLE {qualified} ALTER COLUMN {} {action}",
                quote_ident(column)
            )
        }
        AlterOp::SetDefault {
            column,
            default_value,
        } => match default_value {
            Some(default) => format!(
                "ALTER TABLE {qualified} ALTER COLUMN {} SET DEFAULT {default}",
                quote_ident(column)
            ),
            None => format!(
                "ALTER TABLE {qualified} ALTER COLUMN {} DROP DEFAULT",
                quote_ident(column)
            ),
        },
        AlterOp::DropColumn { name } => {
            format!("ALTER TABLE {qualified} DROP COLUMN {}", quote_ident(name))
        }
        AlterOp::AddIndex {
            name,
            columns,
            unique,
        } => format!(
            "CREATE {}INDEX {} ON {qualified} ({})",
            if *unique { "UNIQUE " } else { "" },
            quote_ident(name),
            quote_idents(columns)
        ),
        // Postgres indexes live in a schema; drop by schema-qualified name.
        AlterOp::DropIndex { name } => {
            format!("DROP INDEX {}.{}", quote_ident(schema), quote_ident(name))
        }
        AlterOp::AddForeignKey {
            name,
            columns,
            ref_table,
            ref_columns,
            on_delete,
        } => {
            let mut s = format!(
                "ALTER TABLE {qualified} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
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
            format!(
                "ALTER TABLE {qualified} DROP CONSTRAINT {}",
                quote_ident(name)
            )
        }
    }
}

/// Quote and comma-join a list of identifiers (index / FK column lists).
pub(super) fn quote_idents(names: &[String]) -> String {
    names
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alter_statement_emits_native_postgres_alters() {
        let q = "\"bt\".\"books\"";
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::AddColumn {
                    name: "note".into(),
                    data_type: "text".into(),
                    nullable: false,
                    default_value: Some("'n/a'".into()),
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ADD COLUMN \"note\" text NOT NULL DEFAULT 'n/a'"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::RenameColumn {
                    from: "a".into(),
                    to: "b".into()
                }
            ),
            "ALTER TABLE \"bt\".\"books\" RENAME COLUMN \"a\" TO \"b\""
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::ChangeType {
                    column: "price".into(),
                    new_type: "numeric(10,2)".into()
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"price\" TYPE numeric(10,2) USING \"price\"::numeric(10,2)"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::SetNullable {
                    column: "email".into(),
                    nullable: false
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"email\" SET NOT NULL"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::SetNullable {
                    column: "email".into(),
                    nullable: true
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"email\" DROP NOT NULL"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: Some("'pending'".into())
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"status\" SET DEFAULT 'pending'"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: None
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"status\" DROP DEFAULT"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::DropColumn {
                    name: "legacy".into()
                }
            ),
            "ALTER TABLE \"bt\".\"books\" DROP COLUMN \"legacy\""
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::AddIndex {
                    name: "idx_books_email".into(),
                    columns: vec!["email".into()],
                    unique: true,
                }
            ),
            "CREATE UNIQUE INDEX \"idx_books_email\" ON \"bt\".\"books\" (\"email\")"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::DropIndex {
                    name: "idx_old".into(),
                }
            ),
            "DROP INDEX \"bt\".\"idx_old\""
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::AddForeignKey {
                    name: "books_author_id_fkey".into(),
                    columns: vec!["author_id".into()],
                    ref_table: "authors".into(),
                    ref_columns: vec!["id".into()],
                    on_delete: Some("CASCADE".into()),
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ADD CONSTRAINT \"books_author_id_fkey\" \
             FOREIGN KEY (\"author_id\") REFERENCES \"bt\".\"authors\" (\"id\") ON DELETE CASCADE"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::DropForeignKey {
                    name: "books_author_id_fkey".into(),
                    columns: vec!["author_id".into()],
                }
            ),
            "ALTER TABLE \"bt\".\"books\" DROP CONSTRAINT \"books_author_id_fkey\""
        );
    }
}
