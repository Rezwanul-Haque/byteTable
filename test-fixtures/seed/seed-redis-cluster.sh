#!/usr/bin/env bash
# Form the Redis Cluster test rig and seed it (M36).
#
#   1. wait for all six nodes to answer PING
#   2. `redis-cli --cluster create` — 3 masters + 3 replicas over 16384 slots
#   3. seed keys that make the cluster workspace worth looking at:
#      - keys spread across all three shards (so the slot map is not one colour)
#      - a HASH-TAGGED family, so the key resolver can demonstrate a collision
#        and a legal multi-key MGET
#      - a deliberately hot tag, so the "key distribution is uneven" warning has
#        something real to fire on
#
# Run after `docker compose -p bytetable-rediscluster -f docker-compose.redis-cluster.yml up -d`.
# Re-running is safe: it detects an already-formed cluster and only re-seeds.
set -euo pipefail

PASS="${BT_REDIS_PASSWORD:-bytetable}"
# Every node lives in one shared network namespace (see the compose file), so
# `docker exec` into any of them can reach all six on 127.0.0.1.
EXEC_IN="${BT_REDIS_CLUSTER_CONTAINER:-bt-rc-1}"
PORTS=(7001 7002 7003 7004 7005 7006)

# R <port> <args...> — run one command against a node.
R() {
  local port="$1"
  shift
  docker exec -i "$EXEC_IN" redis-cli --no-auth-warning -a "$PASS" -c -p "$port" "$@"
}

echo "Waiting for the six nodes…"
for port in "${PORTS[@]}"; do
  until R "$port" PING >/dev/null 2>&1; do sleep 1; done
  echo "  127.0.0.1:$port up"
done

state=$(R 7001 CLUSTER INFO 2>/dev/null | tr -d '\r' | awk -F: '/^cluster_state:/ {print $2}')
if [ "$state" = "ok" ]; then
  echo "Cluster already formed — re-seeding only."
else
  echo "Creating the cluster (3 masters + 3 replicas)…"
  nodes=""
  for port in "${PORTS[@]}"; do nodes="$nodes 127.0.0.1:$port"; done
  # shellcheck disable=SC2086 -- the node list must word-split into six args.
  docker exec -i "$EXEC_IN" redis-cli --no-auth-warning -a "$PASS" \
    --cluster create $nodes --cluster-replicas 1 --cluster-yes
  # Slot assignment gossips for a moment before every node agrees.
  until [ "$(R 7001 CLUSTER INFO | tr -d '\r' | awk -F: '/^cluster_state:/ {print $2}')" = "ok" ]; do
    sleep 1
  done
fi

echo "Seeding…"
# Wipe each master's own keyspace (FLUSHALL is per node, never cluster-wide).
for port in "${PORTS[@]}"; do
  role=$(R "$port" INFO replication | tr -d '\r' | awk -F: '/^role:/ {print $2}')
  [ "$role" = "master" ] && R "$port" FLUSHALL >/dev/null
done

# All the writes go down ONE piped redis-cli session rather than one `docker
# exec` per key — 400+ execs would take minutes. `-c` follows the MOVED
# redirects, so every key lands on the shard that owns its slot regardless of
# which node the session is attached to.
pipe() { docker exec -i "$EXEC_IN" redis-cli --no-auth-warning -a "$PASS" -c -p 7001 >/dev/null; }

{
  # --- keys spread over the whole slot space ---------------------------------
  # Plain keys hash individually and scatter across all three shards, which is
  # what makes the slot map show every shard in use.
  cat <<'CMDS'
HSET product:1 id 1 name "Mechanical Keyboard MK-87" category peripherals price 129.00 stock 212
HSET product:4 id 4 name "4K Monitor 27in" category displays price 379.00 stock 34
HSET product:5 id 5 name "Ultrawide Monitor 34in" category displays price 549.00 stock 56
HSET product:11 id 11 name "Noise-Cancelling Headset" category audio price 249.00 stock 0
HSET product:14 id 14 name "NVMe SSD 2TB" category storage price 164.99 stock 188
HSET product:17 id 17 name "Raspberry Pi 5 8GB" category sbc price 84.00 stock 240
HSET product:19 id 19 name "Ergonomic Chair E-200" category furniture price 459.00 stock 12
HSET product:20 id 20 name "Standing Desk 140cm" category furniture price 629.00 stock 7
SET product:1:views 98000
SET product:4:views 41000
SET product:11:views 23700
SET product:14:views 30500
ZADD leaderboard:sales 612 product:1 540 product:4 503 product:11 488 product:14 366 product:5 281 product:17 122 product:19 84 product:20
SADD online_users user:1 user:3 user:5 user:7 user:9 user:12 user:18 user:24
SET config:json {"theme":"dark","lang":"en","page_size":50}
RPUSH queue:emails {"to":"ada@example.com","tpl":"order_confirm"} {"to":"linus@example.com","tpl":"ship_notice"}
XADD stream:events * type created order_id 7 amount 119.00
XADD stream:events * type paid order_id 7 amount 119.00
XADD stream:events * type created order_id 12 amount 379.00
XADD stream:events * type shipped order_id 3 amount 249.00
SET metrics:cpu 41
SET session:88f3c1 {"user_id":5521,"ip":"203.0.113.42"}

# --- the hash-tag family the key resolver demonstrates ---------------------
# `{user:5521}` pins all three to ONE slot (4403), which is what makes a
# multi-key MGET across them legal — the resolver shows "same slot, allowed"
# here, versus the CROSSSLOT error two untagged keys produce.
SET cart:{user:5521} {"items":3,"total":757.00}
SET orders:{user:5521} {"last":"2026-08-19","count":11}
SET wishlist:{user:5521} {"items":2}
CMDS

  # --- a hot tag, so the key-skew warning has something real to find ---------
  # Every one of these hashes to the slot of `{tenant:acme}`, piling them onto a
  # single shard — exactly the shape the health panel calls out as "usually a
  # hot hash tag pinning many keys to one slot".
  seq 1 400 | while read -r i; do echo "SET audit:{tenant:acme}:$i event-$i"; done
} | pipe

echo
echo "Redis Cluster seeded:"
R 7001 CLUSTER INFO | tr -d '\r' | grep -E '^(cluster_state|cluster_slots_assigned|cluster_known_nodes|cluster_size):'
echo
echo "Keys per master:"
for port in 7001 7002 7003 7004 7005 7006; do
  role=$(R "$port" INFO replication | tr -d '\r' | awk -F: '/^role:/ {print $2}')
  size=$(R "$port" DBSIZE | tr -d '\r')
  echo "  127.0.0.1:$port  $role  $size keys"
done
echo
echo "Connect ByteTable to 127.0.0.1:7001 (db 0, password $PASS) — cluster mode is detected."
echo "To see the PFAIL warning: docker pause bt-rc-6   (docker unpause bt-rc-6 to restore)"
