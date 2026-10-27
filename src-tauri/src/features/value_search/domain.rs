//! Pure domain for the value-search slice: which columns a pasted value can be
//! compared against, and the needle → [`Condition`] translation the adapters
//! compile. No Tauri, no drivers, no I/O — every function here is total and
//! testable on its own.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::engine::{ColumnInfo, ColumnMeta, Condition, FilterOp, FilterValue};

/// Matching rows kept per table. The sweep is a reconnaissance tool — the user
/// wants to know *where* the value lives, then opens that table properly — so a
/// small page keeps the result set readable and the transfer cheap.
pub const DEFAULT_PER_TABLE_LIMIT: u32 = 20;

/// Tables with at least one match after which the sweep stops on its own. A
/// value that appears in hundreds of tables is a denormalized id, and the
/// hundredth hit tells the user nothing the tenth did not.
pub const DEFAULT_MAX_HIT_TABLES: u32 = 100;

/// How the needle is compared against a column.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchMode {
    /// Substring, case-insensitively where the engine's collation says so
    /// (`LIKE %needle%`). Runs against **every** non-binary column: the
    /// adapters cast the column to text first, so numbers, uuids, dates and
    /// json are all searchable. This is the mode that answers "where does this
    /// email appear".
    #[default]
    Contains,
    /// Whole-value equality. Only columns whose type the needle actually fits
    /// are asked — see [`ColumnClass`] — because `=` binds the needle with its
    /// native type and the engine rejects, say, a uuid column compared with
    /// `"hello"`. Narrower and much faster to eyeball when the needle is a
    /// short id that would substring-match everywhere.
    Exact,
}

/// What kind of value a column holds, as far as *matching a pasted string* is
/// concerned. Derived from [`ColumnInfo::data_type`], which is a display label
/// and not a contract (SQLite columns can be untyped entirely) — so this is a
/// deliberately coarse, substring-driven guess, and the only decision riding on
/// it is which operator is safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnClass {
    /// Bytes: blob / bytea / varbinary / image. Never scanned in either mode —
    /// a text cast of binary yields a hex dump that matches nothing a human
    /// pasted, and on some engines errors outright.
    Binary,
    /// char / varchar / text / string / enum, and SQLite's untyped columns.
    Text,
    /// Any integer, decimal or float type.
    Numeric,
    /// uuid / uniqueidentifier.
    Uuid,
    /// A real boolean type (Postgres `boolean`, not MySQL's `tinyint(1)`).
    Boolean,
    /// Searchable as text but not safely comparable with `=` against a pasted
    /// string: dates and timestamps, json, arrays, network and geometry types.
    /// Included in [`MatchMode::Contains`], skipped in [`MatchMode::Exact`].
    TextCastOnly,
}

impl ColumnClass {
    /// Whether [`MatchMode::Contains`] asks this column at all.
    pub fn scannable(self) -> bool {
        !matches!(self, Self::Binary)
    }
}

/// Classify a declared type label. Substring matching, lowercased, with the
/// ambiguous groups ordered so the specific one wins: `interval` and
/// `timestamp` contain "int" and "time" respectively, so temporal types are
/// tested before numeric ones, and binary before everything.
pub fn classify(data_type: &str) -> ColumnClass {
    let t = data_type.to_ascii_lowercase();

    // SQLite allows a column with no declared type at all; it holds whatever
    // was written to it, which in practice is text worth searching.
    if t.trim().is_empty() {
        return ColumnClass::Text;
    }

    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));

    if has(&["blob", "bytea", "binary", "image", "bytes"]) {
        return ColumnClass::Binary;
    }
    if has(&["uuid", "uniqueidentifier"]) {
        return ColumnClass::Uuid;
    }
    if has(&["bool"]) {
        return ColumnClass::Boolean;
    }
    // Before the numeric tests: `interval` contains "int", `date32` contains
    // "date", and none of these may be compared with a bare string.
    if has(&[
        "date",
        "time",
        "interval",
        "year",
        "json",
        "xml",
        "inet",
        "cidr",
        "macaddr",
        "geometry",
        "geography",
        "point",
        "polygon",
        "array",
        "[]",
        "range",
        "money",
        "map(",
        "tuple(",
    ]) {
        return ColumnClass::TextCastOnly;
    }
    if has(&["char", "text", "string", "clob", "enum", "name"]) {
        return ColumnClass::Text;
    }
    if has(&[
        "int", "serial", "dec", "numeric", "float", "double", "real", "number",
    ]) {
        return ColumnClass::Numeric;
    }
    // bit / varbit / unknown vendor types: castable to text, not comparable.
    ColumnClass::TextCastOnly
}

/// The needle as a JSON scalar of `class`'s native type, or `None` when it
/// simply is not one — a non-numeric string against an integer column, a
/// non-uuid string against a uuid column. `None` means "do not ask this column
/// in exact mode"; asking anyway is a bind/cast error, not an empty result.
fn exact_operand(class: ColumnClass, needle: &str) -> Option<Value> {
    match class {
        ColumnClass::Text => Some(Value::String(needle.to_string())),
        ColumnClass::Numeric => {
            let n = needle.trim();
            if let Ok(i) = n.parse::<i64>() {
                Some(Value::from(i))
            } else if let Ok(u) = n.parse::<u64>() {
                Some(Value::from(u))
            } else {
                n.parse::<f64>()
                    .ok()
                    .filter(|f| f.is_finite())
                    .map(Value::from)
            }
        }
        ColumnClass::Uuid => looks_like_uuid(needle).then(|| Value::String(needle.trim().into())),
        ColumnClass::Boolean => match needle.trim().to_ascii_lowercase().as_str() {
            "true" | "t" | "yes" | "y" | "1" => Some(Value::Bool(true)),
            "false" | "f" | "no" | "n" | "0" => Some(Value::Bool(false)),
            _ => None,
        },
        ColumnClass::Binary | ColumnClass::TextCastOnly => None,
    }
}

/// Canonical 8-4-4-4-12 hyphenated form, or the same 32 hex digits bare. Only
/// used to keep an impossible comparison out of the generated SQL, so a loose
/// shape check is enough — the engine does the real parsing.
pub fn looks_like_uuid(s: &str) -> bool {
    let s = s.trim();
    let hex = |c: char| c.is_ascii_hexdigit();
    match s.len() {
        32 => s.chars().all(hex),
        36 => {
            let b = s.as_bytes();
            [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
                && s.chars()
                    .enumerate()
                    .all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) || hex(c))
        }
        _ => false,
    }
}

/// The OR'd conditions that find `needle` anywhere in a table's row.
///
/// Empty means the table cannot hold the needle at all — every column is
/// binary, or (in exact mode) no column's type fits — and the caller should
/// skip the table rather than issue a query with an empty `WHERE`.
pub fn conditions_for(columns: &[ColumnInfo], needle: &str, mode: MatchMode) -> Vec<Condition> {
    columns
        .iter()
        .filter_map(|c| {
            let class = classify(&c.data_type);
            let (op, value) = match mode {
                MatchMode::Contains => {
                    if !class.scannable() {
                        return None;
                    }
                    (FilterOp::Contains, Value::String(needle.to_string()))
                }
                MatchMode::Exact => (FilterOp::Eq, exact_operand(class, needle)?),
            };
            Some(Condition {
                column: c.name.clone(),
                op,
                value: Some(FilterValue::Scalar(value)),
                // Binary columns never reach here, so the bytes-binding path
                // (which expects a `0x…` hex or uuid string) is never wanted.
                binary: false,
            })
        })
        .collect()
}

/// Which of the returned columns actually hold the needle, for the "matched in"
/// labels and cell highlighting.
///
/// Recomputed here rather than inferred from the query because the OR means any
/// one column could have matched, and the engine does not say which. Compared
/// case-insensitively on the JSON rendering of each cell: MySQL's default
/// collation makes `LIKE` case-insensitive while Postgres's does not, so a
/// case-sensitive check here would miss cells the database legitimately
/// matched. The result is the union over the returned page, so it is a superset
/// for any single row — which is what a "matched in: email, username" label
/// wants.
pub fn matched_columns(
    columns: &[ColumnMeta],
    rows: &[Vec<Value>],
    needle: &str,
    mode: MatchMode,
) -> Vec<String> {
    let want = needle.trim().to_lowercase();
    let mut hit = vec![false; columns.len()];
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if i >= hit.len() || hit[i] {
                continue;
            }
            if cell_matches(cell, &want, mode) {
                hit[i] = true;
            }
        }
    }
    columns
        .iter()
        .zip(hit)
        .filter(|&(_, h)| h)
        .map(|(c, _)| c.name.clone())
        .collect()
}

/// Does one cell hold the needle? `want` is already trimmed and lowercased.
fn cell_matches(cell: &Value, want: &str, mode: MatchMode) -> bool {
    let text = match cell {
        Value::Null => return false,
        Value::String(s) => s.to_lowercase(),
        other => other.to_string().to_lowercase(),
    };
    match mode {
        MatchMode::Contains => text.contains(want),
        MatchMode::Exact => text == want,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            data_type: data_type.into(),
            nullable: true,
            pk: false,
            default_value: None,
            fk: None,
            comment: None,
            auto_increment: false,
        }
    }

    #[test]
    fn classifies_the_type_labels_each_engine_actually_reports() {
        for (label, want) in [
            // text
            ("TEXT", ColumnClass::Text),
            ("varchar(255)", ColumnClass::Text),
            ("character varying", ColumnClass::Text),
            ("nvarchar(max)", ColumnClass::Text),
            ("citext", ColumnClass::Text),
            ("LowCardinality(String)", ColumnClass::Text),
            ("", ColumnClass::Text), // SQLite untyped
            // numeric
            ("bigint", ColumnClass::Numeric),
            ("UInt64", ColumnClass::Numeric),
            ("numeric(10,2)", ColumnClass::Numeric),
            ("double precision", ColumnClass::Numeric),
            ("serial", ColumnClass::Numeric),
            ("tinyint(1)", ColumnClass::Numeric),
            // binary
            ("bytea", ColumnClass::Binary),
            ("varbinary(16)", ColumnClass::Binary),
            ("BLOB", ColumnClass::Binary),
            // uuid / bool
            ("uuid", ColumnClass::Uuid),
            ("uniqueidentifier", ColumnClass::Uuid),
            ("boolean", ColumnClass::Boolean),
            // text-cast-only
            ("timestamp with time zone", ColumnClass::TextCastOnly),
            ("date", ColumnClass::TextCastOnly),
            ("interval", ColumnClass::TextCastOnly),
            ("jsonb", ColumnClass::TextCastOnly),
            ("inet", ColumnClass::TextCastOnly),
            ("integer[]", ColumnClass::TextCastOnly),
            ("bit(8)", ColumnClass::TextCastOnly),
        ] {
            assert_eq!(classify(label), want, "classifying {label:?}");
        }
    }

    #[test]
    fn interval_and_date32_are_temporal_not_numeric() {
        // Both contain a numeric/temporal substring; the ordering in `classify`
        // is what keeps `=` away from them.
        assert_eq!(classify("interval"), ColumnClass::TextCastOnly);
        assert_eq!(classify("Date32"), ColumnClass::TextCastOnly);
    }

    #[test]
    fn contains_mode_asks_every_column_except_binary() {
        let cols = [
            col("id", "bigint"),
            col("email", "text"),
            col("avatar", "bytea"),
            col("created_at", "timestamptz"),
            col("meta", "jsonb"),
        ];
        let conds = conditions_for(&cols, "ada@example.com", MatchMode::Contains);
        let names: Vec<&str> = conds.iter().map(|c| c.column.as_str()).collect();
        assert_eq!(names, ["id", "email", "created_at", "meta"]);
        assert!(conds.iter().all(|c| c.op == FilterOp::Contains));
        assert!(conds.iter().all(|c| !c.binary));
    }

    #[test]
    fn exact_mode_only_asks_columns_the_needle_fits() {
        let cols = [
            col("id", "bigint"),
            col("email", "text"),
            col("ref", "uuid"),
            col("created_at", "date"),
        ];

        // A non-numeric, non-uuid string reaches the text column only.
        let conds = conditions_for(&cols, "ada@example.com", MatchMode::Exact);
        assert_eq!(
            conds.iter().map(|c| c.column.as_str()).collect::<Vec<_>>(),
            ["email"]
        );

        // A number reaches the integer column too, bound as a number so the
        // engine compares int-to-int.
        let conds = conditions_for(&cols, "42", MatchMode::Exact);
        assert_eq!(
            conds.iter().map(|c| c.column.as_str()).collect::<Vec<_>>(),
            ["id", "email"]
        );
        assert_eq!(
            conds[0].value,
            Some(FilterValue::Scalar(Value::from(42i64)))
        );

        // A uuid reaches the uuid column; `date` never does.
        let conds = conditions_for(
            &cols,
            "4f1d4b9e-3c2a-4c7b-9f1e-0a2b3c4d5e6f",
            MatchMode::Exact,
        );
        assert_eq!(
            conds.iter().map(|c| c.column.as_str()).collect::<Vec<_>>(),
            ["email", "ref"]
        );
    }

    #[test]
    fn a_table_of_only_binary_columns_yields_no_conditions() {
        let cols = [col("thumb", "blob"), col("raw", "bytea")];
        assert!(conditions_for(&cols, "x", MatchMode::Contains).is_empty());
    }

    #[test]
    fn uuid_shape_check_accepts_both_spellings_and_rejects_near_misses() {
        assert!(looks_like_uuid("4f1d4b9e-3c2a-4c7b-9f1e-0a2b3c4d5e6f"));
        assert!(looks_like_uuid("4f1d4b9e3c2a4c7b9f1e0a2b3c4d5e6f"));
        assert!(!looks_like_uuid("4f1d4b9e-3c2a-4c7b-9f1e-0a2b3c4d5e6"));
        assert!(!looks_like_uuid("not-a-uuid"));
        assert!(!looks_like_uuid(""));
    }

    #[test]
    fn matched_columns_is_case_insensitive_and_reads_non_strings() {
        let cols = [
            ColumnMeta {
                name: "email".into(),
                type_hint: "text".into(),
            },
            ColumnMeta {
                name: "id".into(),
                type_hint: "bigint".into(),
            },
            ColumnMeta {
                name: "note".into(),
                type_hint: "text".into(),
            },
        ];
        let rows = vec![
            vec![
                Value::String("Ada@Example.com".into()),
                Value::from(42i64),
                Value::Null,
            ],
            vec![Value::Null, Value::from(7i64), Value::String("ada".into())],
        ];
        // Postgres LIKE would not have matched the capitalized cell; the label
        // still has to say the column matched.
        let hit = matched_columns(&cols, &rows, "ada", MatchMode::Contains);
        assert_eq!(hit, ["email", "note"]);

        // Numbers are compared on their rendering, so "42" finds the int cell.
        let hit = matched_columns(&cols, &rows, "42", MatchMode::Exact);
        assert_eq!(hit, ["id"]);
    }
}
