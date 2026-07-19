//! Domain model for the structure-editor slice (M8, DESIGN_SPEC §3.6).
//!
//! One inline edit in the structure view = one staged [`AlterOp`]. The
//! renderer accumulates a batch and sends it to `alter_preview` (to read the
//! SQL the change implies) and `alter_apply` (to execute it transactionally).
//! This module is pure value objects + serde; engine-specific SQL generation
//! and execution live exclusively in `crate::engines::*` (the layering rule).
//!
//! # Wire shape
//!
//! [`AlterOp`] is an internally-tagged enum with tag field `op` and camelCase
//! variant tokens, so a batch is a JSON array like:
//!
//! ```json
//! [
//!   { "op": "addColumn", "name": "note", "dataType": "TEXT",
//!     "nullable": true, "default": null },
//!   { "op": "renameColumn", "from": "qty", "to": "quantity" },
//!   { "op": "changeType", "column": "price", "newType": "NUMERIC(10,2)" },
//!   { "op": "setNullable", "column": "email", "nullable": false },
//!   { "op": "setDefault", "column": "status", "default": "'pending'" },
//!   { "op": "dropColumn", "name": "legacy" },
//!   { "op": "addIndex", "name": "idx_t_email", "columns": ["email"], "unique": true },
//!   { "op": "dropIndex", "name": "idx_old" },
//!   { "op": "addForeignKey", "name": "t_user_id_fkey", "columns": ["user_id"],
//!     "refTable": "users", "refColumns": ["id"], "onDelete": "CASCADE" },
//!   { "op": "dropForeignKey", "name": "t_user_id_fkey", "columns": ["user_id"] }
//! ]
//! ```
//!
//! The TS mirror is `AlterOp` in `src/shared/api/engine.ts` — keep them in
//! sync.
//!
//! # Primary-key protection
//!
//! Dropping or retyping a primary-key column is rejected. The enforcement
//! lives in the SQLite adapter (`crate::engines::sqlite`), where the real
//! column set (and thus pk membership) is known after introspection — the
//! domain cannot know which columns are pks. [`AlterOp::target_column`]
//! exposes the affected column name so the adapter can apply the check
//! uniformly; the adapter raises the §5 message.

use serde::{Deserialize, Serialize};

/// One staged structure edit. Ten kinds, matching DESIGN_SPEC §3.6's editing
/// operations (six column ops plus index and foreign-key add/drop). Internally
/// tagged on the wire (`op`), camelCase variant tokens
/// and fields. The `default` fields use the wire name `default` (a Rust
/// keyword), renamed from `default_value` like [`crate::shared::engine::ColumnInfo`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum AlterOp {
    /// Add a new column. `default` is the verbatim default expression
    /// (`None` = no default). Native on SQLite (`ALTER TABLE … ADD COLUMN`).
    #[serde(rename_all = "camelCase")]
    AddColumn {
        name: String,
        data_type: String,
        nullable: bool,
        #[serde(rename = "default")]
        default_value: Option<String>,
    },
    /// Rename a column. Native on SQLite ≥3.25 (`RENAME COLUMN … TO …`).
    RenameColumn { from: String, to: String },
    /// Change a column's declared type. SQLite has no native ALTER for this;
    /// realized via table rebuild (see the adapter).
    #[serde(rename_all = "camelCase")]
    ChangeType { column: String, new_type: String },
    /// Set or drop a column's NOT NULL constraint. `nullable: true` ⇒ DROP NOT
    /// NULL, `false` ⇒ SET NOT NULL. SQLite: realized via table rebuild.
    SetNullable { column: String, nullable: bool },
    /// Set or drop a column's DEFAULT. `default: None` ⇒ DROP DEFAULT,
    /// `Some(expr)` ⇒ SET DEFAULT expr. SQLite: realized via table rebuild.
    #[serde(rename_all = "camelCase")]
    SetDefault {
        column: String,
        #[serde(rename = "default")]
        default_value: Option<String>,
    },
    /// Drop a column. Native on SQLite ≥3.35 (`DROP COLUMN`). PK-protected.
    DropColumn { name: String },
    /// Set or clear a column's comment / description. `comment: None` clears it.
    /// Realized on Postgres via `COMMENT ON COLUMN` and on MySQL via
    /// `MODIFY COLUMN … COMMENT` (which re-states the column definition).
    /// Unsupported on SQLite (no column comments); the editor does not offer it
    /// there.
    SetComment {
        column: String,
        comment: Option<String>,
    },
    /// Create an index over one or more columns. Native everywhere
    /// (`CREATE [UNIQUE] INDEX … ON …`). `name` is the (frontend-generated)
    /// index name; `unique` selects a UNIQUE index.
    AddIndex {
        name: String,
        columns: Vec<String>,
        unique: bool,
    },
    /// Drop an index by name. Native everywhere (`DROP INDEX`).
    DropIndex { name: String },
    /// Add a foreign-key constraint. Native on server engines
    /// (`ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …`); SQLite has no
    /// `ADD CONSTRAINT`, so it is realized via a table rebuild (see the adapter).
    /// `on_delete` is the verbatim referential action (`None` ⇒ omit the clause).
    #[serde(rename_all = "camelCase")]
    AddForeignKey {
        name: String,
        columns: Vec<String>,
        ref_table: String,
        ref_columns: Vec<String>,
        #[serde(default)]
        on_delete: Option<String>,
    },
    /// Drop a foreign-key constraint. Native on server engines
    /// (`DROP CONSTRAINT` / MySQL `DROP FOREIGN KEY`); SQLite realizes it via a
    /// table rebuild. `name` identifies the constraint on server engines;
    /// `columns` (the local columns) identifies it on SQLite, whose
    /// `foreign_key_list` exposes no constraint name.
    DropForeignKey { name: String, columns: Vec<String> },
}

impl AlterOp {
    /// Whether this op is realizable on SQLite without a table rebuild: a native
    /// `ALTER TABLE` (add / rename / drop column) or a `CREATE`/`DROP INDEX`.
    /// The others (type/nullable/default changes and foreign-key add/drop, which
    /// SQLite cannot do with `ALTER TABLE`) require a full table rebuild.
    pub fn is_native(&self) -> bool {
        matches!(
            self,
            Self::AddColumn { .. }
                | Self::RenameColumn { .. }
                | Self::DropColumn { .. }
                | Self::AddIndex { .. }
                | Self::DropIndex { .. }
        )
    }

    /// The existing column this op targets, when it names one (for pk-protection
    /// and validation against the introspected column set). `AddColumn` returns
    /// `None` — it introduces a column rather than targeting an existing one.
    pub fn target_column(&self) -> Option<&str> {
        match self {
            Self::AddColumn { .. } => None,
            Self::RenameColumn { from, .. } => Some(from),
            Self::ChangeType { column, .. } => Some(column),
            Self::SetNullable { column, .. } => Some(column),
            Self::SetDefault { column, .. } => Some(column),
            Self::SetComment { column, .. } => Some(column),
            Self::DropColumn { name } => Some(name),
            // Index / foreign-key ops do not target a single existing column for
            // pk-protection purposes (their column references are validated by
            // the adapter against the introspected set separately).
            Self::AddIndex { .. }
            | Self::DropIndex { .. }
            | Self::AddForeignKey { .. }
            | Self::DropForeignKey { .. } => None,
        }
    }

    /// Whether this op, applied to a primary-key column, must be rejected:
    /// dropping or retyping a pk column would silently lose the key (rebuild
    /// reconstruction cannot safely retype a pk, and dropping it is destructive
    /// in a way the editor does not support). Rename / nullable / default
    /// changes on a pk column are allowed.
    pub fn rejected_on_pk(&self) -> bool {
        matches!(self, Self::ChangeType { .. } | Self::DropColumn { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_column_wire_shape_round_trips() {
        let op = AlterOp::AddColumn {
            name: "note".into(),
            data_type: "TEXT".into(),
            nullable: true,
            default_value: Some("'n/a'".into()),
        };
        let json = serde_json::to_value(&op).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "op": "addColumn",
                "name": "note",
                "dataType": "TEXT",
                "nullable": true,
                "default": "'n/a'"
            })
        );
        let back: AlterOp = serde_json::from_value(json).unwrap();
        assert_eq!(back, op);
    }

    #[test]
    fn every_variant_wire_token_and_round_trip() {
        let cases = vec![
            (
                AlterOp::AddColumn {
                    name: "c".into(),
                    data_type: "INTEGER".into(),
                    nullable: false,
                    default_value: None,
                },
                serde_json::json!({
                    "op": "addColumn", "name": "c", "dataType": "INTEGER",
                    "nullable": false, "default": null
                }),
            ),
            (
                AlterOp::RenameColumn {
                    from: "a".into(),
                    to: "b".into(),
                },
                serde_json::json!({ "op": "renameColumn", "from": "a", "to": "b" }),
            ),
            (
                AlterOp::ChangeType {
                    column: "p".into(),
                    new_type: "NUMERIC(10,2)".into(),
                },
                serde_json::json!({ "op": "changeType", "column": "p", "newType": "NUMERIC(10,2)" }),
            ),
            (
                AlterOp::SetNullable {
                    column: "e".into(),
                    nullable: false,
                },
                serde_json::json!({ "op": "setNullable", "column": "e", "nullable": false }),
            ),
            (
                AlterOp::SetDefault {
                    column: "s".into(),
                    default_value: Some("'pending'".into()),
                },
                serde_json::json!({ "op": "setDefault", "column": "s", "default": "'pending'" }),
            ),
            (
                AlterOp::SetDefault {
                    column: "s".into(),
                    default_value: None,
                },
                serde_json::json!({ "op": "setDefault", "column": "s", "default": null }),
            ),
            (
                AlterOp::DropColumn { name: "x".into() },
                serde_json::json!({ "op": "dropColumn", "name": "x" }),
            ),
            (
                AlterOp::AddIndex {
                    name: "idx_t_email".into(),
                    columns: vec!["email".into()],
                    unique: true,
                },
                serde_json::json!({
                    "op": "addIndex", "name": "idx_t_email",
                    "columns": ["email"], "unique": true
                }),
            ),
            (
                AlterOp::DropIndex {
                    name: "idx_old".into(),
                },
                serde_json::json!({ "op": "dropIndex", "name": "idx_old" }),
            ),
            (
                AlterOp::AddForeignKey {
                    name: "t_user_id_fkey".into(),
                    columns: vec!["user_id".into()],
                    ref_table: "users".into(),
                    ref_columns: vec!["id".into()],
                    on_delete: Some("CASCADE".into()),
                },
                serde_json::json!({
                    "op": "addForeignKey", "name": "t_user_id_fkey",
                    "columns": ["user_id"], "refTable": "users",
                    "refColumns": ["id"], "onDelete": "CASCADE"
                }),
            ),
            (
                AlterOp::DropForeignKey {
                    name: "t_user_id_fkey".into(),
                    columns: vec!["user_id".into()],
                },
                serde_json::json!({
                    "op": "dropForeignKey", "name": "t_user_id_fkey",
                    "columns": ["user_id"]
                }),
            ),
        ];
        for (op, expected) in cases {
            assert_eq!(
                serde_json::to_value(&op).unwrap(),
                expected,
                "serialize {op:?}"
            );
            let back: AlterOp = serde_json::from_value(expected).unwrap();
            assert_eq!(back, op);
        }
    }

    #[test]
    fn native_classification_and_pk_rules() {
        assert!(AlterOp::AddColumn {
            name: "c".into(),
            data_type: "T".into(),
            nullable: true,
            default_value: None,
        }
        .is_native());
        assert!(AlterOp::RenameColumn {
            from: "a".into(),
            to: "b".into()
        }
        .is_native());
        assert!(AlterOp::DropColumn { name: "x".into() }.is_native());
        assert!(!AlterOp::ChangeType {
            column: "c".into(),
            new_type: "T".into()
        }
        .is_native());
        assert!(!AlterOp::SetNullable {
            column: "c".into(),
            nullable: true
        }
        .is_native());
        // CREATE / DROP INDEX are native; FK add/drop need a rebuild on SQLite.
        assert!(AlterOp::AddIndex {
            name: "i".into(),
            columns: vec!["c".into()],
            unique: false,
        }
        .is_native());
        assert!(AlterOp::DropIndex { name: "i".into() }.is_native());
        assert!(!AlterOp::AddForeignKey {
            name: "f".into(),
            columns: vec!["c".into()],
            ref_table: "u".into(),
            ref_columns: vec!["id".into()],
            on_delete: None,
        }
        .is_native());
        assert!(!AlterOp::DropForeignKey {
            name: "f".into(),
            columns: vec!["c".into()],
        }
        .is_native());

        assert!(AlterOp::DropColumn { name: "x".into() }.rejected_on_pk());
        assert!(AlterOp::ChangeType {
            column: "c".into(),
            new_type: "T".into()
        }
        .rejected_on_pk());
        assert!(!AlterOp::RenameColumn {
            from: "a".into(),
            to: "b".into()
        }
        .rejected_on_pk());
    }

    #[test]
    fn target_column_reports_the_affected_column() {
        assert_eq!(
            AlterOp::AddColumn {
                name: "c".into(),
                data_type: "T".into(),
                nullable: true,
                default_value: None,
            }
            .target_column(),
            None
        );
        assert_eq!(
            AlterOp::RenameColumn {
                from: "a".into(),
                to: "b".into()
            }
            .target_column(),
            Some("a")
        );
        assert_eq!(
            AlterOp::DropColumn { name: "x".into() }.target_column(),
            Some("x")
        );
    }
}
