//! Pure, driver-light helpers for the ClickHouse adapter: backtick identifier
//! quoting, the generic/Postgres → ClickHouse type map, `CREATE TABLE` DDL
//! generation (ENGINE + ORDER BY sort key + optional PARTITION BY, `Nullable(…)`
//! wrapping, secondary indexes as `ALTER TABLE … ADD INDEX`), WHERE/ORDER-BY
//! compilation, numeric-type detection, and version formatting. Everything here
//! is unit-testable without a live server; the live HTTP execution lives in
//! `super` (`http.rs` / `mod.rs`).
//!
//! # Value binding model
//!
//! ClickHouse has no generic prepared-statement parameter binding the way
//! Postgres/MySQL/SQL Server do (its `param_x` mechanism needs the placeholder's
//! type spelled out, which a dynamic browser can't know). The official
//! `clickhouse` crate renders `?`-bound values into the SQL as *escaped
//! literals* — so that is what we do too, in [`ch_literal`]: strings are
//! single-quoted with `\` and `'` C-style-escaped, numbers are numeric-only, and
//! booleans render as `1`/`0`. An injection payload in a string value is fully
//! escaped and can never break out of its literal, giving the same no-injection
//! guarantee the placeholder adapters get. The raw "Edit as SQL" filter mode is
//! the one documented interpolation escape hatch (identical threat model to the
//! other adapters and the M6 query editor).

use crate::shared::engine::{
    ColumnInfo, Condition, FilterOp, FilterSpec, FilterValue, IndexInfo, SortSpec,
};
use crate::shared::error::AppError;

/// Quote an identifier for ClickHouse: wrap in backticks, backslash-escaping an
/// embedded backtick or backslash. This is ClickHouse's delimited-identifier
/// rule (the analogue of MySQL backticks / SQL Server brackets).
pub fn quote_ident(ident: &str) -> String {
    let escaped = ident.replace('\\', "\\\\").replace('`', "\\`");
    format!("`{escaped}`")
}

/// `` `database`.`table` `` — both identifiers backtick-quoted. In ClickHouse a
/// "schema" is a database; unqualified names resolve against the connection's
/// default database.
pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

/// Render a ClickHouse string literal: single-quoted with `\` and `'`
/// C-style-escaped (`\\`, `\'`). The one place user text becomes SQL — see the
/// module note on the injection guarantee.
pub fn ch_string_literal(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

/// Render a JSON scalar as a ClickHouse SQL literal for a comparison/SET operand.
/// NULL becomes the SQL keyword `NULL`; booleans `1`/`0`; numbers verbatim
/// (numeric-only, no injection surface); strings an escaped string literal.
/// Arrays/objects fall back to their escaped JSON text so the engine — not a
/// panic — decides.
pub fn ch_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => ch_string_literal(s),
        other => ch_string_literal(&other.to_string()),
    }
}

/// Map a generic/Postgres-ish declared type to its ClickHouse equivalent,
/// wrapping in `Nullable(…)` when the column is nullable and not already
/// nullable. Mirrors the prototype's `toClickHouseType` (`structure.jsx`): a
/// value already spelled as a ClickHouse type (`UInt64`, `LowCardinality(String)`,
/// `Array(...)`, …) passes through unchanged.
pub fn to_clickhouse_type(raw: &str, nullable: bool) -> String {
    let t = raw.trim().to_ascii_uppercase();
    let base: String = if regex_bool(&t) {
        "Bool".into()
    } else if t == "TEXT" || t.starts_with("VARCHAR") || t.starts_with("CHAR") {
        "String".into()
    } else if t == "JSON" || t == "JSONB" {
        "JSON".into()
    } else if t == "UUID" {
        "UUID".into()
    } else if t == "TIMESTAMPTZ" || t == "TIMESTAMP" || t == "DATETIME" {
        "DateTime64(3, 'UTC')".into()
    } else if t == "DATE" {
        "Date".into()
    } else if t == "SMALLINT" {
        "Int16".into()
    } else if t == "INT" || t == "INTEGER" || t == "SERIAL" {
        "Int32".into()
    } else if t == "BIGINT" || t == "BIGSERIAL" {
        "Int64".into()
    } else if t == "DOUBLE PRECISION" {
        "Float64".into()
    } else if t == "REAL" {
        "Float32".into()
    } else if t == "BYTEA" {
        "String".into()
    } else if let Some(inner) = numeric_precision(&t) {
        match inner {
            Some(args) => format!("Decimal({args})"),
            None => "Decimal(18, 2)".into(),
        }
    } else {
        // Already a ClickHouse type — pass through verbatim (original casing).
        raw.trim().to_string()
    };
    if nullable && !base.starts_with("Nullable(") {
        format!("Nullable({base})")
    } else {
        base
    }
}

/// `BOOL` / `BOOLEAN` matcher (no real regex dependency in the tree).
fn regex_bool(t: &str) -> bool {
    t == "BOOL" || t == "BOOLEAN"
}

/// If `t` is `NUMERIC`/`DECIMAL` (optionally with a `(p,s)` suffix), return
/// `Some(Some("p, s"))` when a suffix is present, `Some(None)` when bare, and
/// `None` when it is not a numeric/decimal type at all.
fn numeric_precision(t: &str) -> Option<Option<String>> {
    let base = t.split('(').next().unwrap_or(t).trim();
    if base != "NUMERIC" && base != "DECIMAL" {
        return None;
    }
    match (t.find('('), t.find(')')) {
        (Some(open), Some(close)) if close > open + 1 => {
            Some(Some(t[open + 1..close].trim().to_string()))
        }
        _ => Some(None),
    }
}

/// A column for [`generate_table_ddl`], distilled from [`ColumnInfo`].
//
// The DDL generator + its helpers back the create-table DDL preview (the
// analogue of the prototype's `generateClickHouseDDL`) and are exercised by the
// unit tests; the live Structure/DDL tab prefers server-rendered
// `SHOW CREATE TABLE` (see `introspect`), so these have no non-test caller yet.
#[allow(dead_code)]
pub struct DdlColumn<'a> {
    pub name: &'a str,
    pub data_type: &'a str,
    pub nullable: bool,
    pub pk: bool,
    pub default: Option<&'a str>,
    pub comment: Option<&'a str>,
}

#[allow(dead_code)]
impl<'a> From<&'a ColumnInfo> for DdlColumn<'a> {
    fn from(c: &'a ColumnInfo) -> Self {
        Self {
            name: &c.name,
            data_type: &c.data_type,
            nullable: c.nullable,
            pk: c.pk,
            default: c.default_value.as_deref(),
            comment: c.comment.as_deref(),
        }
    }
}

/// Rewrite a generic/Postgres DEFAULT expression to its ClickHouse form
/// (`now()`, `generateUUIDv4()`, `true/false` → `1/0`). Mirrors the prototype.
#[allow(dead_code)]
fn clickhouse_default(raw: &str) -> String {
    let d = raw.trim();
    let up = d.to_ascii_uppercase();
    if up == "NOW()" || up == "CURRENT_TIMESTAMP" {
        "now()".into()
    } else if up == "GEN_RANDOM_UUID()" || up == "UUID_GENERATE_V4()" {
        "generateUUIDv4()".into()
    } else if up == "TRUE" {
        "1".into()
    } else if up == "FALSE" {
        "0".into()
    } else {
        d.to_string()
    }
}

/// Generate ClickHouse `CREATE TABLE` DDL. **No PK/FK constraints** — the table
/// uses a table ENGINE (default `MergeTree`), an `ORDER BY` sort key (the sparse
/// primary index, doubling as the "primary key"), and an optional `PARTITION BY`.
///
/// Faithful port of the prototype `generateClickHouseDDL` (`structure.jsx`),
/// including the fixed bug: the `CREATE` is terminated with a single `;` BEFORE
/// the secondary indexes are appended as separate `ALTER TABLE … ADD INDEX …;`
/// statements — never double-terminated.
///
/// `order_by` wins if non-empty; else the pk columns; else the first column.
#[allow(dead_code)]
pub fn generate_table_ddl(
    table: &str,
    columns: &[DdlColumn<'_>],
    indexes: &[IndexInfo],
    engine: Option<&str>,
    order_by: &[String],
    partition_by: Option<&str>,
) -> String {
    let eng = engine
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .unwrap_or("MergeTree");

    let pk_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.to_string())
        .collect();
    let order_cols: Vec<String> = if !order_by.is_empty() {
        order_by.to_vec()
    } else if !pk_cols.is_empty() {
        pk_cols
    } else {
        columns
            .first()
            .map(|c| c.name.to_string())
            .into_iter()
            .collect()
    };

    let lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut l = format!(
                "    {} {}",
                c.name,
                to_clickhouse_type(c.data_type, c.nullable && !c.pk)
            );
            if let Some(d) = c.default.filter(|d| !d.is_empty()) {
                l.push_str(&format!(" DEFAULT {}", clickhouse_default(d)));
            }
            if let Some(comment) = c.comment.filter(|c| !c.is_empty()) {
                l.push_str(&format!(" COMMENT {}", ch_string_literal(comment)));
            }
            l
        })
        .collect();

    let mut ddl = format!(
        "CREATE TABLE {table}\n(\n{}\n)\nENGINE = {eng}{}",
        lines.join(",\n"),
        if eng.contains("MergeTree") { "()" } else { "" }
    );
    if let Some(p) = partition_by.filter(|p| !p.is_empty()) {
        ddl.push_str(&format!("\nPARTITION BY {p}"));
    }
    if !order_cols.is_empty() {
        let by = if order_cols.len() > 1 {
            format!("({})", order_cols.join(", "))
        } else {
            order_cols[0].clone()
        };
        ddl.push_str(&format!("\nORDER BY {by}"));
    }
    // Single terminating `;` on the CREATE — BEFORE appending secondary indexes
    // as their own ALTER statements. (Do NOT double-terminate; that was the
    // prototype bug this port preserves the fix for.)
    ddl.push(';');
    for ix in indexes.iter().filter(|i| !i.primary) {
        ddl.push_str(&format!(
            "\n\nALTER TABLE {table} ADD INDEX {} ({}) TYPE minmax GRANULARITY 4;",
            ix.name,
            ix.columns.join(", ")
        ));
    }
    ddl
}

// ---------------------------------------------------------------------------
// WHERE-clause compilation (escaped literals)
// ---------------------------------------------------------------------------

/// A compiled WHERE clause body (without the `WHERE` keyword). `None` means "no
/// predicate" (an empty structured filter), rendered as no WHERE clause at all.
/// Unlike the placeholder adapters this carries no separate params list — values
/// are rendered inline as escaped literals (see the module note).
pub fn where_clause(
    valid_columns: &[String],
    table: &str,
    filter: &FilterSpec,
) -> Result<Option<String>, AppError> {
    match filter {
        FilterSpec::Raw { sql } => {
            let trimmed = sql.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(format!("({trimmed})")))
            }
        }
        FilterSpec::Conditions { items, combinator } => {
            let mut fragments = Vec::with_capacity(items.len());
            for condition in items {
                fragments.push(condition_sql(valid_columns, table, condition)?);
            }
            if fragments.is_empty() {
                return Ok(None);
            }
            let joiner = format!(" {} ", combinator.sql_keyword());
            Ok(Some(fragments.join(&joiner)))
        }
    }
}

fn condition_sql(
    valid_columns: &[String],
    table: &str,
    condition: &Condition,
) -> Result<String, AppError> {
    validate_column(valid_columns, table, &condition.column)?;
    let col = quote_ident(&condition.column);

    match condition.op {
        FilterOp::IsNull => Ok(format!("{col} IS NULL")),
        FilterOp::IsNotNull => Ok(format!("{col} IS NOT NULL")),
        FilterOp::Eq
        | FilterOp::Ne
        | FilterOp::Gt
        | FilterOp::Gte
        | FilterOp::Lt
        | FilterOp::Lte => {
            let value = require_scalar(condition)?;
            let literal = operand_literal(value, condition.binary)?;
            let operator = match condition.op {
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
                FilterOp::Gt => ">",
                FilterOp::Gte => ">=",
                FilterOp::Lt => "<",
                FilterOp::Lte => "<=",
                _ => unreachable!("comparison arm"),
            };
            Ok(format!("{col} {operator} {literal}"))
        }
        FilterOp::Contains | FilterOp::NotContains | FilterOp::BeginsWith | FilterOp::EndsWith => {
            let value = require_scalar(condition)?;
            let text = like_operand(value)?;
            let escaped = escape_like(&text);
            let pattern = match condition.op {
                FilterOp::Contains | FilterOp::NotContains => format!("%{escaped}%"),
                FilterOp::BeginsWith => format!("{escaped}%"),
                FilterOp::EndsWith => format!("%{escaped}"),
                _ => unreachable!("like arm"),
            };
            let keyword = if matches!(condition.op, FilterOp::NotContains) {
                "NOT LIKE"
            } else {
                "LIKE"
            };
            // Cast to String so LIKE works on non-text columns too, matching the
            // lax affinity the other adapters give the `contains` family.
            Ok(format!(
                "toString({col}) {keyword} {}",
                ch_string_literal(&pattern)
            ))
        }
        FilterOp::InList => {
            let values = match &condition.value {
                Some(FilterValue::List(values)) => values,
                Some(FilterValue::Scalar(_)) => {
                    return Err(AppError::Database(format!(
                        "The 'in list' filter on '{}' needs a list of values.",
                        condition.column
                    )));
                }
                None => return Err(missing_value_error(condition)),
            };
            if values.is_empty() {
                return Err(AppError::Database(format!(
                    "The 'in list' filter on '{}' needs at least one value.",
                    condition.column
                )));
            }
            let mut literals = Vec::with_capacity(values.len());
            for value in values {
                literals.push(operand_literal(value, condition.binary)?);
            }
            Ok(format!("{col} IN ({})", literals.join(", ")))
        }
    }
}

/// Render a comparison/`IN` operand as a ClickHouse literal. Binary operands
/// (a `0x`-hex / UUID string) render as `unhex('…')`; a NULL operand is rejected
/// (`= NULL` never matches — the §5 "use IS NULL / IS NOT NULL" rule).
fn operand_literal(value: &serde_json::Value, binary: bool) -> Result<String, AppError> {
    if value.is_null() {
        return Err(AppError::Database(
            "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
        ));
    }
    if binary {
        let hex = match crate::shared::engine::parse_binary_value(value)? {
            Some(bytes) => bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            None => {
                return Err(AppError::Database(
                    "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
                ))
            }
        };
        return Ok(format!("unhex('{hex}')"));
    }
    match value {
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(AppError::Database(
            "A filter value must be a single text, number, or boolean.".to_string(),
        )),
        other => Ok(ch_literal(other)),
    }
}

fn require_scalar(condition: &Condition) -> Result<&serde_json::Value, AppError> {
    match &condition.value {
        Some(FilterValue::Scalar(value)) => Ok(value),
        Some(FilterValue::List(_)) => Err(AppError::Database(format!(
            "The filter on '{}' expects a single value, not a list.",
            condition.column
        ))),
        None => Err(missing_value_error(condition)),
    }
}

fn missing_value_error(condition: &Condition) -> AppError {
    AppError::Database(format!(
        "The filter on '{}' needs a value.",
        condition.column
    ))
}

fn like_operand(value: &serde_json::Value) -> Result<String, AppError> {
    match value {
        serde_json::Value::Null => Err(AppError::Database(
            "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
        )),
        serde_json::Value::String(s) => Ok(s.clone()),
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(AppError::Database(
            "A filter value must be a single text, number, or boolean.".to_string(),
        )),
    }
}

/// Escape the LIKE metacharacters (`%`, `_`) and the escape char itself so a
/// user's value matches literally. ClickHouse `LIKE` uses `\` as the escape
/// character by default (no `ESCAPE` clause needed).
pub fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Build the validated, quoted ORDER BY body for a single-column sort:
/// `` `column` ASC|DESC ``. The column MUST exist (else a §5 error); the
/// direction is the enum's fixed keyword, never a caller string.
pub fn order_by_clause(
    valid_columns: &[String],
    table: &str,
    sort: &SortSpec,
) -> Result<String, AppError> {
    validate_column(valid_columns, table, &sort.column)?;
    Ok(format!(
        "{} {}",
        quote_ident(&sort.column),
        sort.direction.sql_keyword()
    ))
}

/// Validate that `column` is a real column of the table (§5 error otherwise).
pub fn validate_column(
    valid_columns: &[String],
    table: &str,
    column: &str,
) -> Result<(), AppError> {
    if valid_columns.iter().any(|c| c == column) {
        return Ok(());
    }
    Err(AppError::Database(format!(
        "Column '{column}' does not exist on '{table}' (columns: {}).",
        valid_columns.join(", ")
    )))
}

/// Whether a ClickHouse type name denotes a numeric column (drives the
/// column-insights numeric display and `avg`). `Nullable(...)` / `LowCardinality(...)`
/// wrappers and any `(...)` suffix are unwrapped first. `Bool` counts (0/1).
pub fn is_numeric_type(data_type: &str) -> bool {
    let mut t = data_type.trim();
    // Unwrap Nullable(...) / LowCardinality(...) once each.
    for wrapper in ["Nullable(", "LowCardinality("] {
        if let Some(rest) = t.strip_prefix(wrapper) {
            t = rest.strip_suffix(')').unwrap_or(rest);
        }
    }
    let base = t.split('(').next().unwrap_or(t).trim();
    base.starts_with("Int")
        || base.starts_with("UInt")
        || base.starts_with("Float")
        || base.starts_with("Decimal")
        || base == "Bool"
}

/// Format a `SELECT version()` string (e.g. `"24.8.2.3"`) for the sidebar header
/// as `"ClickHouse 24.8"` — the leading `major.minor` kept.
pub fn display_version(raw: &str) -> String {
    let token = raw.split_whitespace().next().unwrap_or(raw).trim();
    let mut parts = token.split('.');
    match (parts.next(), parts.next()) {
        (Some(major), Some(minor)) if !major.is_empty() => {
            format!("ClickHouse {major}.{minor}")
        }
        (Some(major), None) if !major.is_empty() => format!("ClickHouse {major}"),
        _ => "ClickHouse".to_string(),
    }
}

#[cfg(test)]
mod tests {
    //! Pure-dialect unit tests for the ClickHouse adapter: identifier quoting, the
    //! type map, `CREATE TABLE` DDL generation (incl. the secondary-index
    //! double-semicolon regression), the WHERE compiler (injection safety), numeric
    //! classification, and version formatting. No live server.

    use super::*;
    use crate::shared::engine::{
        Combinator, Condition, FilterOp, FilterSpec, FilterValue, IndexInfo, SortDirection,
        SortSpec,
    };

    fn col(name: &str, ty: &str, nullable: bool, pk: bool) -> DdlColumn<'static> {
        // Leak the &str so the borrow lives for the test — fine in a #[cfg(test)].
        DdlColumn {
            name: Box::leak(name.to_string().into_boxed_str()),
            data_type: Box::leak(ty.to_string().into_boxed_str()),
            nullable,
            pk,
            default: None,
            comment: None,
        }
    }

    fn cols() -> Vec<String> {
        vec![
            "id".to_string(),
            "name".to_string(),
            "qty".to_string(),
            "weird`name".to_string(),
        ]
    }

    #[test]
    fn quote_ident_wraps_and_escapes_backtick() {
        assert_eq!(quote_ident("users"), "`users`");
        assert_eq!(quote_ident("a`b"), "`a\\`b`");
        // Injection attempt neutralised: the backtick is escaped, so it cannot
        // break out of the identifier.
        assert_eq!(
            quote_ident("x`; DROP TABLE t; --"),
            "`x\\`; DROP TABLE t; --`"
        );
    }

    #[test]
    fn qualified_quotes_both_parts() {
        assert_eq!(qualified("analytics", "events"), "`analytics`.`events`");
    }

    #[test]
    fn ch_string_literal_escapes_quote_and_backslash() {
        assert_eq!(ch_string_literal("ada"), "'ada'");
        assert_eq!(ch_string_literal("a'b"), "'a\\'b'");
        assert_eq!(ch_string_literal("c\\d"), "'c\\\\d'");
        // An injection payload is fully escaped inside the literal.
        assert_eq!(
            ch_string_literal("'; DROP TABLE t; --"),
            "'\\'; DROP TABLE t; --'"
        );
    }

    #[test]
    fn type_map_covers_generic_and_postgres_types() {
        assert_eq!(to_clickhouse_type("BOOLEAN", false), "Bool");
        assert_eq!(to_clickhouse_type("text", false), "String");
        assert_eq!(to_clickhouse_type("varchar(64)", false), "String");
        assert_eq!(to_clickhouse_type("char(2)", false), "String");
        assert_eq!(to_clickhouse_type("JSON", false), "JSON");
        assert_eq!(to_clickhouse_type("uuid", false), "UUID");
        assert_eq!(
            to_clickhouse_type("timestamptz", false),
            "DateTime64(3, 'UTC')"
        );
        assert_eq!(
            to_clickhouse_type("DATETIME", false),
            "DateTime64(3, 'UTC')"
        );
        assert_eq!(to_clickhouse_type("date", false), "Date");
        assert_eq!(to_clickhouse_type("smallint", false), "Int16");
        assert_eq!(to_clickhouse_type("int", false), "Int32");
        assert_eq!(to_clickhouse_type("integer", false), "Int32");
        assert_eq!(to_clickhouse_type("serial", false), "Int32");
        assert_eq!(to_clickhouse_type("bigint", false), "Int64");
        assert_eq!(to_clickhouse_type("real", false), "Float32");
        assert_eq!(to_clickhouse_type("double precision", false), "Float64");
        assert_eq!(to_clickhouse_type("bytea", false), "String");
        assert_eq!(to_clickhouse_type("numeric(10,2)", false), "Decimal(10,2)");
        assert_eq!(to_clickhouse_type("decimal", false), "Decimal(18, 2)");
        // Already a ClickHouse type — passes through unchanged.
        assert_eq!(to_clickhouse_type("UInt64", false), "UInt64");
        assert_eq!(
            to_clickhouse_type("LowCardinality(String)", false),
            "LowCardinality(String)"
        );
    }

    #[test]
    fn type_map_wraps_nullable_but_not_pk_or_already_nullable() {
        assert_eq!(to_clickhouse_type("int", true), "Nullable(Int32)");
        assert_eq!(to_clickhouse_type("text", true), "Nullable(String)");
        // Already Nullable → not double-wrapped.
        assert_eq!(
            to_clickhouse_type("Nullable(Int64)", true),
            "Nullable(Int64)"
        );
    }

    #[test]
    fn generate_ddl_no_secondary_index_single_terminator() {
        let columns = vec![
            col("id", "bigint", false, true),
            col("status", "text", true, false),
        ];
        let ddl = generate_table_ddl("orders", &columns, &[], None, &[], None);
        let expected = "\
CREATE TABLE orders
(
    id Int64,
    status Nullable(String)
)
ENGINE = MergeTree()
ORDER BY id;";
        assert_eq!(ddl, expected);
        // Exactly one terminating semicolon.
        assert_eq!(ddl.matches(';').count(), 1);
    }

    #[test]
    fn generate_ddl_with_secondary_index_no_double_semicolon() {
        // REGRESSION: the CREATE is terminated with a single `;` BEFORE the ALTER …
        // ADD INDEX is appended — never `;;`.
        let columns = vec![
            col("id", "bigint", false, true),
            col("kind", "text", false, false),
        ];
        let indexes = vec![IndexInfo {
            name: "idx_kind".into(),
            columns: vec!["kind".into()],
            unique: false,
            primary: false,
            origin: None,
        }];
        let ddl = generate_table_ddl("events", &columns, &indexes, None, &[], None);
        assert!(!ddl.contains(";;"), "must not double-terminate: {ddl}");
        assert!(ddl.contains("ENGINE = MergeTree()\nORDER BY id;"));
        assert!(ddl.contains(
            "\n\nALTER TABLE events ADD INDEX idx_kind (kind) TYPE minmax GRANULARITY 4;"
        ));
        // Two statements → exactly two terminating semicolons.
        assert_eq!(ddl.matches(';').count(), 2);
    }

    #[test]
    fn generate_ddl_honours_engine_partition_and_order() {
        let columns = vec![
            col("kind", "text", false, false),
            col("ts", "timestamptz", false, false),
        ];
        let ddl = generate_table_ddl(
            "events",
            &columns,
            &[],
            Some("SummingMergeTree"),
            &["kind".to_string(), "ts".to_string()],
            Some("toYYYYMM(ts)"),
        );
        assert!(ddl.contains("ENGINE = SummingMergeTree()"));
        assert!(ddl.contains("PARTITION BY toYYYYMM(ts)"));
        assert!(ddl.contains("ORDER BY (kind, ts)"));
    }

    #[test]
    fn generate_ddl_rewrites_defaults() {
        let mut id = col("id", "uuid", false, true);
        id.default = Some("gen_random_uuid()");
        let mut created = col("created_at", "timestamptz", false, false);
        created.default = Some("now()");
        let mut active = col("active", "boolean", false, false);
        active.default = Some("true");
        let ddl = generate_table_ddl("t", &[id, created, active], &[], None, &[], None);
        assert!(ddl.contains("id UUID DEFAULT generateUUIDv4()"));
        assert!(ddl.contains("created_at DateTime64(3, 'UTC') DEFAULT now()"));
        assert!(ddl.contains("active Bool DEFAULT 1"));
    }

    #[test]
    fn generate_ddl_falls_back_to_first_column_when_no_pk_or_order() {
        let columns = vec![col("a", "int", false, false), col("b", "int", false, false)];
        let ddl = generate_table_ddl("t", &columns, &[], None, &[], None);
        assert!(ddl.contains("ORDER BY a;"));
    }

    #[test]
    fn where_clause_empty_is_no_predicate() {
        let spec = FilterSpec::Conditions {
            items: vec![],
            combinator: Combinator::And,
        };
        assert_eq!(where_clause(&cols(), "t", &spec).unwrap(), None);
    }

    #[test]
    fn where_clause_comparison_renders_escaped_literal() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "qty".into(),
                op: FilterOp::Gte,
                value: Some(FilterValue::Scalar(serde_json::json!(10))),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        assert_eq!(
            where_clause(&cols(), "t", &spec).unwrap().as_deref(),
            Some("`qty` >= 10")
        );
    }

    #[test]
    fn where_clause_multiple_conditions_join_with_combinator() {
        let spec = FilterSpec::Conditions {
            items: vec![
                Condition {
                    column: "name".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!("ada"))),
                    binary: false,
                },
                Condition {
                    column: "id".into(),
                    op: FilterOp::InList,
                    value: Some(FilterValue::List(vec![
                        serde_json::json!(1),
                        serde_json::json!(2),
                    ])),
                    binary: false,
                },
            ],
            combinator: Combinator::And,
        };
        assert_eq!(
            where_clause(&cols(), "t", &spec).unwrap().as_deref(),
            Some("`name` = 'ada' AND `id` IN (1, 2)")
        );
    }

    #[test]
    fn where_clause_contains_casts_and_escapes() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "name".into(),
                op: FilterOp::Contains,
                value: Some(FilterValue::Scalar(serde_json::json!("a%b"))),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        // The `%` is LIKE-escaped to `\%`, then the backslash is string-escaped to
        // `\\` inside the literal — so ClickHouse sees the pattern `%a\%b%` (a
        // literal `%` in the middle), matching the user's intent.
        assert_eq!(
            where_clause(&cols(), "t", &spec).unwrap().as_deref(),
            Some("toString(`name`) LIKE '%a\\\\%b%'")
        );
    }

    #[test]
    fn injection_payload_renders_as_a_literal_not_sql() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "name".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!(
                    "'; DROP TABLE t; --"
                ))),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        assert_eq!(
            where_clause(&cols(), "t", &spec).unwrap().as_deref(),
            Some("`name` = '\\'; DROP TABLE t; --'")
        );
    }

    #[test]
    fn where_clause_raw_mode_interpolates_verbatim() {
        let spec = FilterSpec::Raw {
            sql: "qty > 100 AND name = 'ada'".into(),
        };
        assert_eq!(
            where_clause(&cols(), "t", &spec).unwrap().as_deref(),
            Some("(qty > 100 AND name = 'ada')")
        );
        let empty = FilterSpec::Raw { sql: "  ".into() };
        assert_eq!(where_clause(&cols(), "t", &empty).unwrap(), None);
    }

    #[test]
    fn where_clause_unknown_column_is_a_human_error() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "ghost".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!(1))),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        let err = where_clause(&cols(), "t", &spec).unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("ghost"));
    }

    #[test]
    fn order_by_validates_and_quotes() {
        let sort = SortSpec {
            column: "name".into(),
            direction: SortDirection::Desc,
        };
        assert_eq!(order_by_clause(&cols(), "t", &sort).unwrap(), "`name` DESC");
        let bad = SortSpec {
            column: "nope".into(),
            direction: SortDirection::Asc,
        };
        assert!(matches!(
            order_by_clause(&cols(), "t", &bad),
            Err(AppError::Database(_))
        ));
    }

    #[test]
    fn is_numeric_type_classifies_clickhouse_types() {
        for t in [
            "UInt8",
            "Int64",
            "Float32",
            "Float64",
            "Decimal(18, 2)",
            "Bool",
            "Nullable(Int32)",
            "LowCardinality(Float64)",
        ] {
            assert!(is_numeric_type(t), "{t} should be numeric");
        }
        for t in [
            "String",
            "FixedString(16)",
            "Date",
            "DateTime64(3, 'UTC')",
            "UUID",
            "Array(String)",
            "Nullable(String)",
        ] {
            assert!(!is_numeric_type(t), "{t} should not be numeric");
        }
    }

    #[test]
    fn display_version_keeps_major_minor() {
        assert_eq!(display_version("24.8.2.3"), "ClickHouse 24.8");
        assert_eq!(display_version("23.3"), "ClickHouse 23.3");
        assert_eq!(display_version("24"), "ClickHouse 24");
        assert_eq!(display_version(""), "ClickHouse");
    }
}
