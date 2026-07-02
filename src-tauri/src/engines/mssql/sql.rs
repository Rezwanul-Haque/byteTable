//! Pure, driver-light helpers for the SQL Server (T-SQL) adapter: bracket
//! identifier quoting, `@P{n}`-placeholder WHERE-clause compilation, numeric-type
//! detection, and server-version formatting. Everything here is unit-testable
//! without a live server; the live TDS execution lives in `super` (`mod.rs`).
//!
//! # Why `@P{n}`, not `?` or `$N`
//!
//! The TDS protocol (via `tiberius`) uses named/positional parameters written
//! `@P1, @P2, …` in the SQL text, bound left-to-right in call order — the exact
//! analogue of Postgres' `$1, $2, …`. So, unlike the MySQL adapter's bare `?`,
//! this module threads a running placeholder index. The 13 operators, the LIKE
//! escaping, and the "bind everything" guarantee are otherwise identical to the
//! Postgres/MySQL adapters.
//!
//! # Dialect specifics honoured here
//!
//! - Identifiers are **bracket-quoted** (`[name]`), doubling embedded `]`.
//! - Paging is `OFFSET … ROWS FETCH NEXT … ROWS ONLY` (built in `mod.rs`), which
//!   T-SQL requires an `ORDER BY` for — see `mod.rs`.

use crate::shared::engine::{Condition, FilterOp, FilterSpec, FilterValue, SortSpec};
use crate::shared::error::AppError;

/// JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 − 1). SQL Server `BIGINT` /
/// `DECIMAL` values whose magnitude exceeds this serialize as JSON *strings*,
/// matching the other adapters and the
/// [`crate::shared::engine::QueryResult::rows`] contract (a JSON number would
/// lose precision the moment the renderer parses it).
pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The character used in `ESCAPE '\'` for the LIKE family (matches the SQLite/
/// MySQL/Postgres adapters). A backslash never appears unescaped in our
/// patterns; T-SQL honours an arbitrary `ESCAPE` character, so we state `\`
/// explicitly (T-SQL has no default LIKE escape character).
pub const LIKE_ESCAPE: char = '\\';

/// Quote an identifier for interpolation into T-SQL: wrap in brackets, doubling
/// an embedded closing bracket (`]` → `]]`). This is SQL Server's delimited-
/// identifier rule, the analogue of MySQL backticks / Postgres double-quotes.
pub fn quote_ident(ident: &str) -> String {
    format!("[{}]", ident.replace(']', "]]"))
}

/// `[schema].[table]`, both identifiers bracket-quoted. SQL Server has a real
/// schema layer within a database (default `dbo`), matching the Postgres model.
pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

// ---------------------------------------------------------------------------
// Bound values
// ---------------------------------------------------------------------------

/// A single value bound into a T-SQL query, in the WHERE/paging order the
/// compiled SQL expects. `mod.rs` binds each to the live `tiberius::Query` with
/// the right type. Kept JSON-shaped so this module needs no driver types and
/// stays unit-testable. Identical in spirit to the Postgres/MySQL `BoundValue`.
#[derive(Debug, Clone, PartialEq)]
pub enum BoundValue {
    Null,
    Bool(bool),
    /// An integer that fits i64 (tinyint/smallint/int/bigint comparisons,
    /// offset/fetch).
    Int(i64),
    /// A floating value (float/real, or a decimal compared as a float).
    Float(f64),
    /// Text — also the carrier for LIKE patterns and for values bound to
    /// char/varchar/nvarchar/decimal columns as their string form.
    Text(String),
    /// Raw bytes bound to a BINARY/VARBINARY column, decoded from the renderer's
    /// `0x`-hex / UUID value (binary edit + FK filter).
    Bytes(Vec<u8>),
}

impl BoundValue {
    /// Map a JSON scalar to a bound value for an equality/comparison/`IN`
    /// operand. NULL is rejected with the §5 "use IS NULL / IS NOT NULL"
    /// message — `col = NULL` never matches, so a NULL comparison is always a
    /// mistake (matches the other adapters).
    pub fn from_json_operand(value: &serde_json::Value) -> Result<Self, AppError> {
        match value {
            serde_json::Value::Null => Err(AppError::Database(
                "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
            )),
            serde_json::Value::Bool(b) => Ok(Self::Bool(*b)),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Ok(Self::Int(i))
                } else if let Some(f) = n.as_f64() {
                    Ok(Self::Float(f))
                } else {
                    Ok(Self::Text(n.to_string()))
                }
            }
            serde_json::Value::String(s) => Ok(Self::Text(s.clone())),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(AppError::Database(
                "A filter value must be a single text, number, or boolean.".to_string(),
            )),
        }
    }

    /// Map a JSON scalar to a bound value for a `SET col = @P` clause. Unlike
    /// [`Self::from_json_operand`], NULL is the legitimate "set the cell to
    /// NULL" case and binds as [`BoundValue::Null`]; nested arrays/objects fall
    /// back to their JSON text so the engine — not a panic — decides.
    pub fn from_json_set(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            other => {
                Self::from_json_operand(other).unwrap_or_else(|_| Self::Text(other.to_string()))
            }
        }
    }

    /// Bind a binary-column operand (filter/pk): the renderer's `0x`-hex / UUID
    /// value decoded to raw bytes. A NULL is rejected like any other operand NULL.
    pub fn from_binary_operand(value: &serde_json::Value) -> Result<Self, AppError> {
        match crate::shared::engine::parse_binary_value(value)? {
            Some(bytes) => Ok(Self::Bytes(bytes)),
            None => Err(AppError::Database(
                "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
            )),
        }
    }

    /// Bind a binary-column `SET col = @P` value: decoded bytes, or NULL when the
    /// renderer sends null (set the cell to NULL).
    pub fn from_binary_set(value: &serde_json::Value) -> Result<Self, AppError> {
        Ok(match crate::shared::engine::parse_binary_value(value)? {
            Some(bytes) => Self::Bytes(bytes),
            None => Self::Null,
        })
    }
}

// ---------------------------------------------------------------------------
// WHERE-clause compilation (@P{n} placeholders)
// ---------------------------------------------------------------------------

/// A compiled WHERE clause: the SQL body (without the `WHERE` keyword) and the
/// values to bind, in left-to-right `@P{n}` order. `sql == None` means "no
/// predicate" (an empty structured filter), rendered as no WHERE clause at all.
///
/// The `next_index` the caller passes in is the first placeholder number to use
/// (`@P1` for the first bind); it is returned advanced so the caller can append
/// further binds (e.g. `OFFSET @Pk ROWS FETCH NEXT @Pm ROWS ONLY`).
#[derive(Debug, Default, PartialEq)]
pub struct WhereClause {
    pub sql: Option<String>,
    pub params: Vec<BoundValue>,
}

/// Compile a [`FilterSpec`] into a WHERE body + bound parameters, numbering
/// placeholders from `start_index` (`1` for a standalone WHERE). Returns the
/// clause and the next free placeholder index. `valid_columns` is the table's
/// real column set (§5 validation). Structured conditions bind every value; the
/// raw mode is interpolated verbatim (the documented "Edit as SQL" escape hatch,
/// same threat model as the other adapters and the M6 query editor).
pub fn where_clause(
    valid_columns: &[String],
    table: &str,
    filter: &FilterSpec,
    start_index: usize,
) -> Result<(WhereClause, usize), AppError> {
    match filter {
        FilterSpec::Raw { sql } => {
            let trimmed = sql.trim();
            if trimmed.is_empty() {
                return Ok((WhereClause::default(), start_index));
            }
            Ok((
                WhereClause {
                    sql: Some(format!("({trimmed})")),
                    params: Vec::new(),
                },
                start_index,
            ))
        }
        FilterSpec::Conditions { items, combinator } => {
            let mut fragments: Vec<String> = Vec::with_capacity(items.len());
            let mut params: Vec<BoundValue> = Vec::new();
            let mut index = start_index;
            for condition in items {
                let fragment =
                    condition_sql(valid_columns, table, condition, &mut params, &mut index)?;
                fragments.push(fragment);
            }
            if fragments.is_empty() {
                return Ok((WhereClause::default(), start_index));
            }
            let joiner = format!(" {} ", combinator.sql_keyword());
            Ok((
                WhereClause {
                    sql: Some(fragments.join(&joiner)),
                    params,
                },
                index,
            ))
        }
    }
}

/// Compile one [`Condition`] into a SQL fragment, pushing bound values onto
/// `params` and emitting `@P{index}` placeholders (advancing `index`). The
/// column is validated; the operator selects a fixed fragment; values are bound,
/// never interpolated.
fn condition_sql(
    valid_columns: &[String],
    table: &str,
    condition: &Condition,
    params: &mut Vec<BoundValue>,
    index: &mut usize,
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
            params.push(if condition.binary {
                BoundValue::from_binary_operand(value)?
            } else {
                BoundValue::from_json_operand(value)?
            });
            let operator = match condition.op {
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
                FilterOp::Gt => ">",
                FilterOp::Gte => ">=",
                FilterOp::Lt => "<",
                FilterOp::Lte => "<=",
                _ => unreachable!("comparison arm"),
            };
            let placeholder = take_placeholder(index);
            Ok(format!("{col} {operator} {placeholder}"))
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
            params.push(BoundValue::Text(pattern));
            let keyword = if matches!(condition.op, FilterOp::NotContains) {
                "NOT LIKE"
            } else {
                "LIKE"
            };
            let placeholder = take_placeholder(index);
            // Cast to NVARCHAR so LIKE works on non-text columns too (numeric/
            // date columns), matching the lax affinity the other adapters give
            // the `contains` family. The escape char is stated explicitly (T-SQL
            // has no default LIKE escape).
            Ok(format!(
                "CAST({col} AS NVARCHAR(MAX)) {keyword} {placeholder} ESCAPE '\\'"
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
            let mut placeholders = Vec::with_capacity(values.len());
            for value in values {
                params.push(if condition.binary {
                    BoundValue::from_binary_operand(value)?
                } else {
                    BoundValue::from_json_operand(value)?
                });
                placeholders.push(take_placeholder(index));
            }
            Ok(format!("{col} IN ({})", placeholders.join(", ")))
        }
    }
}

/// Emit `@P{index}` and advance the counter.
fn take_placeholder(index: &mut usize) -> String {
    let placeholder = format!("@P{index}");
    *index += 1;
    placeholder
}

/// The single scalar a comparison / LIKE operator requires (§5 error otherwise).
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

/// The text operand for a LIKE-family operator. Numbers/bools are stringified;
/// NULL is rejected like any other NULL comparison.
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

/// Escape the LIKE metacharacters (`%`, `_`, `[`) and the escape character
/// itself so they match literally under `ESCAPE '\'`. T-SQL LIKE also treats
/// `[` as a character-class opener, so it is escaped too (a superset of the
/// other adapters' `%`/`_`/`\`).
pub fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch == LIKE_ESCAPE || ch == '%' || ch == '_' || ch == '[' {
            out.push(LIKE_ESCAPE);
        }
        out.push(ch);
    }
    out
}

/// Build the validated, quoted ORDER BY body for a single-column sort:
/// `[column] ASC|DESC`. The column MUST exist (else a §5 error listing the
/// available columns); the direction is the enum's fixed keyword, never a
/// caller string (see [`crate::shared::engine::SortDirection`]).
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

/// Validate that `column` is a real column of the table (§5 error otherwise,
/// listing the available columns) — the shared check used by sort/filter/peek/
/// stats/update, identical to the other adapters' `validate_column`.
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

// ---------------------------------------------------------------------------
// Version formatting
// ---------------------------------------------------------------------------

/// Format a SQL Server `SERVERPROPERTY('ProductVersion')` string (e.g.
/// `"16.0.4085.2"`) for the sidebar header as `"SQL Server 2022 (16.0)"`. The
/// leading `major.minor` is kept; the major version maps to the marketing year
/// (16→2022, 15→2019, 14→2017, 13→2016, 12→2014, 11→2012). Unknown majors fall
/// back to `"SQL Server <major.minor>"`.
pub fn display_version(raw: &str) -> String {
    let token = raw.split_whitespace().next().unwrap_or(raw).trim();
    let mut parts = token.split('.');
    let major = parts.next().and_then(|m| m.parse::<u32>().ok());
    let minor = parts.next().unwrap_or("0");
    match major {
        Some(major) => {
            let year = match major {
                16 => Some("2022"),
                15 => Some("2019"),
                14 => Some("2017"),
                13 => Some("2016"),
                12 => Some("2014"),
                11 => Some("2012"),
                _ => None,
            };
            match year {
                Some(year) => format!("SQL Server {year} ({major}.{minor})"),
                None => format!("SQL Server {major}.{minor}"),
            }
        }
        None => "SQL Server".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Type → numeric classification (by SQL Server catalog type name)
// ---------------------------------------------------------------------------

/// Whether a SQL Server `sys.types` base type name (lowercase, e.g. `int`,
/// `bigint`, `decimal`, `money`) denotes a numeric column — drives the
/// column-insights numeric display and `avg`. `bit` is included: a BIT column is
/// numeric (0/1) and avg/min/max over it are meaningful. Mirrors the Postgres/
/// MySQL `is_numeric_type`.
pub fn is_numeric_type(data_type: &str) -> bool {
    // Trim any length/precision suffix (e.g. "decimal(18,2)") to the base name.
    let base = data_type
        .split('(')
        .next()
        .unwrap_or(data_type)
        .trim()
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "tinyint"
            | "smallint"
            | "int"
            | "integer"
            | "bigint"
            | "decimal"
            | "numeric"
            | "money"
            | "smallmoney"
            | "float"
            | "real"
            | "bit"
    )
}

/// Build the display type label for a column from its `sys.columns` metadata:
/// the base type name (uppercased) plus a length/precision suffix where it
/// matters. `char/varchar/binary/varbinary` show a byte length (`-1` →
/// `(MAX)`); `nchar/nvarchar` show a **character** length (SQL Server stores
/// `max_length` in bytes = 2× the char count; `-1` → `(MAX)`);
/// `decimal/numeric` show `(precision, scale)`. Everything else is just the base
/// name (`INT`, `DATETIME2`, `UNIQUEIDENTIFIER`, …). Mirrors the display labels
/// in the Structure type dropdown (`ST_MSSQL_TYPES`).
pub fn build_display_type(type_name: &str, max_length: i16, precision: u8, scale: u8) -> String {
    let base = type_name.trim().to_ascii_uppercase();
    match base.as_str() {
        "CHAR" | "VARCHAR" | "BINARY" | "VARBINARY" => {
            if max_length == -1 {
                format!("{base}(MAX)")
            } else if max_length >= 0 {
                format!("{base}({max_length})")
            } else {
                base
            }
        }
        "NCHAR" | "NVARCHAR" => {
            if max_length == -1 {
                format!("{base}(MAX)")
            } else if max_length >= 0 {
                format!("{base}({})", max_length / 2)
            } else {
                base
            }
        }
        "DECIMAL" | "NUMERIC" => {
            if precision > 0 {
                format!("{base}({precision},{scale})")
            } else {
                base
            }
        }
        _ => base,
    }
}

/// Build a multi-row `INSERT` with `@P{n}` placeholders for M16 bulk generate:
/// `INSERT INTO [s].[t] ([a], [b]) VALUES (@P1, @P2), (@P3, @P4)`. `n_rows`
/// value groups are emitted; the caller binds `n_rows * columns.len()` values in
/// row-major order. Pure — unit-tested without a live connection.
pub fn build_multi_insert_sql(
    schema: &str,
    table: &str,
    columns: &[String],
    n_rows: usize,
) -> String {
    let cols_sql = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let mut index = 1usize;
    let mut groups = Vec::with_capacity(n_rows);
    for _ in 0..n_rows {
        let mut placeholders = Vec::with_capacity(columns.len());
        for _ in 0..columns.len() {
            placeholders.push(take_placeholder(&mut index));
        }
        groups.push(format!("({})", placeholders.join(", ")));
    }
    format!(
        "INSERT INTO {} ({cols_sql}) VALUES {}",
        qualified(schema, table),
        groups.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::{
        Combinator, Condition, FilterOp, FilterSpec, FilterValue, SortDirection,
    };

    fn cols() -> Vec<String> {
        vec![
            "id".to_string(),
            "name".to_string(),
            "qty".to_string(),
            "weird]name".to_string(),
        ]
    }

    #[test]
    fn quote_ident_wraps_and_doubles_embedded_bracket() {
        assert_eq!(quote_ident("users"), "[users]");
        assert_eq!(quote_ident("a]b"), "[a]]b]");
        // A classic injection attempt is neutralized: the closing bracket is
        // doubled, so it cannot break out of the identifier.
        assert_eq!(
            quote_ident("x]; DROP TABLE t; --"),
            "[x]]; DROP TABLE t; --]"
        );
    }

    #[test]
    fn qualified_quotes_both_parts() {
        assert_eq!(qualified("dbo", "books"), "[dbo].[books]");
    }

    #[test]
    fn display_version_maps_major_to_year() {
        assert_eq!(display_version("16.0.4085.2"), "SQL Server 2022 (16.0)");
        assert_eq!(display_version("15.0.2000.5"), "SQL Server 2019 (15.0)");
        assert_eq!(display_version("13.0.1"), "SQL Server 2016 (13.0)");
        assert_eq!(display_version("99.3.1"), "SQL Server 99.3");
        assert_eq!(display_version(""), "SQL Server");
    }

    #[test]
    fn build_display_type_adds_length_and_precision() {
        assert_eq!(build_display_type("int", 4, 10, 0), "INT");
        assert_eq!(build_display_type("varchar", 255, 0, 0), "VARCHAR(255)");
        assert_eq!(build_display_type("varchar", -1, 0, 0), "VARCHAR(MAX)");
        // nvarchar max_length is bytes = 2× chars.
        assert_eq!(build_display_type("nvarchar", 200, 0, 0), "NVARCHAR(100)");
        assert_eq!(build_display_type("nvarchar", -1, 0, 0), "NVARCHAR(MAX)");
        assert_eq!(build_display_type("decimal", 9, 18, 2), "DECIMAL(18,2)");
        assert_eq!(build_display_type("datetime2", 8, 27, 7), "DATETIME2");
        assert_eq!(
            build_display_type("uniqueidentifier", 16, 0, 0),
            "UNIQUEIDENTIFIER"
        );
    }

    #[test]
    fn multi_insert_sql_uses_brackets_and_numbered_placeholders() {
        let sql = build_multi_insert_sql("dbo", "t", &["a".into(), "b".into()], 2);
        assert_eq!(
            sql,
            "INSERT INTO [dbo].[t] ([a], [b]) VALUES (@P1, @P2), (@P3, @P4)"
        );
    }

    #[test]
    fn is_numeric_type_classifies_mssql_types() {
        for t in [
            "int",
            "bigint",
            "smallint",
            "tinyint",
            "bit",
            "decimal",
            "numeric",
            "money",
            "smallmoney",
            "float",
            "real",
            "DECIMAL(18,2)",
        ] {
            assert!(is_numeric_type(t), "{t} should be numeric");
        }
        for t in [
            "varchar",
            "nvarchar",
            "text",
            "datetime",
            "date",
            "uniqueidentifier",
            "varbinary",
        ] {
            assert!(!is_numeric_type(t), "{t} should not be numeric");
        }
    }

    #[test]
    fn escape_like_escapes_metacharacters_including_bracket() {
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("c\\d"), "c\\\\d");
        assert_eq!(escape_like("a[b"), "a\\[b");
        assert_eq!(escape_like("plain"), "plain");
    }

    #[test]
    fn order_by_validates_and_quotes() {
        let sort = SortSpec {
            column: "name".into(),
            direction: SortDirection::Desc,
        };
        assert_eq!(order_by_clause(&cols(), "t", &sort).unwrap(), "[name] DESC");
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
    fn where_clause_empty_conditions_is_no_predicate() {
        let spec = FilterSpec::Conditions {
            items: vec![],
            combinator: Combinator::And,
        };
        let (wc, next) = where_clause(&cols(), "t", &spec, 1).unwrap();
        assert_eq!(wc.sql, None);
        assert!(wc.params.is_empty());
        assert_eq!(next, 1);
    }

    #[test]
    fn where_clause_comparison_emits_numbered_placeholder_and_binds() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "qty".into(),
                op: FilterOp::Gte,
                value: Some(FilterValue::Scalar(serde_json::json!(10))),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        let (wc, next) = where_clause(&cols(), "t", &spec, 1).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("[qty] >= @P1"));
        assert_eq!(wc.params, vec![BoundValue::Int(10)]);
        assert_eq!(next, 2);
    }

    #[test]
    fn where_clause_multiple_conditions_number_placeholders_in_order() {
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
                Condition {
                    column: "qty".into(),
                    op: FilterOp::Gt,
                    value: Some(FilterValue::Scalar(serde_json::json!(5))),
                    binary: false,
                },
            ],
            combinator: Combinator::And,
        };
        let (wc, next) = where_clause(&cols(), "t", &spec, 1).unwrap();
        assert_eq!(
            wc.sql.as_deref(),
            Some("[name] = @P1 AND [id] IN (@P2, @P3) AND [qty] > @P4")
        );
        assert_eq!(next, 5);
        assert_eq!(
            wc.params,
            vec![
                BoundValue::Text("ada".into()),
                BoundValue::Int(1),
                BoundValue::Int(2),
                BoundValue::Int(5),
            ]
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
        let (wc, _) = where_clause(&cols(), "t", &spec, 1).unwrap();
        assert_eq!(
            wc.sql.as_deref(),
            Some("CAST([name] AS NVARCHAR(MAX)) LIKE @P1 ESCAPE '\\'")
        );
        assert_eq!(wc.params, vec![BoundValue::Text("%a\\%b%".into())]);
    }

    #[test]
    fn where_clause_start_index_offsets_placeholders() {
        // When the caller has already bound @P1..@P2 (e.g. paging binds first),
        // the WHERE placeholders start where told.
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "qty".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!(1))),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        let (wc, next) = where_clause(&cols(), "t", &spec, 3).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("[qty] = @P3"));
        assert_eq!(next, 4);
    }

    #[test]
    fn where_clause_raw_mode_interpolates_verbatim_in_parens() {
        let spec = FilterSpec::Raw {
            sql: "qty > 100 AND name = 'ada'".into(),
        };
        let (wc, next) = where_clause(&cols(), "t", &spec, 1).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("(qty > 100 AND name = 'ada')"));
        assert!(wc.params.is_empty());
        assert_eq!(next, 1);
        let (empty, _) =
            where_clause(&cols(), "t", &FilterSpec::Raw { sql: "  ".into() }, 1).unwrap();
        assert_eq!(empty.sql, None);
    }

    #[test]
    fn injection_payload_binds_as_a_literal_not_sql() {
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
        let (wc, _) = where_clause(&cols(), "t", &spec, 1).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("[name] = @P1"));
        assert_eq!(
            wc.params,
            vec![BoundValue::Text("'; DROP TABLE t; --".into())]
        );
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
        let err = where_clause(&cols(), "t", &spec, 1).unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("ghost"));
    }
}
