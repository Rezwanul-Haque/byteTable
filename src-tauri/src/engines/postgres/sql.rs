//! Pure, driver-light helpers for the Postgres adapter: identifier quoting,
//! `$N` placeholder WHERE-clause compilation, value→JSON type mapping, and
//! `PgConnectOptions` building (incl. TLS-mode mapping). Everything here is
//! unit-testable without a live server; the live SQL execution lives in
//! `super` (`mod.rs`).
//!
//! # Why `$N`, not `?`
//!
//! Postgres uses positional `$1, $2, …` bind placeholders (unlike SQLite's
//! `?`). The WHERE compiler therefore threads a running placeholder index so a
//! composite filter binds in the right order. The SQLite adapter's
//! `where_clause` is the semantic blueprint (same 13 operators, same LIKE
//! escaping, same "bind everything" guarantee); only the placeholder syntax and
//! the bound-value representation differ.
//!
//! # Bound values
//!
//! A compiled clause carries its bound values as [`BoundValue`] (a small JSON
//! scalar wrapper) rather than binding to a sqlx query directly — that keeps
//! this module free of the live `sqlx::query` machinery (so it unit-tests
//! without a connection) and lets `mod.rs` bind each value with the correct
//! Postgres type. See [`super::bind_value`].

use sqlx::postgres::{PgConnectOptions, PgSslMode};

use crate::shared::engine::{
    Condition, ConnectionParams, FilterOp, FilterSpec, FilterValue, SortSpec,
};
use crate::shared::error::AppError;

/// JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 − 1). Postgres `int8`/`numeric`
/// values whose magnitude exceeds this serialize as JSON *strings*, matching the
/// SQLite adapter and the [`crate::shared::engine::QueryResult::rows`] contract
/// (a JSON number would lose precision the moment the renderer parses it).
pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The character used in `ESCAPE '\'` for the LIKE family (matches the SQLite
/// adapter). A backslash never appears unescaped in our patterns.
pub const LIKE_ESCAPE: char = '\\';

/// Quote an identifier for interpolation into Postgres SQL: wrap in double
/// quotes, doubling embedded quotes (`"` → `""`). Identical escaping to the
/// SQLite adapter (both are SQL-standard double-quote identifiers).
pub fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// `"schema"."table"`, both identifiers quoted.
pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

// ---------------------------------------------------------------------------
// Bound values
// ---------------------------------------------------------------------------

/// A single value bound into a Postgres query, in the WHERE/limit order the
/// compiled SQL expects. `mod.rs` binds each to the live query with the right
/// Postgres type (see `super::bind_value`). Kept JSON-shaped so this module
/// needs no `sqlx` query types and stays unit-testable.
#[derive(Debug, Clone, PartialEq)]
pub enum BoundValue {
    Null,
    Bool(bool),
    /// An integer that fits i64 (int2/int4/int8 comparisons, limit/offset).
    Int(i64),
    /// A floating value (float4/float8, or a numeric compared as a float).
    Float(f64),
    /// Text — also the carrier for LIKE patterns and for values bound to
    /// text/uuid/numeric columns as their string form.
    Text(String),
    /// Raw bytes bound to a BYTEA column, decoded from the renderer's `0x`-hex /
    /// UUID value (binary edit + FK filter).
    Bytes(Vec<u8>),
}

impl BoundValue {
    /// Map a JSON scalar to a bound value for an equality/comparison/`IN`
    /// operand. NULL is rejected with the §5 "use IS NULL / IS NOT NULL"
    /// message — `col = NULL` never matches, so a NULL comparison is always a
    /// mistake (matches the SQLite adapter). Nested arrays/objects are not
    /// valid scalars.
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

    /// Map a JSON scalar to a bound value for a `SET col = $1` clause. Unlike
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

    /// Bind a binary (bytea) operand (filter/pk): the renderer's `0x`-hex / UUID
    /// value decoded to raw bytes. NULL is rejected like any operand NULL.
    pub fn from_binary_operand(value: &serde_json::Value) -> Result<Self, AppError> {
        match crate::shared::engine::parse_binary_value(value)? {
            Some(bytes) => Ok(Self::Bytes(bytes)),
            None => Err(AppError::Database(
                "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
            )),
        }
    }

    /// Bind a binary (bytea) `SET col = $1` value: decoded bytes, or NULL.
    pub fn from_binary_set(value: &serde_json::Value) -> Result<Self, AppError> {
        Ok(match crate::shared::engine::parse_binary_value(value)? {
            Some(bytes) => Self::Bytes(bytes),
            None => Self::Null,
        })
    }
}

// ---------------------------------------------------------------------------
// WHERE-clause compilation ($N placeholders)
// ---------------------------------------------------------------------------

/// A compiled WHERE clause: the SQL body (without the `WHERE` keyword) and the
/// values to bind, in `$N` placeholder order. `sql == None` means "no
/// predicate" (an empty structured filter), rendered as no WHERE clause at all.
///
/// `next_index` is the next free placeholder number, so the caller can append
/// further binds (e.g. `LIMIT $k OFFSET $k+1`) after the WHERE params.
#[derive(Debug, Default, PartialEq)]
pub struct WhereClause {
    pub sql: Option<String>,
    pub params: Vec<BoundValue>,
}

impl WhereClause {
    /// The next `$N` index after this clause's params (1-based): WHERE binds
    /// `$1..=$params.len()`, so the next placeholder is `params.len() + 1`.
    pub fn next_index(&self) -> usize {
        self.params.len() + 1
    }
}

/// Compile a [`FilterSpec`] into a WHERE body + bound parameters with `$N`
/// placeholders. `valid_columns` is the table's real column set (for §5
/// validation, identical to the sort/filter column check). Structured
/// conditions bind every value; the raw mode is interpolated verbatim (the
/// documented "Edit as SQL" escape hatch — same threat model as the SQLite
/// adapter and the M6 query editor).
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
/// `params` and emitting `$N` placeholders (N = the running `params` length).
/// The column is validated; the operator selects a fixed fragment; values are
/// bound, never interpolated.
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
            params.push(if condition.binary {
                BoundValue::from_binary_operand(value)?
            } else {
                BoundValue::from_json_operand(value)?
            });
            let placeholder = params.len();
            let operator = match condition.op {
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
                FilterOp::Gt => ">",
                FilterOp::Gte => ">=",
                FilterOp::Lt => "<",
                FilterOp::Lte => "<=",
                _ => unreachable!("comparison arm"),
            };
            // Cast the column to text for the operand-bound comparison? No — we
            // bind the operand with its native type in mod.rs, so a direct
            // comparison works for the common cases. (mod.rs binds Text via a
            // form Postgres can coerce to the column type.)
            Ok(format!("{col} {operator} ${placeholder}"))
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
            let placeholder = params.len();
            let keyword = if matches!(condition.op, FilterOp::NotContains) {
                "NOT LIKE"
            } else {
                "LIKE"
            };
            // Cast the column to text so LIKE works on non-text columns too
            // (e.g. `contains` on a numeric column), mirroring SQLite's lax
            // affinity. The bound pattern is text.
            Ok(format!(
                "{col}::text {keyword} ${placeholder} ESCAPE '{LIKE_ESCAPE}'"
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
                placeholders.push(format!("${}", params.len()));
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
/// they match literally under `ESCAPE '\'` (identical to the SQLite adapter).
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
/// `"column" ASC|DESC`. The column MUST exist (else a §5 error listing the
/// available columns); the direction is the enum's fixed keyword, never a
/// caller string (see [`SortDirection`]).
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
/// stats/update, identical to the SQLite adapter's `validate_column`.
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

/// Map a TLS-mode token to a sqlx [`PgSslMode`]. The renderer's connect modal
/// offers `disable` / `prefer` / `require` / `verify-ca` / `verify-full`;
/// anything unknown falls back to `prefer` (opportunistic — Postgres' own
/// libpq default).
///
/// M12 Task 3 wired this in: [`connect_options`] calls it with
/// `params.tls_mode.as_token()`, replacing the M12-Task-1 `tls: bool` seam.
pub fn ssl_mode_from_token(token: &str) -> PgSslMode {
    match token.trim().to_ascii_lowercase().as_str() {
        "disable" => PgSslMode::Disable,
        "allow" => PgSslMode::Allow,
        "prefer" => PgSslMode::Prefer,
        "require" => PgSslMode::Require,
        "verify-ca" | "verifyca" => PgSslMode::VerifyCa,
        "verify-full" | "verifyfull" => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    }
}

/// Build [`PgConnectOptions`] from [`ConnectionParams::Postgres`] plus the
/// transient password. Returns an `Invalid` error if the params are not
/// Postgres (defensive — the registry routes by engine, so this should not
/// happen).
///
/// `host_override` / `port_override` point the driver at a local SSH-tunnel
/// endpoint (M12 Task 3) instead of the real `host`/`port` when the connection
/// is tunnelled; pass `None` for a direct connection. TLS still applies to the
/// tunnelled connection — for `disable`/`prefer` that is exactly right; for
/// `verify-full` the certificate hostname would be checked against the real
/// `host` (sqlx connects to 127.0.0.1 but the SNI/host is set from `host`), a
/// documented caveat (see the module note / connector).
pub fn connect_options(
    params: &ConnectionParams,
    password: Option<&str>,
    host_override: Option<&str>,
    port_override: Option<u16>,
) -> Result<PgConnectOptions, AppError> {
    let ConnectionParams::Postgres {
        host,
        port,
        database,
        user,
        tls_mode,
        ssh: _,
    } = params
    else {
        return Err(AppError::Invalid(format!(
            "the PostgreSQL connector received {} parameters",
            params.engine().display_name()
        )));
    };

    let mut options = PgConnectOptions::new()
        .host(host_override.unwrap_or(host))
        .port(port_override.unwrap_or(*port))
        .database(database)
        .username(user)
        .ssl_mode(ssl_mode_from_token(tls_mode.as_token()))
        // Identify ByteTable in pg_stat_activity for the DBA looking at who is
        // connected — a small courtesy, not behaviorally significant.
        .application_name("ByteTable");
    if let Some(password) = password {
        options = options.password(password);
    }
    Ok(options)
}

/// Trim Postgres' `server_version` GUC (e.g. `"16.14 (Debian 16.14-1.pgdg…)"`)
/// to the leading version token for the sidebar header, prefixed "PostgreSQL".
pub fn display_version(raw: &str) -> String {
    let version = raw.split_whitespace().next().unwrap_or(raw).trim();
    if version.is_empty() {
        "PostgreSQL".to_string()
    } else {
        format!("PostgreSQL {version}")
    }
}

// ---------------------------------------------------------------------------
// Type → JSON mapping (by Postgres type name)
// ---------------------------------------------------------------------------

/// Whether a Postgres type name (the `udt_name`, e.g. `int4`, `numeric`,
/// `float8`) denotes a numeric column — drives the column-insights numeric
/// display and `avg`. Cleaner than SQLite's value-`typeof` heuristic because
/// Postgres columns are statically typed (we know it from the catalog).
pub fn is_numeric_type(udt_name: &str) -> bool {
    matches!(
        udt_name,
        "int2"
            | "int4"
            | "int8"
            | "float4"
            | "float8"
            | "numeric"
            | "decimal"
            | "money"
            | "smallserial"
            | "serial"
            | "bigserial"
            | "oid"
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
            "weird\"name".to_string(),
        ]
    }

    #[test]
    fn quote_ident_wraps_and_doubles_embedded_quotes() {
        assert_eq!(quote_ident("users"), "\"users\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
        // A classic injection attempt is neutralized: the closing quote is
        // doubled, so it cannot break out of the identifier.
        assert_eq!(
            quote_ident("x\"; DROP TABLE t; --"),
            "\"x\"\"; DROP TABLE t; --\""
        );
    }

    #[test]
    fn qualified_quotes_both_parts() {
        assert_eq!(qualified("bt_probe", "books"), "\"bt_probe\".\"books\"");
    }

    #[test]
    fn display_version_trims_to_leading_token() {
        assert_eq!(
            display_version("16.14 (Debian 16.14-1.pgdg13+1)"),
            "PostgreSQL 16.14"
        );
        assert_eq!(display_version("15.2"), "PostgreSQL 15.2");
        assert_eq!(display_version(""), "PostgreSQL");
    }

    #[test]
    fn ssl_mode_token_mapping_covers_every_variant() {
        assert!(matches!(ssl_mode_from_token("disable"), PgSslMode::Disable));
        assert!(matches!(ssl_mode_from_token("prefer"), PgSslMode::Prefer));
        assert!(matches!(ssl_mode_from_token("require"), PgSslMode::Require));
        assert!(matches!(
            ssl_mode_from_token("verify-ca"),
            PgSslMode::VerifyCa
        ));
        assert!(matches!(
            ssl_mode_from_token("verify-full"),
            PgSslMode::VerifyFull
        ));
        // Unknown / mixed-case fall back to prefer.
        assert!(matches!(ssl_mode_from_token("REQUIRE"), PgSslMode::Require));
        assert!(matches!(ssl_mode_from_token("garbage"), PgSslMode::Prefer));
    }

    #[test]
    fn connect_options_built_from_postgres_params() {
        let params = ConnectionParams::Postgres {
            host: "db.internal".into(),
            port: 5433,
            database: "shop".into(),
            user: "app".into(),
            tls_mode: crate::shared::engine::TlsMode::Disable,
            ssh: None,
        };
        // Just assert it builds (the fields are private on PgConnectOptions);
        // a non-Postgres params is rejected.
        assert!(connect_options(&params, Some("secret"), None, None).is_ok());
        // The tunnel override path builds too.
        assert!(connect_options(&params, Some("secret"), Some("127.0.0.1"), Some(60000)).is_ok());
        let wrong = ConnectionParams::Sqlite { path: "/x".into() };
        assert!(matches!(
            connect_options(&wrong, None, None, None),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn is_numeric_type_classifies_postgres_types() {
        for t in ["int2", "int4", "int8", "float4", "float8", "numeric"] {
            assert!(is_numeric_type(t), "{t} should be numeric");
        }
        for t in ["text", "bool", "uuid", "jsonb", "timestamptz", "_text"] {
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
        assert_eq!(
            order_by_clause(&cols(), "t", &sort).unwrap(),
            "\"name\" DESC"
        );
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
        assert_eq!(wc.next_index(), 1);
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
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("\"qty\" >= $1"));
        assert_eq!(wc.params, vec![BoundValue::Int(10)]);
        assert_eq!(wc.next_index(), 2);
    }

    #[test]
    fn where_clause_every_operator_shape_and_bind_order() {
        // Build one condition per non-null-check operator and assert the
        // emitted SQL fragment + the running $N placeholder order.
        let cases: Vec<(FilterOp, FilterValue, &str)> = vec![
            (
                FilterOp::Eq,
                FilterValue::Scalar(serde_json::json!(1)),
                "\"qty\" = $1",
            ),
            (
                FilterOp::Ne,
                FilterValue::Scalar(serde_json::json!(1)),
                "\"qty\" <> $1",
            ),
            (
                FilterOp::Gt,
                FilterValue::Scalar(serde_json::json!(1)),
                "\"qty\" > $1",
            ),
            (
                FilterOp::Gte,
                FilterValue::Scalar(serde_json::json!(1)),
                "\"qty\" >= $1",
            ),
            (
                FilterOp::Lt,
                FilterValue::Scalar(serde_json::json!(1)),
                "\"qty\" < $1",
            ),
            (
                FilterOp::Lte,
                FilterValue::Scalar(serde_json::json!(1)),
                "\"qty\" <= $1",
            ),
            (
                FilterOp::Contains,
                FilterValue::Scalar(serde_json::json!("x")),
                "\"qty\"::text LIKE $1 ESCAPE '\\'",
            ),
            (
                FilterOp::NotContains,
                FilterValue::Scalar(serde_json::json!("x")),
                "\"qty\"::text NOT LIKE $1 ESCAPE '\\'",
            ),
            (
                FilterOp::BeginsWith,
                FilterValue::Scalar(serde_json::json!("x")),
                "\"qty\"::text LIKE $1 ESCAPE '\\'",
            ),
            (
                FilterOp::EndsWith,
                FilterValue::Scalar(serde_json::json!("x")),
                "\"qty\"::text LIKE $1 ESCAPE '\\'",
            ),
        ];
        for (op, value, expected) in cases {
            let spec = FilterSpec::Conditions {
                items: vec![Condition {
                    column: "qty".into(),
                    op,
                    value: Some(value),
                    binary: false,
                }],
                combinator: Combinator::And,
            };
            let wc = where_clause(&cols(), "t", &spec).unwrap();
            assert_eq!(wc.sql.as_deref(), Some(expected), "op {op:?}");
            assert_eq!(wc.params.len(), 1, "op {op:?} binds one value");
        }

        // null checks: no value, no placeholder.
        for (op, expected) in [
            (FilterOp::IsNull, "\"qty\" IS NULL"),
            (FilterOp::IsNotNull, "\"qty\" IS NOT NULL"),
        ] {
            let spec = FilterSpec::Conditions {
                items: vec![Condition {
                    column: "qty".into(),
                    op,
                    value: None,
                    binary: false,
                }],
                combinator: Combinator::And,
            };
            let wc = where_clause(&cols(), "t", &spec).unwrap();
            assert_eq!(wc.sql.as_deref(), Some(expected));
            assert!(wc.params.is_empty());
        }
    }

    #[test]
    fn where_clause_in_list_numbers_each_placeholder() {
        let spec = FilterSpec::Conditions {
            items: vec![Condition {
                column: "id".into(),
                op: FilterOp::InList,
                value: Some(FilterValue::List(vec![
                    serde_json::json!(1),
                    serde_json::json!(2),
                    serde_json::json!(3),
                ])),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("\"id\" IN ($1, $2, $3)"));
        assert_eq!(
            wc.params,
            vec![BoundValue::Int(1), BoundValue::Int(2), BoundValue::Int(3)]
        );
        assert_eq!(wc.next_index(), 4);
    }

    #[test]
    fn where_clause_multiple_conditions_continue_placeholder_numbering() {
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
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(
            wc.sql.as_deref(),
            Some("\"name\" = $1 AND \"id\" IN ($2, $3) AND \"qty\" > $4")
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
        assert_eq!(wc.next_index(), 5);
    }

    #[test]
    fn where_clause_or_combinator_joins_with_or() {
        let spec = FilterSpec::Conditions {
            items: vec![
                Condition {
                    column: "id".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(1))),
                    binary: false,
                },
                Condition {
                    column: "id".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(2))),
                    binary: false,
                },
            ],
            combinator: Combinator::Or,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("\"id\" = $1 OR \"id\" = $2"));
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
                binary: false,
            }],
            combinator: Combinator::And,
        };
        let wc = where_clause(&cols(), "t", &spec).unwrap();
        assert_eq!(wc.sql.as_deref(), Some("\"name\" = $1"));
        assert_eq!(
            wc.params,
            vec![BoundValue::Text("'; DROP TABLE t; --".into())]
        );
    }
}
