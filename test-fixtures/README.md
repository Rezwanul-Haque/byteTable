# ByteTable test fixtures

Throwaway databases for exercising all engines. **Test data only — never production.**

## Bring it up

```sh
cd test-fixtures
docker compose up -d        # Postgres + MySQL + SQL Server + Redis + DynamoDB + MongoDB + Cassandra + ClickHouse + Typesense (Postgres/MySQL/MongoDB/ClickHouse auto-seed on first init)
./seed/seed-redis.sh        # seed Redis (no auto-init dir for Redis)
./seed/seed-dynamo.sh       # seed DynamoDB (creates tables + items)
./seed/seed-cassandra.sh    # seed Cassandra (waits for the node, ~30–60s)
./seed/seed-typesense.sh    # seed Typesense (collections, curation, a search-only key)
./seed/seed-mssql.sh        # seed SQL Server (waits for it, ~30–60s)
docker compose down -v      # stop + wipe volumes (next `up` re-seeds)
```

Ports are offset (5**5432**/3**3306**/1**1433**/6**3790**) so they won't collide with any local Postgres/MySQL/SQL Server/Redis. DynamoDB Local keeps the standard **8000**, MongoDB the standard **27017**, Cassandra the standard **9042**, and Typesense the standard **8108** so the connect modal's defaults work as-is.

## Credentials — add these in ByteTable's "New connection" modal (TLS: disable)

### PostgreSQL

| field    | value       |
| -------- | ----------- |
| Host     | `localhost` |
| Port     | `55432`     |
| Database | `byteshop`  |
| User     | `postgres`  |
| Password | `bytetable` |

### MySQL

| field    | value       |
| -------- | ----------- |
| Host     | `127.0.0.1` |
| Port     | `33306`     |
| Database | `byteshop`  |
| User     | `root`      |
| Password | `bytetable` |

### MS SQL Server

Run `./seed/seed-mssql.sh` once after `up` (SQL Server takes ~30–60s to accept connections; re-running drops + recreates everything).

| field    | value          |
| -------- | -------------- |
| Host     | `localhost`    |
| Port     | `11433`        |
| Database | `byteshop`     |
| User     | `sa`           |
| Password | `ByteTable1!`  |

> SQL Server enforces a strong SA password, so it isn't `bytetable` like the others. Uses the arm64-native `azure-sql-edge` image (`mssql/server:2022` segfaults under qemu on Apple Silicon).

### Redis

| field    | value                       |
| -------- | --------------------------- |
| Host     | `127.0.0.1`                 |
| Port     | `63790`                     |
| DB index | `0`                         |
| ACL user | _(leave blank → `default`)_ |
| Password | `bytetable`                 |

### DynamoDB (Local)

New connection → **DynamoDB** → **Local endpoint**:

| field        | value                              |
| ------------ | ---------------------------------- |
| Endpoint URL | `http://localhost:8000`            |
| Region       | `eu-central-1` _(label only)_      |
| Credentials  | _(any — DynamoDB Local ignores them)_ |

Run `./seed/seed-dynamo.sh` once after `up` (re-running it drops + recreates the tables).

### MongoDB

No auth — use either connect mode (no password):

**Host / port:**

| field    | value       |
| -------- | ----------- |
| Host     | `localhost` |
| Port     | `27017`     |
| Database | `byteshop`  |
| User     | _(blank)_   |
| Password | _(blank)_   |

**Connection string:** `mongodb://localhost:27017`

Auto-seeds on first init (like the SQL engines) — no manual step.

### Cassandra

New connection → **Cassandra**:

| field            | value         |
| ---------------- | ------------- |
| Contact points   | `127.0.0.1`   |
| Port             | `9042`        |
| Keyspace         | `byteshop` _(optional)_ |
| Local datacenter | `dc1` _(optional — matches the container's DC)_ |
| User / Password  | _(blank — no auth)_ |
| TLS              | `disable`     |

Run `./seed/seed-cassandra.sh` once after `up` (the node takes ~30–60s to accept CQL; re-running drops + recreates the keyspaces).

### ClickHouse

New connection → **ClickHouse**. Columnar OLAP over the HTTP port (8123); native TCP
9000 is offset to 19000. Auto-seeds on first init (like the SQL engines) — no manual step.

| field    | value       |
| -------- | ----------- |
| Host     | `localhost` |
| Port     | `8123`      |
| Database | `default`   |
| User     | `default`   |
| Password | `bytetable` |

> The e-commerce tables live in `default`; the analytics dataset (with a view, a
> SummingMergeTree materialized view, a SQL UDF, and a data-skipping index) lives in the
> `analytics` database. `system` is ClickHouse's built-in catalog.

### Typesense

New connection → **Typesense**. A search engine, not a table store: collections replace
databases and there is no user or password — a single API key authenticates every request.

The fixture is a **real 3-node raft cluster** (one leader, two followers) on ports
8108/8118/8128, so the dashboard's leader/follower column is genuinely exercisable —
connect to 8118 instead and the same workspace reports a follower.

| field              | value                            |
| ------------------ | -------------------------------- |
| Protocol           | `http`                           |
| Host               | `localhost`                      |
| Port               | `8108`                           |
| Default collection | `products`                       |
| Other nodes        | `localhost:8118, localhost:8128` |
| API key            | `bytetable`                      |

> **Other nodes** is not optional decoration: Typesense has no cluster-membership
> endpoint, so a client can only display the peers it is configured with (its own
> clients take the same list). Leave it blank and the node table shows one row — which
> is correct, just not the whole cluster.

Analytics is switched on (`--enable-search-analytics`, flushing every 10s) and the seed
creates the `popular_queries` / `nohits_queries` rules plus their destination collections,
then sends real traffic — so the dashboard's analytics panel has genuine data rather than
an empty state. `product_queries` and `product_no_hits` appear in the sidebar because they
are ordinary collections; that is where Typesense writes the aggregated counts.

Run `./seed/seed-typesense.sh` once after `up`. It prints a **search-only key** as well —
reconnect with that key instead to exercise the degraded views (the schema, curation and
API-key tabs then show "an admin key is required", and the sidebar can only show the one
configured collection, because a scoped key's allowed collections cannot be read back).

> The fixture pins Typesense **29**, where synonyms and curation still live under
> `/collections/{c}/synonyms` and `/overrides`. v30 moved them to top-level `/synonym_sets`
> and `/curation_sets`; the adapter detects the version and speaks either dialect, so bump
> the image to test the other path.

### SQLite

Use **"Open SQLite file…"** → `test-fixtures/byteshop.db` (committed in this folder).

## What's seeded

- **SQL engines** (Postgres/MySQL/SQLite): an e-commerce schema — `users` ← `orders` ← `order_items` → `products`, plus a unique index, FKs (for FK-hop + structure view), booleans, a `numeric`/`REAL` price column (for column insights). Postgres also has an `analytics` schema (for the schema switcher).
- **SQL Server** (M21): the same e-commerce model across three schemas — `dbo` (`users` ← `orders` ← `order_items` → `products`), `sales` (`invoices` → `orders`), `audit` (`events` → `users`) — with `IDENTITY` pks, `BIT` booleans, `DECIMAL`/`MONEY`, `UNIQUEIDENTIFIER` + `VARBINARY` (`accounts`/`documents`, for binary cells + the JSON viewer), and the full object set: `active_users` (view), `order_totals` (**indexed view** = the "matview" section), `user_order_count` (function), `deactivate_user` (procedure), `orders_touch` (trigger). Exercises bracket-quoted T-SQL DDL, the schema switcher, cross-schema FK-hop, staged ALTER, insights, and the sqlcmd terminal.
- **Redis** (db0, 8 keys, one of every type): `user:1:name` (string), `config:json` (JSON string), `user:1` (hash), `queue:emails` (list), `tags:user:1` (set), `leaderboard:sales` (zset), `events:log` (stream), `session:abc` (string with a 3600s TTL).
- **DynamoDB** (M17): `ShopApp` — the **single-table design** (PK + SK + `GSI1`, on-demand): heterogeneous `USER` profiles, `ORDER`s sharing each user's partition (item collections), and `PRODUCT`s with `L`/`N`/`M` attributes. Plus `Sessions` (partition-only, a `byUser` GSI, provisioned 5/5, a `ttl` TimeToLive attr) and `EventLog` (PK + SK with a `byType` GSI). Exercises the dashboard, scan/query (base table + GSI sort-key ops), item editor, schema map, and export/import.
- **MongoDB** (M18): two databases — `byteshop` (`users` 24, `products` 12, `orders` 30, `reviews` 26) and `analytics` (`events` 40, `sessions` 18). Real `ObjectId`/`ISODate` values with referential integrity (`orders.userId`/`items.productId`, `reviews`/`events`/`sessions` → users/products) for the schema-map edges; secondary + unique + sparse indexes; a `$jsonSchema` validator on `byteshop.products`. Exercises the dashboard, Find (filter/projection/sort, IXSCAN vs COLLSCAN explain), aggregation pipeline (incl. `$lookup`), document editor + validation, inferred-schema/Structure, mongosh, schema map, and export/import.
- **ClickHouse** (M25): the ByteShop e-commerce model adapted to columnar OLAP — no PK/FK, every table a `MergeTree` with an `ORDER BY` sort key. `default` holds the shared tables (`users`/`orders`/`products`/`order_items`, plus `accounts`/`documents` with `UUID` + JSON-in-`String`); `analytics` holds the analytics dataset (`events`, partitioned `PARTITION BY toYYYYMM(ts)` with a `set` **data-skipping index** on `kind`) and the full object set — `active_users` (view), `orders_by_day` (**SummingMergeTree materialized view**), `line_total` (SQL UDF function). Exercises ENGINE + ORDER BY + PARTITION BY DDL, `Nullable(...)` wrapping, secondary indexes as `ALTER TABLE … ADD INDEX`, the schema switcher (`default`/`analytics`/`system`), and the `clickhouse-client` terminal.
- **Typesense** (M30): the **ByteShop search cluster**, running as a real 3-node raft cluster with search analytics enabled — `products` (28 docs, faceted on `brand`/`categories`/`price`/`rating`/`in_stock`), `articles` (12 docs with a `body` snippet field, so highlighting and the title/snippet split are exercised) and `users` (16 docs). Plus everything the harder states need: a multi-way **synonym** set (`keyboard`/`keeb`/`kbd`, so the x-ray can label a `synonym` match), a **curation rule** with both a pin and a hide (so the `curated` badge and the `N hidden` chip both appear), a `catalog` **alias**, and a **search-only API key**. The `Kestrel` brand is deliberate: searching `Kstrl` is the milestone's empty-state acceptance case (2 edits, 5 characters — reachable only with `relax min_len` on).
- **Cassandra** (M19): the **query-first wide-column** ByteShop model across two keyspaces — `byteshop` (`users_by_id` + a 2i on `email`, `orders_by_user` + the `orders_by_status` materialized view, `order_items_by_order`, `products_by_category`) and `analytics` (`events_by_user`, `sessions_by_day`, TimeWindowCompaction). Denormalized `*_by_*` tables with consistent `uuid`/`timeuuid` keys (so the schema map's shared-key edges line up) and CQL types throughout (`uuid`/`timeuuid`/`decimal`/`timestamp`/`date`/`inet`/`set`/`map`). `byteshop` uses `NetworkTopologyStrategy {dc1:1}`, `analytics` `SimpleStrategy RF 1`. Exercises the keyspace dashboard (tables/indexes/views + replication + cluster ring), the query builder (partition key, clustering order, ALLOW FILTERING), hybrid inline editing + row modal, the structure view (Kind badges, indexes/MVs), the standalone CQL tab + cqlsh, the schema map, the create flows, and export/import.

## Files

- `docker-compose.yml` — the seven services.
- `seed/postgres.sql`, `seed/mysql.sql`, `seed/mongo.js`, `seed/clickhouse.sql` — auto-run on first container init.
- `seed/seed-redis.sh`, `seed/seed-dynamo.sh`, `seed/seed-cassandra.sh`, `seed/seed-mssql.sh` — run manually after `up`.
- `seed/cassandra.cql` — the CQL seed run by `seed-cassandra.sh` (mounted at `/seed.cql`).
- `seed/mssql.sql` — the T-SQL seed run by `seed-mssql.sh` (mounted at `/seed.mssql.sql`; run via an ephemeral `mssql-tools` container since azure-sql-edge bundles no `sqlcmd`).
- `seed/sqlite.sql` — rebuilds `byteshop.db` (`rm -f byteshop.db && sqlite3 byteshop.db < seed/sqlite.sql`).
- `byteshop.db` — ready-to-open SQLite sample.

## Note: containers may already be running

The same containers (`bt-pg`/`bt-mysql`/`bt-mssql`/`bt-redis`/`bt-dynamo`/`bt-mongo`/`bt-cassandra`/`bt-clickhouse`) may already be up from an ad-hoc launch with identical credentials. If `docker compose up` reports a port/name conflict, remove the ad-hoc ones first: `docker rm -f bt-pg bt-mysql bt-mssql bt-redis bt-dynamo bt-mongo bt-cassandra bt-clickhouse`, then `docker compose up -d`.
