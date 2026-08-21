//! Redis Cluster topology reader (M36 §B1).
//!
//! # What comes from where
//!
//! - **`CLUSTER NODES`** is the backbone: node id, `ip:port@busport`, flags
//!   (`myself` / `master` / `slave` / `fail?` / `fail` / `handshake`), the
//!   master id of a replica, the config epoch, the bus link state, the owned
//!   slot ranges, and the `[slot->-id]` / `[slot-<-id]` migration markers. It
//!   works on every cluster-capable server.
//! - **`CLUSTER SHARDS`** (Redis 7+) adds each node's `replication-offset` and
//!   any announced `hostname`. Optional: a server that rejects it just leaves
//!   those fields `None`.
//! - **`CLUSTER INFO`** is passed through verbatim as ordered `key:value`
//!   pairs — `cluster_state`, `cluster_slots_assigned`, the gossip counters —
//!   so the UI reads the real keys instead of a re-derivation.
//!
//! # Per-node counters are best effort, on purpose
//!
//! Keys / memory / ops / clients are **not** cluster-wide facts: no single
//! node knows them for its peers. `redis-cli --cluster info` gets them by
//! dialling every node, and so do we — one short-lived connection per node,
//! reusing this connection's auth and TLS settings, with a hard timeout and
//! everything running concurrently. When the addresses a cluster announces are
//! not reachable from here (an SSH tunnel forwards exactly one endpoint;
//! private cluster addresses are not routable), the probes are skipped and the
//! counters stay `None` — the UI then says so rather than showing a zero that
//! looks like a measurement.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::future::join_all;
use redis::{Client, ConnectionAddr, Value};

use crate::shared::error::AppError;
use crate::shared::keyvalue::{
    ClusterNode, ClusterReader, ClusterShard, ClusterTopology, KvField, SlotMigration, SlotRange,
};

use super::error::map_query_error;
use super::value::value_to_string;
use super::{info_field, info_num, info_text, RedisKvConnection};

/// How long one per-node `INFO`/`DBSIZE` probe may take before it is given up
/// on. Short: an unreachable node must not stall the dashboard.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

#[async_trait]
impl ClusterReader for RedisKvConnection {
    async fn cluster_topology(&self) -> Result<Option<ClusterTopology>, AppError> {
        let mut conn = self.conn_for(0).await?;

        // `redis_mode` is the server's own answer to "am I a cluster node?" —
        // asked before any CLUSTER command so a standalone server never sees
        // one (it would only reply with an error).
        let server = info_text(&mut conn, "server").await?;
        if info_field(&server, "redis_mode").as_deref() != Some("cluster") {
            return Ok(None);
        }

        let info_text_raw: String = redis::cmd("CLUSTER")
            .arg("INFO")
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        let nodes_text: String = redis::cmd("CLUSTER")
            .arg("NODES")
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;

        // Redis 7+ only — a server without it simply contributes nothing.
        let shards_reply: Option<Value> = redis::cmd("CLUSTER")
            .arg("SHARDS")
            .query_async(&mut conn)
            .await
            .ok();
        let extras = shards_reply
            .map(|v| parse_shards_extras(&v))
            .unwrap_or_default();

        let (mut nodes, migrating) = parse_cluster_nodes(&nodes_text);
        for node in &mut nodes {
            if let Some(extra) = extras.get(&node.id) {
                node.hostname.clone_from(&extra.hostname);
                node.offset = extra.offset;
            }
        }

        let measured = self.probe_nodes(&mut nodes).await;
        let shards = group_into_shards(nodes);

        Ok(Some(ClusterTopology {
            info: parse_info_pairs(&info_text_raw),
            nodes_text,
            shards,
            migrating,
            node_stats_measured: measured,
        }))
    }
}

impl RedisKvConnection {
    /// Fill each node's keys/memory/ops/clients (and replica lag seconds) by
    /// dialling it directly. Returns whether any probe succeeded. Skipped
    /// wholesale over an SSH tunnel: only the tunnelled endpoint is routable
    /// from here, so probing peers would just time out N times.
    async fn probe_nodes(&self, nodes: &mut [ClusterNode]) -> bool {
        if self.tunnel.is_some() {
            return false;
        }
        let probes = join_all(
            nodes
                .iter()
                .map(|node| self.probe_node(node.host.clone(), node.port)),
        )
        .await;

        // Replica lag in seconds is only knowable from the MASTER's
        // `INFO replication` (`slaveN:…,lag=N`), keyed by the replica's address.
        let mut lag_by_addr: HashMap<String, i64> = HashMap::new();
        for probe in probes.iter().flatten() {
            for (addr, lag) in &probe.replica_lag {
                lag_by_addr.insert(addr.clone(), *lag);
            }
        }

        let mut measured = false;
        for (node, probe) in nodes.iter_mut().zip(probes) {
            if let Some(probe) = probe {
                measured = true;
                node.keys = Some(probe.keys);
                node.memory = Some(probe.memory);
                node.ops = Some(probe.ops);
                node.clients = Some(probe.clients);
            }
            node.lag_seconds = lag_by_addr
                .get(&format!("{}:{}", node.host, node.port))
                .copied();
        }

        // Bytes behind = the master's replication offset minus ours. Both come
        // from CLUSTER SHARDS, so this needs no extra round trip.
        let master_offsets: HashMap<String, i64> = nodes
            .iter()
            .filter(|n| n.role == "master")
            .filter_map(|n| n.offset.map(|o| (n.id.clone(), o)))
            .collect();
        for node in nodes.iter_mut() {
            let (Some(master_id), Some(offset)) = (node.master_id.as_ref(), node.offset) else {
                continue;
            };
            node.lag_bytes = master_offsets
                .get(master_id)
                .map(|master| (master - offset).max(0));
        }
        measured
    }

    /// One node's counters, or `None` when it is unreachable / too slow.
    async fn probe_node(&self, host: String, port: u16) -> Option<NodeProbe> {
        let probe = async {
            let client = self.client_for_peer(&host, port).ok()?;
            let mut conn = client.get_multiplexed_async_connection().await.ok()?;
            let info: String = redis::cmd("INFO").query_async(&mut conn).await.ok()?;
            let keys: u64 = redis::cmd("DBSIZE").query_async(&mut conn).await.ok()?;
            Some(NodeProbe {
                keys,
                memory: info_num(&info, "used_memory"),
                ops: info_num(&info, "instantaneous_ops_per_sec"),
                clients: info_num(&info, "connected_clients"),
                replica_lag: parse_replica_lag(&info),
            })
        };
        tokio::time::timeout(PROBE_TIMEOUT, probe)
            .await
            .ok()
            .flatten()
    }

    /// A client for a peer node, reusing this connection's auth (password /
    /// ACL user) and TLS mode with the peer's address swapped in. Cluster
    /// nodes share one configuration, so the credentials that opened this
    /// connection are the ones that open theirs.
    fn client_for_peer(&self, host: &str, port: u16) -> Result<Client, AppError> {
        let mut info = self.client.get_connection_info().clone();
        info.addr = match info.addr {
            ConnectionAddr::TcpTls {
                insecure,
                tls_params,
                ..
            } => ConnectionAddr::TcpTls {
                host: host.to_string(),
                port,
                insecure,
                tls_params,
            },
            _ => ConnectionAddr::Tcp(host.to_string(), port),
        };
        // Cluster mode has a single db; never carry a configured db index over.
        info.redis.db = 0;
        Client::open(info).map_err(super::error::map_connect_error)
    }
}

/// What one per-node probe measured.
struct NodeProbe {
    keys: u64,
    memory: u64,
    ops: u64,
    clients: u64,
    /// `(ip:port, lag seconds)` for each replica this node is the master of.
    replica_lag: Vec<(String, i64)>,
}

/// Per-node extras `CLUSTER SHARDS` adds on top of `CLUSTER NODES`.
#[derive(Default)]
struct ShardExtra {
    hostname: Option<String>,
    offset: Option<i64>,
}

/// Parse an `INFO`-style body into ordered `key:value` pairs, dropping the
/// `# Section` headers and blank lines.
pub(super) fn parse_info_pairs(body: &str) -> Vec<KvField> {
    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once(':'))
        .map(|(field, value)| KvField {
            field: field.to_string(),
            value: value.to_string(),
        })
        .collect()
}

/// Parse `CLUSTER NODES` into nodes plus the local node's in-flight slot
/// moves. One line per node:
///
/// ```text
/// <id> <ip:port@bus[,hostname]> <flags> <master> <ping> <pong> <epoch> <link> <slot>…
/// ```
pub(super) fn parse_cluster_nodes(text: &str) -> (Vec<ClusterNode>, Vec<SlotMigration>) {
    let mut nodes = Vec::new();
    let mut migrating = Vec::new();

    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let parts: Vec<&str> = line.split(' ').filter(|p| !p.is_empty()).collect();
        // id · address · flags · master · ping-sent · pong-recv · epoch · link,
        // then zero or more slot / migration tokens.
        if parts.len() < 8 {
            continue;
        }
        let (id, address, flags, master) = (parts[0], parts[1], parts[2], parts[3]);
        let (epoch, link) = (parts[6], parts[7]);
        let slot_tokens = &parts[8..];

        let (host, port, bus_port, hostname) = parse_address(address);
        let flag_set: Vec<&str> = flags.split(',').collect();
        let role = if flag_set.contains(&"master") {
            "master"
        } else {
            "replica"
        };

        let mut slots = Vec::new();
        for token in slot_tokens {
            if let Some(migration) = parse_migration_marker(token) {
                migrating.push(migration);
            } else if let Some(range) = parse_slot_range(token) {
                slots.push(range);
            }
        }
        slots.sort_by_key(|r| r.from);

        nodes.push(ClusterNode {
            id: id.to_string(),
            host,
            port,
            bus_port,
            hostname,
            role: role.to_string(),
            master_id: (master != "-").then(|| master.to_string()),
            myself: flag_set.contains(&"myself"),
            health: health_of(&flag_set),
            link: link.to_string(),
            epoch: epoch.parse().unwrap_or(0),
            slots,
            offset: None,
            lag_bytes: None,
            lag_seconds: None,
            keys: None,
            memory: None,
            ops: None,
            clients: None,
        });
    }
    migrating.sort_by_key(|m| m.slot);
    (nodes, migrating)
}

/// `ip:port@busport[,hostname[,aux=val]…]` → its parts.
fn parse_address(address: &str) -> (String, u16, u16, Option<String>) {
    let (endpoint, rest) = address.split_once(',').unwrap_or((address, ""));
    let hostname = rest
        .split(',')
        .find(|part| !part.is_empty() && !part.contains('='))
        .map(str::to_string);
    let (host_port, bus) = endpoint.split_once('@').unwrap_or((endpoint, ""));
    // rsplit so an IPv6 literal's colons stay with the host.
    let (host, port) = host_port.rsplit_once(':').unwrap_or((host_port, "6379"));
    let port: u16 = port.parse().unwrap_or(6379);
    let bus_port = bus.parse().unwrap_or(port.saturating_add(10000));
    (host.to_string(), port, bus_port, hostname)
}

/// `0-5460` or a bare `5461` → an inclusive range. Anything else → `None`.
fn parse_slot_range(token: &str) -> Option<SlotRange> {
    if token.starts_with('[') {
        return None;
    }
    match token.split_once('-') {
        Some((from, to)) => Some(SlotRange {
            from: from.parse().ok()?,
            to: to.parse().ok()?,
        }),
        None => {
            let slot: u16 = token.parse().ok()?;
            Some(SlotRange {
                from: slot,
                to: slot,
            })
        }
    }
}

/// `[slot->-<target>]` (leaving) / `[slot-<-<source>]` (arriving).
fn parse_migration_marker(token: &str) -> Option<SlotMigration> {
    let body = token.strip_prefix('[')?.strip_suffix(']')?;
    let (direction, sep) = if body.contains("->-") {
        ("migrating", "->-")
    } else if body.contains("-<-") {
        ("importing", "-<-")
    } else {
        return None;
    };
    let (slot, peer) = body.split_once(sep)?;
    Some(SlotMigration {
        slot: slot.parse().ok()?,
        direction: direction.to_string(),
        peer_id: peer.to_string(),
    })
}

/// The node's health, from the failure flags. Redis keeps `cluster_state: ok`
/// while all slots are covered, so a node being PFAIL is a *separate* fact —
/// which is exactly why it lives on the node and not on the cluster.
fn health_of(flags: &[&str]) -> String {
    for flag in ["fail?", "fail", "handshake", "noaddr"] {
        if flags.contains(&flag) {
            return flag.to_string();
        }
    }
    "online".to_string()
}

/// Pull `hostname` + `replication-offset` per node id out of a
/// `CLUSTER SHARDS` reply, accepting both the RESP3 map and RESP2 flat-array
/// encodings.
fn parse_shards_extras(reply: &Value) -> HashMap<String, ShardExtra> {
    let mut out = HashMap::new();
    let Value::Array(shards) = reply else {
        return out;
    };
    for shard in shards {
        let Some(nodes) = field_of(shard, "nodes") else {
            continue;
        };
        let Value::Array(nodes) = nodes else { continue };
        for node in nodes {
            let Some(id) = field_of(node, "id").map(value_to_string) else {
                continue;
            };
            out.insert(
                id,
                ShardExtra {
                    hostname: field_of(node, "hostname")
                        .map(value_to_string)
                        .filter(|h| !h.is_empty()),
                    offset: field_of(node, "replication-offset").and_then(|v| match v {
                        Value::Int(n) => Some(*n),
                        other => value_to_string(other).parse().ok(),
                    }),
                },
            );
        }
    }
    out
}

/// One field of a RESP map-or-flat-array reply.
fn field_of<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Map(pairs) => pairs
            .iter()
            .find(|(k, _)| value_to_string(k) == key)
            .map(|(_, v)| v),
        Value::Array(flat) => flat
            .chunks_exact(2)
            .find(|pair| value_to_string(&pair[0]) == key)
            .map(|pair| &pair[1]),
        _ => None,
    }
}

/// Replica lag in seconds from a master's `INFO replication`:
/// `slave0:ip=10.0.2.12,port=6379,state=online,offset=418,lag=0`.
fn parse_replica_lag(info: &str) -> Vec<(String, i64)> {
    info.lines()
        .map(str::trim)
        .filter_map(|line| line.split_once(':'))
        .filter(|(key, _)| key.starts_with("slave") && key[5..].chars().all(char::is_numeric))
        .filter_map(|(_, body)| {
            let mut ip = None;
            let mut port = None;
            let mut lag = None;
            for part in body.split(',') {
                match part.split_once('=') {
                    Some(("ip", v)) => ip = Some(v),
                    Some(("port", v)) => port = Some(v),
                    Some(("lag", v)) => lag = v.parse::<i64>().ok(),
                    _ => {}
                }
            }
            Some((format!("{}:{}", ip?, port?), lag?))
        })
        .collect()
}

/// Group the flat node list into shards: one per slot-owning master, ordered
/// by first slot, each carrying the replicas that point at it. A master with
/// no slots (freshly met, or mid-reshard with everything moved away) still
/// gets a shard — hiding it would hide a node.
pub(super) fn group_into_shards(nodes: Vec<ClusterNode>) -> Vec<ClusterShard> {
    let mut masters: Vec<ClusterNode> = nodes
        .iter()
        .filter(|n| n.role == "master")
        .cloned()
        .collect();
    masters.sort_by_key(|m| m.slots.first().map(|s| s.from).unwrap_or(u16::MAX));

    masters
        .into_iter()
        .enumerate()
        .map(|(index, master)| {
            let replicas: Vec<ClusterNode> = nodes
                .iter()
                .filter(|n| n.master_id.as_deref() == Some(master.id.as_str()))
                .cloned()
                .collect();
            ClusterShard {
                index: index as u32,
                slots: master.slots.clone(),
                master,
                replicas,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real three-master cluster: one replica flagged PFAIL with a
    // disconnected link, and the local node migrating a slot window out.
    const NODES: &str = "\
07c37dfeb235213a872192d90877d0cd55635b91 10.0.2.11:6379@16379 myself,master - 0 1730000000000 12 connected 0-5460 [5461->-67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1]\n\
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.0.2.15:6379@16379,redis-b.internal master - 0 1730000000100 13 connected 5461-10922\n\
6ec23923021cf3ffec47632106199cb7f496ce01 10.0.2.19:6379@16379 master - 0 1730000000200 14 connected 10923-16383\n\
824fe116063bc5fcf9f4ffd895bc17aee7731ac3 10.0.2.12:6379@16379 slave 07c37dfeb235213a872192d90877d0cd55635b91 0 1730000000300 12 connected\n\
58e6e48d41228013e5d9c1c37c5060693925e97e 10.0.2.20:6379@16379 slave,fail? 6ec23923021cf3ffec47632106199cb7f496ce01 0 1730000000400 14 disconnected\n";

    #[test]
    fn parses_nodes_flags_slots_and_the_local_migration() {
        let (nodes, migrating) = parse_cluster_nodes(NODES);
        assert_eq!(nodes.len(), 5);

        let me = &nodes[0];
        assert_eq!(me.id, "07c37dfeb235213a872192d90877d0cd55635b91");
        assert_eq!(me.host, "10.0.2.11");
        assert_eq!(me.port, 6379);
        assert_eq!(me.bus_port, 16379);
        assert_eq!(me.role, "master");
        assert!(me.myself);
        assert_eq!(me.health, "online");
        assert_eq!(me.epoch, 12);
        assert_eq!(me.slots, vec![SlotRange { from: 0, to: 5460 }]);
        assert_eq!(me.master_id, None);

        // The announced hostname rides in the address field.
        assert_eq!(nodes[1].hostname.as_deref(), Some("redis-b.internal"));

        // A replica points at its master and keeps its failure flag + link.
        let bad = &nodes[4];
        assert_eq!(bad.role, "replica");
        assert_eq!(
            bad.master_id.as_deref(),
            Some("6ec23923021cf3ffec47632106199cb7f496ce01")
        );
        assert_eq!(bad.health, "fail?");
        assert_eq!(bad.link, "disconnected");
        assert!(bad.slots.is_empty());

        // The `[slot->-id]` marker is a migration, never a slot the node owns.
        assert_eq!(migrating.len(), 1);
        assert_eq!(migrating[0].slot, 5461);
        assert_eq!(migrating[0].direction, "migrating");
        assert_eq!(
            migrating[0].peer_id,
            "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1"
        );
    }

    #[test]
    fn importing_marker_reads_the_other_way() {
        let m = parse_migration_marker("[16000-<-07c37dfeb235213a872192d90877d0cd55635b91]")
            .expect("a marker");
        assert_eq!(m.slot, 16000);
        assert_eq!(m.direction, "importing");
        assert_eq!(parse_migration_marker("0-16383"), None);
    }

    #[test]
    fn shards_are_ordered_by_first_slot_and_carry_their_replicas() {
        let (nodes, _) = parse_cluster_nodes(NODES);
        let shards = group_into_shards(nodes);
        assert_eq!(shards.len(), 3);
        assert_eq!(shards[0].slots, vec![SlotRange { from: 0, to: 5460 }]);
        assert_eq!(shards[0].replicas.len(), 1);
        assert_eq!(shards[0].replicas[0].host, "10.0.2.12");
        assert_eq!(shards[1].master.host, "10.0.2.15");
        assert!(shards[1].replicas.is_empty());
        // The third shard's only replica is the PFAIL one — a shard with no
        // healthy replica, which is the case the health panel must call out.
        assert_eq!(shards[2].replicas.len(), 1);
        assert_eq!(shards[2].replicas[0].health, "fail?");
        assert_eq!(shards[2].index, 2);
    }

    #[test]
    fn a_bare_slot_number_is_a_one_slot_range() {
        assert_eq!(parse_slot_range("77"), Some(SlotRange { from: 77, to: 77 }));
        assert_eq!(parse_slot_range("[77->-abc]"), None);
    }

    #[test]
    fn cluster_info_keeps_the_servers_own_keys_and_order() {
        let pairs = parse_info_pairs("cluster_state:ok\r\ncluster_slots_assigned:16384\r\n");
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].field, "cluster_state");
        assert_eq!(pairs[0].value, "ok");
        assert_eq!(pairs[1].field, "cluster_slots_assigned");
    }

    #[test]
    fn replica_lag_comes_from_the_masters_replication_section() {
        let info = "# Replication\r\nrole:master\r\n\
             slave0:ip=10.0.2.12,port=6379,state=online,offset=418,lag=0\r\n\
             slave1:ip=10.0.2.20,port=6379,state=online,offset=100,lag=37\r\n";
        let lag = parse_replica_lag(info);
        assert_eq!(
            lag,
            vec![
                ("10.0.2.12:6379".to_string(), 0),
                ("10.0.2.20:6379".to_string(), 37),
            ]
        );
    }
}
