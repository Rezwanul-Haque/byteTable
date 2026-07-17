// Introspection metadata: engine / schema / table / column / index / FK shapes.

use serde::{Deserialize, Serialize};

use super::*;

/// What a successful test/open learned about the target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: Engine,
    /// Display version string, e.g. "SQLite 3.46.0" (sidebar header, M3).
    pub server_version: String,
}

/// A schema (SQLite: `main` + attached databases; server engines: schemas).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    /// Number of user tables, when cheaply known.
    pub table_count: Option<u64>,
}

/// A table within a schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    /// Approximate row count, when cheaply known (may be an estimate for
    /// server engines; exact `COUNT(*)` for SQLite in M2).
    pub approx_row_count: Option<u64>,
}

/// A schema-level database object other than a base table — surfaced in the
/// sidebar's object groups. Each engine exposes the kinds it supports (see
/// [`EngineConnection::object_kinds`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DbObjectKind {
    View,
    MaterializedView,
    Function,
    Procedure,
    Trigger,
}

/// One database object in a schema (sidebar row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObjectInfo {
    pub name: String,
    pub kind: DbObjectKind,
    /// Identity detail an engine needs to resolve/drop the object precisely:
    /// the owning table (triggers), or the identity arguments of an overloaded
    /// routine (Postgres functions, e.g. `"integer, text"`). `None` otherwise.
    pub detail: Option<String>,
    // --- Object Explorer grid metadata (M22) ---
    // Best-effort per engine; each field renders as a grid column only when
    // present, so partial introspection degrades cleanly (empty → `—`). The
    // sidebar ignores these; only the Explorer reads them.
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub modified: Option<String>,
    #[serde(default)]
    pub returns: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub volatility: Option<String>,
    #[serde(default)]
    pub arg_count: Option<i64>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub timing: Option<String>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub approx_rows: Option<i64>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

impl DbObjectInfo {
    /// A bare list row — name/kind/detail only, all Explorer grid metadata
    /// empty. Engines fill the metadata fields they can source cheaply.
    pub fn bare(name: String, kind: DbObjectKind, detail: Option<String>) -> Self {
        Self {
            name,
            kind,
            detail,
            owner: None,
            modified: None,
            returns: None,
            language: None,
            volatility: None,
            arg_count: None,
            table: None,
            timing: None,
            events: Vec::new(),
            enabled: None,
            approx_rows: None,
            size: None,
            depends_on: Vec::new(),
        }
    }
}

/// One argument of a routine (function/procedure), for the viewer's args table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineArg {
    /// `IN` / `OUT` / `INOUT` (MySQL); `None` for Postgres (defaults to IN).
    pub mode: Option<String>,
    pub name: String,
    pub data_type: String,
}

/// The `CREATE …` DDL for one object plus best-effort metadata for the viewer's
/// chip row + arguments table. Metadata fields are optional and engine/kind
/// dependent — each renders only when present, so partial introspection
/// degrades cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObjectDefinition {
    pub name: String,
    pub kind: DbObjectKind,
    /// Engine-native `CREATE …` statement.
    pub ddl: String,
    #[serde(default)]
    pub comment: Option<String>,
    // routines
    #[serde(default)]
    pub returns: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub volatility: Option<String>,
    #[serde(default)]
    pub args: Vec<RoutineArg>,
    // triggers
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub timing: Option<String>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    // materialized views
    #[serde(default)]
    pub populated: Option<bool>,
    #[serde(default)]
    pub approx_rows: Option<i64>,
    #[serde(default)]
    pub size: Option<String>,
    // views / matviews
    #[serde(default)]
    pub depends_on: Vec<String>,
}

impl DbObjectDefinition {
    /// A definition carrying just the DDL — all metadata empty. Adapters fill
    /// the chip fields they can resolve after constructing this.
    pub fn ddl_only(name: String, kind: DbObjectKind, ddl: String) -> Self {
        Self {
            name,
            kind,
            ddl,
            comment: None,
            returns: None,
            language: None,
            volatility: None,
            args: Vec::new(),
            table: None,
            timing: None,
            events: Vec::new(),
            level: None,
            enabled: None,
            populated: None,
            approx_rows: None,
            size: None,
            depends_on: Vec::new(),
        }
    }
}

/// Metadata for one table. Powers the M3 sidebar (`columns` with pk/fk icons
/// and type labels) and, since M7, the structure view's 348px rail
/// (DESIGN_SPEC §3.6): indexes, table-level and inbound foreign keys, plus the
/// `CREATE TABLE` DDL.
///
/// M7 additions (everything past `columns`) are additive — `columns` keeps
/// its M3 shape so the sidebar and the M4 grid headers, which read only
/// `columns`, are unaffected. New `Vec` fields are always present (empty when
/// none); `comment`/`ddl` are `Option` (always present on the wire, `null`
/// when absent). `Default` is derived so test fakes can build a bare
/// `TableMeta { columns, ..Default::default() }` without enumerating M7
/// fields, and so future additive fields do not break them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub columns: Vec<ColumnInfo>,
    /// The table's comment/description, when the engine has one. SQLite has
    /// no table comments, so this is always `None` there; it is modelled now
    /// for the §3.6 header's "table comment" slot and for server engines
    /// (MySQL `COMMENT`, Postgres `COMMENT ON TABLE`) in M12.
    pub comment: Option<String>,
    /// Indexes declared on the table, including the implicit primary-key
    /// index (`primary == true`). Empty when the table has none.
    pub indexes: Vec<IndexInfo>,
    /// Foreign keys declared *on this table* (outbound), grouped per
    /// constraint so a composite fk is one entry with ordered column lists.
    /// `ColumnInfo.fk` carries the same targets per-column for the sidebar
    /// icon; this is the table-level view §3.6 renders.
    pub foreign_keys: Vec<ForeignKeyInfo>,
    /// Foreign keys *pointing at this table* (inbound) from other tables in
    /// the same schema — §3.6's "referenced by". Empty when nothing
    /// references it. See the SQLite adapter for the per-table scan cost note.
    pub referenced_by: Vec<InboundFkInfo>,
    /// The `CREATE TABLE` statement, verbatim, for the §3.6 DDL modal
    /// (rendered syntax-highlighted — verbatim is truthful). `None` when the
    /// engine cannot supply it.
    pub ddl: Option<String>,
}

/// One index on a table (§3.6 structure view).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// Indexed columns, in index order. May be empty for an expression index
    /// (SQLite reports expression members as unnamed).
    pub columns: Vec<String>,
    /// True for a UNIQUE index (includes the implicit primary-key index).
    pub unique: bool,
    /// True for the implicit primary-key index (SQLite `origin == "pk"`).
    pub primary: bool,
    /// How the index came to exist, when the engine reports it. SQLite uses
    /// `"c"` (CREATE INDEX), `"u"` (a UNIQUE constraint), or `"pk"` (the
    /// primary key); other engines leave this `None`.
    pub origin: Option<String>,
}

/// One foreign key declared on a table (outbound), grouped per constraint so
/// composite keys are a single entry with parallel, ordered column lists
/// (`columns[i]` references `ref_columns[i]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    /// The constraint name, when the engine exposes one. SQLite's
    /// `foreign_key_list` has no name, so this is always `None` there; server
    /// engines populate it.
    pub name: Option<String>,
    /// Local columns of this table, in constraint order.
    pub columns: Vec<String>,
    pub ref_table: String,
    /// Referenced columns of `ref_table`, parallel to `columns`.
    pub ref_columns: Vec<String>,
    /// The `ON DELETE` action (e.g. `"CASCADE"`, `"SET NULL"`,
    /// `"NO ACTION"`), as the engine reports it; `None` if unknown.
    pub on_delete: Option<String>,
    /// The `ON UPDATE` action, as the engine reports it; `None` if unknown.
    pub on_update: Option<String>,
}

/// A foreign key from another table pointing *at* this table (§3.6
/// "referenced by"). Grouped per constraint like [`ForeignKeyInfo`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundFkInfo {
    /// The child table that holds the foreign key.
    pub table: String,
    /// The child table's foreign-key columns, in constraint order.
    pub columns: Vec<String>,
    /// This table's referenced columns, parallel to `columns`.
    pub ref_columns: Vec<String>,
    /// The `ON DELETE` action on the child's constraint; `None` if unknown.
    pub on_delete: Option<String>,
}

/// One column of a table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// Declared type as written in the DDL (may be empty — SQLite allows
    /// untyped columns). A display label, never for logic.
    pub data_type: String,
    /// True when the column has no NOT NULL constraint declared.
    pub nullable: bool,
    /// True when the column is part of the primary key (composite pks mark
    /// every member column).
    pub pk: bool,
    /// The column's DEFAULT expression, verbatim as the engine reports it
    /// (SQLite's `PRAGMA table_info.dflt_value`), or `None` when the column
    /// has no default. The value is the literal SQL text of the default
    /// (e.g. `"0"`, `"'pending'"`, `"CURRENT_TIMESTAMP"`) — a display/round-trip
    /// value, never re-quoted. M8's structure editor reads this for the
    /// "Default" cell and rebuilds preserve it. Field is named `default_value`
    /// because `default` is a Rust keyword; the wire name is `default`.
    #[serde(rename = "default")]
    pub default_value: Option<String>,
    /// The foreign-key target, when this column references another table.
    pub fk: Option<FkRef>,
}

/// The target of a foreign-key reference: a column in another table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FkRef {
    pub table: String,
    pub column: String,
}

/// Column metadata accompanying a query result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Best-effort type label (declared type for SQLite; may be empty for
    /// computed expressions). A hint for display, never for logic.
    pub type_hint: String,
}
