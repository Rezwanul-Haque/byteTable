//! Pure, driver-light helpers for the MySQL adapter: identifier quoting,
//! `?`-placeholder WHERE-clause compilation, numeric-type detection, and
//! `MySqlConnectOptions` building (incl. TLS-mode mapping). Everything here is
//! unit-testable without a live server; the live SQL execution lives in
//! `super` (`mod.rs`).
//!
//! # Why `?`, not `$N`
//!
//! MySQL uses positional `?` bind placeholders (unlike Postgres' `$1, $2, …`).
//! There is therefore no running placeholder index to thread — every bound
//! value emits a bare `?`, and the binds are appended in left-to-right order.
//! The Postgres adapter's `where_clause` is the semantic blueprint (same 13
//! operators, same LIKE escaping, same "bind everything" guarantee); only the
//! placeholder syntax and the identifier-quoting character differ.
//!
//! # Bound values
//!
//! A compiled clause carries its bound values as [`BoundValue`] (a small JSON
//! scalar wrapper) rather than binding to a sqlx query directly — that keeps
//! this module free of the live `sqlx::query` machinery (so it unit-tests
//! without a connection) and lets `mod.rs` bind each value with the correct
//! MySQL type. See [`super::bind_value`].

use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};

use crate::shared::engine::{
    Condition, ConnectionParams, FilterOp, FilterSpec, FilterValue, SortSpec,
};
use crate::shared::error::AppError;

/// JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 − 1). MySQL `BIGINT` /
/// `DECIMAL` values whose magnitude exceeds this serialize as JSON *strings*,
/// matching the SQLite/Postgres adapters and the
/// [`crate::shared::engine::QueryResult::rows`] contract (a JSON number would
/// lose precision the moment the renderer parses it).
pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The character used in `ESCAPE '\\'` for the LIKE family (matches the SQLite
/// and Postgres adapters). A backslash never appears unescaped in our patterns.
///
/// Note: MySQL's LIKE already treats `\` as the default escape character, so the
/// explicit `ESCAPE '\\'` is a no-op-but-explicit reaffirmation — kept for
/// parity with the other adapters and to be unambiguous regardless of the
/// server's `NO_BACKSLASH_ESCAPES` SQL mode (which only affects string
/// literals, not the bound-pattern path we use).
pub const LIKE_ESCAPE: char = '\\';

/// Quote an identifier for interpolation into MySQL SQL: wrap in backticks,
/// doubling embedded backticks (`` ` `` → `` `` `` ``). This is MySQL's
/// identifier-quoting rule (ANSI double-quotes only apply under `ANSI_QUOTES`
/// mode, which we do not assume), the analogue of the Postgres adapter's
/// double-quote quoting.
pub fn quote_ident(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

/// `` `schema`.`table` ``, both identifiers backtick-quoted. MySQL "schemas"
/// are databases, so this is `` `database`.`table` ``.
pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

// ---------------------------------------------------------------------------
// Bound values
// ---------------------------------------------------------------------------

/// A single value bound into a MySQL query, in the WHERE/limit order the
/// compiled SQL expects. `mod.rs` binds each to the live query with the right
/// MySQL type (see `super::bind_value`). Kept JSON-shaped so this module needs
/// no `sqlx` query types and stays unit-testable. Identical in spirit to the
/// Postgres adapter's `BoundValue`.
#[derive(Debug, Clone, PartialEq)]
pub enum BoundValue {
    Null,
    Bool(bool),
    /// An integer that fits i64 (tinyint/smallint/mediumint/int/bigint
    /// comparisons, limit/offset).
    Int(i64),
    /// A floating value (float/double, or a decimal compared as a float).
    Float(f64),
    /// Text — also the carrier for LIKE patterns and for values bound to
    /// char/varchar/text/decimal columns as their string form.
    Text(String),
}

impl BoundValue {
    /// Map a JSON scalar to a bound value for an equality/comparison/`IN`
    /// operand. NULL is rejected with the §5 "use IS NULL / IS NOT NULL"
    /// message — `col = NULL` never matches, so a NULL comparison is always a
    /// mistake (matches the SQLite/Postgres adapters). Nested arrays/objects
    /// are not valid scalars.
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
                    // u64 beyond i64::MAX — preserve as text rather than lose it.
                    Ok(Self::Text(n.to_string()))
                }
            }
            serde_json::Value::String(s) => Ok(Self::Text(s.clone())),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(AppError::Database(
                "A filter value must be a single text, number, or boolean.".to_string(),
            )),
        }
    }

    /// Map a JSON scalar to a bound value for a `SET col = ?` clause. Unlike
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
}

// ---------------------------------------------------------------------------
// WHERE-clause compilation (? placeholders)
// ---------------------------------------------------------------------------

/// A compiled WHERE clause: the SQL body (without the `WHERE` keyword) and the
/// values to bind, in left-to-right `?` order. `sql == None` means "no
/// predicate" (an empty structured filter), rendered as no WHERE clause at all.
///
/// Unlike the Postgres adapter there is no placeholder index to track: MySQL's
/// `?` are positional by order, so the caller simply binds `params` first, then
/// appends any further binds (e.g. `LIMIT ? OFFSET ?`).
#[derive(Debug, Default, PartialEq)]
pub struct WhereClause {
    pub sql: Option<String>,
    pub params: Vec<BoundValue>,
}

/// Compile a [`FilterSpec`] into a WHERE body + bound parameters with `?`
/// placeholders. `valid_columns` is the table's real column set (for §5
/// validation, identical to the sort/filter column check). Structured
/// conditions bind every value; the raw mode is interpolated verbatim (the
/// documented "Edit as SQL" escape hatch — same threat model as the SQLite /
/// Postgres adapters and the M6 query editor).
pub fn where_clause(
    valid_columns: &[String],
    table: &str,
    filter: &FilterSpec,
) -> Result<WhereClause, AppError> {
    match filter {
        FilterSpec::Raw { sql } => {
            let trimmed = sql.trim();
            if trimmed.is_empty() {
                return Ok(WhereClause::default());
            }
            Ok(WhereClause {
                sql: Some(format!("({trimmed})")),
                params: Vec::new(),
            })
        }
        FilterSpec::Conditions { items, combinator } => {
            let mut fragments: Vec<String> = Vec::with_capacity(items.len());
            let mut params: Vec<BoundValue> = Vec::new();
            for condition in items {
                let fragment = condition_sql(valid_columns, table, condition, &mut params)?;
                fragments.push(fragment);
            }
            if fragments.is_empty() {
                return Ok(WhereClause::default());
            }
            let joiner = format!(" {} ", combinator.sql_keyword());
            Ok(WhereClause {
                sql: Some(fragments.join(&joiner)),
                params,
            })
        }
    }
}

/// Compile one [`Condition`] into a SQL fragment, pushing bound values onto
/// `params` and emitting `?` placeholders. The column is validated; the
/// operator selects a fixed fragment; values are bound, never interpolated.
fn condition_sql(
    valid_columns: &[String],
    table: &str,
    condition: &Condition,
    params: &mut Vec<BoundValue>,
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
            params.push(BoundValue::from_json_operand(value)?);
            let operator = match condition.op {
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
                FilterOp::Gt => ">",
                FilterOp::Gte => ">=",
                FilterOp::Lt => "<",
                FilterOp::Lte => "<=",
                _ => unreachable!("comparison arm"),
            };
            // The operand is bound with its native type in mod.rs; MySQL coerces
            // it to the column type for the comparison, so a direct comparison
            // works for the common grid/filter cases.
            Ok(format!("{col} {operator} ?"))
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
            // No `::text` cast is needed (unlike Postgres): MySQL's LIKE applies
            // to any column type, implicitly coercing numerics to their string
            // form, which matches the lax affinity the SQLite/Postgres adapters
            // give the `contains` family on non-text columns. The bound pattern
            // is text. We deliberately omit an explicit `ESCAPE` clause: MySQL's
            // default LIKE escape character is already `\` (the one
            // [`escape_like`] uses), and writing `ESCAPE '\'` would be a SQL
            // syntax error (a single backslash is an incomplete string escape in
            // a MySQL literal). The bound pattern carries the `\`-escaped
            // metacharacters, which the default escape honours.
            Ok(format!("{col} {keyword} ?"))
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
                params.push(BoundValue::from_json_operand(value)?);
                placeholders.push("?");
            }
            Ok(format!("{col} IN ({})", placeholders.join(", ")))
        }
    }
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

/// Escape the LIKE metacharacters (`%`, `_`) and the escape character itself so
/// they match literally under `ESCAPE '\\'` (identical to the SQLite/Postgres
/// adapters).
pub fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch == LIKE_ESCAPE || ch == '%' || ch == '_' {
            out.push(LIKE_ESCAPE);
        }
        out.push(ch);
    }
    out
}

/// Build the validated, quoted ORDER BY body for a single-column sort:
/// `` `column` ASC|DESC ``. The column MUST exist (else a §5 error listing the
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
/// stats/update, identical to the SQLite/Postgres adapters' `validate_column`.
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
// Connection options (incl. TLS-mode mapping)
// ---------------------------------------------------------------------------

/// Map a TLS-mode token to a sqlx [`MySqlSslMode`]. The renderer's connect modal
/// offers `disable` / `prefer` / `require` / `verify-ca` / `verify-full`;
/// anything unknown falls back to `prefer` (opportunistic — MySQL's own client
/// default). MySQL has no `allow` mode (a Postgres-ism); it maps to `prefer`.
///
/// Exposed (but not yet called by `connect_options`) for M12 Task 3, which
/// threads the granular mode token through instead of the current `tls: bool`
/// — see [`ssl_mode_from_bool`]. The `allow(dead_code)` reflects that pending
/// seam; the unit test below exercises every branch. Mirrors the Postgres
/// adapter's `ssl_mode_from_token`.
#[allow(dead_code)]
pub fn ssl_mode_from_token(token: &str) -> MySqlSslMode {
    match token.trim().to_ascii_lowercase().as_str() {
        "disable" => MySqlSslMode::Disabled,
        // MySQL has no `allow`; treat it as opportunistic, like `prefer`.
        "allow" | "prefer" => MySqlSslMode::Preferred,
        "require" => MySqlSslMode::Required,
        "verify-ca" | "verifyca" => MySqlSslMode::VerifyCa,
        "verify-full" | "verifyfull" => MySqlSslMode::VerifyIdentity,
        _ => MySqlSslMode::Preferred,
    }
}

/// Map the current `ConnectionParams::Mysql.tls` boolean to a [`MySqlSslMode`].
///
/// The stored params carry only a boolean today (the connect modal collapses
/// its TLS dropdown to `tls != "disable"`), so the granular mode is not yet
/// available at this layer. `true` → `Preferred` (opportunistic TLS: use it
/// when the server offers it, but do not fail against a non-TLS server like the
/// M12 test container); `false` → `Disabled`. M12 Task 3 threads the real mode
/// token through and calls [`ssl_mode_from_token`] instead — documented in the
/// module note and in the connector. Mirrors the Postgres `ssl_mode_from_bool`.
pub fn ssl_mode_from_bool(tls: bool) -> MySqlSslMode {
    if tls {
        MySqlSslMode::Preferred
    } else {
        MySqlSslMode::Disabled
    }
}

/// Build [`MySqlConnectOptions`] from [`ConnectionParams::Mysql`] plus the
/// transient password. Returns an `Invalid` error if the params are not MySQL
/// (defensive — the registry routes by engine, so this should not happen).
pub fn connect_options(
    params: &ConnectionParams,
    password: Option<&str>,
) -> Result<MySqlConnectOptions, AppError> {
    let ConnectionParams::Mysql {
        host,
        port,
        database,
        user,
        tls,
    } = params
    else {
        return Err(AppError::Invalid(format!(
            "the MySQL connector received {} parameters",
            params.engine().display_name()
        )));
    };

    let mut options = MySqlConnectOptions::new()
        .host(host)
        .port(*port)
        .database(database)
        .username(user)
        .ssl_mode(ssl_mode_from_bool(*tls));
    if let Some(password) = password {
        options = options.password(password);
    }
    Ok(options)
}

/// Format a MySQL `VERSION()` string (e.g. `"8.4.9"` or
/// `"8.0.36-0ubuntu0.22.04.1"`) for the sidebar header, prefixed "MySQL". Only
/// the leading dash-free version token is kept (drops the distro suffix).
pub fn display_version(raw: &str) -> String {
    let token = raw.split_whitespace().next().unwrap_or(raw).trim();
    // The build suffix is after the first '-' (e.g. "8.0.36-0ubuntu…").
    let version = token.split('-').next().unwrap_or(token).trim();
    if version.is_empty() {
        "MySQL".to_string()
    } else {
        format!("MySQL {version}")
    }
}

// ---------------------------------------------------------------------------
// Type → JSON mapping (by MySQL catalog DATA_TYPE)
// ---------------------------------------------------------------------------

/// Whether a MySQL `information_schema.columns.DATA_TYPE` (the lowercase base
/// type name, e.g. `int`, `bigint`, `decimal`, `double`) denotes a numeric
/// column — drives the column-insights numeric display and `avg`. Cleaner than
/// SQLite's value-`typeof` heuristic because MySQL columns are statically typed
/// (we know it from the catalog). Mirrors the Postgres `is_numeric_type`.
///
/// `tinyint` is included: a `TINYINT(1)`/`BOOL` column is numeric (0/1), and
/// avg/min/max over it are meaningful numbers (MySQL has no native bool — see
/// the module/adapter docs).
pub fn is_numeric_type(data_type: &str) -> bool {
    matches!(
        data_type.to_ascii_lowercase().as_str(),
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "decimal"
            | "dec"
            | "numeric"
            | "fixed"
            | "float"
            | "double"
            | "real"
            | "bit"
            | "year"
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
            "weird`name".to_string(),
        ]
    }

    #[test]
    fn quote_ident_wraps_and_doubles_embedded_backticks() {
        assert_eq!(quote_ident("users"), "`users`");
        assert_eq!(quote_ident("a`b"), "`a``b`");
        // A classic injection attempt is neutralized: the closing backtick is
        // doubled, so it cannot break out of the identifier.
        assert_eq!(
            quote_ident("x`; DROP TABLE t; --"),
            "`x``; DROP TABLE t; --`"
        );
    }

    #[test]
    fn qualified_quotes_both_parts() {
        assert_eq!(qualified("bytetable", "books"), "`bytetable`.`books`");
    }

    #[test]
    fn display_version_trims_to_leading_token_without_suffix() {
        assert_eq!(display_version("8.4.9"), "MySQL 8.4.9");
        assert_eq!(display_version("8.0.36-0ubuntu0.22.04.1"), "MySQL 8.0.36");
        assert_eq!(display_version("5.7.44-log"), "MySQL 5.7.44");
        assert_eq!(display_version(""), "MySQL");
    }

    #[test]
    fn ssl_mode_token_mapping_covers_every_variant() {
        assert!(matches!(
            ssl_mode_from_token("disable"),
            MySqlSslMode::Disabled
        ));
        assert!(matches!(
            ssl_mode_from_token("prefer"),
            MySqlSslMode::Preferred
        ));
        assert!(matches!(
            ssl_mode_from_token("allow"),
            MySqlSslMode::Preferred
        ));
        assert!(matches!(
            ssl_mode_from_token("require"),
            MySqlSslMode::Required
        ));
        assert!(matches!(
            ssl_mode_from_token("verify-ca"),
            MySqlSslMode::VerifyCa
        ));
        assert!(matches!(
            ssl_mode_from_token("verify-full"),
            MySqlSslMode::VerifyIdentity
        ));
        // Unknown / mixed-case fall back to preferred.
        assert!(matches!(
            ssl_mode_from_token("REQUIRE"),
            MySqlSslMode::Required
        ));
        assert!(matches!(
            ssl_mode_from_token("garbage"),
            MySqlSslMode::Preferred
        ));
    }

    #[test]
    fn ssl_mode_bool_mapping() {
        assert!(matches!(ssl_mode_from_bool(true), MySqlSslMode::Preferred));
        assert!(matches!(ssl_mode_from_bool(false), MySqlSslMode::Disabled));
    }

    #[test]
    fn connect_options_built_from_mysql_params() {
        let params = ConnectionParams::Mysql {
            host: "db.internal".into(),
            port: 3307,
            database: "shop".into(),
            user: "app".into(),
            tls: false,
        };
        // Just assert it builds (the fields are private on MySqlConnectOptions);
        // a non-MySQL params is rejected.
        assert!(connect_options(&params, Some("secret")).is_ok());
        let wrong = ConnectionParams::Sqlite { path: "/x".into() };
        assert!(matches!(
            connect_options(&wrong, None),
            Err(AppError::Invalid(_))
        ));
        // Postgres params are also rejected by the MySQL connector.
        let pg = ConnectionParams::Postgres {
            host: "h".into(),
            port: 5432,
            database: "d".into(),
            user: "u".into(),
            tls: false,
        };
        assert!(matches!(
            connect_options(&pg, None),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn is_numeric_type_classifies_mysql_types() {
        for t in [
            "tinyint",
            "smallint",
            "mediumint",
            "int",
            "bigint",
            "decimal",
            "double",
            "float",
            "bit",
            "year",
        ] {
            assert!(is_numeric_type(t), "{t} should be numeric");
        }
        // Case-insensitive.
        assert!(is_numeric_type("BIGINT"));
        for t in [
            "varchar", "text", "datetime", "json", "blob", "enum", "date",
        ] {
            assert!(!is_numeric_type(t), "{t} should not be numeric");
        }
    }

    #[test]
    fn bound_value_from_operand_rejects_null_and_maps_scalars() {
        assert!(matches!(
            BoundValue::from_json_operand(&serde_json::Value::Null),
            Err(AppError::Database(_))
        ));
        assert_eq!(
            BoundValue::from_json_operand(&serde_json::json!(true)).unwrap(),
            BoundValue::Bool(true)
        );
        assert_eq!(
            BoundValue::from_json_operand(&serde_json::json!(42)).unwrap(),
            BoundValue::Int(42)
        );
        assert_eq!(
            BoundValue::from_json_operand(&serde_json::json!(3.5)).unwrap(),
            BoundValue::Float(3.5)
        );
        assert_eq!(
            BoundValue::from_json_operand(&serde_json::json!("hi")).unwrap(),
            BoundValue::Text("hi".into())
        );
        assert!(matches!(
            BoundValue::from_json_operand(&serde_json::json!([1, 2])),
            Err(AppError::Database(_))
        ));
    }

    #[test]
    fn bound_value_from_set_allows_null() {
        assert_eq!(
            BoundValue::from_json_set(&serde_json::Value::Null),
            BoundValue::Null
        );
        assert_eq!(
            BoundValue::from_json_set(&serde_json::json!("x")),
            BoundValue::Text("x".into())
        );
    }

    #[test]
    fn escape_like_escapes_metacharacters() {
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("c\\d"), "c\\\\d");
        assert_eq!(escape_like("plain"), "plain");
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
    fn where_clause_empty_conditions_is_no_predicate() {
        let spec = FilterSpec::Conditions {
            items: vec![],
            combinator: Combinator::And,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql, None);
        assert!(wc.params.is_empty());
    }

    #[test]
    fn where_clause_comparison_emits_placeholder_and_binds() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "qty".into(),
                op: FilterOp::Gte,
                value: Some(FilterValue::Scalar(serde_json::json!(10))),
            }],
            combinator: Combinator::And,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("`qty` >= ?"));
        assert_eq!(wc.params, vec![BoundValue::Int(10)]);
    }

    #[test]
    fn where_clause_every_operator_shape_and_bind_order() {
        // Build one condition per non-null-check operator and assert the
        // emitted SQL fragment (with `?` placeholders) + the bind count.
        let cases: Vec<(FilterOp, FilterValue, &str)> = vec![
            (
                FilterOp::Eq,
                FilterValue::Scalar(serde_json::json!(1)),
                "`qty` = ?",
            ),
            (
                FilterOp::Ne,
                FilterValue::Scalar(serde_json::json!(1)),
                "`qty` <> ?",
            ),
            (
                FilterOp::Gt,
                FilterValue::Scalar(serde_json::json!(1)),
                "`qty` > ?",
            ),
            (
                FilterOp::Gte,
                FilterValue::Scalar(serde_json::json!(1)),
                "`qty` >= ?",
            ),
            (
                FilterOp::Lt,
                FilterValue::Scalar(serde_json::json!(1)),
                "`qty` < ?",
            ),
            (
                FilterOp::Lte,
                FilterValue::Scalar(serde_json::json!(1)),
                "`qty` <= ?",
            ),
            (
                FilterOp::Contains,
                FilterValue::Scalar(serde_json::json!("x")),
                "`qty` LIKE ?",
            ),
            (
                FilterOp::NotContains,
                FilterValue::Scalar(serde_json::json!("x")),
                "`qty` NOT LIKE ?",
            ),
            (
                FilterOp::BeginsWith,
                FilterValue::Scalar(serde_json::json!("x")),
                "`qty` LIKE ?",
            ),
            (
                FilterOp::EndsWith,
                FilterValue::Scalar(serde_json::json!("x")),
                "`qty` LIKE ?",
            ),
        ];
        for (op, value, expected) in cases {
            let spec = FilterSpec::Conditions {
                items: vec![Condition {
                    column: "qty".into(),
                    op,
                    value: Some(value),
                }],
                combinator: Combinator::And,
            };
            let wc = where_clause(&cols(), "t", &spec).unwrap();
            assert_eq!(wc.sql.as_deref(), Some(expected), "op {op:?}");
            assert_eq!(wc.params.len(), 1, "op {op:?} binds one value");
        }

        // null checks: no value, no placeholder.
        for (op, expected) in [
            (FilterOp::IsNull, "`qty` IS NULL"),
            (FilterOp::IsNotNull, "`qty` IS NOT NULL"),
        ] {
            let spec = FilterSpec::Conditions {
                items: vec![Condition {
                    column: "qty".into(),
                    op,
                    value: None,
                }],
                combinator: Combinator::And,
            };
            let wc = where_clause(&cols(), "t", &spec).unwrap();
            assert_eq!(wc.sql.as_deref(), Some(expected));
            assert!(wc.params.is_empty());
        }
    }

    #[test]
    fn where_clause_in_list_emits_one_placeholder_each() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "id".into(),
                op: FilterOp::InList,
                value: Some(FilterValue::List(vec![
                    serde_json::json!(1),
                    serde_json::json!(2),
                    serde_json::json!(3),
                ])),
            }],
            combinator: Combinator::And,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("`id` IN (?, ?, ?)"));
        assert_eq!(
            wc.params,
            vec![BoundValue::Int(1), BoundValue::Int(2), BoundValue::Int(3)]
        );
    }

    #[test]
    fn where_clause_multiple_conditions_preserve_bind_order() {
        let spec = FilterSpec::Conditions {
            items: vec![
                Condition {
                    column: "name".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!("ada"))),
                },
                Condition {
                    column: "id".into(),
                    op: FilterOp::InList,
                    value: Some(FilterValue::List(vec![
                        serde_json::json!(1),
                        serde_json::json!(2),
                    ])),
                },
                Condition {
                    column: "qty".into(),
                    op: FilterOp::Gt,
                    value: Some(FilterValue::Scalar(serde_json::json!(5))),
                },
            ],
            combinator: Combinator::And,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(
            wc.sql.as_deref(),
            Some("`name` = ? AND `id` IN (?, ?) AND `qty` > ?")
        );
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
    fn where_clause_or_combinator_joins_with_or() {
        let spec = FilterSpec::Conditions {
            items: vec![
                Condition {
                    column: "id".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(1))),
                },
                Condition {
                    column: "id".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(2))),
                },
            ],
            combinator: Combinator::Or,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("`id` = ? OR `id` = ?"));
    }

    #[test]
    fn where_clause_unknown_column_is_a_human_error() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "ghost".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!(1))),
            }],
            combinator: Combinator::And,
        };
        let err = where_clause(&cols(), "t", &spec).unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("ghost"));
    }

    #[test]
    fn where_clause_raw_mode_interpolates_verbatim_in_parens() {
        let spec = FilterSpec::Raw {
            sql: "qty > 100 AND name = 'ada'".into(),
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("(qty > 100 AND name = 'ada')"));
        assert!(wc.params.is_empty());
        // An empty raw clause is "no filter", not an error.
        let empty = where_clause(&cols(), "t", &FilterSpec::Raw { sql: "  ".into() }).unwrap();
        assert_eq!(empty.sql, None);
    }

    #[test]
    fn injection_payload_binds_as_a_literal_not_sql() {
        // A value that looks like SQL is bound, never interpolated — the
        // compiled SQL contains only a placeholder.
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "name".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!(
                    "'; DROP TABLE t; --"
                ))),
            }],
            combinator: Combinator::And,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("`name` = ?"));
        assert_eq!(
            wc.params,
            vec![BoundValue::Text("'; DROP TABLE t; --".into())]
        );
    }
}
