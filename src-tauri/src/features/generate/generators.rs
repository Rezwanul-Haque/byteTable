//! Pure value generation: declared type + column name -> generator -> value.
//! No I/O, no Tauri. FK values are NOT produced here (the runner supplies the
//! parent pool); `Generator::ForeignKey` is a marker.
//!
//! The **declared type drives the choice**, the name only refines text columns.
//! Generated values respect the type's constraints — integer width/sign, decimal
//! precision/scale, and string length — and dates use a `YYYY-MM-DD HH:MM:SS`
//! format that MySQL, Postgres, and SQLite all accept (no ISO `T`/`Z`, which
//! MySQL rejects). This is what keeps a real (constraint-enforcing) engine from
//! rejecting a row.
use serde_json::{json, Value};

use crate::shared::engine::ColumnInfo;

/// SplitMix64 — tiny, dependency-free, deterministic.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_add(0x9E37_79B9_7F4A_7C15))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut z = self.0;
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, n)`; returns 0 when n == 0.
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next_u64() % n
        }
    }
    fn pick<'a>(&mut self, xs: &'a [&'a str]) -> &'a str {
        xs[self.below(xs.len() as u64) as usize]
    }
}

// ---------------------------------------------------------------------------
// Declared-type parsing
// ---------------------------------------------------------------------------

/// The broad family a declared type belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Int,
    Bool,
    Decimal,
    Date,
    DateTime,
    Time,
    Text,
    Json,
    /// `binary(n)` / `varbinary(n)` / `blob` — stored as raw bytes.
    Binary,
}

/// A declared column type parsed into the constraints generation must respect.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedType {
    pub family: Family,
    /// String length limit (`varchar(n)`/`char(n)`); `None` for text/unbounded.
    pub max_len: Option<usize>,
    /// Inclusive integer bounds for `Int` (from width + signedness).
    pub int_min: i64,
    pub int_max: i64,
    /// Decimal integer-part digit count and fractional scale (for `Decimal`).
    pub dec_int_digits: u32,
    pub dec_scale: u32,
}

/// Integer bounds for a width in bits + signedness, clamped to i64.
fn int_bounds(bits: u32, unsigned: bool) -> (i64, i64) {
    if unsigned {
        let max = if bits >= 64 {
            i64::MAX
        } else {
            ((1u128 << bits) - 1) as i64
        };
        (0, max)
    } else if bits >= 64 {
        (i64::MIN, i64::MAX)
    } else {
        let lim = 1i128 << (bits - 1);
        ((-lim) as i64, (lim - 1) as i64)
    }
}

/// Parse a declared type string (MySQL/Postgres/SQLite spellings) into the
/// constraints generation needs. Unknown types fall back to `Text`.
pub fn parse_type(ty: &str) -> ParsedType {
    let lower = ty.to_ascii_lowercase();
    let unsigned = lower.contains("unsigned");
    let base = lower.split('(').next().unwrap_or("").trim().to_string();
    let args: Vec<u32> = lower
        .split_once('(')
        .and_then(|(_, rest)| rest.split(')').next())
        .map(|inner| {
            inner
                .split(',')
                .filter_map(|x| x.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default();

    let is_tinyint1 = base.contains("tinyint") && args.first() == Some(&1);
    let family = if lower.contains("bool") || is_tinyint1 {
        Family::Bool
    } else if base.contains("binary") || base.contains("blob") {
        Family::Binary
    } else if base.contains("int") || base.contains("serial") {
        Family::Int
    } else if base.contains("dec")
        || base.contains("numeric")
        || base.contains("real")
        || base.contains("float")
        || base.contains("double")
        || base.contains("money")
    {
        Family::Decimal
    } else if base.contains("datetime") || base.contains("timestamp") {
        Family::DateTime
    } else if base.contains("date") {
        Family::Date
    } else if base.contains("time") {
        Family::Time
    } else if base.contains("json") {
        Family::Json
    } else {
        Family::Text
    };

    let (int_min, int_max) = if family == Family::Int {
        let bits = if base.contains("tinyint") {
            8
        } else if base.contains("smallint") || base == "int2" {
            16
        } else if base.contains("mediumint") {
            24
        } else if base.contains("bigint") || base == "int8" || base.contains("bigserial") {
            64
        } else {
            32
        };
        int_bounds(bits, unsigned)
    } else {
        (0, 0)
    };

    let (dec_int_digits, dec_scale) = if family == Family::Decimal {
        match args.as_slice() {
            [p, s] => (p.saturating_sub(*s).min(9), (*s).min(6)),
            [p] => ((*p).min(9), 0),
            _ => (6, 2),
        }
    } else {
        (0, 0)
    };

    // Length: characters for Text, byte count for Binary.
    let max_len = if family == Family::Text || family == Family::Binary {
        args.first().map(|n| *n as usize)
    } else {
        None
    };

    ParsedType {
        family,
        max_len,
        int_min,
        int_max,
        dec_int_digits,
        dec_scale,
    }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Generator {
    AutoPk,
    Email,
    FirstName,
    LastName,
    FullName,
    Username,
    Phone,
    City,
    Country,
    Company,
    Url,
    Title,
    Sentence,
    /// `(int_min, int_max)` inclusive bounds.
    IntRange(i64, i64),
    /// `(integer-part digits, fractional scale)`.
    Decimal(u32, u32),
    /// `n` random bytes, rendered as a `0x`-hex string the engine decodes to a
    /// `binary(n)`/`blob` value (round-trips with `fetch_pk_pool` for binary FKs).
    Binary(usize),
    Bool,
    /// `YYYY-MM-DD HH:MM:SS` (engine-portable; no ISO `T`/`Z`).
    DateTime,
    /// `YYYY-MM-DD`.
    DateOnly,
    Uuid,
    Json,
    Null,
    ForeignKey,
    TextFallback,
}

const FIRST: &[&str] = &[
    "Ava", "Liam", "Noah", "Mia", "Zoe", "Kai", "Ivy", "Leo", "Ada", "Sam",
];
const LAST: &[&str] = &[
    "Khan", "Patel", "Silva", "Cruz", "Wong", "Diaz", "Roy", "Park", "Ali", "Bose",
];
const CITY: &[&str] = &[
    "Dhaka", "Berlin", "Tokyo", "Lima", "Oslo", "Cairo", "Quito", "Riga",
];
const COUNTRY: &[&str] = &["Bangladesh", "Germany", "Japan", "Peru", "Norway", "Egypt"];
const COUNTRY_CODE: &[&str] = &["BD", "DE", "JP", "PE", "NO", "EG", "US", "GB"];
const COMPANY: &[&str] = &["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark"];
const WORDS: &[&str] = &[
    "lorem", "ipsum", "dolor", "sit", "amet", "fugit", "vela", "nova",
];

/// Split a column name into lowercase `_`-delimited tokens. Token matching avoids
/// substring false-positives (e.g. `account_id` must not match "count").
fn tokens(name: &str) -> Vec<String> {
    name.to_ascii_lowercase()
        .split(['_', ' ', '-'])
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

/// Pick a TEXT generator from the column name. Only consulted for `Text`-family
/// columns — numeric/bool/date/json are decided by the declared type.
fn text_generator_for_name(name: &str) -> Generator {
    let n = name.to_ascii_lowercase();
    let toks = tokens(name);
    let has = |t: &str| toks.iter().any(|x| x == t);

    if n.contains("email") {
        Generator::Email
    } else if has("first") && (has("name") || n.contains("name")) {
        Generator::FirstName
    } else if has("last") && (has("name") || n.contains("name")) {
        Generator::LastName
    } else if has("username") || has("login") || (has("user") && has("name")) {
        Generator::Username
    } else if n.contains("name") {
        Generator::FullName
    } else if n.contains("phone") || n.contains("mobile") {
        Generator::Phone
    } else if n.contains("city") {
        Generator::City
    } else if n.contains("country") || has("nationality") {
        Generator::Country
    } else if n.contains("company") || has("org") || n.contains("organization") {
        Generator::Company
    } else if n.contains("url") || n.contains("website") || n.contains("link") {
        Generator::Url
    } else if n == "uuid" || n.ends_with("_uuid") || n == "guid" {
        Generator::Uuid
    } else if n.contains("title") || n.contains("subject") {
        Generator::Title
    } else if n.contains("desc")
        || n.contains("body")
        || n.contains("content")
        || n.contains("comment")
        || n.contains("bio")
    {
        Generator::Sentence
    } else {
        Generator::TextFallback
    }
}

/// Choose a generator. The declared type (`parsed`) decides the family; the name
/// only refines text columns. FK and auto-increment PK take priority.
pub fn classify_column(
    col: &ColumnInfo,
    parsed: &ParsedType,
    _is_unique: bool,
    is_autoinc: bool,
) -> Generator {
    if col.fk.is_some() {
        return Generator::ForeignKey;
    }
    if col.pk && is_autoinc {
        return Generator::AutoPk;
    }
    match parsed.family {
        Family::Bool => Generator::Bool,
        Family::Int => Generator::IntRange(parsed.int_min, parsed.int_max),
        Family::Decimal => Generator::Decimal(parsed.dec_int_digits, parsed.dec_scale),
        Family::Date => Generator::DateOnly,
        Family::DateTime | Family::Time => Generator::DateTime,
        Family::Json => Generator::Json,
        Family::Binary => Generator::Binary(parsed.max_len.unwrap_or(16)),
        Family::Text => text_generator_for_name(&col.name),
    }
}

/// Preview label.
pub fn label(g: &Generator) -> String {
    match g {
        Generator::AutoPk => "auto-increment (omitted)".into(),
        Generator::ForeignKey => "foreign key".into(),
        Generator::IntRange(a, b) => format!("int {a}..{b}"),
        Generator::Decimal(d, s) => format!("decimal {d}.{s}"),
        Generator::Binary(n) => format!("binary({n})"),
        Generator::DateTime => "datetime".into(),
        Generator::DateOnly => "date".into(),
        other => format!("{other:?}").to_ascii_lowercase(),
    }
}

/// Truncate a string Value to `max_len` characters (char-boundary safe).
fn clamp(value: Value, max_len: Option<usize>) -> Value {
    match (max_len, &value) {
        (Some(n), Value::String(s)) if s.chars().count() > n => {
            Value::String(s.chars().take(n).collect())
        }
        _ => value,
    }
}

/// Synthesize a value, respecting `max_len` for strings. `row_index` makes unique
/// generators collision-free within a run (and, with the caller's offset, across
/// appends). FK values are filled by the runner → `Null` for `ForeignKey`.
pub fn generate(
    g: &Generator,
    rng: &mut Rng,
    row_index: u64,
    unique: bool,
    max_len: Option<usize>,
) -> Value {
    let v = match g {
        Generator::AutoPk | Generator::ForeignKey | Generator::Null => Value::Null,
        Generator::Email => {
            let user = rng.pick(FIRST).to_ascii_lowercase();
            json!(format!("{user}{row_index}@example.com"))
        }
        Generator::FirstName => json!(rng.pick(FIRST)),
        Generator::LastName => json!(rng.pick(LAST)),
        Generator::FullName => json!(format!("{} {}", rng.pick(FIRST), rng.pick(LAST))),
        Generator::Username => {
            json!(format!(
                "{}{}",
                rng.pick(FIRST).to_ascii_lowercase(),
                row_index
            ))
        }
        Generator::Phone => json!(format!("+1{:010}", rng.below(10_000_000_000))),
        Generator::City => json!(rng.pick(CITY)),
        Generator::Country => {
            // Honor short code columns (e.g. CHAR(2)/(3) ISO codes).
            if max_len.map(|n| n < 4).unwrap_or(false) {
                json!(rng.pick(COUNTRY_CODE))
            } else {
                json!(rng.pick(COUNTRY))
            }
        }
        Generator::Company => json!(rng.pick(COMPANY)),
        Generator::Url => json!(format!(
            "https://{}.example.com/{row_index}",
            rng.pick(COMPANY).to_ascii_lowercase()
        )),
        Generator::Title => json!(format!("{} {}", rng.pick(WORDS), rng.pick(WORDS))),
        Generator::Sentence => json!(format!(
            "{} {} {} {}.",
            rng.pick(WORDS),
            rng.pick(WORDS),
            rng.pick(WORDS),
            rng.pick(WORDS)
        )),
        Generator::Decimal(int_digits, scale) => {
            let max_int = 10i64.checked_pow(*int_digits).unwrap_or(1_000_000).max(1);
            let int_part = rng.below(max_int as u64) as f64;
            let frac = if *scale == 0 {
                0.0
            } else {
                let denom = 10f64.powi(*scale as i32);
                (rng.below(denom as u64) as f64) / denom
            };
            let factor = 10f64.powi(*scale as i32);
            json!(((int_part + frac) * factor).round() / factor)
        }
        Generator::IntRange(a, b) => {
            if unique {
                // Sequential from the low bound, clamped into range.
                let lo = (*a).max(0);
                json!(lo.saturating_add(row_index as i64).min(*b))
            } else {
                // Keep values small but always inside the column's range.
                let lo = (*a).max(0);
                let hi = (*b).min(100_000).max(lo);
                let span = (hi - lo + 1) as u64;
                json!(lo + rng.below(span) as i64)
            }
        }
        Generator::Binary(n) => {
            use std::fmt::Write as _;
            // First up to 8 bytes encode row_index (uniqueness), rest random.
            let mut hex = String::with_capacity(2 + n * 2);
            hex.push_str("0x");
            for i in 0..*n {
                let b = if i < 8 {
                    (row_index >> (8 * i)) as u8
                } else {
                    rng.next_u64() as u8
                };
                let _ = write!(hex, "{b:02x}");
            }
            return json!(hex); // never clamp: max_len here is a byte count, not chars
        }
        Generator::Bool => json!(rng.below(2) == 1),
        Generator::DateTime => {
            let (y, m, d, h, mi, s) = civil(1_750_000_000 - rng.below(315_360_000));
            json!(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
        }
        Generator::DateOnly => {
            let (y, m, d, _, _, _) = civil(1_750_000_000 - rng.below(315_360_000));
            json!(format!("{y:04}-{m:02}-{d:02}"))
        }
        Generator::Uuid => json!(format!(
            "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
            rng.next_u64() as u32,
            rng.next_u64() as u16,
            (rng.next_u64() as u16) & 0x0fff,
            (rng.next_u64() as u16) & 0x3fff | 0x8000,
            rng.next_u64() & 0xffff_ffff_ffff
        )),
        Generator::Json => json!(format!("{{\"k\":{row_index}}}")),
        Generator::TextFallback => {
            if unique {
                json!(format!("{}-{row_index}", rng.pick(WORDS)))
            } else {
                json!(format!("{} {}", rng.pick(WORDS), rng.pick(WORDS)))
            }
        }
    };
    clamp(v, max_len)
}

/// Civil date-time `(y, m, d, h, mi, s)` from epoch seconds (no chrono).
/// Howard Hinnant's civil-from-days algorithm.
fn civil(secs: u64) -> (i64, i64, i64, u64, u64, u64) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::{ColumnInfo, FkRef};

    fn col(name: &str, ty: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable: false,
            pk: false,
            default_value: None,
            fk: None,
        }
    }

    fn classify(c: &ColumnInfo, unique: bool, autoinc: bool) -> Generator {
        let parsed = parse_type(&c.data_type);
        classify_column(c, &parsed, unique, autoinc)
    }

    #[test]
    fn rng_is_deterministic_for_a_seed() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        assert_eq!(a.next_u64(), b.next_u64());
    }

    #[test]
    fn email_column_classified_by_name() {
        assert!(matches!(
            classify(&col("email", "varchar(255)"), false, false),
            Generator::Email
        ));
        assert!(matches!(
            classify(&col("user_email", "text"), false, false),
            Generator::Email
        ));
    }

    #[test]
    fn fk_column_classified_as_foreign_key() {
        let mut c = col("user_id", "int");
        c.fk = Some(FkRef {
            table: "users".into(),
            column: "id".into(),
        });
        assert!(matches!(classify(&c, false, false), Generator::ForeignKey));
    }

    #[test]
    fn autoinc_pk_is_omitted_generator() {
        let mut c = col("id", "integer");
        c.pk = true;
        assert!(matches!(classify(&c, true, true), Generator::AutoPk));
    }

    #[test]
    fn email_value_looks_like_an_email_and_is_unique() {
        let mut rng = Rng::new(1);
        let a = generate(&Generator::Email, &mut rng, 0, true, None);
        let b = generate(&Generator::Email, &mut rng, 1, true, None);
        assert!(a.as_str().unwrap().contains('@'), "{a}");
        assert_ne!(a, b, "unique emails differ per row");
    }

    // --- type-aware regression tests (the MySQL failures) ---

    #[test]
    fn account_id_does_not_match_count() {
        // varchar account_id must be a text generator, never an int range.
        let g = classify(&col("account_id", "varchar(36)"), false, false);
        assert!(
            matches!(g, Generator::TextFallback | Generator::Uuid),
            "{g:?}"
        );
    }

    #[test]
    fn tinyint1_is_a_bool() {
        assert_eq!(parse_type("tinyint(1)").family, Family::Bool);
        assert!(matches!(
            classify(&col("paid", "tinyint(1)"), false, false),
            Generator::Bool
        ));
    }

    #[test]
    fn smallint_range_never_overflows() {
        let p = parse_type("smallint");
        assert_eq!((p.int_min, p.int_max), (-32768, 32767));
        let mut rng = Rng::new(5);
        let g = Generator::IntRange(p.int_min, p.int_max);
        for _ in 0..200 {
            let v = generate(&g, &mut rng, 0, false, None).as_i64().unwrap();
            assert!((-32768..=32767).contains(&v), "{v}");
        }
    }

    #[test]
    fn unsigned_tinyint_stays_in_byte_range() {
        let p = parse_type("tinyint unsigned");
        assert_eq!((p.int_min, p.int_max), (0, 255));
    }

    #[test]
    fn datetime_has_no_t_or_z_separator() {
        let mut rng = Rng::new(9);
        let v = generate(&Generator::DateTime, &mut rng, 0, false, None);
        let s = v.as_str().unwrap();
        assert!(!s.contains('T') && !s.contains('Z'), "{s}");
        assert_eq!(s.len(), 19, "YYYY-MM-DD HH:MM:SS: {s}");
        assert_eq!(&s[10..11], " ");
    }

    #[test]
    fn date_only_is_ten_chars() {
        let mut rng = Rng::new(9);
        let v = generate(&Generator::DateOnly, &mut rng, 0, false, None);
        assert_eq!(v.as_str().unwrap().len(), 10);
    }

    #[test]
    fn short_country_column_emits_a_code() {
        let mut rng = Rng::new(2);
        let v = generate(&Generator::Country, &mut rng, 0, false, Some(2));
        assert!(v.as_str().unwrap().chars().count() <= 2, "{v}");
    }

    #[test]
    fn strings_are_clamped_to_max_len() {
        let mut rng = Rng::new(3);
        let v = generate(&Generator::FullName, &mut rng, 0, false, Some(4));
        assert!(v.as_str().unwrap().chars().count() <= 4, "{v}");
    }

    #[test]
    fn decimal_respects_precision() {
        let p = parse_type("decimal(5,2)");
        assert_eq!(p.family, Family::Decimal);
        let mut rng = Rng::new(7);
        let g = Generator::Decimal(p.dec_int_digits, p.dec_scale);
        for _ in 0..100 {
            let v = generate(&g, &mut rng, 0, false, None).as_f64().unwrap();
            // integer part < 10^(5-2) = 1000
            assert!((0.0..1000.0).contains(&v), "{v}");
        }
    }

    #[test]
    fn varchar_length_is_parsed() {
        assert_eq!(parse_type("varchar(2)").max_len, Some(2));
        assert_eq!(parse_type("char(3)").max_len, Some(3));
        assert_eq!(parse_type("text").max_len, None);
    }
}
