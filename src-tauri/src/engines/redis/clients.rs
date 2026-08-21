//! Connected-client administration (M36 §A): `CLIENT LIST` → [`KvClient`], and
//! the three `CLIENT KILL` routes the clients tab offers (one id, a batch of
//! ids, a server-side filter).
//!
//! A `CLIENT LIST` line is exactly the `CLIENT INFO` wire format — space
//! separated `key=value` in the server's own field order. We keep the line
//! verbatim (`raw`) and its pairs in order (`fields`) so the inspector shows
//! what the server actually said, and additionally parse the handful of fields
//! the table sorts, filters and colours by. Nothing is invented: a field the
//! server does not report is simply absent from `fields`.
//!
//! Everything here is server-global (`CLIENT …` ignores the selected db), so
//! db 0 is only the carrier connection. In cluster mode this is inherently
//! **per node** — the node we are attached to.

use async_trait::async_trait;

use crate::shared::error::AppError;
use crate::shared::keyvalue::{ClientAdmin, KvClient, KvField, KvKillFilter};

use super::error::map_query_error;
use super::RedisKvConnection;

#[async_trait]
impl ClientAdmin for RedisKvConnection {
    async fn client_list(&self) -> Result<Vec<KvClient>, AppError> {
        let mut conn = self.conn_for(0).await?;
        let self_id: i64 = redis::cmd("CLIENT")
            .arg("ID")
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        let list: String = redis::cmd("CLIENT")
            .arg("LIST")
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(parse_client_list(&list, self_id))
    }

    async fn client_kill(&self, filter: KvKillFilter, value: &str) -> Result<u64, AppError> {
        if value.trim().is_empty() {
            return Err(AppError::Invalid(
                "a CLIENT KILL filter needs a value to match on.".into(),
            ));
        }
        let mut conn = self.conn_for(0).await?;
        kill_one(&mut conn, filter.as_token(), value).await
    }

    async fn client_kill_ids(&self, ids: &[i64]) -> Result<u64, AppError> {
        let mut conn = self.conn_for(0).await?;
        let mut closed = 0;
        // One command per id — the same list of `CLIENT KILL ID <id>` lines the
        // confirm dialog showed. Multi-id kills are not portable across the
        // server versions ByteTable supports.
        for id in ids {
            closed += kill_one(&mut conn, "ID", &id.to_string()).await?;
        }
        Ok(closed)
    }

    async fn client_no_evict(&self, on: bool) -> Result<(), AppError> {
        let mut conn = self.conn_for(0).await?;
        redis::cmd("CLIENT")
            .arg("NO-EVICT")
            .arg(if on { "on" } else { "off" })
            .query_async::<redis::Value>(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(())
    }

    async fn client_unpause(&self) -> Result<(), AppError> {
        let mut conn = self.conn_for(0).await?;
        redis::cmd("CLIENT")
            .arg("UNPAUSE")
            .query_async::<redis::Value>(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(())
    }
}

/// Run one `CLIENT KILL <filter> <value>` and read the "closed" count. The
/// filter form always replies with an integer (the legacy `addr:port` form
/// replies `+OK`, which is why we never use it).
async fn kill_one(
    conn: &mut redis::aio::MultiplexedConnection,
    filter: &str,
    value: &str,
) -> Result<u64, AppError> {
    let killed: i64 = redis::cmd("CLIENT")
        .arg("KILL")
        .arg(filter)
        .arg(value)
        .query_async(conn)
        .await
        .map_err(map_query_error)?;
    Ok(killed.max(0) as u64)
}

/// Parse the newline-separated `CLIENT LIST` reply into [`KvClient`] rows.
pub(super) fn parse_client_list(reply: &str, self_id: i64) -> Vec<KvClient> {
    reply
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| parse_client_line(line, self_id))
        .collect()
}

/// Parse one `CLIENT LIST` / `CLIENT INFO` line.
fn parse_client_line(line: &str, self_id: i64) -> KvClient {
    // Keep every pair in the server's order — that order IS the wire format.
    let fields: Vec<KvField> = line
        .split(' ')
        .filter(|token| !token.is_empty())
        .filter_map(|token| {
            let (field, value) = token.split_once('=')?;
            Some(KvField {
                field: field.to_string(),
                value: value.to_string(),
            })
        })
        .collect();

    let get = |key: &str| {
        fields
            .iter()
            .find(|f| f.field == key)
            .map(|f| f.value.as_str())
    };
    let num = |key: &str, default: i64| get(key).and_then(|v| v.parse().ok()).unwrap_or(default);

    let flags = get("flags").unwrap_or_default().to_string();
    let cmd = get("cmd").unwrap_or_default().to_string();
    let id = num("id", 0);

    KvClient {
        id,
        addr: get("addr").unwrap_or_default().to_string(),
        laddr: get("laddr").unwrap_or_default().to_string(),
        name: get("name").unwrap_or_default().to_string(),
        age: num("age", 0),
        idle: num("idle", 0),
        client_type: client_type(&flags, &cmd),
        flags,
        db: num("db", 0).clamp(0, 255) as u8,
        sub: num("sub", 0),
        psub: num("psub", 0),
        // `multi=-1` is Redis's own "no transaction open" sentinel.
        multi: num("multi", -1),
        watch: num("watch", 0),
        qbuf: num("qbuf", 0),
        oll: num("oll", 0),
        omem: num("omem", 0),
        tot_mem: num("tot-mem", 0),
        cmd,
        user: get("user").unwrap_or_default().to_string(),
        is_self: id == self_id,
        fields,
        raw: line.to_string(),
    }
}

/// The client's class, derived the way Redis's own `CLIENT KILL TYPE` groups
/// them: replica/master connections by flag, pub/sub by the `P` flag or a
/// held subscription, everything else normal.
fn client_type(flags: &str, cmd: &str) -> String {
    if flags.contains('S') {
        return "replica".into();
    }
    if flags.contains('M') {
        return "master".into();
    }
    if flags.contains('P') || cmd.split('|').next().unwrap_or("").ends_with("subscribe") {
        return "pubsub".into();
    }
    "normal".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = "id=6 addr=10.0.4.18:52310 laddr=10.0.1.5:6379 fd=8 name=web-1 age=42 \
        idle=0 flags=N db=2 sub=0 psub=0 ssub=0 multi=-1 watch=0 qbuf=26 qbuf-free=20448 \
        argv-mem=10 multi-mem=0 tot-net-in=140 tot-net-out=0 rbs=1024 rbp=0 obl=0 oll=0 omem=0 \
        tot-mem=20512 events=r cmd=client|list user=default redir=-1 resp=3 lib-name=redis-py \
        lib-ver=5.0.4";

    #[test]
    fn parses_every_field_in_server_order_and_flags_self() {
        let clients = parse_client_list(LINE, 6);
        assert_eq!(clients.len(), 1);
        let c = &clients[0];
        assert_eq!(c.id, 6);
        assert_eq!(c.addr, "10.0.4.18:52310");
        assert_eq!(c.laddr, "10.0.1.5:6379");
        assert_eq!(c.name, "web-1");
        assert_eq!(c.age, 42);
        assert_eq!(c.db, 2);
        assert_eq!(c.multi, -1);
        assert_eq!(c.tot_mem, 20512);
        assert_eq!(c.cmd, "client|list");
        assert_eq!(c.user, "default");
        assert_eq!(c.client_type, "normal");
        assert!(c.is_self);
        // The pairs keep the server's order, first and last included.
        assert_eq!(c.fields.first().map(|f| f.field.as_str()), Some("id"));
        assert_eq!(c.fields.last().map(|f| f.field.as_str()), Some("lib-ver"));
        assert_eq!(c.fields.len(), 33);
        // …and the raw line round-trips verbatim (this is CLIENT INFO output).
        assert_eq!(c.raw, LINE);
    }

    #[test]
    fn derives_the_client_type_the_way_client_kill_type_groups_them() {
        assert_eq!(client_type("N", "get"), "normal");
        assert_eq!(client_type("S", "psync"), "replica");
        assert_eq!(client_type("M", "ping"), "master");
        assert_eq!(client_type("P", "ping"), "pubsub");
        // A subscribed client before the server sets the P flag.
        assert_eq!(client_type("N", "psubscribe"), "pubsub");
    }

    #[test]
    fn missing_fields_fall_back_without_inventing_values() {
        let clients = parse_client_list("id=9 addr=x:1 flags=b cmd=blpop", 1);
        let c = &clients[0];
        assert_eq!(c.id, 9);
        assert_eq!(c.name, "");
        assert_eq!(c.idle, 0);
        assert_eq!(c.multi, -1);
        assert!(!c.is_self);
        assert_eq!(c.fields.len(), 4);
    }
}
