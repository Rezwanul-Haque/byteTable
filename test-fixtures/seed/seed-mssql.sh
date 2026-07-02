#!/usr/bin/env bash
# Seed SQL Server (azure-sql-edge) with the ByteShop e-commerce model: the
# byteshop database across three schemas (dbo / sales / audit), IDENTITY pks,
# BIT booleans, DECIMAL/MONEY, UNIQUEIDENTIFIER + VARBINARY, cross-schema FKs,
# and the full object set (view / indexed view / function / procedure / trigger).
#
# Run after `docker compose up -d`. SQL Server images have NO auto-init dir (no
# /docker-entrypoint-initdb.d), so this is manual — like seed-redis.sh /
# seed-cassandra.sh. Re-running it is idempotent (the SQL drops + recreates
# everything). Also note azure-sql-edge bundles no `sqlcmd`, so we run it from an
# ephemeral `mssql-tools` container that shares the DB container's network
# namespace (so `localhost,1433` reaches SQL Server on any host OS).
#
# Connect to it in ByteTable: New connection → MS SQL Server →
#   Host       localhost
#   Port       11433
#   Database   byteshop
#   User       sa
#   Password   ByteTable1!   (or $BT_MSSQL_PASSWORD)
#   TLS        disable
set -euo pipefail

CONTAINER="${BT_MSSQL_CONTAINER:-bt-mssql}"
PASSWORD="${BT_MSSQL_PASSWORD:-ByteTable1!}"
TOOLS_IMAGE="${BT_MSSQL_TOOLS_IMAGE:-mcr.microsoft.com/mssql-tools}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED="$HERE/mssql.sql"

# Run sqlcmd against the DB container. `--network container:<c>` shares the DB
# container's net namespace so localhost:1433 is SQL Server; `-C` trusts the
# self-signed cert. Extra args ($@) are appended (e.g. -Q / -i).
run_sql() {
  docker run --rm --network "container:$CONTAINER" \
    -v "$SEED:/seed.mssql.sql:ro" \
    "$TOOLS_IMAGE" \
    /opt/mssql-tools/bin/sqlcmd -S localhost,1433 -U sa -P "$PASSWORD" -C -b "$@"
}

echo "Waiting for SQL Server (this can take up to a minute after 'up')…"
for _ in $(seq 1 60); do
  if run_sql -Q "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

if ! run_sql -Q "SELECT 1" >/dev/null 2>&1; then
  echo "SQL Server did not become ready in time. Is the '$CONTAINER' container up?" >&2
  exit 1
fi

echo "Loading seed/mssql.sql…"
run_sql -i /seed.mssql.sql

tables=$(run_sql -d byteshop -h -1 -W -Q \
  "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.tables;" 2>/dev/null | head -1 | tr -d ' \r')
echo "SQL Server seeded: database byteshop, schemas dbo/sales/audit, ${tables:-?} tables."
echo "Objects: active_users (view), order_totals (indexed view), user_order_count (fn),"
echo "         deactivate_user (proc), orders_touch (trigger)."
