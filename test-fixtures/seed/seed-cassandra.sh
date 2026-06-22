#!/usr/bin/env bash
# Seed Cassandra with the design-representative ByteShop wide-column model
# (ported from the prototype's cassandra-data.js): a query-first schema with
# denormalized *_by_* tables across two keyspaces —
#
#   byteshop   — users_by_id (+ a 2i on email), orders_by_user (+ the
#                orders_by_status materialized view), order_items_by_order,
#                products_by_category.
#   analytics  — events_by_user, sessions_by_day (TimeWindowCompaction).
#
# This exercises every surface: the keyspace dashboard (tables/indexes/views +
# replication + cluster ring), the query builder (partition key, clustering
# order, ALLOW FILTERING), hybrid inline editing + the row modal, the structure
# view (Kind badges, indexes/MVs), the standalone CQL tab + cqlsh, the schema map
# (shared-key denormalization edges), the create flows, and export/import.
#
# Run after `docker compose up -d`. The Cassandra image has no auto-init dir, so
# this is manual (like seed-redis.sh / seed-dynamo.sh). Re-running it is
# idempotent — the CQL drops + recreates the keyspaces.
#
# Connect to it in ByteTable: New connection → Cassandra →
#   Contact points     127.0.0.1
#   Port               9042
#   Keyspace           byteshop   (optional)
#   Local datacenter   dc1        (optional, matches the container's DC)
#   TLS                disable
set -euo pipefail

CONTAINER="${BT_CASSANDRA_CONTAINER:-bt-cassandra}"

# Wait until CQL is accepting queries (the JVM + gossip take ~30–60s after `up`).
echo "Waiting for Cassandra (this can take up to a minute)…"
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" cqlsh -e "DESCRIBE KEYSPACES" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! docker exec "$CONTAINER" cqlsh -e "DESCRIBE KEYSPACES" >/dev/null 2>&1; then
  echo "Cassandra did not become ready in time. Is the '$CONTAINER' container up?" >&2
  exit 1
fi

# The CQL seed is mounted into the container at /seed.cql by docker-compose.yml.
echo "Loading seed/cassandra.cql…"
docker exec "$CONTAINER" cqlsh -f /seed.cql

echo "Cassandra seeded:"
for ks in byteshop analytics; do
  tables=$(docker exec "$CONTAINER" cqlsh -e \
    "SELECT count(*) FROM system_schema.tables WHERE keyspace_name='$ks';" 2>/dev/null \
    | sed -n '4p' | tr -d ' ' || echo "?")
  echo "  keyspace $ks: $tables tables"
done
echo "Query-first model: orders_by_user / order_items_by_order / products_by_category, + the orders_by_status MV."
