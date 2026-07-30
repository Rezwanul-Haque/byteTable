//! Domain model for Schema Diff & Sync (M28): the structural snapshot two
//! environments are compared through, the per-table diff, and the migration
//! statements that make a target match a source.
//!
//! Pure value objects + two pure functions ([`diff`] and [`plan`]) — no Tauri,
//! no drivers, no I/O. As elsewhere in the app the `serde` derives double as
//! the wire representation (camelCase fields), so the renderer's TS mirrors
//! match field-for-field.
//!
//! **Structure only.** Nothing here reads, carries, or emits row data: a
//! snapshot holds column and index metadata, and the generated statements are
//! DDL. That promise is the feature's headline and is enforced by construction.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::shared::engine::Engine;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/// One column in a structural snapshot. `data_type` is the engine's declared
/// type verbatim (wire name `type`); comparison normalizes it (see [`norm`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSchema {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    /// Part of the primary key (composite pks mark every member column).
    pub pk: bool,
    /// No `NOT NULL` declared.
    pub nullable: bool,
}

/// One index in a structural snapshot. `primary` marks the implicit
/// primary-key index, which the differ ignores (it travels with the table).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSchema {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

/// One table's structure. Views / materialized views are never snapshotted —
/// the reader lists base tables only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<ColumnSchema>,
    pub indexes: Vec<IndexSchema>,
}

/// The structure of one schema on one connection — what the differ consumes.
///
/// `schema` is carried so the renderer can label a card and so an apply knows
/// which schema the statements are scoped to. Tables are in the order the
/// engine listed them (alphabetical for every adapter today).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    pub schema: String,
    pub tables: Vec<TableSchema>,
}

impl SchemaSnapshot {
    /// The table with this name, or `None`.
    pub fn table(&self, name: &str) -> Option<&TableSchema> {
        self.tables.iter().find(|t| t.name == name)
    }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/// How one table differs between source and target.
///
/// The vocabulary is directional: it always describes *what the target needs*
/// to look like the source. `diff(a, b)` and `diff(b, a)` are computed
/// independently, so swapping direction needs no inverse logic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TableStatus {
    /// In the source, missing from the target — the target must create it.
    New,
    /// In both, but the columns/indexes differ.
    Changed,
    /// In the target only — a sync would drop it.
    OnlyTarget,
    /// Structurally identical.
    Same,
}

impl TableStatus {
    /// Sort rank: new → changed → only-target → identical (identical last).
    fn rank(self) -> u8 {
        match self {
            TableStatus::New => 0,
            TableStatus::Changed => 1,
            TableStatus::OnlyTarget => 2,
            TableStatus::Same => 3,
        }
    }
}

/// What happened to one column (or non-primary index) of a table.
///
/// The wire values are the marker glyphs the diff pane renders, which is also
/// how the prototype models them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColumnMark {
    /// Column present in the source, missing in the target.
    #[serde(rename = "+")]
    Add,
    /// Column in both, with a different declared type.
    #[serde(rename = "~")]
    Alter,
    /// Column present in the target only.
    #[serde(rename = "-")]
    Drop,
    /// Column identical in both — emitted so the expanded row shows full
    /// context, never turned into a statement.
    #[serde(rename = "=")]
    Same,
    /// Non-primary index present in the source only.
    #[serde(rename = "+idx")]
    IndexAdd,
    /// Non-primary index present in the target only.
    #[serde(rename = "-idx")]
    IndexDrop,
}

/// One row inside an expanded table diff: a column, or an index (the `+idx` /
/// `-idx` marks), whose `data_type` then carries the `(col, col)` list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    #[serde(rename = "mk")]
    pub mark: ColumnMark,
    pub name: String,
    /// The source's type (for `-` / `-idx`: the target's, since that is the
    /// only side that has it). Wire name `type`.
    #[serde(rename = "type")]
    pub data_type: String,
    /// The target's current type, present only for [`ColumnMark::Alter`] — the
    /// `old → new` pair the diff pane renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
    pub pk: bool,
}

/// One table's diff entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    pub name: String,
    pub status: TableStatus,
    pub cols: Vec<ColumnDiff>,
    /// "N cols" — shown on identical rows ("N cols · in sync"). Absent for
    /// tables that exist on one side only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
}

// ---------------------------------------------------------------------------
// Migration plan
// ---------------------------------------------------------------------------

/// What a statement does — drives the summary chips (new tables / cols + /
/// cols ~) and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StatementKind {
    Create,
    Drop,
    ColAdd,
    ColDrop,
    ColAlter,
    Index,
    IndexDrop,
}

/// One statement of the migration plan, in apply order.
///
/// `destructive` marks the statements that remove structure (and with it any
/// data those objects hold): `DROP TABLE`, `DROP COLUMN`, `DROP INDEX`. The
/// renderer starts them **unchecked** and tints them red; nothing here decides
/// what runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatement {
    /// Index in the plan — the renderer's stable key / checkbox identity.
    pub id: usize,
    pub kind: StatementKind,
    pub sql: String,
    pub table: String,
    pub destructive: bool,
}

/// What one comparison produced: the per-table diff and the migration plan
/// derived from it. Compare-only callers use `tables` and the DDL modal reads
/// `statements`; neither ever applies anything on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaComparison {
    pub tables: Vec<TableDiff>,
    pub statements: Vec<MigrationStatement>,
}

// ---------------------------------------------------------------------------
// The differ
// ---------------------------------------------------------------------------

/// Normalize a declared type for comparison: uppercase, all whitespace
/// stripped — so `numeric(12, 2)` and `NUMERIC(12,2)` are the same type and do
/// not show up as spurious drift.
fn norm(data_type: &str) -> String {
    data_type
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

/// Structural diff describing **how to make `target` match `source`**.
///
/// Table names are visited in source order, then target-only names, and the
/// result is sorted by [`TableStatus::rank`] with a stable sort — so within a
/// status group the original order survives.
///
/// Primary-key indexes are skipped: they are created and dropped with the
/// table itself, so reporting them separately would be noise.
pub fn diff(source: &SchemaSnapshot, target: &SchemaSnapshot) -> Vec<TableDiff> {
    let mut names: Vec<&str> = source.tables.iter().map(|t| t.name.as_str()).collect();
    for t in &target.tables {
        if !names.contains(&t.name.as_str()) {
            names.push(&t.name);
        }
    }

    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let src = source.table(name);
        let tgt = target.table(name);
        match (src, tgt) {
            // Only in the source → the target must create it (every column `+`).
            (Some(s), None) => out.push(TableDiff {
                name: name.to_string(),
                status: TableStatus::New,
                cols: s
                    .columns
                    .iter()
                    .map(|c| ColumnDiff {
                        mark: ColumnMark::Add,
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        old: None,
                        pk: c.pk,
                    })
                    .collect(),
                delta: None,
            }),
            // Only in the target → a sync would drop it (every column `-`).
            (None, Some(t)) => out.push(TableDiff {
                name: name.to_string(),
                status: TableStatus::OnlyTarget,
                cols: t
                    .columns
                    .iter()
                    .map(|c| ColumnDiff {
                        mark: ColumnMark::Drop,
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        old: None,
                        pk: c.pk,
                    })
                    .collect(),
                delta: None,
            }),
            (Some(s), Some(t)) => out.push(diff_table(name, s, t)),
            // Unreachable: `name` came from one of the two snapshots.
            (None, None) => {}
        }
    }

    out.sort_by_key(|d| d.status.rank());
    out
}

/// Column + index diff for one table present on both sides.
fn diff_table(name: &str, source: &TableSchema, target: &TableSchema) -> TableDiff {
    let target_cols: BTreeMap<&str, &ColumnSchema> = target
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();
    let source_cols: BTreeMap<&str, &ColumnSchema> = source
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();

    let mut cols = Vec::new();
    let mut changed = false;

    for sc in &source.columns {
        match target_cols.get(sc.name.as_str()) {
            None => {
                changed = true;
                cols.push(ColumnDiff {
                    mark: ColumnMark::Add,
                    name: sc.name.clone(),
                    data_type: sc.data_type.clone(),
                    old: None,
                    pk: sc.pk,
                });
            }
            Some(tc) if norm(&sc.data_type) != norm(&tc.data_type) => {
                changed = true;
                cols.push(ColumnDiff {
                    mark: ColumnMark::Alter,
                    name: sc.name.clone(),
                    data_type: sc.data_type.clone(),
                    old: Some(tc.data_type.clone()),
                    pk: sc.pk,
                });
            }
            // Identical — still emitted, so an expanded row reads as the whole
            // table rather than only its drift.
            Some(_) => cols.push(ColumnDiff {
                mark: ColumnMark::Same,
                name: sc.name.clone(),
                data_type: sc.data_type.clone(),
                old: None,
                pk: sc.pk,
            }),
        }
    }
    for tc in &target.columns {
        if !source_cols.contains_key(tc.name.as_str()) {
            changed = true;
            cols.push(ColumnDiff {
                mark: ColumnMark::Drop,
                name: tc.name.clone(),
                data_type: tc.data_type.clone(),
                old: None,
                pk: tc.pk,
            });
        }
    }

    // Indexes, primary-key ones excluded (they belong to the table).
    let secondary = |t: &TableSchema| -> Vec<IndexSchema> {
        t.indexes.iter().filter(|i| !i.primary).cloned().collect()
    };
    let source_idx = secondary(source);
    let target_idx = secondary(target);
    let has = |set: &[IndexSchema], name: &str| set.iter().any(|i| i.name == name);

    for ix in &source_idx {
        if !has(&target_idx, &ix.name) {
            changed = true;
            cols.push(index_row(ColumnMark::IndexAdd, ix));
        }
    }
    for ix in &target_idx {
        if !has(&source_idx, &ix.name) {
            changed = true;
            cols.push(index_row(ColumnMark::IndexDrop, ix));
        }
    }

    TableDiff {
        name: name.to_string(),
        status: if changed {
            TableStatus::Changed
        } else {
            TableStatus::Same
        },
        cols,
        delta: Some(format!("{} cols", source.columns.len())),
    }
}

/// An index rendered as a diff row: its column list stands in for a type.
fn index_row(mark: ColumnMark, ix: &IndexSchema) -> ColumnDiff {
    ColumnDiff {
        mark,
        name: ix.name.clone(),
        data_type: format!("({})", ix.columns.join(", ")),
        old: None,
        pk: false,
    }
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/// Turn a diff into ordered DDL statements in the **target** engine's dialect.
///
/// `source` supplies the full column list for tables the target is missing.
/// Identifiers are emitted bare (as introspected) and statements are
/// unqualified: an apply is scoped to the target schema by the engine
/// (`SET search_path` / `USE`), so qualifying here would only make the DDL
/// harder to read and re-run elsewhere.
pub fn plan(
    diff: &[TableDiff],
    source: &SchemaSnapshot,
    target_engine: Engine,
) -> Vec<MigrationStatement> {
    let mysql = target_engine == Engine::Mysql;
    let mut out: Vec<MigrationStatement> = Vec::new();
    let mut push = |kind: StatementKind, sql: String, table: &str, destructive: bool| {
        out.push(MigrationStatement {
            id: out.len(),
            kind,
            sql,
            table: table.to_string(),
            destructive,
        });
    };

    for t in diff {
        match t.status {
            TableStatus::Same => continue,
            TableStatus::New => {
                // `new` means "in the source only", so the source always has it.
                let Some(table) = source.table(&t.name) else {
                    continue;
                };
                let lines = table
                    .columns
                    .iter()
                    .map(|c| {
                        let suffix = if c.pk {
                            " PRIMARY KEY"
                        } else if !c.nullable {
                            " NOT NULL"
                        } else {
                            ""
                        };
                        format!("  {} {}{}", c.name, c.data_type, suffix)
                    })
                    .collect::<Vec<_>>()
                    .join(",\n");
                push(
                    StatementKind::Create,
                    format!("CREATE TABLE {} (\n{}\n);", t.name, lines),
                    &t.name,
                    false,
                );
            }
            TableStatus::OnlyTarget => push(
                StatementKind::Drop,
                format!("DROP TABLE {};", t.name),
                &t.name,
                true,
            ),
            TableStatus::Changed => {
                for c in &t.cols {
                    match c.mark {
                        ColumnMark::Add => push(
                            StatementKind::ColAdd,
                            format!(
                                "ALTER TABLE {} ADD COLUMN {} {};",
                                t.name, c.name, c.data_type
                            ),
                            &t.name,
                            false,
                        ),
                        ColumnMark::Drop => push(
                            StatementKind::ColDrop,
                            format!("ALTER TABLE {} DROP COLUMN {};", t.name, c.name),
                            &t.name,
                            true,
                        ),
                        ColumnMark::Alter => {
                            let old = c.old.clone().unwrap_or_default();
                            let sql = if mysql {
                                format!(
                                    "ALTER TABLE {} MODIFY COLUMN {} {}; -- was {}",
                                    t.name, c.name, c.data_type, old
                                )
                            } else {
                                format!(
                                    "ALTER TABLE {} ALTER COLUMN {} TYPE {}; -- was {}",
                                    t.name, c.name, c.data_type, old
                                )
                            };
                            push(StatementKind::ColAlter, sql, &t.name, false);
                        }
                        ColumnMark::IndexAdd => push(
                            StatementKind::Index,
                            format!("CREATE INDEX {} ON {} {};", c.name, t.name, c.data_type),
                            &t.name,
                            false,
                        ),
                        ColumnMark::IndexDrop => push(
                            StatementKind::IndexDrop,
                            format!("DROP INDEX {};", c.name),
                            &t.name,
                            true,
                        ),
                        ColumnMark::Same => {}
                    }
                }
            }
        }
    }

    out
}

/// Diff two snapshots and plan the migration in one step — what the command
/// layer hands the renderer.
pub fn compare(
    source: &SchemaSnapshot,
    target: &SchemaSnapshot,
    target_engine: Engine,
) -> SchemaComparison {
    let tables = diff(source, target);
    let statements = plan(&tables, source, target_engine);
    SchemaComparison { tables, statements }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str) -> ColumnSchema {
        ColumnSchema {
            name: name.into(),
            data_type: data_type.into(),
            pk: false,
            nullable: true,
        }
    }

    fn pk(name: &str, data_type: &str) -> ColumnSchema {
        ColumnSchema {
            pk: true,
            nullable: false,
            ..col(name, data_type)
        }
    }

    fn idx(name: &str, columns: &[&str]) -> IndexSchema {
        IndexSchema {
            name: name.into(),
            columns: columns.iter().map(|c| (*c).to_string()).collect(),
            unique: false,
            primary: false,
        }
    }

    fn table(name: &str, columns: Vec<ColumnSchema>, indexes: Vec<IndexSchema>) -> TableSchema {
        TableSchema {
            name: name.into(),
            columns,
            indexes,
        }
    }

    /// users(id pk, email, country) + orders(id pk, total) — the baseline both
    /// drift cases below are measured against.
    fn baseline() -> SchemaSnapshot {
        SchemaSnapshot {
            schema: "public".into(),
            tables: vec![
                table(
                    "users",
                    vec![
                        pk("id", "INTEGER"),
                        col("email", "TEXT"),
                        col("country", "VARCHAR(64)"),
                    ],
                    vec![IndexSchema {
                        name: "users_pkey".into(),
                        columns: vec!["id".into()],
                        unique: true,
                        primary: true,
                    }],
                ),
                table(
                    "orders",
                    vec![pk("id", "INTEGER"), col("total", "NUMERIC(10,2)")],
                    vec![],
                ),
            ],
        }
    }

    fn find<'a>(diff: &'a [TableDiff], name: &str) -> &'a TableDiff {
        diff.iter().find(|t| t.name == name).expect("table in diff")
    }

    #[test]
    fn identical_schemas_are_all_same_and_plan_nothing() {
        let a = baseline();
        let d = diff(&a, &a);
        assert!(d.iter().all(|t| t.status == TableStatus::Same));
        assert_eq!(find(&d, "users").delta.as_deref(), Some("3 cols"));
        assert!(plan(&d, &a, Engine::Postgres).is_empty());
    }

    #[test]
    fn a_table_only_in_the_source_is_new_and_creates() {
        let mut src = baseline();
        src.tables.push(table(
            "coupons",
            vec![pk("id", "INTEGER"), col("code", "VARCHAR(24)")],
            vec![],
        ));
        let d = diff(&src, &baseline());
        let coupons = find(&d, "coupons");
        assert_eq!(coupons.status, TableStatus::New);
        assert!(coupons.cols.iter().all(|c| c.mark == ColumnMark::Add));

        let stmts = plan(&d, &src, Engine::Postgres);
        assert_eq!(stmts.len(), 1);
        assert_eq!(stmts[0].kind, StatementKind::Create);
        assert!(!stmts[0].destructive);
        assert_eq!(
            stmts[0].sql,
            "CREATE TABLE coupons (\n  id INTEGER PRIMARY KEY,\n  code VARCHAR(24)\n);"
        );
    }

    #[test]
    fn the_same_pair_reversed_reports_only_target_and_drops() {
        let mut src = baseline();
        src.tables
            .push(table("coupons", vec![pk("id", "INTEGER")], vec![]));
        // Direction flipped: the extra table now lives on the target side.
        let d = diff(&baseline(), &src);
        let coupons = find(&d, "coupons");
        assert_eq!(coupons.status, TableStatus::OnlyTarget);
        assert!(coupons.cols.iter().all(|c| c.mark == ColumnMark::Drop));

        let stmts = plan(&d, &baseline(), Engine::Postgres);
        assert_eq!(stmts.len(), 1);
        assert_eq!(stmts[0].kind, StatementKind::Drop);
        assert!(stmts[0].destructive, "DROP TABLE is destructive");
        assert_eq!(stmts[0].sql, "DROP TABLE coupons;");
    }

    #[test]
    fn an_added_column_is_marked_and_altered_in() {
        let mut src = baseline();
        src.tables[0].columns.push(col("last_login", "TIMESTAMP"));
        let d = diff(&src, &baseline());
        let users = find(&d, "users");
        assert_eq!(users.status, TableStatus::Changed);
        let added = users
            .cols
            .iter()
            .find(|c| c.name == "last_login")
            .expect("column row");
        assert_eq!(added.mark, ColumnMark::Add);
        // Unchanged columns are still emitted, for context.
        assert_eq!(
            users
                .cols
                .iter()
                .filter(|c| c.mark == ColumnMark::Same)
                .count(),
            3
        );

        let stmts = plan(&d, &src, Engine::Postgres);
        assert_eq!(stmts.len(), 1);
        assert_eq!(
            stmts[0].sql,
            "ALTER TABLE users ADD COLUMN last_login TIMESTAMP;"
        );
        assert!(!stmts[0].destructive);
    }

    #[test]
    fn a_dropped_column_is_detected_in_the_other_direction() {
        let mut src = baseline();
        src.tables[0].columns.push(col("last_login", "TIMESTAMP"));
        let d = diff(&baseline(), &src);
        let users = find(&d, "users");
        let dropped = users
            .cols
            .iter()
            .find(|c| c.name == "last_login")
            .expect("column row");
        assert_eq!(dropped.mark, ColumnMark::Drop);

        let stmts = plan(&d, &baseline(), Engine::Postgres);
        assert_eq!(stmts[0].sql, "ALTER TABLE users DROP COLUMN last_login;");
        assert!(stmts[0].destructive);
    }

    #[test]
    fn a_retyped_column_keeps_the_old_type_and_follows_the_target_dialect() {
        let mut src = baseline();
        src.tables[0].columns[2] = col("country", "VARCHAR(2)");
        let d = diff(&src, &baseline());
        let users = find(&d, "users");
        let altered = users
            .cols
            .iter()
            .find(|c| c.name == "country")
            .expect("column row");
        assert_eq!(altered.mark, ColumnMark::Alter);
        assert_eq!(altered.old.as_deref(), Some("VARCHAR(64)"));

        assert_eq!(
            plan(&d, &src, Engine::Postgres)[0].sql,
            "ALTER TABLE users ALTER COLUMN country TYPE VARCHAR(2); -- was VARCHAR(64)"
        );
        assert_eq!(
            plan(&d, &src, Engine::Sqlite)[0].sql,
            "ALTER TABLE users ALTER COLUMN country TYPE VARCHAR(2); -- was VARCHAR(64)"
        );
        assert_eq!(
            plan(&d, &src, Engine::Mysql)[0].sql,
            "ALTER TABLE users MODIFY COLUMN country VARCHAR(2); -- was VARCHAR(64)"
        );
    }

    #[test]
    fn type_comparison_ignores_case_and_whitespace() {
        let mut src = baseline();
        src.tables[1].columns[1] = col("total", "numeric(10, 2)");
        let d = diff(&src, &baseline());
        assert_eq!(find(&d, "orders").status, TableStatus::Same);
    }

    #[test]
    fn a_secondary_index_is_created_and_dropped_by_direction() {
        let mut src = baseline();
        src.tables[0]
            .indexes
            .push(idx("idx_users_email", &["email"]));

        let forward = diff(&src, &baseline());
        let row = find(&forward, "users")
            .cols
            .iter()
            .find(|c| c.name == "idx_users_email")
            .expect("index row");
        assert_eq!(row.mark, ColumnMark::IndexAdd);
        assert_eq!(row.data_type, "(email)");
        let stmts = plan(&forward, &src, Engine::Postgres);
        assert_eq!(
            stmts[0].sql,
            "CREATE INDEX idx_users_email ON users (email);"
        );
        assert!(!stmts[0].destructive);

        let back = diff(&baseline(), &src);
        let row = find(&back, "users")
            .cols
            .iter()
            .find(|c| c.name == "idx_users_email")
            .expect("index row");
        assert_eq!(row.mark, ColumnMark::IndexDrop);
        let stmts = plan(&back, &baseline(), Engine::Postgres);
        assert_eq!(stmts[0].sql, "DROP INDEX idx_users_email;");
        assert!(stmts[0].destructive);
    }

    #[test]
    fn primary_key_indexes_are_never_reported() {
        // The target lost the pk index entry entirely; the tables still match,
        // because a pk index travels with its table.
        let mut tgt = baseline();
        tgt.tables[0].indexes.clear();
        let d = diff(&baseline(), &tgt);
        assert_eq!(find(&d, "users").status, TableStatus::Same);
    }

    #[test]
    fn statuses_sort_new_then_changed_then_only_target_then_identical() {
        let mut src = baseline();
        src.tables
            .push(table("coupons", vec![pk("id", "INTEGER")], vec![]));
        src.tables[0].columns.push(col("last_login", "TIMESTAMP"));
        let mut tgt = baseline();
        tgt.tables
            .push(table("legacy_carts", vec![pk("id", "INTEGER")], vec![]));

        let d = diff(&src, &tgt);
        let order: Vec<&str> = d.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(order, vec!["coupons", "users", "legacy_carts", "orders"]);
    }

    #[test]
    fn statement_ids_are_the_plan_order() {
        let mut src = baseline();
        src.tables[0].columns.push(col("a", "TEXT"));
        src.tables[1].columns.push(col("b", "TEXT"));
        let d = diff(&src, &baseline());
        let stmts = plan(&d, &src, Engine::Postgres);
        assert_eq!(stmts.iter().map(|s| s.id).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn wire_shape_matches_the_renderer_mirror() {
        let mut src = baseline();
        src.tables[0].columns[2] = col("country", "VARCHAR(2)");
        let comparison = compare(&src, &baseline(), Engine::Mysql);
        let json = serde_json::to_value(&comparison).expect("serialize");

        let users = json["tables"]
            .as_array()
            .expect("tables")
            .iter()
            .find(|t| t["name"] == "users")
            .expect("users entry")
            .clone();
        assert_eq!(users["status"], "changed");
        assert_eq!(users["delta"], "3 cols");
        let altered = users["cols"]
            .as_array()
            .expect("cols")
            .iter()
            .find(|c| c["name"] == "country")
            .expect("country row")
            .clone();
        assert_eq!(altered["mk"], "~");
        assert_eq!(altered["type"], "VARCHAR(2)");
        assert_eq!(altered["old"], "VARCHAR(64)");

        let stmt = json["statements"][0].clone();
        assert_eq!(stmt["id"], 0);
        assert_eq!(stmt["kind"], "col-alter");
        assert_eq!(stmt["table"], "users");
        assert_eq!(stmt["destructive"], false);
    }

    #[test]
    fn comparing_a_snapshot_with_itself_yields_no_statements() {
        // The UI can point both cards at the same connection; that must read as
        // identical, never as a self-migration.
        let a = baseline();
        let comparison = compare(&a, &a, Engine::Postgres);
        assert!(comparison.statements.is_empty());
        assert!(comparison
            .tables
            .iter()
            .all(|t| t.status == TableStatus::Same));
    }
}
