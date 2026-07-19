//! MySQL structure editing: native `ALTER TABLE` statement generation and
//! transactional apply for a batch of [`AlterOp`]s.

use sqlx::mysql::MySqlPool;

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::{driver_message, humanize};
use super::introspect::{ensure_schema_exists, table_meta};
use super::sql::{qualified, quote_ident};

// ---------------------------------------------------------------------------
// alter_table (native ALTER — NOT atomic across statements; see module docs)
// ---------------------------------------------------------------------------

/// Preview or apply a batch of structure edits via native `ALTER TABLE`
/// statements. Preview = the real ALTER SQL; apply = run them sequentially.
///
/// **Non-atomic caveat (module docs):** MySQL implicitly commits each DDL
/// statement, so a multi-statement batch is NOT rolled back on a mid-batch
/// failure. We validate ALL ops first (so a structurally-bad batch never
/// starts), then run each statement in order; on failure we report exactly
/// which statements already applied. pk-protection per the policy.
pub(super) async fn alter_table(
    pool: &MySqlPool,
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
    // Build each statement up front (so preview == apply). `SetNullable` needs
    // the column's current type (MySQL's MODIFY couples type + nullability), so
    // pass the introspected meta to the builder.
    let statements: Vec<String> = ops
        .iter()
        .map(|op| alter_statement(schema, &qualified, op, &meta))
        .collect::<Result<Vec<_>, _>>()?;

    if !apply {
        return Ok(AlterResult {
            statements,
            applied: false,
        });
    }

    // Run sequentially. No transaction wraps DDL (MySQL auto-commits each), so
    // on a mid-batch failure we surface which statements already landed.
    for (i, statement) in statements.iter().enumerate() {
        if let Err(err) = sqlx::query(statement).execute(pool).await {
            let applied_so_far = &statements[..i];
            let detail = if applied_so_far.is_empty() {
                "No statements were applied.".to_string()
            } else {
                format!(
                    "These statements already applied and were NOT rolled back \
                     (MySQL commits each DDL statement): {}.",
                    applied_so_far.join("; ")
                )
            };
            return Err(AppError::Database(format!(
                "{} The change failed at: {}. {}",
                humanize(&driver_message(&err)),
                statement,
                detail
            )));
        }
    }

    Ok(AlterResult {
        statements,
        applied: true,
    })
}

/// Validate each op against the introspected columns; pk columns are protected
/// from drop/retype (same as the SQLite/Postgres adapters).
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

/// The native `ALTER TABLE` statement for one op. MySQL specifics (module docs):
/// rename uses `RENAME COLUMN old TO new` (8.0+); type change uses `MODIFY
/// COLUMN col <newtype>`; nullable uses `MODIFY COLUMN col <currenttype>
/// [NOT NULL]` (MySQL couples type + nullability in MODIFY, so we read the
/// current type from `meta`); default uses `ALTER COLUMN col SET/DROP DEFAULT`.
/// `default` and type expressions are the verbatim SQL text the user supplied.
pub(super) fn alter_statement(
    schema: &str,
    qualified: &str,
    op: &AlterOp,
    meta: &TableMeta,
) -> Result<String, AppError> {
    let stmt = match op {
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
            "ALTER TABLE {qualified} MODIFY COLUMN {} {new_type}",
            quote_ident(column)
        ),
        AlterOp::SetNullable { column, nullable } => {
            // MODIFY rewrites the whole column definition, so we must repeat the
            // current type (else MySQL would default it). Read it from the meta.
            let current_type = meta
                .columns
                .iter()
                .find(|c| &c.name == column)
                .map(|c| c.data_type.clone())
                .ok_or_else(|| {
                    AppError::Database(format!(
                        "Cannot change nullability of '{column}': its current type is unknown."
                    ))
                })?;
            let null_clause = if *nullable { "NULL" } else { "NOT NULL" };
            format!(
                "ALTER TABLE {qualified} MODIFY COLUMN {} {current_type} {null_clause}",
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
        // MySQL has no standalone "set column comment": MODIFY COLUMN rewrites the
        // whole definition, so we must re-state the current type, nullability, and
        // default (from the introspected meta) or they'd be lost. `None` clears the
        // comment by emitting COMMENT ''.
        AlterOp::SetComment { column, comment } => {
            let col = meta
                .columns
                .iter()
                .find(|c| &c.name == column)
                .ok_or_else(|| {
                    AppError::Database(format!(
                        "Cannot set the comment of '{column}': the column is unknown."
                    ))
                })?;
            let mut s = format!(
                "ALTER TABLE {qualified} MODIFY COLUMN {} {}",
                quote_ident(column),
                col.data_type
            );
            if !col.nullable {
                s.push_str(" NOT NULL");
            }
            if let Some(default) = &col.default_value {
                s.push_str(&format!(" DEFAULT {default}"));
            }
            // MySQL string literal: double single quotes and escape backslashes.
            let text = comment.as_deref().unwrap_or("");
            let escaped = text.replace('\\', "\\\\").replace('\'', "''");
            s.push_str(&format!(" COMMENT '{escaped}'"));
            s
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
        // MySQL drops indexes with ALTER TABLE … DROP INDEX (index names are
        // table-local).
        AlterOp::DropIndex { name } => {
            format!("ALTER TABLE {qualified} DROP INDEX {}", quote_ident(name))
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
        // MySQL drops FK constraints with DROP FOREIGN KEY (by constraint name).
        AlterOp::DropForeignKey { name, .. } => {
            format!(
                "ALTER TABLE {qualified} DROP FOREIGN KEY {}",
                quote_ident(name)
            )
        }
    };
    Ok(stmt)
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

    fn meta_with(columns: Vec<ColumnInfo>) -> TableMeta {
        TableMeta {
            columns,
            ..Default::default()
        }
    }

    #[test]
    fn alter_statement_emits_native_mysql_alters() {
        let q = "`bytetable`.`books`";
        let meta = meta_with(vec![
            ColumnInfo {
                name: "price".into(),
                data_type: "decimal(10,2)".into(),
                nullable: true,
                pk: false,
                default_value: None,
                fk: None,
                comment: None,
            },
            ColumnInfo {
                name: "title".into(),
                data_type: "varchar(255)".into(),
                nullable: false,
                pk: false,
                default_value: None,
                fk: None,
                comment: None,
            },
        ]);

        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::AddColumn {
                    name: "note".into(),
                    data_type: "text".into(),
                    nullable: false,
                    default_value: Some("'n/a'".into()),
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` ADD COLUMN `note` text NOT NULL DEFAULT 'n/a'"
        );
        // RENAME COLUMN (MySQL 8.0+), not CHANGE.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::RenameColumn {
                    from: "a".into(),
                    to: "b".into()
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` RENAME COLUMN `a` TO `b`"
        );
        // Type change uses MODIFY COLUMN.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::ChangeType {
                    column: "price".into(),
                    new_type: "decimal(12,3)".into()
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` MODIFY COLUMN `price` decimal(12,3)"
        );
        // SetNullable couples the CURRENT type into MODIFY (SET NOT NULL).
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetNullable {
                    column: "title".into(),
                    nullable: false
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` MODIFY COLUMN `title` varchar(255) NOT NULL"
        );
        // SetNullable → NULL also repeats the current type.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetNullable {
                    column: "title".into(),
                    nullable: true
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` MODIFY COLUMN `title` varchar(255) NULL"
        );
        // SetNullable on an unknown column is a §5 error (type unknown).
        assert!(matches!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetNullable {
                    column: "ghost".into(),
                    nullable: true
                },
                &meta
            ),
            Err(AppError::Database(_))
        ));
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: Some("'pending'".into())
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` ALTER COLUMN `status` SET DEFAULT 'pending'"
        );
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: None
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` ALTER COLUMN `status` DROP DEFAULT"
        );
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::DropColumn {
                    name: "legacy".into()
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` DROP COLUMN `legacy`"
        );
        // SetComment re-states the current type + nullability (MODIFY rewrites the
        // whole definition) and appends the escaped COMMENT. `title` is
        // varchar(255) NOT NULL in the meta.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetComment {
                    column: "title".into(),
                    comment: Some("the book's title".into())
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` MODIFY COLUMN `title` varchar(255) NOT NULL COMMENT 'the book''s title'"
        );
        // Clearing the comment emits COMMENT '' (still preserving the definition).
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetComment {
                    column: "price".into(),
                    comment: None
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` MODIFY COLUMN `price` decimal(10,2) COMMENT ''"
        );
        // CREATE INDEX (unique).
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::AddIndex {
                    name: "idx_books_title".into(),
                    columns: vec!["title".into()],
                    unique: true,
                },
                &meta
            )
            .unwrap(),
            "CREATE UNIQUE INDEX `idx_books_title` ON `bytetable`.`books` (`title`)"
        );
        // DROP INDEX via ALTER TABLE.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::DropIndex {
                    name: "idx_old".into(),
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` DROP INDEX `idx_old`"
        );
        // ADD CONSTRAINT … FOREIGN KEY, ref table qualified with the schema.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::AddForeignKey {
                    name: "books_author_id_fkey".into(),
                    columns: vec!["author_id".into()],
                    ref_table: "authors".into(),
                    ref_columns: vec!["id".into()],
                    on_delete: Some("CASCADE".into()),
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` ADD CONSTRAINT `books_author_id_fkey` \
             FOREIGN KEY (`author_id`) REFERENCES `bytetable`.`authors` (`id`) ON DELETE CASCADE"
        );
        // DROP FOREIGN KEY (by constraint name).
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::DropForeignKey {
                    name: "books_author_id_fkey".into(),
                    columns: vec!["author_id".into()],
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` DROP FOREIGN KEY `books_author_id_fkey`"
        );
    }

    #[test]
    fn validate_ops_protects_pk_and_unknown_columns() {
        let meta = meta_with(vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "int".into(),
                nullable: false,
                pk: true,
                default_value: None,
                fk: None,
                comment: None,
            },
            ColumnInfo {
                name: "name".into(),
                data_type: "varchar(50)".into(),
                nullable: true,
                pk: false,
                default_value: None,
                fk: None,
                comment: None,
            },
        ]);
        // Dropping the pk → rejected.
        assert!(matches!(
            validate_ops(&meta, "t", &[AlterOp::DropColumn { name: "id".into() }]),
            Err(AppError::Database(_))
        ));
        // Retyping the pk → rejected.
        assert!(matches!(
            validate_ops(
                &meta,
                "t",
                &[AlterOp::ChangeType {
                    column: "id".into(),
                    new_type: "bigint".into()
                }]
            ),
            Err(AppError::Database(_))
        ));
        // Unknown target column → rejected.
        assert!(matches!(
            validate_ops(
                &meta,
                "t",
                &[AlterOp::DropColumn {
                    name: "ghost".into()
                }]
            ),
            Err(AppError::Database(_))
        ));
        // Renaming the pk is allowed (not drop/retype).
        assert!(validate_ops(
            &meta,
            "t",
            &[AlterOp::RenameColumn {
                from: "id".into(),
                to: "pk".into()
            }]
        )
        .is_ok());
        // Dropping a non-pk column is fine.
        assert!(validate_ops(
            &meta,
            "t",
            &[AlterOp::DropColumn {
                name: "name".into()
            }]
        )
        .is_ok());
    }
}
