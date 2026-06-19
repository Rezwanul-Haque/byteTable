# ByteTable test fixtures

Throwaway databases for exercising all engines. **Test data only — never production.**

## Bring it up

```sh
cd test-fixtures
docker compose up -d        # Postgres + MySQL + Redis + DynamoDB (Postgres/MySQL auto-seed on first init)
./seed/seed-redis.sh        # seed Redis (no auto-init dir for Redis)
./seed/seed-dynamo.sh       # seed DynamoDB (creates tables + items)
docker compose down -v      # stop + wipe volumes (next `up` re-seeds)
```

Ports are offset (5**5432**/3**3306**/6**3790**) so they won't collide with any local Postgres/MySQL/Redis. DynamoDB Local keeps the standard **8000** so the connect modal's default Local endpoint works as-is.

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

### SQLite

Use **"Open SQLite file…"** → `test-fixtures/byteshop.db` (committed in this folder).

## What's seeded

- **SQL engines** (Postgres/MySQL/SQLite): an e-commerce schema — `users` ← `orders` ← `order_items` → `products`, plus a unique index, FKs (for FK-hop + structure view), booleans, a `numeric`/`REAL` price column (for column insights). Postgres also has an `analytics` schema (for the schema switcher).
- **Redis** (db0, 8 keys, one of every type): `user:1:name` (string), `config:json` (JSON string), `user:1` (hash), `queue:emails` (list), `tags:user:1` (set), `leaderboard:sales` (zset), `events:log` (stream), `session:abc` (string with a 3600s TTL).
- **DynamoDB** (M17): `ShopApp` — the **single-table design** (PK + SK + `GSI1`, on-demand): heterogeneous `USER` profiles, `ORDER`s sharing each user's partition (item collections), and `PRODUCT`s with `L`/`N`/`M` attributes. Plus `Sessions` (partition-only, a `byUser` GSI, provisioned 5/5, a `ttl` TimeToLive attr) and `EventLog` (PK + SK with a `byType` GSI). Exercises the dashboard, scan/query (base table + GSI sort-key ops), item editor, schema map, and export/import.

## Files

- `docker-compose.yml` — the four services.
- `seed/postgres.sql`, `seed/mysql.sql` — auto-run on first container init.
- `seed/seed-redis.sh`, `seed/seed-dynamo.sh` — run manually after `up`.
- `seed/sqlite.sql` — rebuilds `byteshop.db` (`rm -f byteshop.db && sqlite3 byteshop.db < seed/sqlite.sql`).
- `byteshop.db` — ready-to-open SQLite sample.

## Note: containers may already be running

The same containers (`bt-pg`/`bt-mysql`/`bt-redis`/`bt-dynamo`) may already be up from an ad-hoc launch with identical credentials. If `docker compose up` reports a port/name conflict, remove the ad-hoc ones first: `docker rm -f bt-pg bt-mysql bt-redis bt-dynamo`, then `docker compose up -d`.
