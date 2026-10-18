//! The read-only workspace guard: one place that answers "may this reach the
//! database?" for a connection the user opened read-only.
//!
//! A read-only workspace is a property of the *open handle* (see
//! [`ConnectionManager`](crate::features::connections::application::ConnectionManager)),
//! not of the UI: the renderer hides its mutation affordances, but the refusal
//! that matters happens here, at the command boundary, so a stray invoke — a
//! hand-crafted one, a code path nobody remembered to gate, a future slice —
//! cannot write either.
//!
//! Two kinds of command need guarding, and they are guarded differently:
//!
//! 1. **Named mutations** (`row_update`, `drop_table`, `kv_set_string`, …) —
//!    the command itself *is* a write, so the guard is unconditional:
//!    `manager.ensure_writable(&handle).await?`.
//! 2. **Free-form statement runners** (the SQL editor, the CQL/PartiQL runners,
//!    the Redis command palette, the Typesense HTTP console) — what the user
//!    typed decides. Those classify the text with the predicates below and
//!    refuse only what writes, so reading stays fully usable.
//!
//! The classifiers are deliberately **conservative**: they answer "is this
//! *certainly* read-only?", and anything they cannot prove safe is refused. A
//! false refusal is a visible annoyance with an obvious workaround (reconnect
//! writable); a false pass is silent data loss in a workspace whose whole
//! promise was that it could not happen.

use crate::shared::error::AppError;

/// The §5 refusal every guarded command returns. `action` names what was
/// refused, in the infinitive ("delete rows", "run this statement"), so the
/// toast reads as a sentence.
pub fn read_only_error(action: &str) -> AppError {
    AppError::ReadOnly(format!(
        "This workspace is read-only, so it cannot {action}. Reconnect with read-only turned off \
         to make changes."
    ))
}

/// The only statement keywords a read-only session may *start* with. Every
/// data-modifying and DDL statement in every dialect ByteTable speaks leads
/// with its own verb (`INSERT`, `DROP`, `GRANT`, `SET`, `BEGIN`, `CALL`, …), so
/// an allowlist of openers rejects all of them by construction — including the
/// ones a keyword blocklist would miss.
const READ_LEADERS: &[&str] = &[
    "select", "with", // CTE — may still end in a write, see the tail scan.
    "show", "describe", "desc", "explain",
    "table",  // `TABLE foo` (Postgres/ClickHouse) = `SELECT * FROM foo`.
    "values", // `VALUES (1), (2)` — a literal row source.
    "pragma", // SQLite introspection; the assigning form is refused below.
];

/// Keywords that turn an allowed opener into a write when they appear later in
/// the statement: `WITH x AS (…) INSERT …`, `EXPLAIN ANALYZE DELETE …`,
/// `SELECT … INTO backup`, `SELECT … FOR UPDATE` (which takes row locks).
///
/// Narrow on purpose — a keyword only belongs here if it can legally appear
/// mid-statement — and matched only when *not* immediately followed by `(`, so
/// `SELECT REPLACE(name, 'a', 'b')` and friends stay readable.
const TAIL_HAZARDS: &[&str] = &[
    "insert",
    "update",
    "delete",
    "drop",
    "create",
    "alter",
    "truncate",
    "merge",
    "into",
    "grant",
    "revoke",
    "call",
    "exec",
    "execute",
    "do",
    "copy",
    "load",
    "attach",
    "detach",
    "vacuum",
    "analyze",
    "refresh",
    "reindex",
    "optimize",
    "rename",
    "lock",
    "unlock",
    "begin",
    "commit",
    "rollback",
    "savepoint",
    "set",
    "reset",
    "kill",
    "flush",
    "shutdown",
    "checkpoint",
    "repair",
    "prepare",
    "deallocate",
    "declare",
    "backup",
    "restore",
];

/// True when `sql` provably only reads.
///
/// The test is lexical, on the text with its comments, string literals and
/// quoted identifiers blanked out: every `;`-separated statement must open with
/// a [`READ_LEADERS`] keyword and carry no [`TAIL_HAZARDS`] keyword. So a
/// stacked `SELECT 1; DROP TABLE t` is refused on its second statement, while
/// `SELECT * FROM audit WHERE action = 'delete'` and `SELECT updated_at FROM t`
/// are not refused at all — the first is a literal, the second is not the word
/// `update`.
///
/// Used for SQL, CQL and PartiQL alike: all three share the statement
/// vocabulary that matters here, and being conservative across dialects is the
/// point. Blank input (or comments only) is read-only by vacuity.
pub fn sql_is_read_only(sql: &str) -> bool {
    let stripped = strip_literals_and_comments(sql);
    for statement in stripped.split(';') {
        let tokens = tokenize(statement);
        let Some(leader) = tokens.first() else {
            continue; // Blank / comment-only fragment — nothing executable.
        };
        if !READ_LEADERS.contains(&leader.word.as_str()) {
            return false;
        }
        match leader.word.as_str() {
            // These only ever report. Their tails *name* things
            // (`SHOW CREATE TABLE t`, `DESCRIBE orders`), so scanning them for
            // hazards would refuse a plain read.
            "show" | "describe" | "desc" => continue,
            // `PRAGMA table_info(t)` reads; `PRAGMA journal_mode = WAL` writes.
            // The assigning form is the one with an `=`.
            "pragma" => {
                if statement.contains('=') {
                    return false;
                }
                continue;
            }
            _ => {}
        }
        // A hazard word directly followed by `(` is a function call
        // (`REPLACE(…)`, `UPDATE(…)` in some dialects), not a statement.
        if tokens
            .iter()
            .any(|t| TAIL_HAZARDS.contains(&t.word.as_str()) && !t.call)
        {
            return false;
        }
    }
    true
}

/// One identifier/keyword from a statement, lowercased, plus whether it is
/// immediately followed by `(` — i.e. used as a function call.
struct Token {
    word: String,
    call: bool,
}

/// Split a (literal-stripped) statement into its words. Word characters are
/// alphanumerics and `_`, so `updated_at` is one token and never matches
/// `update`.
fn tokenize(statement: &str) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    let mut word = String::new();
    for ch in statement.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            word.push(ch.to_ascii_lowercase());
            continue;
        }
        if !word.is_empty() {
            tokens.push(Token {
                word: std::mem::take(&mut word),
                call: ch == '(',
            });
        }
    }
    if !word.is_empty() {
        tokens.push(Token { word, call: false });
    }
    tokens
}

/// Blank out everything a keyword scan must not see: `--` and `#` line
/// comments, `/* … */` block comments, `'single'` / `"double"` quoted spans and
/// `` `backtick` `` / `[bracket]` quoted identifiers. Replaced with spaces
/// rather than removed, so word boundaries and `;` positions survive.
fn strip_literals_and_comments(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < chars.len() && chars[i] != '\n' {
                    out.push(' ');
                    i += 1;
                }
            }
            '#' => {
                while i < chars.len() && chars[i] != '\n' {
                    out.push(' ');
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                out.push_str("  ");
                i += 2;
                while i < chars.len() {
                    let closes = chars[i] == '*' && chars.get(i + 1) == Some(&'/');
                    out.push(' ');
                    i += 1;
                    if closes {
                        out.push(' ');
                        i += 1;
                        break;
                    }
                }
            }
            '\'' | '"' | '`' => {
                out.push(' ');
                i += 1;
                while i < chars.len() {
                    if chars[i] == ch {
                        // A doubled quote is an escaped quote ('it''s'), not
                        // the end of the span.
                        if chars.get(i + 1) == Some(&ch) {
                            out.push_str("  ");
                            i += 2;
                            continue;
                        }
                        out.push(' ');
                        i += 1;
                        break;
                    }
                    out.push(' ');
                    i += 1;
                }
            }
            '[' => {
                while i < chars.len() && chars[i] != ']' {
                    out.push(' ');
                    i += 1;
                }
                if i < chars.len() {
                    out.push(' ');
                    i += 1;
                }
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

/// Redis commands that only read. An allowlist for the same reason as
/// [`READ_LEADERS`]: Redis and its modules keep adding write commands, so an
/// unknown command must be refused — which is also the only safe reading of
/// `EVAL`, `FCALL` and anything a module contributes.
///
/// Container commands (`CLIENT`, `CONFIG`, `ACL`, …) are *not* here; they mix
/// readers and writers under one name and go through the subcommand check in
/// [`redis_command_is_read_only`].
const REDIS_READ_COMMANDS: &[&str] = &[
    "get",
    "getrange",
    "substr",
    "strlen",
    "mget",
    "exists",
    "type",
    "ttl",
    "pttl",
    "expiretime",
    "pexpiretime",
    "dump",
    "keys",
    "scan",
    "randomkey",
    "dbsize",
    "hget",
    "hmget",
    "hgetall",
    "hkeys",
    "hvals",
    "hlen",
    "hexists",
    "hstrlen",
    "hrandfield",
    "hscan",
    "lindex",
    "llen",
    "lrange",
    "lpos",
    "smembers",
    "sismember",
    "smismember",
    "scard",
    "srandmember",
    "sscan",
    "sdiff",
    "sinter",
    "sintercard",
    "sunion",
    "zscore",
    "zmscore",
    "zcard",
    "zcount",
    "zrange",
    "zrangebyscore",
    "zrangebylex",
    "zrevrange",
    "zrevrangebyscore",
    "zrevrangebylex",
    "zrank",
    "zrevrank",
    "zlexcount",
    "zscan",
    "zrandmember",
    "zdiff",
    "zinter",
    "zintercard",
    "zunion",
    "xlen",
    "xrange",
    "xrevrange",
    "xinfo",
    "xpending",
    "pfcount",
    "bitcount",
    "bitpos",
    "getbit",
    "geodist",
    "geopos",
    "geohash",
    "geosearch",
    "info",
    "ping",
    "echo",
    "time",
    "lastsave",
    "lolwut",
    "role",
    "dbsize",
];

/// Redis container commands whose subcommand decides: `CLIENT LIST` reads,
/// `CLIENT KILL` does not; `CONFIG GET` reads, `CONFIG SET` does not.
const REDIS_CONTAINERS: &[&str] = &[
    "client", "config", "acl", "slowlog", "memory", "object", "cluster", "command", "latency",
    "function", "script", "xgroup", "xinfo",
];

/// Subcommands of a [`REDIS_CONTAINERS`] command that only read.
const REDIS_READ_SUBCOMMANDS: &[&str] = &[
    "list",
    "info",
    "id",
    "getname",
    "get",
    "help",
    "count",
    "doctor",
    "stats",
    "usage",
    "whoami",
    "cat",
    "users",
    "getuser",
    "shards",
    "slots",
    "nodes",
    "myid",
    "countkeysinslot",
    "getkeysinslot",
    "links",
    "keyslot",
    "docs",
    "getkeys",
    "history",
    "latest",
    "dump",
    "groups",
    "consumers",
    "stream",
];

/// True when a Redis command (as the palette's already-split argv) only reads.
/// An empty argv is read-only by vacuity: there is nothing to send.
pub fn redis_command_is_read_only(args: &[String]) -> bool {
    let Some(name) = args.first() else {
        return true;
    };
    let name = name.trim().to_ascii_lowercase();
    if REDIS_CONTAINERS.contains(&name.as_str()) {
        let Some(sub) = args.get(1) else {
            // A bare container command is a server-side arity error, not a
            // write — let Redis be the one to say so.
            return true;
        };
        return REDIS_READ_SUBCOMMANDS.contains(&sub.trim().to_ascii_lowercase().as_str());
    }
    REDIS_READ_COMMANDS.contains(&name.as_str())
}

/// True when an HTTP method only reads — the test for the Typesense HTTP
/// console, whose whole surface is "send this method to this path".
pub fn http_method_is_read_only(method: &str) -> bool {
    matches!(
        method.trim().to_ascii_uppercase().as_str(),
        "GET" | "HEAD" | "OPTIONS"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_reads_pass() {
        for sql in [
            "SELECT * FROM users",
            "select id, name from users where id = 1 order by name limit 10",
            "WITH recent AS (SELECT * FROM orders) SELECT count(*) FROM recent",
            "SHOW TABLES",
            "SHOW CREATE TABLE users",
            "DESCRIBE users",
            "EXPLAIN SELECT * FROM users",
            "EXPLAIN (FORMAT JSON) SELECT 1",
            "TABLE users",
            "VALUES (1), (2)",
            "PRAGMA table_info(users)",
            "SELECT * FROM users; SELECT * FROM orders;",
            "",
            "   ",
            "-- just a comment",
            "/* block */",
        ] {
            assert!(sql_is_read_only(sql), "should be read-only: {sql}");
        }
    }

    #[test]
    fn writes_are_refused_whatever_their_shape() {
        for sql in [
            "INSERT INTO users (id) VALUES (1)",
            "update users set name = 'x'",
            "DELETE FROM users",
            "TRUNCATE TABLE users",
            "DROP TABLE users",
            "ALTER TABLE users ADD COLUMN x int",
            "CREATE INDEX idx ON users (id)",
            "GRANT SELECT ON users TO bob",
            "REVOKE SELECT ON users FROM bob",
            "SET autocommit = 0",
            "BEGIN",
            "START TRANSACTION",
            "CALL cleanup()",
            "COMMENT ON TABLE users IS 'x'",
            "USE other_db",
            "COPY users FROM '/tmp/u.csv'",
            "REPLACE INTO users (id) VALUES (1)",
            "PRAGMA journal_mode = WAL",
            // An opener that is allowed, with the write hiding in the tail.
            "WITH moved AS (DELETE FROM a RETURNING *) SELECT * FROM moved",
            "EXPLAIN ANALYZE DELETE FROM users",
            "SELECT * INTO backup FROM users",
            "SELECT * FROM users FOR UPDATE",
            // Stacked statements: a read prefix must not smuggle a write.
            "SELECT 1; DROP TABLE users",
            "SELECT 1;\n-- sneaky\nDELETE FROM users",
        ] {
            assert!(!sql_is_read_only(sql), "should be refused: {sql}");
        }
    }

    #[test]
    fn write_words_in_literals_identifiers_and_names_do_not_refuse_a_read() {
        // The classifier would be useless if it tripped on data or on columns
        // that merely contain a keyword.
        for sql in [
            "SELECT * FROM audit WHERE action = 'delete'",
            "SELECT * FROM audit WHERE op = 'DROP TABLE users'",
            "SELECT \"insert\" FROM t",
            "SELECT `update` FROM t",
            "SELECT [delete] FROM t",
            "SELECT * FROM t -- delete me later",
            "SELECT * FROM t /* drop this */ WHERE id = 1",
            "SELECT * FROM t WHERE s = 'it''s a delete'",
            "SELECT updated_at, created_at, deletion_count FROM t",
            "SELECT comment, type FROM posts",
            // Function calls that share a statement keyword's name.
            "SELECT REPLACE(name, 'a', 'b') FROM t",
            "SELECT count(*) FROM t",
        ] {
            assert!(sql_is_read_only(sql), "should be read-only: {sql}");
        }
    }

    #[test]
    fn partiql_and_cql_shapes_classify_the_same_way() {
        assert!(sql_is_read_only("SELECT * FROM \"Orders\" WHERE pk = 'a'"));
        assert!(!sql_is_read_only("UPDATE \"Orders\" SET total = 1"));
        assert!(sql_is_read_only(
            "SELECT * FROM byteshop.orders WHERE id = 1 ALLOW FILTERING"
        ));
        assert!(!sql_is_read_only("TRUNCATE byteshop.orders"));
    }

    #[test]
    fn redis_reads_pass_and_writes_are_refused() {
        let argv = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        for cmd in [
            "GET k",
            "scan 0",
            "HGETALL h",
            "ZRANGE z 0 -1",
            "INFO",
            "TTL k",
            "CLIENT LIST",
            "CONFIG GET maxmemory",
            "ACL WHOAMI",
            "CLUSTER NODES",
        ] {
            assert!(
                redis_command_is_read_only(&argv(cmd)),
                "should be read-only: {cmd}"
            );
        }
        for cmd in [
            "SET k v",
            "DEL k",
            "FLUSHALL",
            "EXPIRE k 10",
            "RENAME a b",
            "HSET h f v",
            "LPUSH l v",
            "CLIENT KILL ID 4",
            "CLIENT PAUSE 100",
            "CONFIG SET maxmemory 0",
            "CONFIG RESETSTAT",
            "ACL SETUSER bob",
            "SLOWLOG RESET",
            "SCRIPT FLUSH",
            // Unknown / scriptable commands are refused, not assumed safe.
            "EVAL script 0",
            "FCALL f 0",
            "SOMETHING-NEW k",
        ] {
            assert!(
                !redis_command_is_read_only(&argv(cmd)),
                "should be refused: {cmd}"
            );
        }
        assert!(redis_command_is_read_only(&[]), "nothing to send");
    }

    #[test]
    fn only_safe_http_methods_read() {
        assert!(http_method_is_read_only("GET"));
        assert!(http_method_is_read_only(" get "));
        assert!(http_method_is_read_only("HEAD"));
        for method in ["POST", "PUT", "PATCH", "DELETE", "post"] {
            assert!(!http_method_is_read_only(method), "{method}");
        }
    }

    #[test]
    fn the_refusal_names_the_action() {
        let message = read_only_error("delete rows").to_string();
        assert!(message.contains("read-only"));
        assert!(message.contains("delete rows"));
    }
}
