//! The SQL the change history writes (M48 C1–C2): the statements that reverse
//! a change, and the reads that check rows by key. Per-engine identifier
//! quoting and literals — dates and text quoted, booleans and numbers bare,
//! binary as hex, JSON as its text, NULL — and the engine's way of
//! re-inserting a row with its original identity / auto-increment key.
//!
//! The statements shown in the detail view are the statements run: both come
//! from `reverse`, character for character.

use std::collections::HashMap;

use serde_json::Value;

use crate::shared::engine::{ColumnInfo, Engine};

use super::{Change, Kind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
    Mssql,
}

impl Dialect {
    /// The engines whose writes can be captured and undone. ClickHouse is not
    /// one: no transactions, and its mutations run asynchronously.
    pub fn of(engine: Engine) -> Option<Self> {
        match engine {
            Engine::Postgres => Some(Self::Postgres),
            Engine::Mysql => Some(Self::Mysql),
            Engine::Sqlite => Some(Self::Sqlite),
            Engine::Mssql => Some(Self::Mssql),
            _ => None,
        }
    }

    pub fn begin(self) -> &'static str {
        match self {
            Self::Mssql => "BEGIN TRANSACTION",
            Self::Sqlite => "BEGIN IMMEDIATE",
            _ => "BEGIN",
        }
    }
}

/// What a column's values need to be written back correctly.
#[derive(Debug, Clone, Copy, Default)]
pub struct ColType {
    pub binary: bool,
    pub boolean: bool,
    pub identity: bool,
}

pub type ColTypes = HashMap<String, ColType>;

/// Column facts from the table's metadata.
pub fn col_types(columns: &[ColumnInfo]) -> ColTypes {
    columns
        .iter()
        .map(|c| {
            let t = c.data_type.to_ascii_lowercase();
            let binary = ["bytea", "blob", "binary", "varbinary", "image"]
                .iter()
                .any(|b| t.contains(b));
            let boolean = t == "boolean" || t == "bool" || t == "bit";
            (
                c.name.clone(),
                ColType {
                    binary,
                    boolean,
                    identity: c.auto_increment,
                },
            )
        })
        .collect()
}

pub fn ident(d: Dialect, name: &str) -> String {
    match d {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        Dialect::Mssql => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// `schema.table`, quoted. SQLite's `main` is left implicit.
pub fn table_ref(d: Dialect, schema: &str, table: &str) -> String {
    if schema.is_empty() || (d == Dialect::Sqlite && schema == "main") {
        ident(d, table)
    } else {
        format!("{}.{}", ident(d, schema), ident(d, table))
    }
}

fn quote(d: Dialect, s: &str) -> String {
    let body = s.replace('\'', "''");
    match d {
        // MySQL reads backslash escapes in string literals by default.
        Dialect::Mysql => format!("'{}'", body.replace('\\', "\\\\")),
        Dialect::Mssql => format!("N'{body}'"),
        _ => format!("'{body}'"),
    }
}

/// A value as a SQL literal for this engine and column.
pub fn lit(d: Dialect, v: &Value, ty: Option<&ColType>) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => match d {
            Dialect::Mssql | Dialect::Sqlite => (if *b { "1" } else { "0" }).into(),
            _ => (if *b { "TRUE" } else { "FALSE" }).into(),
        },
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            // Binary arrives as `0x…` hex; written back as the engine's hex form.
            let hex = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"));
            match (ty.is_some_and(|t| t.binary), hex) {
                (true, Some(h)) if h.bytes().all(|b| b.is_ascii_hexdigit()) => match d {
                    Dialect::Postgres => format!("'\\x{h}'::bytea"),
                    Dialect::Mssql => format!("0x{h}"),
                    _ => format!("X'{h}'"),
                },
                _ => quote(d, s),
            }
        }
        other => quote(d, &other.to_string()),
    }
}

/// `a = 1 AND b = 'x'` for a key.
pub fn where_key(d: Dialect, pk: &[String], key: &[Value], types: &ColTypes) -> String {
    pk.iter()
        .zip(key)
        .map(|(col, v)| match v {
            Value::Null => format!("{} IS NULL", ident(d, col)),
            _ => format!("{} = {}", ident(d, col), lit(d, v, types.get(col))),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// The statement(s) that reverse one change. Several only for SQL Server's
/// identity re-insert, which must be switched on and off around it.
pub fn reverse(d: Dialect, c: &Change, types: &ColTypes) -> Vec<String> {
    let t = table_ref(d, &c.schema, &c.table);
    let key = where_key(d, &c.pk, &c.key, types);
    match c.kind {
        Kind::Insert => vec![format!("DELETE FROM {t} WHERE {key};")],
        Kind::Update => {
            let sets = c
                .cols
                .iter()
                .map(|col| {
                    let v = c.get(&c.before, col).cloned().unwrap_or(Value::Null);
                    format!("{} = {}", ident(d, col), lit(d, &v, types.get(col)))
                })
                .collect::<Vec<_>>()
                .join(", ");
            vec![format!("UPDATE {t} SET {sets} WHERE {key};")]
        }
        Kind::Delete => {
            let row = c.before.clone().unwrap_or_default();
            let cols = c
                .columns
                .iter()
                .map(|col| ident(d, col))
                .collect::<Vec<_>>()
                .join(", ");
            let vals = c
                .columns
                .iter()
                .zip(&row)
                .map(|(col, v)| lit(d, v, types.get(col)))
                .collect::<Vec<_>>()
                .join(", ");
            let identity = c
                .columns
                .iter()
                .any(|col| types.get(col).is_some_and(|t| t.identity));
            match (d, identity) {
                // Put the row back under its original key: an identity column
                // refuses an explicit value unless told.
                (Dialect::Postgres, true) => vec![format!(
                    "INSERT INTO {t} ({cols}) OVERRIDING SYSTEM VALUE VALUES ({vals});"
                )],
                (Dialect::Mssql, true) => vec![
                    format!("SET IDENTITY_INSERT {t} ON;"),
                    format!("INSERT INTO {t} ({cols}) VALUES ({vals});"),
                    format!("SET IDENTITY_INSERT {t} OFF;"),
                ],
                _ => vec![format!("INSERT INTO {t} ({cols}) VALUES ({vals});")],
            }
        }
    }
}

/// Read rows of a table by key — one query per table (B1). With `lock`, the
/// rows are locked until the transaction ends (B2): `FOR UPDATE`, or SQL
/// Server's `UPDLOCK` hint. SQLite needs none: `BEGIN IMMEDIATE` holds the
/// write lock.
pub fn select_by_keys(
    d: Dialect,
    schema: &str,
    table: &str,
    pk: &[String],
    keys: &[Vec<Value>],
    types: &ColTypes,
    lock: bool,
) -> String {
    let t = table_ref(d, schema, table);
    let hint = if lock && d == Dialect::Mssql {
        " WITH (UPDLOCK, ROWLOCK)"
    } else {
        ""
    };
    let cond = if keys.is_empty() {
        "1 = 0".to_string()
    } else if pk.len() == 1 && keys.iter().all(|k| !k[0].is_null()) {
        let vals = keys
            .iter()
            .map(|k| lit(d, &k[0], types.get(&pk[0])))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{} IN ({vals})", ident(d, &pk[0]))
    } else {
        keys.iter()
            .map(|k| format!("({})", where_key(d, pk, k, types)))
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    let tail = if lock && matches!(d, Dialect::Postgres | Dialect::Mysql) {
        " FOR UPDATE"
    } else {
        ""
    };
    format!("SELECT * FROM {t}{hint} WHERE {cond}{tail}")
}

/// The statements wrapped as one transaction, for display and for Copy.
pub fn wrap(d: Dialect, statements: &[String]) -> String {
    let commit = if d == Dialect::Mssql {
        "COMMIT TRANSACTION;"
    } else {
        "COMMIT;"
    };
    let mut out = vec![format!("{};", d.begin())];
    out.extend(statements.iter().cloned());
    out.push(commit.into());
    out.join("\n")
}
