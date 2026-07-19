//! SQLite structure editing (M8, DESIGN_SPEC §3.6): preview SQL generation and
//! transactional apply for a batch of [`AlterOp`]s. This is the ONLY place the
//! ALTER/rebuild SQL for SQLite lives (the layering rule — slices never write
//! SQL).
//!
//! # Preview vs. execution
//!
//! The "Review SQL" panel shows the *logical* intent of each op, engine-
//! agnostically, matching the prototype's statement list. For SQLite:
//!
//! | op             | preview statement                                              | how apply realizes it |
//! |----------------|----------------------------------------------------------------|-----------------------|
//! | AddColumn      | `ALTER TABLE "t" ADD COLUMN "c" TYPE [NOT NULL] [DEFAULT x]`    | native ADD COLUMN |
//! | RenameColumn   | `ALTER TABLE "t" RENAME COLUMN "a" TO "b"`                      | native RENAME COLUMN (≥3.25) |
//! | DropColumn     | `ALTER TABLE "t" DROP COLUMN "c"`                               | native DROP COLUMN (≥3.35) |
//! | ChangeType     | `ALTER TABLE "t" ALTER COLUMN "c" TYPE x`                       | table rebuild |
//! | SetNullable    | `ALTER TABLE "t" ALTER COLUMN "c" SET/DROP NOT NULL`           | table rebuild |
//! | SetDefault     | `ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT x / DROP DEFAULT` | table rebuild |
//! | AddIndex       | `CREATE [UNIQUE] INDEX "i" ON "t" (…)`                          | native CREATE INDEX |
//! | DropIndex      | `DROP INDEX "i"`                                                | native DROP INDEX |
//! | AddForeignKey  | `ALTER TABLE "t" ADD CONSTRAINT "f" FOREIGN KEY (…) REFERENCES …` | table rebuild |
//! | DropForeignKey | `ALTER TABLE "t" DROP CONSTRAINT "f"`                           | table rebuild |
//!
//! SQLite has NO native `ALTER COLUMN` (type/nullable/default) and no
//! `ADD/DROP CONSTRAINT` (foreign keys), so those are shown as their logical
//! intent but executed via the 12-step table rebuild ("Making Other Kinds Of
//! Table Schema Changes" in the SQLite docs). `CREATE`/`DROP INDEX` are native.
//! The preview SQL is therefore truthful about WHAT changes, not the literal
//! rebuild SQL.
//!
//! # Apply strategy
//!
//! - If EVERY op is native (add/rename/drop column, create/drop index) → run
//!   the native statements in order inside a transaction.
//! - If ANY op needs a rebuild (type/nullable/default change, or a foreign-key
//!   add/drop) → compute the target column set, foreign-key set, and user-index
//!   set (apply all ops in order to the introspected metadata), then do the
//!   metadata-reconstruction rebuild: build a fresh `CREATE TABLE` from the
//!   target columns + target foreign keys, copy data across with column mapping,
//!   swap, recreate the target user indexes. With FK enforcement originally on,
//!   `foreign_key_check` runs inside the transaction before commit so a
//!   violation rolls the whole rebuild back.
//!
//! # Rebuild safety guard
//!
//! Metadata reconstruction CANNOT preserve CHECK constraints, generated/virtual
//! columns, AUTOINCREMENT, WITHOUT ROWID, COLLATE clauses, or triggers. Before a
//! rebuild we inspect the original `CREATE TABLE` DDL and the table's triggers;
//! if any of those features are present we REFUSE with a §5 message rather than
//! silently dropping them. Native-only batches are unaffected (they preserve the
//! table definition by construction).

use std::time::Duration;

use rusqlite::Connection;

use super::error::map_query_error;
use super::introspect::{ensure_schema_exists, table_ddl, table_meta_blocking};
use super::sql::quote_ident;
use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{AlterResult, ColumnInfo, ForeignKeyInfo, IndexInfo, TableMeta};
use crate::shared::error::AppError;

/// Preview or apply a batch of structure edits on one SQLite table.
///
/// `apply == false` returns the statement strings only (no mutation).
/// `apply == true` executes the batch transactionally, rolling back fully on
/// any error. See the module docs for the strategy and safety guard.
pub fn alter_table_blocking(
    conn: &Connection,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
    apply: bool,
) -> Result<AlterResult, AppError> {
    // Existence + the real column set (also gives us pk membership for the
    // protection check). Unknown schema/table produce the §5 messages.
    ensure_schema_exists(conn, schema)?;
    let meta = table_meta_blocking(conn, schema, table)?;

    if ops.is_empty() {
        return Err(AppError::Invalid(
            "No structure changes to apply.".to_string(),
        ));
    }

    // Validate every op against the real columns and the pk-protection rule
    // (applies to BOTH preview and apply, so the user sees the error before
    // committing). This also rejects renaming/typing a column that does not
    // exist.
    validate_ops(&meta, table, ops)?;

    // The statement strings shown in "Review SQL" — the same for preview and
    // apply (logical intent; see module docs).
    let statements: Vec<String> = ops.iter().map(|op| preview_statement(table, op)).collect();

    if !apply {
        return Ok(AlterResult {
            statements,
            applied: false,
        });
    }

    if ops.iter().all(AlterOp::is_native) {
        apply_native(conn, schema, table, ops)?;
    } else {
        apply_with_rebuild(conn, schema, table, &meta, ops)?;
    }

    Ok(AlterResult {
        statements,
        applied: true,
    })
}

// ---------------------------------------------------------------------------
// Validation (preview + apply)
// ---------------------------------------------------------------------------

/// Validate each op against the introspected columns: the targeted column must
/// exist, and pk columns are protected from drop/retype. A §5 error otherwise.
fn validate_ops(meta: &TableMeta, table: &str, ops: &[AlterOp]) -> Result<(), AppError> {
    // The columns an index / FK may reference: the introspected set with this
    // batch's column ops folded in (adds, renames, drops), since the rebuild
    // applies those before recreating indexes / FKs — so an index or FK may
    // reference a column added or renamed in the same batch.
    let mut available: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    for op in ops {
        match op {
            AlterOp::AddColumn { name, .. } => available.push(name.clone()),
            AlterOp::DropColumn { name } => available.retain(|c| c != name),
            AlterOp::RenameColumn { from, to } => {
                if let Some(slot) = available.iter_mut().find(|c| *c == from) {
                    *slot = to.clone();
                }
            }
            _ => {}
        }
    }
    let exists = |c: &str| available.iter().any(|a| a == c);
    let listing = || available.join(", ");

    for op in ops {
        if let Some(column) = op.target_column() {
            let Some(info) = meta.columns.iter().find(|c| c.name == column) else {
                let cols: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
                return Err(AppError::Database(format!(
                    "Column '{column}' does not exist on '{table}' (columns: {}).",
                    cols.join(", ")
                )));
            };
            if info.pk && op.rejected_on_pk() {
                return Err(AppError::Database(format!(
                    "Column '{column}' is part of the primary key of '{table}' and \
                     cannot be dropped or retyped."
                )));
            }
        }
        match op {
            AlterOp::AddIndex { columns, name, .. } => {
                if columns.is_empty() {
                    return Err(AppError::Invalid(format!(
                        "Index '{name}' must cover at least one column."
                    )));
                }
                for c in columns {
                    if !exists(c) {
                        return Err(AppError::Database(format!(
                            "Cannot index '{c}': no such column on '{table}' (columns: {}).",
                            listing()
                        )));
                    }
                }
            }
            AlterOp::AddForeignKey {
                columns,
                ref_columns,
                ..
            } => {
                if columns.is_empty() || ref_columns.is_empty() {
                    return Err(AppError::Invalid(
                        "A foreign key needs at least one local and one referenced column."
                            .to_string(),
                    ));
                }
                if columns.len() != ref_columns.len() {
                    return Err(AppError::Invalid(
                        "A foreign key's local and referenced columns must match in count."
                            .to_string(),
                    ));
                }
                for c in columns {
                    if !exists(c) {
                        return Err(AppError::Database(format!(
                            "Cannot reference '{c}' in a foreign key: no such column on \
                             '{table}' (columns: {}).",
                            listing()
                        )));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Preview statement generation (logical intent)
// ---------------------------------------------------------------------------

/// The "Review SQL" statement for one op (logical intent; see module docs).
fn preview_statement(table: &str, op: &AlterOp) -> String {
    let t = quote_ident(table);
    match op {
        AlterOp::AddColumn {
            name,
            data_type,
            nullable,
            default_value,
        } => {
            let mut s = format!(
                "ALTER TABLE {t} ADD COLUMN {} {data_type}",
                quote_ident(name)
            );
            if !*nullable {
                s.push_str(" NOT NULL");
            }
            if let Some(default) = default_value {
                s.push_str(&format!(" DEFAULT {default}"));
            }
            s
        }
        AlterOp::RenameColumn { from, to } => format!(
            "ALTER TABLE {t} RENAME COLUMN {} TO {}",
            quote_ident(from),
            quote_ident(to)
        ),
        AlterOp::ChangeType { column, new_type } => format!(
            "ALTER TABLE {t} ALTER COLUMN {} TYPE {new_type}",
            quote_ident(column)
        ),
        AlterOp::SetNullable { column, nullable } => format!(
            "ALTER TABLE {t} ALTER COLUMN {} {}",
            quote_ident(column),
            if *nullable {
                "DROP NOT NULL"
            } else {
                "SET NOT NULL"
            }
        ),
        AlterOp::SetDefault {
            column,
            default_value,
        } => match default_value {
            Some(default) => format!(
                "ALTER TABLE {t} ALTER COLUMN {} SET DEFAULT {default}",
                quote_ident(column)
            ),
            None => format!(
                "ALTER TABLE {t} ALTER COLUMN {} DROP DEFAULT",
                quote_ident(column)
            ),
        },
        AlterOp::DropColumn { name } => {
            format!("ALTER TABLE {t} DROP COLUMN {}", quote_ident(name))
        }
        // SQLite has no column comments; the editor never offers this on SQLite,
        // but the preview must still render something if one is ever staged.
        AlterOp::SetComment { column, .. } => {
            format!(
                "-- SQLite has no comment for column {}",
                quote_ident(column)
            )
        }
        AlterOp::AddIndex {
            name,
            columns,
            unique,
        } => format!(
            "CREATE {}INDEX {} ON {t} ({})",
            if *unique { "UNIQUE " } else { "" },
            quote_ident(name),
            quote_idents(columns)
        ),
        AlterOp::DropIndex { name } => format!("DROP INDEX {}", quote_ident(name)),
        AlterOp::AddForeignKey {
            name,
            columns,
            ref_table,
            ref_columns,
            on_delete,
        } => {
            let mut s = format!(
                "ALTER TABLE {t} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
                quote_ident(name),
                quote_idents(columns),
                quote_ident(ref_table),
                quote_idents(ref_columns)
            );
            if let Some(action) = on_delete {
                s.push_str(&format!(" ON DELETE {action}"));
            }
            s
        }
        AlterOp::DropForeignKey { name, .. } => {
            format!("ALTER TABLE {t} DROP CONSTRAINT {}", quote_ident(name))
        }
    }
}

/// Quote and comma-join a list of identifiers (index / FK column lists).
fn quote_idents(names: &[String]) -> String {
    names
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------
// Native apply (add / rename / drop column, create / drop index)
// ---------------------------------------------------------------------------

/// The native `ALTER TABLE` statement actually executed for a native op.
/// Differs from the preview only in being engine-runnable (it is, for these).
fn native_exec_statement(schema: &str, table: &str, op: &AlterOp) -> String {
    let t = format!("{}.{}", quote_ident(schema), quote_ident(table));
    match op {
        AlterOp::AddColumn {
            name,
            data_type,
            nullable,
            default_value,
        } => {
            // SQLite requires a type token for ADD COLUMN with constraints;
            // fall back to no type only when none was given AND no constraints.
            let mut s = format!("ALTER TABLE {t} ADD COLUMN {}", quote_ident(name));
            if !data_type.is_empty() {
                s.push(' ');
                s.push_str(data_type);
            }
            if !*nullable {
                s.push_str(" NOT NULL");
            }
            if let Some(default) = default_value {
                s.push_str(&format!(" DEFAULT {default}"));
            }
            s
        }
        AlterOp::RenameColumn { from, to } => format!(
            "ALTER TABLE {t} RENAME COLUMN {} TO {}",
            quote_ident(from),
            quote_ident(to)
        ),
        AlterOp::DropColumn { name } => {
            format!("ALTER TABLE {t} DROP COLUMN {}", quote_ident(name))
        }
        AlterOp::AddIndex {
            name,
            columns,
            unique,
        } => format!(
            "CREATE {}INDEX {}.{} ON {} ({})",
            if *unique { "UNIQUE " } else { "" },
            quote_ident(schema),
            quote_ident(name),
            quote_ident(table),
            quote_idents(columns)
        ),
        AlterOp::DropIndex { name } => {
            format!("DROP INDEX {}.{}", quote_ident(schema), quote_ident(name))
        }
        // Rebuild-only ops (type/nullable/default, foreign keys) never reach here.
        _ => unreachable!("native_exec_statement called on a non-native op"),
    }
}

/// Run a batch of native ALTERs in order inside a transaction. Any error rolls
/// the whole batch back (the table is untouched) and surfaces §5-style.
fn apply_native(
    conn: &Connection,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
) -> Result<(), AppError> {
    let tx = Transaction::begin(conn)?;
    for op in ops {
        let sql = native_exec_statement(schema, table, op);
        conn.execute_batch(&sql)
            .map_err(|err| map_query_error(conn, err))?;
    }
    tx.commit()
}

// ---------------------------------------------------------------------------
// Rebuild apply (type / nullable / default changes)
// ---------------------------------------------------------------------------

/// SQLite features that a metadata-reconstruction rebuild CANNOT preserve. If
/// the original DDL contains any (or the table has triggers), we refuse rather
/// than silently drop them.
fn rebuild_unsupported_feature(ddl: &str, has_triggers: bool) -> Option<&'static str> {
    if has_triggers {
        return Some("a trigger");
    }
    // Crude but conservative scan of the upper-cased DDL. False positives only
    // make us refuse a rebuild we might have managed — the safe direction.
    let upper = ddl.to_uppercase();
    // Strip string/identifier-quoted regions out so a column NAMED e.g.
    // "check_in" or a default string 'AS IS' does not trip the scan.
    let stripped = strip_quoted(&upper);
    let checks = [
        ("CHECK", "a CHECK constraint"),
        (" AS ", "a generated column"),
        ("GENERATED", "a generated column"),
        ("AUTOINCREMENT", "AUTOINCREMENT"),
        ("WITHOUT ROWID", "WITHOUT ROWID"),
        ("COLLATE", "a COLLATE clause"),
    ];
    for (needle, label) in checks {
        if stripped.contains(needle) {
            return Some(label);
        }
    }
    None
}

/// Remove the contents of single-quoted strings and double-quoted / backtick /
/// bracket identifiers from `sql`, leaving placeholders, so a keyword scan does
/// not match text inside a quoted name or literal. Operates on already
/// upper-cased input.
fn strip_quoted(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                // Single-quoted string literal (SQLite doubles '' to escape).
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n == '\'' {
                        if chars.peek() == Some(&'\'') {
                            chars.next();
                            continue;
                        }
                        break;
                    }
                }
                out.push(' ');
            }
            '"' => {
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n == '"' {
                        break;
                    }
                }
                out.push(' ');
            }
            '`' => {
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n == '`' {
                        break;
                    }
                }
                out.push(' ');
            }
            '[' => {
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n == ']' {
                        break;
                    }
                }
                out.push(' ');
            }
            other => out.push(other),
        }
    }
    out
}

/// Whether `table` has any triggers in `schema`.
fn table_has_triggers(conn: &Connection, schema: &str, table: &str) -> Result<bool, AppError> {
    let count: i64 = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM {}.sqlite_schema \
                 WHERE type = 'trigger' AND tbl_name = ?1",
                quote_ident(schema)
            ),
            [table],
            |row| row.get(0),
        )
        .map_err(|err| map_query_error(conn, err))?;
    Ok(count > 0)
}

/// One column in the target (post-batch) table, with the original name it maps
/// from (for the data-copy SELECT). `from` is `None` for a freshly added
/// column (its value comes from the default / NULL).
#[derive(Debug, Clone)]
struct TargetColumn {
    info: ColumnInfo,
    /// The original column name to copy data from, or `None` for an added column.
    from: Option<String>,
}

/// Apply all ops in order to the introspected columns to compute the target
/// column set, tracking the original→target name mapping for the data copy.
/// Validation already proved every targeted column exists.
fn compute_target_columns(
    meta: &TableMeta,
    ops: &[AlterOp],
) -> Result<Vec<TargetColumn>, AppError> {
    let mut cols: Vec<TargetColumn> = meta
        .columns
        .iter()
        .map(|c| TargetColumn {
            info: c.clone(),
            from: Some(c.name.clone()),
        })
        .collect();

    let position =
        |cols: &[TargetColumn], name: &str| cols.iter().position(|c| c.info.name == name);

    for op in ops {
        match op {
            AlterOp::AddColumn {
                name,
                data_type,
                nullable,
                default_value,
            } => {
                if position(&cols, name).is_some() {
                    return Err(AppError::Database(format!(
                        "Column '{name}' already exists."
                    )));
                }
                cols.push(TargetColumn {
                    info: ColumnInfo {
                        name: name.clone(),
                        data_type: data_type.clone(),
                        nullable: *nullable,
                        pk: false,
                        default_value: default_value.clone(),
                        fk: None,
                        comment: None,
                    },
                    from: None,
                });
            }
            AlterOp::RenameColumn { from, to } => {
                if position(&cols, to).is_some() {
                    return Err(AppError::Database(format!("Column '{to}' already exists.")));
                }
                let idx = position(&cols, from).ok_or_else(|| {
                    AppError::Database(format!("Column '{from}' does not exist."))
                })?;
                cols[idx].info.name = to.clone();
            }
            AlterOp::ChangeType { column, new_type } => {
                let idx = require_idx(&cols, column)?;
                cols[idx].info.data_type = new_type.clone();
            }
            AlterOp::SetNullable { column, nullable } => {
                let idx = require_idx(&cols, column)?;
                cols[idx].info.nullable = *nullable;
            }
            AlterOp::SetDefault {
                column,
                default_value,
            } => {
                let idx = require_idx(&cols, column)?;
                cols[idx].info.default_value = default_value.clone();
            }
            AlterOp::DropColumn { name } => {
                let idx = require_idx(&cols, name)?;
                cols.remove(idx);
            }
            // Index / foreign-key ops do not change the column set; they are
            // realized separately (target index set + rebuilt FK clauses).
            // SetComment is a no-op on SQLite (no column comments).
            AlterOp::SetComment { .. }
            | AlterOp::AddIndex { .. }
            | AlterOp::DropIndex { .. }
            | AlterOp::AddForeignKey { .. }
            | AlterOp::DropForeignKey { .. } => {}
        }
    }

    if cols.is_empty() {
        return Err(AppError::Database(
            "The changes would leave the table with no columns.".to_string(),
        ));
    }
    Ok(cols)
}

fn require_idx(cols: &[TargetColumn], name: &str) -> Result<usize, AppError> {
    cols.iter()
        .position(|c| c.info.name == name)
        .ok_or_else(|| AppError::Database(format!("Column '{name}' does not exist.")))
}

/// Whether a [`DropForeignKey`](AlterOp::DropForeignKey) op identifies `fk`.
/// Server-introspected FKs carry a name (match on it); SQLite's do not, so we
/// fall back to matching the local-column set.
fn fk_matches(fk: &ForeignKeyInfo, name: &str, columns: &[String]) -> bool {
    if let Some(n) = &fk.name {
        if !name.is_empty() && n == name {
            return true;
        }
    }
    !columns.is_empty() && fk.columns == columns
}

/// The foreign keys the rebuilt table should carry: the introspected set plus
/// any `AddForeignKey` in the batch, minus any `DropForeignKey`.
fn compute_target_foreign_keys(meta: &TableMeta, ops: &[AlterOp]) -> Vec<ForeignKeyInfo> {
    let mut fks: Vec<ForeignKeyInfo> = meta.foreign_keys.clone();
    for op in ops {
        match op {
            AlterOp::AddForeignKey {
                name,
                columns,
                ref_table,
                ref_columns,
                on_delete,
            } => fks.push(ForeignKeyInfo {
                name: Some(name.clone()),
                columns: columns.clone(),
                ref_table: ref_table.clone(),
                ref_columns: ref_columns.clone(),
                on_delete: on_delete.clone(),
                on_update: None,
            }),
            AlterOp::DropForeignKey { name, columns } => {
                fks.retain(|fk| !fk_matches(fk, name, columns));
            }
            _ => {}
        }
    }
    fks
}

/// The user-created indexes (SQLite `origin == "c"`) the rebuild should
/// recreate: the introspected user indexes plus any `AddIndex`, minus any
/// `DropIndex` (by name). The implicit pk / UNIQUE-constraint indexes are
/// reconstructed by the fresh `CREATE TABLE` itself, so they are excluded here.
fn compute_target_indexes(meta: &TableMeta, ops: &[AlterOp]) -> Vec<IndexInfo> {
    let mut indexes: Vec<IndexInfo> = meta
        .indexes
        .iter()
        .filter(|ix| ix.origin.as_deref() == Some("c"))
        .cloned()
        .collect();
    for op in ops {
        match op {
            AlterOp::AddIndex {
                name,
                columns,
                unique,
            } => indexes.push(IndexInfo {
                name: name.clone(),
                columns: columns.clone(),
                unique: *unique,
                primary: false,
                origin: Some("c".to_string()),
            }),
            AlterOp::DropIndex { name } => indexes.retain(|ix| &ix.name != name),
            _ => {}
        }
    }
    indexes
}

/// The metadata-reconstruction rebuild. Wrapped in a transaction with the
/// documented `PRAGMA legacy_alter_table` / foreign-key handling; any error
/// rolls back so the table is untouched.
fn apply_with_rebuild(
    conn: &Connection,
    schema: &str,
    table: &str,
    meta: &TableMeta,
    ops: &[AlterOp],
) -> Result<(), AppError> {
    // Safety guard: refuse if the table uses features a rebuild cannot
    // reconstruct (see module docs). Inspect the original DDL + triggers.
    let ddl = table_ddl(conn, schema, table)?.ok_or_else(|| {
        AppError::Database(format!(
            "Cannot edit the structure of '{table}': its CREATE TABLE definition is unavailable."
        ))
    })?;
    let has_triggers = table_has_triggers(conn, schema, table)?;
    if let Some(feature) = rebuild_unsupported_feature(&ddl, has_triggers) {
        return Err(AppError::Unsupported(format!(
            "Changing the type, nullability, or default of a column on '{table}' isn't \
             supported yet because the table uses {feature}; the table would lose that \
             definition."
        )));
    }

    let target = compute_target_columns(meta, ops)?;
    let target_fks = compute_target_foreign_keys(meta, ops);
    let target_indexes = compute_target_indexes(meta, ops);

    // SQLite's documented procedure: foreign_keys must be OFF for the rebuild,
    // and it cannot be toggled inside a transaction. Read the current setting,
    // turn it off, do the rebuild in a transaction, then restore it and run
    // foreign_key_check. The RENAME can't rewrite references in other objects'
    // SQL here: the temp table has a unique private name nothing else points
    // at, and the original is dropped before the RENAME — so no reference
    // rewriting is triggered and `legacy_alter_table` is unnecessary.
    let fk_on: bool = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
        .map(|v| v != 0)
        .map_err(|err| map_query_error(conn, err))?;
    if fk_on {
        conn.execute_batch("PRAGMA foreign_keys = OFF")
            .map_err(|err| map_query_error(conn, err))?;
    }

    // The rebuild runs foreign_key_check inside the transaction (before commit)
    // when `fk_on`, so a violation rolls the whole rebuild back.
    let rebuild = rebuild_in_transaction(
        conn,
        schema,
        table,
        &target,
        &target_fks,
        &target_indexes,
        fk_on,
    );

    // Always attempt to restore the fk setting, regardless of the rebuild
    // outcome.
    let restore = if fk_on {
        conn.execute_batch("PRAGMA foreign_keys = ON")
            .map_err(|err| map_query_error(conn, err))
    } else {
        Ok(())
    };

    rebuild?;
    restore?;

    Ok(())
}

/// The transactional core of the rebuild: create the new table, copy data,
/// drop the old one, rename, recreate indexes. Any error rolls back.
fn rebuild_in_transaction(
    conn: &Connection,
    schema: &str,
    table: &str,
    target: &[TargetColumn],
    target_fks: &[ForeignKeyInfo],
    target_indexes: &[IndexInfo],
    fk_on: bool,
) -> Result<(), AppError> {
    let tx = Transaction::begin(conn)?;

    let tmp_name = format!("__bytetable_rebuild_{table}");
    let qualified_tmp = format!("{}.{}", quote_ident(schema), quote_ident(&tmp_name));
    let qualified_orig = format!("{}.{}", quote_ident(schema), quote_ident(table));

    // 1. Create the new table from the target columns + the target fks.
    let create_sql = build_create_table(&qualified_tmp, target, target_fks);
    conn.execute_batch(&create_sql)
        .map_err(|err| map_query_error(conn, err))?;

    // 2. Copy data: INSERT INTO tmp(target cols that map from an original col)
    //    SELECT those original cols FROM orig. Added columns are omitted so
    //    their DEFAULT / NULL applies.
    let mapped: Vec<&TargetColumn> = target.iter().filter(|c| c.from.is_some()).collect();
    if !mapped.is_empty() {
        let dest: Vec<String> = mapped.iter().map(|c| quote_ident(&c.info.name)).collect();
        let src: Vec<String> = mapped
            .iter()
            .map(|c| quote_ident(c.from.as_deref().expect("mapped has from")))
            .collect();
        let copy_sql = format!(
            "INSERT INTO {qualified_tmp} ({}) SELECT {} FROM {qualified_orig}",
            dest.join(", "),
            src.join(", ")
        );
        conn.execute_batch(&copy_sql)
            .map_err(|err| map_query_error(conn, err))?;
    }

    // 3. Drop the original, 4. rename tmp to the original name.
    conn.execute_batch(&format!("DROP TABLE {qualified_orig}"))
        .map_err(|err| map_query_error(conn, err))?;
    conn.execute_batch(&format!(
        "ALTER TABLE {qualified_tmp} RENAME TO {}",
        quote_ident(table)
    ))
    .map_err(|err| map_query_error(conn, err))?;

    // 5. Recreate the target user indexes (introspected + staged adds − drops),
    //    skipping any whose columns no longer all exist (e.g. a dropped column).
    let target_names: Vec<&str> = target.iter().map(|c| c.info.name.as_str()).collect();
    for index in target_indexes {
        if index.columns.is_empty()
            || !index
                .columns
                .iter()
                .all(|c| target_names.contains(&c.as_str()))
        {
            continue;
        }
        let cols: Vec<String> = index.columns.iter().map(|c| quote_ident(c)).collect();
        let unique = if index.unique { "UNIQUE " } else { "" };
        let create_index = format!(
            "CREATE {unique}INDEX {}.{} ON {} ({})",
            quote_ident(schema),
            quote_ident(&index.name),
            quote_ident(table),
            cols.join(", ")
        );
        conn.execute_batch(&create_index)
            .map_err(|err| map_query_error(conn, err))?;
    }

    // 6. If FK enforcement was originally on, confirm the rebuilt table did not
    //    break referential integrity BEFORE committing (foreign_key_check is
    //    independent of the enforcement pragma, so it runs while it is off).
    //    A violation returns Err, and the Transaction guard rolls back on drop —
    //    so the table is untouched, which the post-commit check could not
    //    guarantee.
    if fk_on {
        let mut stmt = conn
            .prepare(&format!(
                "PRAGMA {}.foreign_key_check({})",
                quote_ident(schema),
                quote_ident(table)
            ))
            .map_err(|err| map_query_error(conn, err))?;
        let mut rows = stmt.query([]).map_err(|err| map_query_error(conn, err))?;
        if rows
            .next()
            .map_err(|err| map_query_error(conn, err))?
            .is_some()
        {
            return Err(AppError::Database(format!(
                "The structure change on '{table}' would violate a foreign-key \
                 constraint; no changes were applied."
            )));
        }
    }

    tx.commit()
}

/// Build a `CREATE TABLE` for the rebuilt table from the target columns + the
/// target foreign keys (introspected set plus staged adds, minus drops).
/// Composite primary keys become a table-level `PRIMARY KEY (...)` clause; a
/// single pk column is declared inline.
fn build_create_table(
    qualified: &str,
    target: &[TargetColumn],
    foreign_keys: &[ForeignKeyInfo],
) -> String {
    let pk_columns: Vec<&str> = target
        .iter()
        .filter(|c| c.info.pk)
        .map(|c| c.info.name.as_str())
        .collect();
    let inline_pk = pk_columns.len() == 1;

    let mut defs: Vec<String> = Vec::with_capacity(target.len());
    for col in target {
        let mut def = quote_ident(&col.info.name);
        if !col.info.data_type.is_empty() {
            def.push(' ');
            def.push_str(&col.info.data_type);
        }
        if inline_pk && col.info.pk {
            def.push_str(" PRIMARY KEY");
        }
        // NOT NULL: a single inline pk implies NOT NULL semantics for INTEGER
        // pks; emit the declared constraint regardless (harmless, truthful).
        if !(col.info.nullable || (inline_pk && col.info.pk)) {
            def.push_str(" NOT NULL");
        }
        if let Some(default) = &col.info.default_value {
            def.push_str(&format!(" DEFAULT {default}"));
        }
        defs.push(def);
    }

    if !inline_pk && !pk_columns.is_empty() {
        let cols: Vec<String> = pk_columns.iter().map(|c| quote_ident(c)).collect();
        defs.push(format!("PRIMARY KEY ({})", cols.join(", ")));
    }

    // Foreign keys from the original table, dropping any whose local columns no
    // longer exist (e.g. a dropped fk column).
    let target_names: Vec<&str> = target.iter().map(|c| c.info.name.as_str()).collect();
    for fk in foreign_keys {
        if fk.columns.is_empty()
            || !fk
                .columns
                .iter()
                .all(|c| target_names.contains(&c.as_str()))
        {
            continue;
        }
        let local: Vec<String> = fk.columns.iter().map(|c| quote_ident(c)).collect();
        let refd: Vec<String> = fk.ref_columns.iter().map(|c| quote_ident(c)).collect();
        let mut clause = format!(
            "FOREIGN KEY ({}) REFERENCES {}",
            local.join(", "),
            quote_ident(&fk.ref_table)
        );
        if !refd.is_empty() && fk.ref_columns.iter().all(|c| !c.is_empty()) {
            clause.push_str(&format!(" ({})", refd.join(", ")));
        }
        if let Some(on_delete) = &fk.on_delete {
            clause.push_str(&format!(" ON DELETE {on_delete}"));
        }
        if let Some(on_update) = &fk.on_update {
            clause.push_str(&format!(" ON UPDATE {on_update}"));
        }
        defs.push(clause);
    }

    format!("CREATE TABLE {qualified} (\n  {}\n)", defs.join(",\n  "))
}

// ---------------------------------------------------------------------------
// Transaction guard (rollback on drop unless committed)
// ---------------------------------------------------------------------------

/// A minimal RAII transaction over the shared `&Connection`. `rusqlite`'s own
/// `Transaction` borrows the connection mutably, which we cannot get through
/// the `with_conn` `&Connection`, so we drive `BEGIN` / `COMMIT` / `ROLLBACK`
/// by hand and roll back on drop if not committed — guaranteeing the table is
/// untouched on any early return / error.
struct Transaction<'c> {
    conn: &'c Connection,
    committed: bool,
}

impl<'c> Transaction<'c> {
    fn begin(conn: &'c Connection) -> Result<Self, AppError> {
        // Busy timeout so a transient lock surfaces as a clear error rather
        // than an immediate "database is locked".
        let _ = conn.busy_timeout(Duration::from_secs(5));
        conn.execute_batch("BEGIN")
            .map_err(|err| map_query_error(conn, err))?;
        Ok(Self {
            conn,
            committed: false,
        })
    }

    fn commit(mut self) -> Result<(), AppError> {
        self.conn
            .execute_batch("COMMIT")
            .map_err(|err| map_query_error(self.conn, err))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if !self.committed {
            // Best effort: if rollback fails there is nothing more we can do,
            // and the connection will report the broken state on next use.
            let _ = self.conn.execute_batch("ROLLBACK");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// An in-memory connection seeded with the given SQL batch.
    fn db(setup: &str) -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(setup).expect("seed db");
        conn
    }

    /// The column names of `table` after the fact, in order.
    fn column_names(conn: &Connection, table: &str) -> Vec<String> {
        table_meta_blocking(conn, "main", table)
            .expect("table meta")
            .columns
            .into_iter()
            .map(|c| c.name)
            .collect()
    }

    fn column<'a>(meta: &'a TableMeta, name: &str) -> &'a ColumnInfo {
        meta.columns
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("column {name} not found"))
    }

    fn meta(conn: &Connection, table: &str) -> TableMeta {
        table_meta_blocking(conn, "main", table).expect("table meta")
    }

    fn preview(conn: &Connection, table: &str, ops: &[AlterOp]) -> Result<Vec<String>, AppError> {
        alter_table_blocking(conn, "main", table, ops, false).map(|r| {
            assert!(!r.applied, "preview must not apply");
            r.statements
        })
    }

    fn apply(conn: &Connection, table: &str, ops: &[AlterOp]) -> Result<(), AppError> {
        let r = alter_table_blocking(conn, "main", table, ops, true)?;
        assert!(r.applied, "apply must report applied");
        Ok(())
    }

    // -- preview generation -------------------------------------------------

    #[test]
    fn preview_renders_each_op_as_its_logical_statement() {
        let conn = db(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, price REAL, \
             email TEXT, status TEXT, legacy TEXT);",
        );

        let cases: Vec<(AlterOp, &str)> = vec![
            (
                AlterOp::AddColumn {
                    name: "note".into(),
                    data_type: "TEXT".into(),
                    nullable: true,
                    default_value: None,
                },
                r#"ALTER TABLE "t" ADD COLUMN "note" TEXT"#,
            ),
            (
                AlterOp::AddColumn {
                    name: "qty".into(),
                    data_type: "INTEGER".into(),
                    nullable: false,
                    default_value: Some("0".into()),
                },
                r#"ALTER TABLE "t" ADD COLUMN "qty" INTEGER NOT NULL DEFAULT 0"#,
            ),
            (
                AlterOp::RenameColumn {
                    from: "name".into(),
                    to: "full_name".into(),
                },
                r#"ALTER TABLE "t" RENAME COLUMN "name" TO "full_name""#,
            ),
            (
                AlterOp::ChangeType {
                    column: "price".into(),
                    new_type: "NUMERIC(10,2)".into(),
                },
                r#"ALTER TABLE "t" ALTER COLUMN "price" TYPE NUMERIC(10,2)"#,
            ),
            (
                AlterOp::SetNullable {
                    column: "email".into(),
                    nullable: false,
                },
                r#"ALTER TABLE "t" ALTER COLUMN "email" SET NOT NULL"#,
            ),
            (
                AlterOp::SetNullable {
                    column: "email".into(),
                    nullable: true,
                },
                r#"ALTER TABLE "t" ALTER COLUMN "email" DROP NOT NULL"#,
            ),
            (
                AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: Some("'pending'".into()),
                },
                r#"ALTER TABLE "t" ALTER COLUMN "status" SET DEFAULT 'pending'"#,
            ),
            (
                AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: None,
                },
                r#"ALTER TABLE "t" ALTER COLUMN "status" DROP DEFAULT"#,
            ),
            (
                AlterOp::DropColumn {
                    name: "legacy".into(),
                },
                r#"ALTER TABLE "t" DROP COLUMN "legacy""#,
            ),
        ];
        for (op, expected) in cases {
            let stmts = preview(&conn, "t", std::slice::from_ref(&op)).expect("preview");
            assert_eq!(stmts, vec![expected.to_string()], "op {op:?}");
        }
    }

    #[test]
    fn preview_does_not_mutate_the_table() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO t VALUES (1, 'a');");
        let before = column_names(&conn, "t");
        preview(
            &conn,
            "t",
            &[
                AlterOp::ChangeType {
                    column: "name".into(),
                    new_type: "BLOB".into(),
                },
                AlterOp::DropColumn {
                    name: "name".into(),
                },
            ],
        )
        .expect("preview");
        assert_eq!(
            column_names(&conn, "t"),
            before,
            "preview changed the table"
        );
    }

    // -- pk protection ------------------------------------------------------

    #[test]
    fn dropping_a_pk_column_is_rejected_at_preview_and_apply() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");
        let op = [AlterOp::DropColumn { name: "id".into() }];
        let err = preview(&conn, "t", &op).unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("primary key"));
        let err = apply(&conn, "t", &op).unwrap_err();
        assert!(err.to_string().contains("primary key"));
        // Table untouched.
        assert_eq!(column_names(&conn, "t"), vec!["id", "name"]);
    }

    #[test]
    fn retyping_a_pk_column_is_rejected() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");
        let err = preview(
            &conn,
            "t",
            &[AlterOp::ChangeType {
                column: "id".into(),
                new_type: "TEXT".into(),
            }],
        )
        .unwrap_err();
        assert!(err.to_string().contains("primary key"));
    }

    // -- native apply -------------------------------------------------------

    #[test]
    fn native_add_column_with_default_and_not_null() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO t VALUES (1, 'a'), (2, 'b');");
        apply(
            &conn,
            "t",
            &[AlterOp::AddColumn {
                name: "active".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                default_value: Some("1".into()),
            }],
        )
        .expect("add column");
        let m = meta(&conn, "t");
        let active = column(&m, "active");
        assert_eq!(active.data_type, "INTEGER");
        assert!(!active.nullable);
        assert_eq!(active.default_value.as_deref(), Some("1"));
        // Existing rows get the default.
        let n: i64 = conn
            .query_row("SELECT count(*) FROM t WHERE active = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn native_rename_column_preserves_data() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO t VALUES (1, 'ada');");
        apply(
            &conn,
            "t",
            &[AlterOp::RenameColumn {
                from: "name".into(),
                to: "full_name".into(),
            }],
        )
        .expect("rename");
        assert_eq!(column_names(&conn, "t"), vec!["id", "full_name"]);
        let v: String = conn
            .query_row("SELECT full_name FROM t WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "ada");
    }

    #[test]
    fn native_drop_column_removes_it_keeping_other_data() {
        let conn = db(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, junk TEXT); \
             INSERT INTO t VALUES (1, 'ada', 'x');",
        );
        apply(
            &conn,
            "t",
            &[AlterOp::DropColumn {
                name: "junk".into(),
            }],
        )
        .expect("drop");
        assert_eq!(column_names(&conn, "t"), vec!["id", "name"]);
        let v: String = conn
            .query_row("SELECT name FROM t WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "ada");
    }

    // -- rebuild apply ------------------------------------------------------

    #[test]
    fn rebuild_change_type_preserves_data_and_indexes() {
        let conn = db(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, price TEXT, name TEXT); \
             CREATE INDEX idx_name ON t (name); \
             INSERT INTO t VALUES (1, '9.5', 'ada'), (2, '7.0', 'linus');",
        );
        apply(
            &conn,
            "t",
            &[AlterOp::ChangeType {
                column: "price".into(),
                new_type: "REAL".into(),
            }],
        )
        .expect("change type");
        let m = meta(&conn, "t");
        assert_eq!(column(&m, "price").data_type, "REAL");
        // The INTEGER PRIMARY KEY survives the rebuild as a pk.
        assert!(column(&m, "id").pk, "pk preserved after rebuild");
        assert_eq!(column(&m, "id").data_type, "INTEGER");
        // Data preserved — REAL affinity now stores it as a float.
        let price: f64 = conn
            .query_row("SELECT price FROM t WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!((price - 9.5).abs() < 1e-9, "price = {price}");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        // Index recreated.
        assert!(
            m.indexes.iter().any(|ix| ix.name == "idx_name"),
            "idx_name should be recreated: {:?}",
            m.indexes
        );
    }

    #[test]
    fn rebuild_set_and_drop_not_null() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT); \
             INSERT INTO t VALUES (1, 'a@b');");
        apply(
            &conn,
            "t",
            &[AlterOp::SetNullable {
                column: "email".into(),
                nullable: false,
            }],
        )
        .expect("set not null");
        assert!(!column(&meta(&conn, "t"), "email").nullable);
        apply(
            &conn,
            "t",
            &[AlterOp::SetNullable {
                column: "email".into(),
                nullable: true,
            }],
        )
        .expect("drop not null");
        assert!(column(&meta(&conn, "t"), "email").nullable);
    }

    #[test]
    fn rebuild_set_and_drop_default() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT);");
        apply(
            &conn,
            "t",
            &[AlterOp::SetDefault {
                column: "status".into(),
                default_value: Some("'pending'".into()),
            }],
        )
        .expect("set default");
        assert_eq!(
            column(&meta(&conn, "t"), "status").default_value.as_deref(),
            Some("'pending'")
        );
        apply(
            &conn,
            "t",
            &[AlterOp::SetDefault {
                column: "status".into(),
                default_value: None,
            }],
        )
        .expect("drop default");
        assert_eq!(column(&meta(&conn, "t"), "status").default_value, None);
    }

    #[test]
    fn rebuild_preserves_composite_pk_and_foreign_keys() {
        let conn = db("CREATE TABLE parent (code TEXT PRIMARY KEY); \
             CREATE TABLE t (\
                 a INTEGER, b INTEGER, ref TEXT REFERENCES parent(code), val TEXT, \
                 PRIMARY KEY (a, b)); \
             INSERT INTO parent VALUES ('x'); \
             INSERT INTO t VALUES (1, 2, 'x', 'old');");
        apply(
            &conn,
            "t",
            &[AlterOp::ChangeType {
                column: "val".into(),
                new_type: "BLOB".into(),
            }],
        )
        .expect("change type with composite pk + fk");
        let m = meta(&conn, "t");
        let pks: Vec<&str> = m
            .columns
            .iter()
            .filter(|c| c.pk)
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(pks, vec!["a", "b"], "composite pk preserved");
        assert_eq!(
            m.foreign_keys.len(),
            1,
            "fk preserved: {:?}",
            m.foreign_keys
        );
        assert_eq!(m.foreign_keys[0].ref_table, "parent");
        let val: String = conn
            .query_row("SELECT val FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(val, "old");
    }

    // -- acceptance: add + rename + retype in one batch ---------------------

    #[test]
    fn acceptance_add_rename_retype_in_one_batch() {
        let conn = db(
            "CREATE TABLE products (id INTEGER PRIMARY KEY, price TEXT, label TEXT); \
             INSERT INTO products VALUES (1, '9.99', 'widget'), (2, '4.50', 'gadget');",
        );
        apply(
            &conn,
            "products",
            &[
                AlterOp::AddColumn {
                    name: "in_stock".into(),
                    data_type: "INTEGER".into(),
                    nullable: false,
                    default_value: Some("1".into()),
                },
                AlterOp::RenameColumn {
                    from: "label".into(),
                    to: "name".into(),
                },
                AlterOp::ChangeType {
                    column: "price".into(),
                    new_type: "NUMERIC".into(),
                },
            ],
        )
        .expect("composite batch");

        let m = meta(&conn, "products");
        let names: Vec<&str> = m.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "price", "name", "in_stock"]);
        assert_eq!(column(&m, "price").data_type, "NUMERIC");
        assert_eq!(column(&m, "in_stock").default_value.as_deref(), Some("1"));
        // Data intact (renamed column carries values, added column defaults).
        // `price` now has NUMERIC affinity, so '9.99' is stored as 9.99.
        let row: (f64, String, i64) = conn
            .query_row(
                "SELECT price, name, in_stock FROM products WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!((row.0 - 9.99).abs() < 1e-9, "price = {}", row.0);
        assert_eq!(row.1, "widget");
        assert_eq!(row.2, 1);
        let count: i64 = conn
            .query_row("SELECT count(*) FROM products", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    // -- rebuild safety guard ----------------------------------------------

    #[test]
    fn rebuild_refuses_table_with_check_constraint() {
        let conn = db(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0)); \
             INSERT INTO t VALUES (1, 30);",
        );
        let err = apply(
            &conn,
            "t",
            &[AlterOp::ChangeType {
                column: "age".into(),
                new_type: "TEXT".into(),
            }],
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Unsupported(_)));
        assert!(err.to_string().contains("CHECK"));
        // Table unchanged.
        assert_eq!(column(&meta(&conn, "t"), "age").data_type, "INTEGER");
    }

    #[test]
    fn rebuild_refuses_table_with_autoincrement() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);");
        let err = apply(
            &conn,
            "t",
            &[AlterOp::ChangeType {
                column: "v".into(),
                new_type: "BLOB".into(),
            }],
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Unsupported(_)));
        assert!(err.to_string().contains("AUTOINCREMENT"));
    }

    #[test]
    fn rebuild_refuses_table_with_trigger() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); \
             CREATE TABLE log (msg TEXT); \
             CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log VALUES ('hi'); END;");
        let err = apply(
            &conn,
            "t",
            &[AlterOp::ChangeType {
                column: "v".into(),
                new_type: "BLOB".into(),
            }],
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Unsupported(_)));
        assert!(err.to_string().contains("trigger"));
    }

    #[test]
    fn strip_quoted_protects_quoted_names_from_the_guard_scan() {
        // A column literally named "check_in" / a default 'GENERATED' must not
        // trip the rebuild guard.
        let conn = db(
            r#"CREATE TABLE t (id INTEGER PRIMARY KEY, "check_in" TEXT, status TEXT DEFAULT 'GENERATED');"#,
        );
        // A rebuild (retype status) should succeed — no real unsupported feature.
        apply(
            &conn,
            "t",
            &[AlterOp::ChangeType {
                column: "check_in".into(),
                new_type: "DATE".into(),
            }],
        )
        .expect("rebuild should not be blocked by quoted names");
        assert_eq!(column(&meta(&conn, "t"), "check_in").data_type, "DATE");
    }

    // -- rollback -----------------------------------------------------------

    #[test]
    fn native_rename_collision_rolls_back_whole_batch() {
        // Second op renames onto an existing column → fails; the first op (a
        // successful add) must roll back too.
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT); \
             INSERT INTO t VALUES (1, 'x', 'y');");
        let err = apply(
            &conn,
            "t",
            &[
                AlterOp::AddColumn {
                    name: "c".into(),
                    data_type: "TEXT".into(),
                    nullable: true,
                    default_value: None,
                },
                AlterOp::RenameColumn {
                    from: "a".into(),
                    to: "b".into(),
                },
            ],
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        // Fully unchanged: no "c" column, "a" still present.
        assert_eq!(column_names(&conn, "t"), vec!["id", "a", "b"]);
    }

    #[test]
    fn rebuild_not_null_violation_rolls_back() {
        // Setting NOT NULL on a column that already holds NULL fails the copy /
        // constraint → the table must be untouched.
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT); \
             INSERT INTO t VALUES (1, NULL), (2, 'a@b');");
        let err = apply(
            &conn,
            "t",
            &[AlterOp::SetNullable {
                column: "email".into(),
                nullable: false,
            }],
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        // Table unchanged: email still nullable, both rows present incl. NULL.
        assert!(column(&meta(&conn, "t"), "email").nullable);
        let nulls: i64 = conn
            .query_row("SELECT count(*) FROM t WHERE email IS NULL", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(nulls, 1);
    }

    // -- unknown table / column --------------------------------------------

    #[test]
    fn unknown_table_is_a_human_error() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY);");
        let err =
            preview(&conn, "ghosts", &[AlterOp::DropColumn { name: "x".into() }]).unwrap_err();
        assert!(err.to_string().contains("does not exist"));
    }

    #[test]
    fn unknown_schema_is_a_human_error() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY);");
        let err = alter_table_blocking(
            &conn,
            "warehouse",
            "t",
            &[AlterOp::DropColumn { name: "x".into() }],
            false,
        )
        .unwrap_err();
        assert!(err.to_string().contains("Schema 'warehouse'"));
    }

    #[test]
    fn unknown_column_is_a_human_error() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");
        let err = preview(
            &conn,
            "t",
            &[AlterOp::RenameColumn {
                from: "nope".into(),
                to: "x".into(),
            }],
        )
        .unwrap_err();
        assert!(err.to_string().contains("'nope'"));
        assert!(err.to_string().contains("does not exist"));
    }

    // -- index + foreign-key ops -------------------------------------------

    #[test]
    fn preview_renders_index_and_fk_ops() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT, user_id INTEGER);");
        let cases: Vec<(AlterOp, &str)> = vec![
            (
                AlterOp::AddIndex {
                    name: "idx_t_email".into(),
                    columns: vec!["email".into()],
                    unique: true,
                },
                r#"CREATE UNIQUE INDEX "idx_t_email" ON "t" ("email")"#,
            ),
            (
                AlterOp::AddIndex {
                    name: "idx_t_uid".into(),
                    columns: vec!["user_id".into()],
                    unique: false,
                },
                r#"CREATE INDEX "idx_t_uid" ON "t" ("user_id")"#,
            ),
            (
                AlterOp::DropIndex {
                    name: "idx_old".into(),
                },
                r#"DROP INDEX "idx_old""#,
            ),
            (
                AlterOp::AddForeignKey {
                    name: "t_uid_fkey".into(),
                    columns: vec!["user_id".into()],
                    ref_table: "users".into(),
                    ref_columns: vec!["id".into()],
                    on_delete: Some("CASCADE".into()),
                },
                r#"ALTER TABLE "t" ADD CONSTRAINT "t_uid_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE"#,
            ),
            (
                AlterOp::DropForeignKey {
                    name: "t_uid_fkey".into(),
                    columns: vec!["user_id".into()],
                },
                r#"ALTER TABLE "t" DROP CONSTRAINT "t_uid_fkey""#,
            ),
        ];
        for (op, expected) in cases {
            let stmts = preview(&conn, "t", std::slice::from_ref(&op)).expect("preview");
            assert_eq!(stmts, vec![expected.to_string()], "op {op:?}");
        }
    }

    #[test]
    fn native_add_and_drop_index() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT); \
             INSERT INTO t VALUES (1, 'a@b');");
        apply(
            &conn,
            "t",
            &[AlterOp::AddIndex {
                name: "idx_t_email".into(),
                columns: vec!["email".into()],
                unique: true,
            }],
        )
        .expect("add index");
        assert!(
            meta(&conn, "t")
                .indexes
                .iter()
                .any(|ix| ix.name == "idx_t_email" && ix.unique),
            "unique index should exist"
        );
        apply(
            &conn,
            "t",
            &[AlterOp::DropIndex {
                name: "idx_t_email".into(),
            }],
        )
        .expect("drop index");
        assert!(
            !meta(&conn, "t")
                .indexes
                .iter()
                .any(|ix| ix.name == "idx_t_email"),
            "index should be gone"
        );
    }

    #[test]
    fn unknown_index_column_is_rejected() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT);");
        let err = preview(
            &conn,
            "t",
            &[AlterOp::AddIndex {
                name: "idx_bad".into(),
                columns: vec!["nope".into()],
                unique: false,
            }],
        )
        .unwrap_err();
        assert!(err.to_string().contains("nope"));
    }

    #[test]
    fn rebuild_add_foreign_key_preserves_data() {
        let conn = db("CREATE TABLE users (id INTEGER PRIMARY KEY); \
             CREATE TABLE t (id INTEGER PRIMARY KEY, user_id INTEGER); \
             INSERT INTO users VALUES (1); INSERT INTO t VALUES (1, 1);");
        apply(
            &conn,
            "t",
            &[AlterOp::AddForeignKey {
                name: "t_user_id_fkey".into(),
                columns: vec!["user_id".into()],
                ref_table: "users".into(),
                ref_columns: vec!["id".into()],
                on_delete: Some("CASCADE".into()),
            }],
        )
        .expect("add fk");
        let m = meta(&conn, "t");
        assert_eq!(m.foreign_keys.len(), 1, "fk added: {:?}", m.foreign_keys);
        assert_eq!(m.foreign_keys[0].ref_table, "users");
        assert_eq!(m.foreign_keys[0].columns, vec!["user_id"]);
        assert_eq!(m.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
        let n: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "row preserved through rebuild");
    }

    #[test]
    fn rebuild_add_foreign_key_with_orphan_row_rolls_back() {
        // user_id 2 has no matching users row → foreign_key_check fails → the
        // whole change rolls back and the table keeps no FK.
        let conn = db("CREATE TABLE users (id INTEGER PRIMARY KEY); \
             CREATE TABLE t (id INTEGER PRIMARY KEY, user_id INTEGER); \
             INSERT INTO users VALUES (1); INSERT INTO t VALUES (1, 2);");
        // foreign_key_check only runs when FK enforcement is on (off by default
        // for an in-memory connection).
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        let err = apply(
            &conn,
            "t",
            &[AlterOp::AddForeignKey {
                name: "t_user_id_fkey".into(),
                columns: vec!["user_id".into()],
                ref_table: "users".into(),
                ref_columns: vec!["id".into()],
                on_delete: None,
            }],
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(
            meta(&conn, "t").foreign_keys.is_empty(),
            "no fk after rollback"
        );
    }

    #[test]
    fn rebuild_drop_foreign_key_by_columns() {
        // SQLite's foreign_key_list exposes no constraint name, so DropForeignKey
        // identifies the FK by its local columns.
        let conn = db("CREATE TABLE users (id INTEGER PRIMARY KEY); \
             CREATE TABLE t (id INTEGER PRIMARY KEY, \
                 user_id INTEGER REFERENCES users(id)); \
             INSERT INTO users VALUES (1); INSERT INTO t VALUES (1, 1);");
        assert_eq!(meta(&conn, "t").foreign_keys.len(), 1);
        apply(
            &conn,
            "t",
            &[AlterOp::DropForeignKey {
                name: String::new(),
                columns: vec!["user_id".into()],
            }],
        )
        .expect("drop fk");
        assert!(
            meta(&conn, "t").foreign_keys.is_empty(),
            "fk should be dropped"
        );
        // Data preserved.
        let n: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn empty_batch_is_rejected() {
        let conn = db("CREATE TABLE t (id INTEGER PRIMARY KEY);");
        let err = alter_table_blocking(&conn, "main", "t", &[], false).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }
}
