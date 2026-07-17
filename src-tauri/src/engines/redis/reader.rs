//! Redis keyspace reader: scan, key enrichment, and typed value reads
//! (`KeyspaceReader`). Mirrors the `ports::keyvalue` read surface.

use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use redis::Value;

use crate::shared::error::AppError;
use crate::shared::keyvalue::*;

use super::error::map_query_error;
use super::value::value_to_string;
use super::{info_field, info_num, info_text, RedisKvConnection};

/// How many keys' worth of `TYPE`+`TTL` to pipeline per scan page enrichment.
/// (The whole page is pipelined in one round trip regardless; this is just the
/// `COUNT` default if the request omits one — handled in the port DTO.)
const DEFAULT_SCAN_COUNT: u32 = 100;

// ---------------------------------------------------------------------------
// KeyspaceReader
// ---------------------------------------------------------------------------

#[async_trait]
impl KeyspaceReader for RedisKvConnection {
    async fn server_info(&self) -> Result<KvServerInfo, AppError> {
        let mut conn = self.conn_for(0).await?;
        let server = info_text(&mut conn, "server").await?;
        let replication = info_text(&mut conn, "replication").await?;
        let version = info_field(&server, "redis_version").unwrap_or_else(|| "unknown".into());
        let mode = info_field(&server, "redis_mode").unwrap_or_else(|| "standalone".into());
        let role = info_field(&replication, "role").unwrap_or_else(|| "master".into());
        // The protocol we negotiated is RESP3 against a v6+ server; HELLO would
        // confirm it, but the client downgrades transparently on older servers.
        // Probe by issuing HELLO and reading the proto field is overkill here;
        // report 3 (we requested RESP3) which the status bar shows.
        Ok(KvServerInfo {
            server_version: version,
            mode,
            role,
            resp_version: 3,
        })
    }

    async fn server_stats(&self) -> Result<KvServerStats, AppError> {
        let mut conn = self.conn_for(0).await?;
        let stats = info_text(&mut conn, "stats").await?;
        let memory = info_text(&mut conn, "memory").await?;
        let clients = info_text(&mut conn, "clients").await?;
        let server = info_text(&mut conn, "server").await?;
        Ok(KvServerStats {
            keyspace_hits: info_num(&stats, "keyspace_hits"),
            keyspace_misses: info_num(&stats, "keyspace_misses"),
            instantaneous_ops_per_sec: info_num(&stats, "instantaneous_ops_per_sec"),
            connected_clients: info_num(&clients, "connected_clients"),
            used_memory: info_num(&memory, "used_memory"),
            maxmemory: info_num(&memory, "maxmemory"),
            uptime_in_days: info_num(&server, "uptime_in_days"),
            expired_keys: info_num(&stats, "expired_keys"),
            evicted_keys: info_num(&stats, "evicted_keys"),
        })
    }

    async fn keyspace(&self) -> Result<Vec<KvDbInfo>, AppError> {
        let mut conn = self.conn_for(0).await?;
        let keyspace = info_text(&mut conn, "keyspace").await?;
        // Lines look like `db0:keys=3,expires=1,avg_ttl=0`.
        let mut out = Vec::new();
        for line in keyspace.lines() {
            let Some(rest) = line.strip_prefix("db") else {
                continue;
            };
            let Some((index_str, fields)) = rest.split_once(':') else {
                continue;
            };
            let Ok(index) = index_str.parse::<u8>() else {
                continue;
            };
            let key_count = fields
                .split(',')
                .find_map(|kv| kv.strip_prefix("keys="))
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            out.push(KvDbInfo { index, key_count });
        }
        Ok(out)
    }

    async fn scan(&self, db: u8, req: ScanRequest) -> Result<ScanPage, AppError> {
        let mut conn = self.conn_for(db).await?;
        let count = if req.count == 0 {
            DEFAULT_SCAN_COUNT
        } else {
            req.count
        };

        // One cursor round trip: SCAN <cursor> MATCH <pat> COUNT <n> [TYPE <t>].
        let mut scan_cmd = redis::cmd("SCAN");
        scan_cmd
            .arg(&req.cursor)
            .arg("MATCH")
            .arg(&req.pattern)
            .arg("COUNT")
            .arg(count);
        if let Some(t) = req.type_filter {
            scan_cmd.arg("TYPE").arg(t.as_token());
        }
        let (next_cursor, names): (String, Vec<String>) = scan_cmd
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;

        // Enrich each key with TYPE + TTL in a single pipeline round trip.
        let keys = enrich_keys(&mut conn, names).await?;
        Ok(ScanPage {
            cursor: next_cursor,
            keys,
        })
    }

    async fn get_key(&self, db: u8, key: &str) -> Result<KeyView, AppError> {
        let mut conn = self.conn_for(db).await?;

        let type_token: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        let Some(key_type) = KeyType::from_token(&type_token) else {
            // `none` → the key does not exist.
            return Ok(KeyView {
                key_type: KeyType::String,
                ttl: -2,
                encoding: None,
                memory: None,
                idle: None,
                value: KvValue::Missing {},
            });
        };

        let ttl: i64 = redis::cmd("TTL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        let encoding: Option<String> = redis::cmd("OBJECT")
            .arg("ENCODING")
            .arg(key)
            .query_async(&mut conn)
            .await
            .ok();
        let memory: Option<u64> = redis::cmd("MEMORY")
            .arg("USAGE")
            .arg(key)
            .query_async(&mut conn)
            .await
            .ok();
        let idle: Option<u64> = redis::cmd("OBJECT")
            .arg("IDLETIME")
            .arg(key)
            .query_async(&mut conn)
            .await
            .ok();

        let value = read_typed_value(&mut conn, key, key_type).await?;
        Ok(KeyView {
            key_type,
            ttl,
            encoding,
            memory,
            idle,
            value,
        })
    }
}

/// Pipeline `TYPE` + `TTL` for every scanned key in one round trip, returning
/// the enriched [`KeyEntry`] list (keys that vanished mid-scan get `ttl: -2`).
pub(super) async fn enrich_keys(
    conn: &mut MultiplexedConnection,
    names: Vec<String>,
) -> Result<Vec<KeyEntry>, AppError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut pipe = redis::pipe();
    for name in &names {
        pipe.cmd("TYPE").arg(name);
        pipe.cmd("TTL").arg(name);
    }
    // Reply is [type0, ttl0, type1, ttl1, …].
    let replies: Vec<Value> = pipe.query_async(conn).await.map_err(map_query_error)?;
    let mut keys = Vec::with_capacity(names.len());
    for (i, name) in names.into_iter().enumerate() {
        let type_token = replies.get(i * 2).map(value_to_string).unwrap_or_default();
        let ttl = replies
            .get(i * 2 + 1)
            .and_then(|v| match v {
                Value::Int(n) => Some(*n),
                _ => None,
            })
            .unwrap_or(-2);
        let Some(key_type) = KeyType::from_token(&type_token) else {
            continue; // key vanished between SCAN and the pipeline
        };
        keys.push(KeyEntry {
            name,
            key_type,
            ttl,
        });
    }
    Ok(keys)
}

/// Read the typed value of `key` (already known to be `key_type`).
pub(super) async fn read_typed_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    key_type: KeyType,
) -> Result<KvValue, AppError> {
    match key_type {
        KeyType::String => {
            let v: String = redis::cmd("GET")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Str { value: v })
        }
        KeyType::List => {
            let items: Vec<String> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg(-1)
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::List { items })
        }
        KeyType::Set => {
            let members: Vec<String> = redis::cmd("SMEMBERS")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Set { members })
        }
        KeyType::Hash => {
            // HGETALL → RESP2 flat [field, value, …] OR RESP3 Map. Read the
            // raw `Value` and normalize both into ordered field/value pairs.
            let raw: Value = redis::cmd("HGETALL")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Hash {
                fields: parse_field_pairs(raw),
            })
        }
        KeyType::Zset => {
            // ZRANGE … WITHSCORES → RESP2 flat [member, score, …] OR RESP3
            // array of [member, score] pairs; scores ascending either way.
            let raw: Value = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg(-1)
                .arg("WITHSCORES")
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Zset {
                entries: parse_scored(raw),
            })
        }
        KeyType::Stream => {
            // XRANGE key - + → [[id, [f, v, …]], …].
            let raw: Value = redis::cmd("XRANGE")
                .arg(key)
                .arg("-")
                .arg("+")
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Stream {
                entries: parse_stream(raw),
            })
        }
    }
}

/// Normalize an `HGETALL` reply into ordered field/value pairs, accepting both
/// the RESP2 flat array `[f, v, f, v, …]` and the RESP3 `Map`.
pub(super) fn parse_field_pairs(value: Value) -> Vec<KvField> {
    match value {
        Value::Map(pairs) => pairs
            .into_iter()
            .map(|(k, v)| KvField {
                field: value_to_string(&k),
                value: value_to_string(&v),
            })
            .collect(),
        Value::Array(flat) => flat
            .chunks_exact(2)
            .map(|pair| KvField {
                field: value_to_string(&pair[0]),
                value: value_to_string(&pair[1]),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Normalize a `ZRANGE … WITHSCORES` reply into scored members, accepting both
/// the RESP2 flat array `[m, s, m, s, …]` and the RESP3 array of `[m, s]`
/// pairs.
pub(super) fn parse_scored(value: Value) -> Vec<KvScored> {
    match value {
        Value::Array(items) => {
            // RESP3: an array whose elements are themselves [member, score]
            // pairs. RESP2: a flat [member, score, member, score, …].
            let is_paired = items
                .iter()
                .all(|it| matches!(it, Value::Array(inner) if inner.len() == 2));
            if is_paired && !items.is_empty() {
                items
                    .into_iter()
                    .filter_map(|it| {
                        let Value::Array(pair) = it else { return None };
                        let member = value_to_string(pair.first()?);
                        let score = score_of(pair.get(1)?);
                        Some(KvScored { member, score })
                    })
                    .collect()
            } else {
                items
                    .chunks_exact(2)
                    .map(|pair| KvScored {
                        member: value_to_string(&pair[0]),
                        score: score_of(&pair[1]),
                    })
                    .collect()
            }
        }
        _ => Vec::new(),
    }
}

/// Read a score from a RESP value (a RESP3 `Double`, or a RESP2 bulk string).
pub(super) fn score_of(value: &Value) -> f64 {
    match value {
        Value::Double(d) => *d,
        Value::Int(n) => *n as f64,
        other => value_to_string(other).parse().unwrap_or(f64::NAN),
    }
}

/// Parse an `XRANGE` reply [[id, [f, v, …]], …] into typed stream entries.
pub(super) fn parse_stream(value: Value) -> Vec<KvStreamEntry> {
    let Value::Array(entries) = value else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let Value::Array(parts) = entry else {
                return None;
            };
            let mut it = parts.into_iter();
            let id = value_to_string(&it.next()?);
            let fields = match it.next() {
                Some(Value::Array(flat)) => flat
                    .chunks_exact(2)
                    .map(|pair| KvField {
                        field: value_to_string(&pair[0]),
                        value: value_to_string(&pair[1]),
                    })
                    .collect(),
                _ => Vec::new(),
            };
            Some(KvStreamEntry { id, fields })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_stream_flattens_id_and_fields() {
        let raw = Value::Array(vec![Value::Array(vec![
            Value::BulkString(b"1-0".to_vec()),
            Value::Array(vec![
                Value::BulkString(b"type".to_vec()),
                Value::BulkString(b"created".to_vec()),
                Value::BulkString(b"order_id".to_vec()),
                Value::BulkString(b"42".to_vec()),
            ]),
        ])]);
        let entries = parse_stream(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "1-0");
        assert_eq!(entries[0].fields.len(), 2);
        assert_eq!(entries[0].fields[0].field, "type");
        assert_eq!(entries[0].fields[0].value, "created");
        assert_eq!(entries[0].fields[1].field, "order_id");
        assert_eq!(entries[0].fields[1].value, "42");
    }

    #[test]
    fn parse_field_pairs_handles_resp2_flat_and_resp3_map() {
        // RESP2: flat array.
        let flat = Value::Array(vec![
            Value::BulkString(b"name".to_vec()),
            Value::BulkString(b"Ada".to_vec()),
            Value::BulkString(b"role".to_vec()),
            Value::BulkString(b"admin".to_vec()),
        ]);
        let fields = parse_field_pairs(flat);
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0].field, "name");
        assert_eq!(fields[0].value, "Ada");
        assert_eq!(fields[1].field, "role");

        // RESP3: map.
        let map = Value::Map(vec![(
            Value::BulkString(b"k".to_vec()),
            Value::BulkString(b"v".to_vec()),
        )]);
        let fields = parse_field_pairs(map);
        assert_eq!(
            fields,
            vec![KvField {
                field: "k".into(),
                value: "v".into()
            }]
        );
    }

    #[test]
    fn parse_scored_handles_resp2_flat_and_resp3_pairs() {
        // RESP2: flat [member, score, …] as bulk strings.
        let flat = Value::Array(vec![
            Value::BulkString(b"low".to_vec()),
            Value::BulkString(b"1".to_vec()),
            Value::BulkString(b"high".to_vec()),
            Value::BulkString(b"9".to_vec()),
        ]);
        let scored = parse_scored(flat);
        assert_eq!(scored.len(), 2);
        assert_eq!(scored[0].member, "low");
        assert_eq!(scored[0].score, 1.0);
        assert_eq!(scored[1].member, "high");
        assert_eq!(scored[1].score, 9.0);

        // RESP3: array of [member, Double] pairs.
        let paired = Value::Array(vec![Value::Array(vec![
            Value::BulkString(b"m".to_vec()),
            Value::Double(2.5),
        ])]);
        let scored = parse_scored(paired);
        assert_eq!(
            scored,
            vec![KvScored {
                member: "m".into(),
                score: 2.5
            }]
        );
    }
}
