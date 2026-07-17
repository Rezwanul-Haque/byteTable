// Row-mutation request & result types (update cell, delete rows, alter batch).

use serde::{Deserialize, Serialize};

use super::*;

/// One primary-key predicate in an [`UpdateCellRequest`]: a pk column and the
/// value identifying the target row. A composite primary key needs one
/// [`PkPredicate`] per pk column; the adapter ANDs them all so the WHERE clause
/// matches exactly one row.
///
/// Security: `column` is a real column name the adapter MUST validate — both
/// that it exists AND that it is part of the table's real primary key (a §5
/// error otherwise). `value` is *bound* as a parameter, never interpolated, so
/// an injection payload binds as an inert literal that simply matches nothing.
/// A `null` pk value is a no-match (`= NULL` is never true in SQL) — pks are
/// non-null in normal use (see the SQLite adapter).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkPredicate {
    pub column: String,
    /// The pk value identifying the row, as a JSON scalar. Bound as a parameter.
    pub value: serde_json::Value,
    /// True when this pk column is a binary type — the value (a `0x`-hex or UUID
    /// string) is then bound as raw bytes so the `WHERE pk = ?` matches a binary
    /// key. Defaults false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
}

/// A request to update a single cell (M11 inline edit, DESIGN_SPEC §3.5): set
/// `column` to `value` on the one row identified by the primary key.
///
/// **This MUTATES user data.** The safety contract (enforced by the adapter):
///
/// - `pk` must cover the table's FULL primary key — every pk column, no more,
///   no fewer. A table with no pk, a partial pk, or a `pk` predicate naming a
///   non-pk column is a §5 error. This guarantees the WHERE clause targets at
///   most one row (mass-update prevention).
/// - `value` is the new cell value and is *bound* as a parameter (`SET col =
///   ?`), so it can be `null` (→ `SET col = NULL`, which a bound NULL handles
///   correctly) and any string — including SQL syntax — is stored as a literal,
///   never executed.
/// - Every pk value is likewise *bound*. Nothing the caller supplies is
///   interpolated; only validated, quoted identifiers are.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCellRequest {
    pub schema: String,
    pub table: String,
    /// The column whose cell is updated (validated against the table).
    pub column: String,
    /// The new value. Bound as a parameter; `null` sets the cell to NULL.
    pub value: serde_json::Value,
    /// True when `column` is a binary type — `value` (a `0x`-hex or UUID string)
    /// is then bound as raw bytes so `SET col = ?` writes the right bytes.
    /// Defaults false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
    /// The full primary key of the target row, one predicate per pk column.
    pub pk: Vec<PkPredicate>,
}

/// The outcome of an [`EngineConnection::update_cell`] call (M11 inline edit):
/// the number of rows changed and a cosmetic statement string for the §3.5
/// "toast with the executed statement".
///
/// `statement` is a **display** rendering of the UPDATE with its values shown
/// inline (e.g. `UPDATE "main"."users" SET "name" = 'Ada' WHERE "id" = 42`) so
/// the toast reads naturally. It is NOT the verbatim string sent to the engine:
/// the real query is fully parameterized (`SET "name" = ? WHERE "id" = ?`) with
/// every value bound. The two are equivalent in effect, never in form — the
/// executed query never interpolates a value (see [`UpdateCellRequest`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    /// Rows changed by the UPDATE. The adapter guarantees this is exactly `1`
    /// on success (0 → "no row matched" §5 error; >1 → rolled back §5 error).
    pub affected: u64,
    /// A human-readable, values-inlined rendering of the statement for the
    /// toast. Cosmetic only — the executed query binds every value (see the
    /// type docs).
    pub statement: String,
}

/// A request to delete a set of whole rows by primary key (grid multi-select
/// bulk delete). Each entry in `rows` is the FULL primary key of one target row
/// (one [`PkPredicate`] per pk column), so every DELETE targets at most one row.
/// Same safety contract as [`UpdateCellRequest`]: pk columns are validated, every
/// value is bound (never interpolated), and the whole batch runs in one
/// transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRowsRequest {
    pub schema: String,
    pub table: String,
    /// One full primary key per row to delete.
    pub rows: Vec<Vec<PkPredicate>>,
}

/// The outcome of a [`EngineConnection::delete_rows`] call: the number of rows
/// actually removed (rows that had already vanished count as 0, not an error).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRowsResult {
    pub deleted: u64,
}

/// The outcome of an `alter_table` call (M8 structure editor). Carries the
/// SQL statements the batch implies (for the "Review SQL" panel) and whether
/// they were actually executed.
///
/// Preview (`apply == false`) and apply (`apply == true`) return the SAME
/// `statements` list so the user reviews exactly what apply will do — with one
/// documented caveat for SQLite (see [`EngineConnection::alter_table`]): the
/// statements are the *logical* intent (e.g. `ALTER TABLE … ALTER COLUMN …
/// TYPE …`), which SQLite cannot run natively for type/nullable/default
/// changes; apply realizes those via a table rebuild. The preview SQL is the
/// engine-agnostic display the prototype shows, not necessarily the verbatim
/// SQL the engine runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterResult {
    /// The statement strings the batch implies, in order — the "Review SQL"
    /// list. Always populated (preview and apply alike).
    pub statements: Vec<String>,
    /// True when the statements were executed (`apply == true` and the whole
    /// batch committed); false for a preview.
    pub applied: bool,
}
