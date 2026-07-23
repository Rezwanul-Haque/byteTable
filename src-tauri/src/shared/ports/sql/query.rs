// Query execution + fetch / filter / sort / column-stats request & result types.

use serde::{Deserialize, Serialize};

use super::*;

/// Options for a single query execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueryOptions {
    /// Maximum rows to return; the adapter reads one extra row to set
    /// `QueryResult::truncated`.
    pub row_limit: usize,
    /// Schema context for unqualified names. Server engines apply it
    /// (search_path / USE) in M12; for SQLite it is advisory — unqualified
    /// names resolve per SQLite's own rules (`main` first, then attached).
    pub schema: Option<String>,
}

impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            row_limit: 500,
            schema: None,
        }
    }
}

/// The outcome of a query: column metadata, JSON-mapped rows, and timing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    /// Row-major values. Engine values map to JSON: NULL → null,
    /// integers/reals → numbers, text → strings; integers beyond ±2^53
    /// (JavaScript's safe-integer range) arrive as strings to preserve
    /// precision. Engine-specific types (e.g. blobs) are mapped by the
    /// adapter and documented there.
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    /// True when `row_limit` cut the result short.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// One statement's outcome inside a session-pinned multi-statement run
/// ([`EngineConnection::run_batch`]). Exactly one of `result` / `error` is
/// `Some`: `result` on success, `error` (the §5 human message) on failure. The
/// batch runs every statement on ONE pinned connection, in order, and does NOT
/// stop at the first failure — each statement reports its own outcome so a
/// failing statement never hides the ones after it (mirrors the SQL editor's
/// per-statement result tabs). The renderer maps each of these to a `SqlRun`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementOutcome {
    /// The statement that produced this outcome (the result tab's tooltip).
    pub sql: String,
    /// The result set on success, or `None` when this statement failed.
    pub result: Option<QueryResult>,
    /// The §5 driver message on failure, or `None` on success.
    pub error: Option<String>,
}

/// Sort direction for a single column. Lowercase on the wire ("asc" /
/// "desc"), matching the renderer's `SortDirection` in
/// `src/shared/api/engine.ts`.
///
/// Security: this enum is the *only* thing that drives the ORDER BY
/// direction in [`EngineConnection::fetch_rows`] — adapters emit the literal
/// `ASC`/`DESC` keyword per variant and never interpolate any caller string
/// into the direction, so the sort clause carries no SQL-injection surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    /// The SQL keyword for this direction — a fixed string literal, never
    /// caller-derived (see the type docs on the injection guarantee).
    pub fn sql_keyword(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }
}

/// A single-column sort applied to a browsed table. `column` is a real
/// column name the adapter MUST validate against the table's columns before
/// quoting it into the SQL (an unknown column is a §5 error); `direction`
/// is enum-driven and never interpolated as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub direction: SortDirection,
}

/// The comparison applied by a single structured [`Condition`]. The wire
/// tokens are explicit camelCase strings the renderer's filter builder sends
/// — they map to (but are *not* identical to) the prototype's internal op ids
/// in `bytetable/filters.jsx`. The mapping the renderer must honour:
///
/// | prototype id (filters.jsx) | label        | wire token (this enum) | SQLite |
/// |----------------------------|--------------|------------------------|--------|
/// | `eq`                       | `=`          | `eq`                   | `"c" = ?` |
/// | `neq`                      | `≠`          | `ne`                   | `"c" <> ?` |
/// | `gt`                       | `>`          | `gt`                   | `"c" > ?` |
/// | `gte`                      | `≥`          | `gte`                  | `"c" >= ?` |
/// | `lt`                       | `<`          | `lt`                   | `"c" < ?` |
/// | `lte`                      | `≤`          | `lte`                  | `"c" <= ?` |
/// | `contains`                 | `contains`   | `contains`             | `"c" LIKE ? ESCAPE '\'` (`%v%`) |
/// | `ncontains`                | `not contains` | `notContains`        | `"c" NOT LIKE ? ESCAPE '\'` (`%v%`) |
/// | `begins`                   | `begins with` | `beginsWith`          | `"c" LIKE ? ESCAPE '\'` (`v%`) |
/// | `ends`                     | `ends with`  | `endsWith`             | `"c" LIKE ? ESCAPE '\'` (`%v`) |
/// | `in`                       | `in list`    | `inList`               | `"c" IN (?, ?, …)` |
/// | `null`                     | `is null`    | `isNull`               | `"c" IS NULL` |
/// | `nnull`                    | `is not null` | `isNotNull`           | `"c" IS NOT NULL` |
///
/// Security: this enum is the *only* thing that selects a comparison operator
/// in [`EngineConnection::fetch_rows`] — adapters emit fixed SQL fragments per
/// variant and bind the user's value as a parameter (`?`), never interpolating
/// it. The LIKE family escapes `%`/`_`/`\` in the bound value so user wildcards
/// match literally (see the SQLite adapter).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    NotContains,
    BeginsWith,
    EndsWith,
    InList,
    IsNull,
    IsNotNull,
}

impl FilterOp {
    /// Whether this operator takes a value. The null checks do not; every
    /// other operator requires a non-null [`FilterValue`] (a §5 error
    /// otherwise — see the adapter).
    pub fn needs_value(self) -> bool {
        !matches!(self, Self::IsNull | Self::IsNotNull)
    }
}

/// The value a [`Condition`] compares against. Either a single JSON scalar
/// (string / number / bool) for the comparison and LIKE operators, or a list
/// of scalars for `inList`. `null` values inside are rejected by the adapter
/// with the §5 "use IS NULL / IS NOT NULL" message — SQL `= NULL` never
/// matches, so a NULL comparison is always a mistake.
///
/// Untagged on the wire: a JSON array deserializes to [`FilterValue::List`],
/// anything else (string/number/bool) to [`FilterValue::Scalar`]. Security:
/// every contained value is *bound* as a parameter, never interpolated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    /// A list of scalars for `inList` (`IN (?, ?, …)`).
    List(Vec<serde_json::Value>),
    /// A single scalar for the comparison / LIKE operators.
    Scalar(serde_json::Value),
}

/// One structured filter row: a column, an operator, and (unless the operator
/// is a null check) a value. `column` is a real column name the adapter MUST
/// validate against the table's columns before quoting it — an unknown column
/// is a §5 error, identical to the sort-column check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub column: String,
    pub op: FilterOp,
    /// `None` for `isNull` / `isNotNull`; required for every other operator.
    pub value: Option<FilterValue>,
    /// True when `column` is a binary type (BINARY/VARBINARY/BLOB/BYTEA). The
    /// renderer sets this from the column's type so the value (a `0x`-hex or
    /// UUID string) is bound as raw bytes — comparing bytes-to-bytes — instead
    /// of as a text literal that would never match. Defaults false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
}

/// How structured [`Condition`]s combine into one WHERE clause. Lowercase on
/// the wire ("and" / "or"). The prototype's builder only renders `WHERE … AND
/// …` between rows, so the renderer defaults to `And`; `Or` is supported here
/// so the builder can offer it without a backend change. (Mixed/nested
/// boolean logic is the job of the raw "Edit as SQL" escape hatch.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Combinator {
    And,
    Or,
}

impl Combinator {
    /// The SQL keyword joining conditions — a fixed literal, never
    /// caller-derived.
    pub fn sql_keyword(self) -> &'static str {
        match self {
            Self::And => "AND",
            Self::Or => "OR",
        }
    }
}

/// The filter applied to a browsed table (M5 stackable filter builder). Two
/// mutually exclusive modes, discriminated by `mode` on the wire:
///
/// - `{ "mode": "conditions", "items": [...], "combinator": "and" }` — the
///   structured builder. Every condition compiles to **bound-parameter** SQL;
///   there is no SQL-injection surface (operators are enum-driven, values are
///   bound).
/// - `{ "mode": "raw", "sql": "status = 'paid' AND total > 100" }` — the
///   "Edit as SQL" escape hatch. The string is the body of the WHERE clause
///   and is **interpolated verbatim** (wrapped in parentheses). See the
///   adapter for the explicit threat model: this is an intentional power-user
///   feature on a local-first single-user tool that already grants full SQL
///   access via the query editor (M6), so the only "validation" is execution
///   — a bad clause surfaces as a §5 error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum FilterSpec {
    /// The structured builder: parameterized conditions joined by one
    /// top-level combinator.
    Conditions {
        items: Vec<Condition>,
        combinator: Combinator,
    },
    /// The raw "Edit as SQL" WHERE body, interpolated verbatim (escape hatch).
    Raw { sql: String },
}

/// A request for one page of rows from a table, powering the M4 data grid and
/// the M5 filter builder.
///
/// Scope: paging (`offset`/`limit`), an optional single-column sort, and an
/// optional [`FilterSpec`] (M5). When a filter is present it applies to BOTH
/// the page query and the `COUNT(*)`, so `RowsPage::total_rows` is the
/// *filtered* row count (the "n of N rows" status shows the filtered total).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRowsRequest {
    pub schema: String,
    pub table: String,
    /// Optional single-column sort; `None` leaves row order to the engine.
    pub sort: Option<SortSpec>,
    /// Optional row filter (M5); `None` returns the whole table. Structured
    /// conditions are fully parameterized; the raw mode is a documented
    /// escape hatch (see [`FilterSpec`]).
    #[serde(default)]
    pub filter: Option<FilterSpec>,
    /// Zero-based row offset of the page (bound as a parameter, never
    /// interpolated).
    pub offset: u64,
    /// Maximum rows in the page. Adapters clamp this to their page ceiling.
    pub limit: u32,
}

/// One page of rows from a table: column metadata, JSON-mapped values, the
/// page window, and timing — the data-grid counterpart of [`QueryResult`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsPage {
    pub columns: Vec<ColumnMeta>,
    /// Row-major values, mapped to JSON exactly as [`QueryResult::rows`]
    /// (NULL → null, big integers → strings, blobs → placeholder, …).
    pub rows: Vec<Vec<serde_json::Value>>,
    /// The offset this page was fetched at (echoes the request after any
    /// clamping).
    pub offset: u64,
    /// The effective page size after clamping (echoes the request).
    pub limit: u32,
    /// Exact `COUNT(*)` matching the request: the whole table when the
    /// request carries no filter, the *filtered* count when
    /// [`FetchRowsRequest::filter`] is present (so the renderer's "n of N
    /// rows" status reflects the filter, §3.5).
    ///
    /// Computed per fetch for correctness and simplicity; a later milestone
    /// may cache it or fall back to an engine estimate for very large tables,
    /// at which point this becomes `None` when unknown. `None` today means the
    /// count could not be obtained.
    pub total_rows: Option<u64>,
    pub elapsed_ms: u64,
}

/// A single-row lookup by key (M10 "FK peek", DESIGN_SPEC §3.5): find the
/// row(s) in `table` where `column = value`. The driving use-case is clicking
/// a foreign-key cell to peek at the referenced row — `column` is the
/// *referenced* column (usually the parent's primary key or a unique key), so
/// the match is normally 0 or 1 row.
///
/// Security: `column` is a real column name the adapter MUST validate against
/// the table's columns before quoting it (an unknown column is a §5 error,
/// identical to the sort/filter column check). `value` is *bound as a
/// parameter*, never interpolated — an injection payload binds as a literal
/// that simply matches nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowLookupRequest {
    pub schema: String,
    pub table: String,
    /// The column to match on (the referenced column for an FK peek).
    pub column: String,
    /// The key value to look up, as a JSON scalar. Bound as a parameter.
    /// A `null` value never matches a `=` comparison in SQL, so the adapter
    /// treats a null key as "no match" (`matchCount: 0`) rather than emitting
    /// `IS NULL` — FK keys are non-null in normal use (see the adapter).
    pub value: serde_json::Value,
    /// True when `column` is a binary type — the value (a `0x`-hex / UUID string)
    /// is bound as raw bytes so the FK peek on a binary key matches. Defaults
    /// false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
}

/// The result of a [`RowLookupRequest`] (M10 "FK peek"): the matching row (if
/// any) plus the columns for field labels and the total match count.
///
/// `columns` is ALWAYS returned (even when `row` is `None`) so the UI can show
/// labelled field placeholders for a missing reference. `row` is `None` when
/// nothing matched; otherwise it is the first matching row, mapped to JSON
/// exactly like [`RowsPage::rows`]. `match_count` is the total number of
/// matching rows so the UI can say "1 of N" when the key is not unique.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowLookup {
    pub columns: Vec<ColumnMeta>,
    /// The first matching row, or `None` when nothing matched.
    pub row: Option<Vec<serde_json::Value>>,
    /// Total rows matching `column = value` (so the UI can flag a non-unique
    /// key as "1 of N"). `0` when nothing matched (including a null key).
    pub match_count: u64,
}

/// One value/frequency pair in a column's top-values list ([`ColumnStats`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreqEntry {
    /// The value, mapped to JSON exactly like [`RowsPage::rows`].
    pub value: serde_json::Value,
    /// How many rows (within the filtered set) hold this value.
    pub count: u64,
}

/// A request for per-column statistics (M10 "column insights", DESIGN_SPEC
/// §3.5), computed over the grid's CURRENT FILTERED SET so the insights match
/// what the user sees.
///
/// Security: `column` is validated against the table's columns before quoting
/// (a §5 error otherwise). `filter` reuses the same parameterized
/// [`FilterSpec`] compilation as [`FetchRowsRequest`] — structured-condition
/// values are bound, the raw mode is the documented escape hatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStatsRequest {
    pub schema: String,
    pub table: String,
    pub column: String,
    /// The grid's current filter; `None` (or absent) computes stats over the
    /// whole table.
    #[serde(default)]
    pub filter: Option<FilterSpec>,
}

/// Per-column statistics over a (possibly filtered) row set (M10 "column
/// insights"). All counts respect the request's filter, so they match the
/// grid's visible set.
///
/// `min`/`max` are always returned (lexicographic for text — the UI decides
/// how to display them); `avg` is only meaningful for numeric columns and is
/// `None` otherwise. `numeric` tells the UI whether to render min/max/avg as
/// numbers (see the adapter for the detection heuristic).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStats {
    /// Total rows in the (filtered) set, including NULLs.
    pub total: u64,
    /// Distinct non-NULL values (`count(DISTINCT col)`).
    pub distinct: u64,
    /// Rows whose value is NULL.
    pub nulls: u64,
    /// The minimum value, or `None` when the set has no non-NULL values.
    pub min: Option<serde_json::Value>,
    /// The maximum value, or `None` when the set has no non-NULL values.
    pub max: Option<serde_json::Value>,
    /// The average, only when `numeric` (else `None`).
    pub avg: Option<f64>,
    /// Whether the column holds numeric data (drives numeric display of
    /// min/max/avg). See the adapter for the heuristic.
    pub numeric: bool,
    /// The up-to-five most frequent non-NULL values, most frequent first.
    pub top: Vec<FreqEntry>,
}
