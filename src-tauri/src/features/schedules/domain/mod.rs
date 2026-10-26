//! Domain model for the schedules slice (M41, `MILESTONE_41_SCHEDULED_QUERIES.md`):
//! what a scheduled report IS, when it is next due, what its output file is
//! called, and how a result set becomes CSV or JSON text.
//!
//! Everything here is pure — no clock of its own (the caller passes `now`), no
//! filesystem, no engine. That is what makes the recurrence math, which is the
//! part most likely to be subtly wrong at a month end or across a DST shift,
//! testable without a running app.
//!
//! Design note: as in the saved-queries and connections slices, the plain
//! `serde` derives double as the wire AND persisted representation (camelCase
//! fields), so the renderer's TS literals match exactly.

use chrono::{DateTime, Datelike, Days, LocalResult, Months, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};

use crate::features::export::domain::csv_value;

/// Floor for [`Recurrence::Every`], in minutes.
///
/// There is no legitimate scheduled-report use for a one-minute recurrence,
/// and the floor is the difference between a feature and a way to accidentally
/// hold a connection open permanently.
pub const MIN_EVERY_MINUTES: u32 = 5;

/// Rows a scheduled run reads before it stops, unless the schedule says
/// otherwise. Far above the renderer's `MAX_ROW_LIMIT` on purpose: that
/// constant exists to stop an unbounded result set crossing the IPC boundary,
/// and this path writes to a file without going near IPC.
pub const DEFAULT_ROW_LIMIT: u32 = 100_000;

/// Output files kept per schedule before the oldest are pruned.
pub const DEFAULT_KEEP: u32 = 30;

/// Run records kept per schedule. The history is a diagnostic, not an audit
/// log; twenty runs is enough to see a pattern of failures.
pub const MAX_HISTORY: usize = 20;

/// Longest filename stem this slice will produce, in characters. Comfortably
/// under every filesystem's 255-BYTE component limit even when every character
/// is multi-byte.
const MAX_FILENAME_STEM: usize = 120;

/// The §5 sentence a non-reading scheduled query is refused with, at save
/// time and again before a run opens anything.
///
/// Not the generic `readonly::read_only_error` message: that one ends with
/// "reconnect with read-only turned off", which is advice a scheduled run
/// cannot take. There is nothing to reconnect and nobody to do it.
pub const WRITE_REFUSED: &str = "A scheduled query must only read. Statements that change data \
                                 or structure are refused — a schedule runs unattended, where \
                                 an accidental write has nobody to catch it.";

/// Whether `sql` provably only reads, by the app's own conservative
/// classifier (`shared::readonly`) — the same one that guards a read-only
/// workspace, so a schedule and a read-only session agree on what a read is.
pub fn sql_only_reads(sql: &str) -> bool {
    crate::shared::readonly::sql_is_read_only(sql)
}

/// What a scheduled run writes.
///
/// No `sql` variant, unlike the manual export's [`ExportFormat`]: a SQL dump is
/// `CREATE TABLE` + `INSERT`, and a query result has no table to anchor either
/// to.
///
/// [`ExportFormat`]: crate::features::export::domain::ExportFormat
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    /// A header row of column names + one line per row, `csv_value`-escaped —
    /// byte-identical to what the manual table export produces.
    Csv,
    /// An array of objects keyed by column name, in COLUMN order.
    Json,
}

impl OutputFormat {
    /// The extension appended to the resolved filename stem (no dot).
    pub fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }
}

/// When a schedule runs.
///
/// Serde-tagged (`{ "kind": "daily", "hour": 3, "minute": 0 }`) so a
/// `Cron { expr }` variant can be added later without a format break. The
/// deliberate omission is a cron expression: cron is the right answer for the
/// user who already thinks in cron and the wrong one for everybody else, and
/// these four cover "nightly", "hourly", "every Monday" and "the 1st".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Recurrence {
    /// A fixed interval from the previous due time. Minimum
    /// [`MIN_EVERY_MINUTES`].
    Every { minutes: u32 },
    /// Every day at a local wall-clock time.
    Daily { hour: u32, minute: u32 },
    /// One day a week at a local wall-clock time. `weekday` is 0 = Sunday,
    /// matching JavaScript's `Date.getDay()` so the renderer needs no mapping.
    Weekly {
        weekday: u32,
        hour: u32,
        minute: u32,
    },
    /// One day a month at a local wall-clock time. A `day` past the end of a
    /// short month CLAMPS to its last day rather than skipping the month —
    /// skipping is what real cron does and the thing people file bugs about.
    Monthly { day: u32, hour: u32, minute: u32 },
}

impl Recurrence {
    /// What is wrong with this recurrence, or `None`. A human message
    /// (DESIGN_SPEC §5), checked field by field.
    pub fn validation_error(&self) -> Option<&'static str> {
        match *self {
            Self::Every { minutes } => {
                if minutes < MIN_EVERY_MINUTES {
                    return Some("A repeating schedule must be at least 5 minutes apart.");
                }
                None
            }
            Self::Daily { hour, minute } => time_error(hour, minute),
            Self::Weekly {
                weekday,
                hour,
                minute,
            } => {
                if weekday > 6 {
                    return Some("Day of week must be between 0 (Sunday) and 6 (Saturday).");
                }
                time_error(hour, minute)
            }
            Self::Monthly { day, hour, minute } => {
                if !(1..=31).contains(&day) {
                    return Some("Day of month must be between 1 and 31.");
                }
                time_error(hour, minute)
            }
        }
    }

    /// The first occurrence strictly AFTER `after`.
    ///
    /// Strictly, so that recomputing from the instant a run just happened
    /// cannot return that same instant and fire twice. Returns `None` only when
    /// the local calendar has no valid instant anywhere near the target — in
    /// practice unreachable, but the clock is not something to `unwrap` on.
    pub fn next_due_after(
        &self,
        after: DateTime<chrono::Local>,
    ) -> Option<DateTime<chrono::Local>> {
        match *self {
            Self::Every { minutes } => {
                let step = minutes.max(MIN_EVERY_MINUTES) as i64;
                after.checked_add_signed(chrono::Duration::minutes(step))
            }
            Self::Daily { hour, minute } => {
                let today = after.date_naive();
                first_after(after, [today, today.checked_add_days(Days::new(1))?], |d| {
                    local_at(d, hour, minute)
                })
            }
            Self::Weekly {
                weekday,
                hour,
                minute,
            } => {
                // Scan this week's matching day and the next one. Two candidates
                // suffice: if today IS the weekday but the time has passed, the
                // answer is seven days later.
                let today = after.date_naive();
                // `num_days_from_sunday` matches our 0 = Sunday convention.
                let current = today.weekday().num_days_from_sunday();
                let ahead = (weekday + 7 - current) % 7;
                let first = today.checked_add_days(Days::new(ahead as u64))?;
                let second = first.checked_add_days(Days::new(7))?;
                first_after(after, [first, second], |d| local_at(d, hour, minute))
            }
            Self::Monthly { day, hour, minute } => {
                let today = after.date_naive();
                let this_month = clamped_day(today.year(), today.month(), day)?;
                let next = today.checked_add_months(Months::new(1))?;
                let next_month = clamped_day(next.year(), next.month(), day)?;
                first_after(after, [this_month, next_month], |d| {
                    local_at(d, hour, minute)
                })
            }
        }
    }
}

/// `hour`/`minute` out of range, as a §5 message.
fn time_error(hour: u32, minute: u32) -> Option<&'static str> {
    if hour > 23 {
        return Some("Hour must be between 0 and 23.");
    }
    if minute > 59 {
        return Some("Minute must be between 0 and 59.");
    }
    None
}

/// `day` of the given month, clamped to the month's last day — so a schedule
/// set to the 31st lands on the 28th/29th in February instead of vanishing.
fn clamped_day(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
    let last = last_day_of_month(year, month)?;
    NaiveDate::from_ymd_opt(year, month, day.clamp(1, last))
}

/// Days in `month` of `year`, Gregorian leap rules included (computed, not
/// tabulated: the first of the next month minus one day).
fn last_day_of_month(year: i32, month: u32) -> Option<u32> {
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    Some(first.checked_add_months(Months::new(1))?.pred_opt()?.day())
}

/// The first candidate date whose local instant is strictly after `after`.
fn first_after<F>(
    after: DateTime<chrono::Local>,
    candidates: [NaiveDate; 2],
    at: F,
) -> Option<DateTime<chrono::Local>>
where
    F: Fn(NaiveDate) -> Option<DateTime<chrono::Local>>,
{
    candidates
        .into_iter()
        .filter_map(at)
        .find(|instant| *instant > after)
}

/// A local wall-clock instant for `date` at `hour:minute`, resolving the two
/// ways a local time can fail to name exactly one instant:
///
/// - **Ambiguous** (clocks went back, the hour runs twice): take the EARLIER
///   occurrence, so a 01:30 nightly report runs once, at the first 01:30.
/// - **Nonexistent** (clocks went forward, the hour never happens): walk
///   forward a minute at a time to the first instant that does exist, so a
///   02:30 report on a spring-forward night runs at 03:00 rather than being
///   silently skipped for the day.
fn local_at(date: NaiveDate, hour: u32, minute: u32) -> Option<DateTime<chrono::Local>> {
    // Up to three hours of gap covers every DST jump in the tz database.
    for extra in 0..180 {
        let total = hour * 60 + minute + extra;
        let naive = date
            .checked_add_days(Days::new((total / 1440) as u64))?
            .and_hms_opt((total / 60) % 24, total % 60, 0)?;
        match chrono::Local.from_local_datetime(&naive) {
            LocalResult::Single(instant) => return Some(instant),
            LocalResult::Ambiguous(earliest, _) => return Some(earliest),
            LocalResult::None => continue,
        }
    }
    None
}

/// One scheduled report.
///
/// `sql` is a RESOLVED SNAPSHOT, not a pointer into the saved query. Query
/// parameters (`:name` / `${name}` / `?`) are substituted by the renderer
/// (`features/workspaces/sqlParams.ts`) when the schedule is saved, because the
/// lexer that decides what is and is not a placeholder lives there and a second
/// implementation of it in Rust is the one thing in this feature that must
/// never disagree with the first. `saved_query_id` is kept for provenance only.
///
/// The dynamic part survives as `{{today}}`-style date tokens inside the
/// snapshot, which [`resolve_sql_tokens`] expands per run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// UUID assigned by the save use-case when empty (new entry).
    pub id: String,
    pub name: String,
    /// Paused schedules stay in the list and keep their history; they are
    /// simply never due. Defaults to true so a hand-written entry runs.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// The persisted `SavedConnection` id this runs against. Opaque here; the
    /// run use-case resolves it (and fails the run if it has been deleted).
    pub connection_id: String,
    /// Schema context for unqualified names, as `QueryOptions::schema`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// The saved query this snapshot came from, for display and re-snapshot.
    /// Absent for a schedule created from an ad-hoc buffer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_query_id: Option<String>,
    pub sql: String,
    pub recurrence: Recurrence,
    pub format: OutputFormat,
    /// Absolute path of the directory the output lands in.
    pub directory: String,
    /// Filename STEM pattern, tokens included, WITHOUT an extension — the
    /// extension comes from `format`, so switching CSV to JSON cannot leave a
    /// `.csv` file full of JSON.
    pub filename: String,
    /// Output files to keep. Pruning only ever considers files this schedule's
    /// own pattern could have produced.
    #[serde(default = "default_keep")]
    pub keep: u32,
    #[serde(default = "default_row_limit")]
    pub row_limit: u32,
    /// Unix epoch milliseconds, assigned on first save (a plain integer, as in
    /// connections' `created_at` and saved queries' `saved_at`).
    pub created_at: u64,
    /// Unix epoch milliseconds of the next due run, maintained by the
    /// scheduler. 0 = never computed; the scheduler fills it in on first sight.
    #[serde(default)]
    pub next_run_at: u64,
}

fn default_enabled() -> bool {
    true
}
fn default_keep() -> u32 {
    DEFAULT_KEEP
}
fn default_row_limit() -> u32 {
    DEFAULT_ROW_LIMIT
}

impl Schedule {
    /// Validate the user-supplied fields, in field order. Returns a human
    /// message (DESIGN_SPEC §5) on the first problem.
    pub fn validation_error(&self) -> Option<&'static str> {
        if self.name.trim().is_empty() {
            return Some("Schedule name is required.");
        }
        if self.connection_id.trim().is_empty() {
            return Some("Pick a connection to run against.");
        }
        if self.sql.trim().is_empty() {
            return Some("Schedule SQL is required.");
        }
        if !sql_only_reads(&self.sql) {
            return Some(WRITE_REFUSED);
        }
        if self.directory.trim().is_empty() {
            return Some("Pick an output folder.");
        }
        if self.filename.trim().is_empty() {
            return Some("Output filename is required.");
        }
        if let Some(message) = self.recurrence.validation_error() {
            return Some(message);
        }
        if self.keep == 0 {
            return Some("Keep at least one output file.");
        }
        if self.row_limit == 0 {
            return Some("Row limit must be at least 1.");
        }
        None
    }

    /// The output file's name — pattern tokens resolved, sanitized, extension
    /// appended.
    pub fn output_filename(&self, now: DateTime<chrono::Local>, env: &str) -> String {
        let stem = resolve_filename_tokens(&self.filename, now, &self.name, env);
        format!("{stem}.{}", self.format.extension())
    }

    /// Whether `filename` is one this schedule could have written — the test
    /// pruning uses, so it can never delete a file it did not produce.
    ///
    /// Matching is on the pattern's FIXED text, in order: its literal runs
    /// plus `{{name}}` and `{{env}}`, which are tokens but resolve to the same
    /// value on every run of a given schedule. Only the date tokens actually
    /// vary, and they are the gaps between the fixed parts. So
    /// `{{name}}_{{date}}` on a schedule called "Nightly orders" requires
    /// `Nightly orders_` to appear — which "Weekly revenue_20261026.csv" does
    /// not, even though it is a `.csv` with an underscore in it.
    ///
    /// Deliberately conservative in both directions it can be wrong. A pattern
    /// with no fixed text at all (`{{date}}`) matches NOTHING and is never
    /// pruned: with nothing to tell this schedule's output from anyone else's
    /// in a shared folder, leaving files behind is the only acceptable
    /// mistake. The default pattern includes `{{name}}`, and the name is
    /// required, so this does not arise unless someone goes looking for it.
    pub fn owns_filename(&self, filename: &str, env: &str) -> bool {
        let extension = format!(".{}", self.format.extension());
        let Some(stem) = filename.strip_suffix(&extension) else {
            return false;
        };
        let fixed = self.fixed_filename_parts(env);
        if fixed.is_empty() {
            return false;
        }
        let mut rest = stem;
        for part in fixed {
            match rest.find(&part) {
                Some(at) => rest = &rest[at + part.len()..],
                None => return false,
            }
        }
        true
    }

    /// The parts of this schedule's filename pattern that are the same on
    /// every run: literal text, with `{{name}}` / `{{env}}` folded in. Each is
    /// character-sanitized the same way the real filename was, so the
    /// comparison is against what actually reached the disk.
    fn fixed_filename_parts(&self, env: &str) -> Vec<String> {
        let mut parts = Vec::new();
        let mut current = String::new();
        for piece in split_pattern(&self.filename) {
            match piece {
                PatternPiece::Literal(text) => current.push_str(&text),
                PatternPiece::Token(name) if name == "name" => current.push_str(&self.name),
                PatternPiece::Token(name) if name == "env" => current.push_str(env),
                // A varying token ends the current fixed run.
                PatternPiece::Token(_) => {
                    let sanitized = replace_illegal_chars(&current);
                    if !sanitized.is_empty() {
                        parts.push(sanitized);
                    }
                    current.clear();
                }
            }
        }
        let sanitized = replace_illegal_chars(&current);
        if !sanitized.is_empty() {
            parts.push(sanitized);
        }
        parts
    }
}

/// Why a run happened — a scheduled occurrence, or the manager's "Run now".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunTrigger {
    Scheduled,
    Manual,
}

/// One entry in a schedule's history.
///
/// Exactly one of `path` / `error` is meaningful: `path` on success (so the
/// manager can reveal the file), `error` on failure (the §5 message, stored as
/// text because an `AppError` is not what the history is for — it is read by a
/// person).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub schedule_id: String,
    /// Unix epoch milliseconds.
    pub started_at: u64,
    pub duration_ms: u64,
    pub trigger: RunTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub row_count: u64,
    /// The row limit cut the result short — a report that is quietly losing
    /// rows shows up here instead of going unnoticed for a month.
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RunRecord {
    /// Whether this run produced a file.
    pub fn succeeded(&self) -> bool {
        self.error.is_none()
    }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Expand the DATE tokens in a SQL snapshot: `{{today}}`, `{{yesterday}}`,
/// `{{now}}`, `{{month_start}}`, `{{days_ago:N}}`. All local time, matching
/// `exportStamp`'s reasoning — these read back as the wall-clock day the report
/// covers.
///
/// A plain string replace is safe here *because* the renderer already quoted
/// the parameter: a token sits inside the literal it belongs to
/// (`created_at >= '{{yesterday}}'`), and every value this produces is
/// date-shaped — digits, hyphens, colons and spaces, no quote and no backslash
/// — so it cannot break out of that literal. [`is_date_shaped`] ENFORCES that
/// rather than assuming it; a value that somehow failed the check is left
/// unsubstituted instead of being pasted into SQL.
///
/// Only date tokens: `{{name}}` and `{{env}}` are user-controlled text and are
/// deliberately not available here, where their quoting would be our problem.
/// An unrecognised token is left exactly as written, so a typo is visible in
/// the run's error instead of silently becoming an empty string — the same
/// stance `applyParams` takes on an unresolved placeholder.
pub fn resolve_sql_tokens(sql: &str, now: DateTime<chrono::Local>) -> String {
    render_tokens(sql, |token| {
        date_token(token, now).filter(|value| is_date_shaped(value))
    })
}

/// Expand a filename pattern's tokens and sanitize the result into a single
/// safe path component. Date tokens as above, plus `{{name}}` (the schedule
/// name), `{{env}}` (the connection's deployment environment), `{{date}}` and
/// `{{time}}` (the compact forms `exportStamp` uses, so scheduled output sorts
/// beside manual exports).
pub fn resolve_filename_tokens(
    pattern: &str,
    now: DateTime<chrono::Local>,
    name: &str,
    env: &str,
) -> String {
    let resolved = render_tokens(pattern, |token| match token {
        "name" => Some(name.to_string()),
        "env" => Some(env.to_string()),
        "date" => Some(now.format("%Y%m%d").to_string()),
        "time" => Some(now.format("%H%M%S").to_string()),
        other => date_token(other, now),
    });
    sanitize_component(&resolved)
}

/// The value of a date token, or `None` when the name is not one.
fn date_token(token: &str, now: DateTime<chrono::Local>) -> Option<String> {
    let date = now.date_naive();
    match token {
        "today" => Some(date.to_string()),
        "yesterday" => Some(date.checked_sub_days(Days::new(1))?.to_string()),
        "now" => Some(now.format("%Y-%m-%d %H:%M:%S").to_string()),
        "month_start" => Some(NaiveDate::from_ymd_opt(date.year(), date.month(), 1)?.to_string()),
        other => {
            let n: u64 = other.strip_prefix("days_ago:")?.trim().parse().ok()?;
            Some(date.checked_sub_days(Days::new(n))?.to_string())
        }
    }
}

/// Digits, hyphens, colons and spaces only — the shape every date token
/// produces, and the shape that cannot terminate a SQL string literal.
fn is_date_shaped(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | ' '))
}

/// Replace every `{{token}}` for which `lookup` returns a value. Unrecognised
/// tokens, and an unterminated `{{`, are left exactly as written.
fn render_tokens<F>(template: &str, lookup: F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            // Unterminated — the rest is literal text.
            out.push_str(&rest[start..]);
            return out;
        };
        let token = after[..end].trim();
        match lookup(token) {
            Some(value) => out.push_str(&value),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// One piece of a token pattern.
enum PatternPiece {
    Literal(String),
    Token(String),
}

/// A pattern split into its literal runs and its tokens, in order. An
/// unterminated `{{` is literal text, matching [`render_tokens`].
fn split_pattern(pattern: &str) -> Vec<PatternPiece> {
    let mut out = Vec::new();
    let mut rest = pattern;
    while let Some(start) = rest.find("{{") {
        if start > 0 {
            out.push(PatternPiece::Literal(rest[..start].to_string()));
        }
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push(PatternPiece::Literal(rest[start..].to_string()));
            return out;
        };
        out.push(PatternPiece::Token(after[..end].trim().to_string()));
        rest = &after[end + 2..];
    }
    if !rest.is_empty() {
        out.push(PatternPiece::Literal(rest.to_string()));
    }
    out
}

/// Reduce arbitrary text to one safe path component.
///
/// Path separators, the Windows-illegal set (`<>:"|?*`) and control characters
/// all become `_`; a leading dot is dropped (no accidental hidden files);
/// trailing dots and spaces are trimmed (Windows silently strips them, which
/// would make the pruner's filename comparison wrong); a Windows device name
/// (`CON`, `NUL`, `COM1`, …) is prefixed; and the result is capped at
/// [`MAX_FILENAME_STEM`] characters. An empty result becomes `export`, because
/// a nameless file is worse than a generic one.
fn sanitize_component(raw: &str) -> String {
    let mut out = replace_illegal_chars(raw);
    out = out.trim().trim_start_matches('.').to_string();
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.chars().count() > MAX_FILENAME_STEM {
        out = out.chars().take(MAX_FILENAME_STEM).collect();
        out = out.trim_end().to_string();
    }
    if out.is_empty() {
        return "export".to_string();
    }
    if is_windows_device_name(&out) {
        return format!("_{out}");
    }
    out
}

/// The character-level half of [`sanitize_component`]: path separators, the
/// Windows-illegal set and control characters become `_`. Split out because
/// [`Schedule::fixed_filename_parts`] needs exactly this and NOT the
/// whole-string trimming, which only makes sense applied once to a complete
/// filename.
fn replace_illegal_chars(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect()
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` — reserved on
/// Windows whatever the extension, and sanitized on every platform so a
/// schedules.json written on macOS still works when the folder is synced.
fn is_windows_device_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if let Some(rest) = upper
        .strip_prefix("COM")
        .or_else(|| upper.strip_prefix("LPT"))
    {
        return rest.len() == 1 && matches!(rest.as_bytes()[0], b'1'..=b'9');
    }
    false
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/// A result set as CSV: a header row of column names, then one line per row,
/// every value through the export slice's `csv_value` — so a scheduled CSV and
/// a manually exported one escape identically.
///
/// Ends with a newline, unlike the manual export's in-memory text: this one is
/// a file on disk that other tools (`cat`, `tail -n +2`, spreadsheet importers)
/// will read, and a missing final newline is a real annoyance there.
pub fn rows_to_csv(columns: &[String], rows: &[Vec<serde_json::Value>]) -> String {
    let mut out = String::new();
    out.push_str(
        &columns
            .iter()
            .map(|name| csv_value(&serde_json::Value::String(name.clone())))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for row in rows {
        out.push_str(&row.iter().map(csv_value).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

/// A result set as a JSON array of objects keyed by column name.
///
/// Assembled as text rather than through `serde_json::Map` deliberately: that
/// map is a `BTreeMap` in this build (no `preserve_order` feature), so going
/// through it would silently alphabetize the columns of every report. Keys and
/// values still go through `serde_json` for escaping — only the ORDER is ours.
///
/// A duplicated column name (`SELECT id, id`) produces a duplicated key, which
/// is legal JSON; most parsers keep the last. Renaming it is the user's call,
/// not ours.
pub fn rows_to_json(columns: &[String], rows: &[Vec<serde_json::Value>]) -> String {
    let keys: Vec<String> = columns
        .iter()
        .map(|name| serde_json::Value::String(name.clone()).to_string())
        .collect();
    let mut out = String::from("[\n");
    for (index, row) in rows.iter().enumerate() {
        out.push_str("  {");
        for (column, value) in row.iter().enumerate() {
            if column > 0 {
                out.push_str(", ");
            }
            // A row with more values than columns cannot happen (the engine
            // builds both), but naming the extra rather than panicking keeps
            // this total.
            let key = keys.get(column).cloned().unwrap_or_else(|| {
                serde_json::Value::String(format!("column{}", column + 1)).to_string()
            });
            out.push_str(&key);
            out.push_str(": ");
            out.push_str(&value.to_string());
        }
        out.push('}');
        if index + 1 < rows.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push_str("]\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Local;
    use serde_json::json;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        local_at(NaiveDate::from_ymd_opt(y, m, d).expect("date"), h, min).expect("local instant")
    }

    fn schedule() -> Schedule {
        Schedule {
            id: "s1".into(),
            name: "Nightly orders".into(),
            enabled: true,
            connection_id: "conn-1".into(),
            schema: Some("public".into()),
            saved_query_id: Some("q-9".into()),
            sql: "SELECT 1".into(),
            recurrence: Recurrence::Daily { hour: 3, minute: 0 },
            format: OutputFormat::Csv,
            directory: "/tmp/reports".into(),
            filename: "{{name}}_{{date}}".into(),
            keep: DEFAULT_KEEP,
            row_limit: DEFAULT_ROW_LIMIT,
            created_at: 1_761_480_000_000,
            next_run_at: 0,
        }
    }

    // --- recurrence -------------------------------------------------------

    #[test]
    fn every_steps_forward_by_the_interval() {
        let now = at(2026, 10, 26, 10, 0);
        let next = Recurrence::Every { minutes: 15 }
            .next_due_after(now)
            .expect("next");
        assert_eq!(next, now + chrono::Duration::minutes(15));
    }

    #[test]
    fn every_is_floored_even_if_a_hand_edited_file_asks_for_less() {
        let now = at(2026, 10, 26, 10, 0);
        let next = Recurrence::Every { minutes: 1 }
            .next_due_after(now)
            .expect("next");
        assert_eq!(
            next,
            now + chrono::Duration::minutes(MIN_EVERY_MINUTES as i64)
        );
    }

    #[test]
    fn daily_picks_today_when_the_time_is_still_ahead() {
        let next = Recurrence::Daily { hour: 3, minute: 0 }
            .next_due_after(at(2026, 10, 26, 1, 30))
            .expect("next");
        assert_eq!(next, at(2026, 10, 26, 3, 0));
    }

    #[test]
    fn daily_rolls_to_tomorrow_once_the_time_has_passed() {
        let next = Recurrence::Daily { hour: 3, minute: 0 }
            .next_due_after(at(2026, 10, 26, 3, 0))
            .expect("next");
        assert_eq!(next, at(2026, 10, 27, 3, 0));
    }

    #[test]
    fn weekly_finds_the_next_matching_weekday() {
        // 2026-10-26 is a Monday; weekday 1 = Monday, 3 = Wednesday.
        let monday = at(2026, 10, 26, 10, 0);
        let wednesday = Recurrence::Weekly {
            weekday: 3,
            hour: 7,
            minute: 0,
        }
        .next_due_after(monday)
        .expect("next");
        assert_eq!(wednesday, at(2026, 10, 28, 7, 0));
    }

    #[test]
    fn weekly_on_today_after_the_time_lands_a_week_out() {
        let monday_late = at(2026, 10, 26, 10, 0);
        let next = Recurrence::Weekly {
            weekday: 1,
            hour: 7,
            minute: 0,
        }
        .next_due_after(monday_late)
        .expect("next");
        assert_eq!(next, at(2026, 11, 2, 7, 0));
    }

    #[test]
    fn monthly_clamps_the_31st_into_february_instead_of_skipping_it() {
        let next = Recurrence::Monthly {
            day: 31,
            hour: 6,
            minute: 0,
        }
        .next_due_after(at(2026, 2, 1, 0, 0))
        .expect("next");
        // 2026 is not a leap year.
        assert_eq!(next, at(2026, 2, 28, 6, 0));

        let leap = Recurrence::Monthly {
            day: 31,
            hour: 6,
            minute: 0,
        }
        .next_due_after(at(2028, 2, 1, 0, 0))
        .expect("next");
        assert_eq!(leap, at(2028, 2, 29, 6, 0));
    }

    #[test]
    fn monthly_rolls_into_next_month_once_the_day_has_passed() {
        let next = Recurrence::Monthly {
            day: 1,
            hour: 6,
            minute: 0,
        }
        .next_due_after(at(2026, 10, 26, 10, 0))
        .expect("next");
        assert_eq!(next, at(2026, 11, 1, 6, 0));
    }

    #[test]
    fn next_due_is_strictly_after_so_a_run_cannot_fire_twice() {
        let fire = at(2026, 10, 26, 3, 0);
        let next = Recurrence::Daily { hour: 3, minute: 0 }
            .next_due_after(fire)
            .expect("next");
        assert!(next > fire);
    }

    #[test]
    fn last_day_of_month_knows_the_leap_rules() {
        assert_eq!(last_day_of_month(2026, 2), Some(28));
        assert_eq!(last_day_of_month(2028, 2), Some(29));
        assert_eq!(last_day_of_month(2000, 2), Some(29)); // divisible by 400
        assert_eq!(last_day_of_month(1900, 2), Some(28)); // divisible by 100
        assert_eq!(last_day_of_month(2026, 4), Some(30));
        assert_eq!(last_day_of_month(2026, 12), Some(31));
    }

    #[test]
    fn recurrence_validation_messages() {
        assert!(Recurrence::Every { minutes: 4 }
            .validation_error()
            .is_some());
        assert!(Recurrence::Every { minutes: 5 }
            .validation_error()
            .is_none());
        assert!(Recurrence::Daily {
            hour: 24,
            minute: 0
        }
        .validation_error()
        .is_some());
        assert!(Recurrence::Daily {
            hour: 0,
            minute: 60
        }
        .validation_error()
        .is_some());
        assert!(Recurrence::Weekly {
            weekday: 7,
            hour: 0,
            minute: 0
        }
        .validation_error()
        .is_some());
        assert!(Recurrence::Monthly {
            day: 0,
            hour: 0,
            minute: 0
        }
        .validation_error()
        .is_some());
        assert!(Recurrence::Monthly {
            day: 31,
            hour: 23,
            minute: 59
        }
        .validation_error()
        .is_none());
    }

    #[test]
    fn recurrence_is_tagged_on_the_wire() {
        let json = serde_json::to_value(Recurrence::Daily { hour: 3, minute: 5 }).expect("ser");
        assert_eq!(json, json!({ "kind": "daily", "hour": 3, "minute": 5 }));
        let back: Recurrence =
            serde_json::from_value(json!({ "kind": "every", "minutes": 30 })).expect("de");
        assert_eq!(back, Recurrence::Every { minutes: 30 });
    }

    // --- tokens -----------------------------------------------------------

    #[test]
    fn sql_date_tokens_resolve() {
        let now = at(2026, 10, 26, 3, 0);
        assert_eq!(
            resolve_sql_tokens("WHERE d >= '{{yesterday}}' AND d < '{{today}}'", now),
            "WHERE d >= '2026-10-25' AND d < '2026-10-26'"
        );
        assert_eq!(
            resolve_sql_tokens("SELECT '{{month_start}}'", now),
            "SELECT '2026-10-01'"
        );
        assert_eq!(
            resolve_sql_tokens("SELECT '{{days_ago:7}}'", now),
            "SELECT '2026-10-19'"
        );
        assert_eq!(
            resolve_sql_tokens("SELECT '{{now}}'", now).len(),
            "SELECT '2026-10-26 03:00:00'".len()
        );
    }

    #[test]
    fn sql_tokens_tolerate_surrounding_whitespace() {
        let now = at(2026, 10, 26, 3, 0);
        assert_eq!(resolve_sql_tokens("'{{ today }}'", now), "'2026-10-26'");
    }

    #[test]
    fn an_unknown_sql_token_is_left_exactly_as_written() {
        let now = at(2026, 10, 26, 3, 0);
        // Including the user-text tokens, which are filename-only on purpose.
        assert_eq!(
            resolve_sql_tokens("SELECT '{{tomorrow}}', '{{name}}'", now),
            "SELECT '{{tomorrow}}', '{{name}}'"
        );
    }

    #[test]
    fn an_unterminated_token_is_literal_text() {
        let now = at(2026, 10, 26, 3, 0);
        assert_eq!(
            resolve_sql_tokens("SELECT '{{today", now),
            "SELECT '{{today"
        );
    }

    #[test]
    fn every_date_token_is_date_shaped_so_it_cannot_escape_a_literal() {
        let now = at(2026, 10, 26, 3, 0);
        for token in ["today", "yesterday", "now", "month_start", "days_ago:3"] {
            let value = date_token(token, now).expect(token);
            assert!(is_date_shaped(&value), "{token} produced {value:?}");
            assert!(!value.contains('\''));
            assert!(!value.contains('\\'));
        }
    }

    #[test]
    fn filename_tokens_resolve_and_sanitize() {
        let now = at(2026, 10, 26, 3, 7);
        assert_eq!(
            resolve_filename_tokens("{{name}}_{{env}}_{{date}}-{{time}}", now, "Orders", "prod"),
            "Orders_prod_20261026-030700"
        );
    }

    #[test]
    fn a_schedule_name_cannot_write_outside_the_output_folder() {
        let now = at(2026, 10, 26, 3, 0);
        let stem = resolve_filename_tokens("{{name}}", now, "../../etc/passwd", "");
        assert!(!stem.contains('/'));
        assert!(!stem.contains('\\'));
        // Separators flattened, then the leading dots dropped so it is not a
        // hidden file either.
        assert_eq!(stem, "_.._etc_passwd");
    }

    #[test]
    fn sanitize_handles_empty_dotfiles_devices_and_length() {
        assert_eq!(sanitize_component(""), "export");
        assert_eq!(sanitize_component("   "), "export");
        assert_eq!(sanitize_component(".hidden"), "hidden");
        assert_eq!(sanitize_component("report."), "report");
        assert_eq!(sanitize_component("NUL"), "_NUL");
        assert_eq!(sanitize_component("com4"), "_com4");
        assert_eq!(sanitize_component("com10"), "com10"); // not a device
        assert_eq!(sanitize_component(&"x".repeat(200)).chars().count(), 120);
    }

    #[test]
    fn output_filename_takes_its_extension_from_the_format() {
        let now = at(2026, 10, 26, 3, 0);
        let mut s = schedule();
        assert_eq!(
            s.output_filename(now, "prod"),
            "Nightly orders_20261026.csv"
        );
        s.format = OutputFormat::Json;
        assert_eq!(
            s.output_filename(now, "prod"),
            "Nightly orders_20261026.json"
        );
    }

    // --- pruning ownership ------------------------------------------------

    #[test]
    fn owns_filename_matches_only_this_schedules_own_output() {
        let s = schedule();
        assert!(s.owns_filename("Nightly orders_20261026.csv", "prod"));
        assert!(s.owns_filename("Nightly orders_20250101.csv", "prod"));
        // Another schedule's file, a different format, and an unrelated file.
        assert!(!s.owns_filename("Weekly revenue_20261026.csv", "prod"));
        assert!(!s.owns_filename("Nightly orders_20261026.json", "prod"));
        assert!(!s.owns_filename("notes.csv", "prod"));
    }

    #[test]
    fn owns_filename_treats_name_and_env_as_fixed_but_dates_as_variable() {
        let s = Schedule {
            filename: "{{env}}/{{name}}-{{date}}".into(),
            ..schedule()
        };
        // The separator in the pattern was flattened on the way to disk, so
        // the comparison has to see it flattened too.
        assert!(s.owns_filename("production_Nightly orders-20261026.csv", "production"));
        // Same schedule, a file written against a DIFFERENT environment: not
        // this configuration's output.
        assert!(!s.owns_filename("dev_Nightly orders-20261026.csv", "production"));
    }

    #[test]
    fn owns_filename_respects_literal_order() {
        let s = Schedule {
            filename: "a_{{date}}_b".into(),
            ..schedule()
        };
        assert!(s.owns_filename("a_20261026_b.csv", "prod"));
        // Same literals, wrong order — not ours.
        assert!(!s.owns_filename("b_20261026_a.csv", "prod"));
    }

    #[test]
    fn a_pattern_with_nothing_fixed_in_it_owns_nothing_so_nothing_is_pruned() {
        let s = Schedule {
            filename: "{{date}}".into(),
            ..schedule()
        };
        // Leaving files behind is the only acceptable mistake here: with no
        // fixed text there is no way to tell this schedule's output from
        // anyone else's in a shared folder.
        assert!(!s.owns_filename("20261026.csv", "prod"));
    }

    // --- writers ----------------------------------------------------------

    #[test]
    fn csv_has_a_header_escapes_like_the_manual_export_and_ends_with_a_newline() {
        let columns = vec!["id".to_string(), "note,s".to_string()];
        let rows = vec![
            vec![json!(1), json!("say \"hi\"")],
            vec![json!(null), json!("plain")],
        ];
        assert_eq!(
            rows_to_csv(&columns, &rows),
            "id,\"note,s\"\n1,\"say \"\"hi\"\"\"\n,plain\n"
        );
    }

    #[test]
    fn csv_of_an_empty_result_is_still_a_header() {
        assert_eq!(rows_to_csv(&["id".to_string()], &[]), "id\n");
    }

    #[test]
    fn json_keeps_column_order_rather_than_alphabetizing() {
        let columns = vec!["z".to_string(), "a".to_string()];
        let rows = vec![vec![json!(1), json!("x")]];
        let text = rows_to_json(&columns, &rows);
        assert_eq!(text, "[\n  {\"z\": 1, \"a\": \"x\"}\n]\n");
        // And it is valid JSON.
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid json");
        assert_eq!(parsed[0]["a"], json!("x"));
    }

    #[test]
    fn json_escapes_keys_and_values() {
        let columns = vec!["we\"ird".to_string()];
        let rows = vec![vec![json!("line\nbreak")]];
        let text = rows_to_json(&columns, &rows);
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid json");
        assert_eq!(parsed[0]["we\"ird"], json!("line\nbreak"));
    }

    #[test]
    fn json_of_an_empty_result_is_an_empty_array() {
        let parsed: serde_json::Value =
            serde_json::from_str(&rows_to_json(&["id".to_string()], &[])).expect("valid json");
        assert_eq!(parsed, json!([]));
    }

    // --- schedule ---------------------------------------------------------

    #[test]
    fn validation_reports_the_first_problem_in_field_order() {
        let blank_name = Schedule {
            name: "  ".into(),
            ..schedule()
        };
        assert_eq!(
            blank_name.validation_error(),
            Some("Schedule name is required.")
        );

        let no_connection = Schedule {
            connection_id: "".into(),
            ..schedule()
        };
        assert_eq!(
            no_connection.validation_error(),
            Some("Pick a connection to run against.")
        );

        let no_dir = Schedule {
            directory: "".into(),
            ..schedule()
        };
        assert_eq!(no_dir.validation_error(), Some("Pick an output folder."));

        let bad_keep = Schedule {
            keep: 0,
            ..schedule()
        };
        assert_eq!(
            bad_keep.validation_error(),
            Some("Keep at least one output file.")
        );

        assert_eq!(schedule().validation_error(), None);
    }

    #[test]
    fn validation_refuses_a_query_that_does_not_only_read() {
        for sql in [
            "DELETE FROM orders",
            "UPDATE orders SET note = 'x'",
            "DROP TABLE orders",
            // Stacked: the read in front does not launder the write behind it.
            "SELECT 1; DROP TABLE orders",
        ] {
            let writing = Schedule {
                sql: sql.into(),
                ..schedule()
            };
            assert_eq!(
                writing.validation_error(),
                Some(WRITE_REFUSED),
                "{sql} should be refused"
            );
        }

        // And the reads a report is actually made of still pass — including
        // one whose text merely CONTAINS a hazard word.
        for sql in [
            "SELECT * FROM orders",
            "WITH recent AS (SELECT 1) SELECT * FROM recent",
            "SELECT updated_at FROM orders WHERE action = 'delete'",
            "SELECT * FROM orders WHERE created_at >= '{{yesterday}}'",
        ] {
            let reading = Schedule {
                sql: sql.into(),
                ..schedule()
            };
            assert_eq!(reading.validation_error(), None, "{sql} should be allowed");
        }
    }

    #[test]
    fn wire_format_is_camel_case_and_round_trips() {
        let json = serde_json::to_value(schedule()).expect("ser");
        assert_eq!(json["connectionId"], json!("conn-1"));
        assert_eq!(json["savedQueryId"], json!("q-9"));
        assert_eq!(
            json["recurrence"],
            json!({"kind":"daily","hour":3,"minute":0})
        );
        assert_eq!(json["format"], json!("csv"));
        let back: Schedule = serde_json::from_value(json).expect("de");
        assert_eq!(back, schedule());
    }

    #[test]
    fn a_hand_written_entry_gets_sensible_defaults() {
        let json = json!({
            "id": "s1",
            "name": "Ad hoc",
            "connectionId": "conn-1",
            "sql": "SELECT 1",
            "recurrence": { "kind": "daily", "hour": 3, "minute": 0 },
            "format": "json",
            "directory": "/tmp",
            "filename": "out",
            "createdAt": 0,
        });
        let parsed: Schedule = serde_json::from_value(json).expect("de");
        assert!(parsed.enabled);
        assert_eq!(parsed.keep, DEFAULT_KEEP);
        assert_eq!(parsed.row_limit, DEFAULT_ROW_LIMIT);
        assert_eq!(parsed.next_run_at, 0);
        assert_eq!(parsed.schema, None);
        assert_eq!(parsed.saved_query_id, None);
    }

    #[test]
    fn a_run_record_round_trips_and_omits_what_it_has_nothing_for() {
        let ok = RunRecord {
            schedule_id: "s1".into(),
            started_at: 1,
            duration_ms: 2,
            trigger: RunTrigger::Manual,
            path: Some("/tmp/out.csv".into()),
            row_count: 3,
            truncated: false,
            error: None,
        };
        let json = serde_json::to_value(&ok).expect("ser");
        assert_eq!(json["trigger"], json!("manual"));
        assert!(json.get("error").is_none());
        assert!(ok.succeeded());

        let failed = RunRecord {
            path: None,
            error: Some("boom".into()),
            ..ok.clone()
        };
        let json = serde_json::to_value(&failed).expect("ser");
        assert!(json.get("path").is_none());
        assert!(!failed.succeeded());
        let back: RunRecord = serde_json::from_value(json).expect("de");
        assert_eq!(back, failed);
    }
}
