# DB Objects — Manual Test Plan (views / matviews / functions / procedures / triggers)

End-to-end test commands for the schema-object browser + CRUD, per engine, built against the `test-fixtures` seed data (tables: `users`, `orders`, `products`, `order_items`, `accounts`, `documents`).

> Reseed a fresh volume first so the seeded objects + tables exist:
> ```
> cd bytetable/test-fixtures && docker compose down -v && docker compose up -d
> # SQLite: sqlite3 <fixture.db> < seed/sqlite.sql
> ```

## Capability matrix

| Object | Postgres | MySQL | SQLite |
|---|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ |
| Materialized view | ✅ | — | — |
| Function | ✅ | ✅ | — |
| Procedure | ✅ | ✅ | — |
| Trigger | ✅ | ✅ | ✅ |

The sidebar shows only the supported classes per engine (Postgres = all 5, MySQL = view/procedure/function/trigger, SQLite = view/trigger).

## What to test (the lifecycle), per object

For each object below, exercise the full footer/lifecycle:

1. **Create** — sidebar bottom accordion → expand the class → hover header → **`+`** → opens a SQL editor with a `CREATE …` template → replace with the command → **Run All**. The object appears in the sidebar.
2. **View** — click the object row → ObjectViewer tab → check: type badge, metadata **chips** (returns/language/args, trigger timing/events/table, matview populated/rows/size), **arguments table**, and the **DEFINITION** DDL block (formatted).
3. **Browse data** (views/matviews) — header **Browse data** → opens a data grid.
4. **Refresh** (matviews) — header **Refresh** → re-runs `REFRESH MATERIALIZED VIEW`.
5. **Edit** — header **Edit definition** → opens a SQL editor pre-loaded with a re-runnable form (adds a `DROP … IF EXISTS` when the dialect has no `CREATE OR REPLACE`) → change something → **Run All**. Reopen the viewer to confirm.
6. **Copy DDL** — header **Copy DDL**.
7. **Drop** — header **Drop** → centered confirm modal (type the object name to confirm on a `production` connection) → Drop. The object disappears and its tab closes.

The commands below use a `test_` prefix so they don't collide with the seeded objects (`active_users`, `order_totals`, `user_order_count`, `deactivate_user`, `orders_touch`) — you can also run **Edit/Drop directly on the seeded ones**.

---

## PostgreSQL

### View
```sql
-- create
CREATE VIEW test_active_users AS
SELECT id, name, email FROM users WHERE active;

-- edit (CREATE OR REPLACE — no drop needed)
CREATE OR REPLACE VIEW test_active_users AS
SELECT id, name, email, country FROM users WHERE active;

-- drop
DROP VIEW test_active_users;
```

### Materialized view
```sql
-- create
CREATE MATERIALIZED VIEW test_order_totals AS
SELECT user_id, count(*) AS orders, coalesce(sum(total), 0) AS spent
FROM orders GROUP BY user_id;

-- refresh
REFRESH MATERIALIZED VIEW test_order_totals;

-- edit (no OR REPLACE → drop + recreate)
DROP MATERIALIZED VIEW IF EXISTS test_order_totals;
CREATE MATERIALIZED VIEW test_order_totals AS
SELECT user_id, count(*) AS orders FROM orders GROUP BY user_id;

-- drop
DROP MATERIALIZED VIEW test_order_totals;
```

### Function
```sql
-- create
CREATE OR REPLACE FUNCTION test_user_orders(uid integer)
RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM orders WHERE user_id = uid;
$$;

-- edit (change body)
CREATE OR REPLACE FUNCTION test_user_orders(uid integer)
RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM orders WHERE user_id = uid AND total > 0;
$$;

-- drop (arg signature required)
DROP FUNCTION test_user_orders(integer);
```

### Procedure
```sql
-- create
CREATE OR REPLACE PROCEDURE test_deactivate(uid integer)
LANGUAGE sql AS $$
  UPDATE users SET active = false WHERE id = uid;
$$;

-- edit
CREATE OR REPLACE PROCEDURE test_deactivate(uid integer)
LANGUAGE sql AS $$
  UPDATE users SET active = true WHERE id = uid;
$$;

-- drop (arg signature required)
DROP PROCEDURE test_deactivate(integer);
```

### Trigger
```sql
-- the trigger function must exist first (create it as a Function)
CREATE OR REPLACE FUNCTION test_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;

-- create the trigger
CREATE TRIGGER test_orders_trg BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION test_touch();

-- edit (no OR REPLACE → drop + recreate)
DROP TRIGGER IF EXISTS test_orders_trg ON orders;
CREATE TRIGGER test_orders_trg AFTER UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION test_touch();

-- drop (ON <table> required)
DROP TRIGGER test_orders_trg ON orders;
```

---

## MySQL

> CREATE/DROP for FUNCTION/PROCEDURE/TRIGGER run via the text protocol (handled in the app). The SQL editor keeps `BEGIN … END` (and `$$ … $$`) bodies whole, so multi-statement routines/triggers run fine. If binary logging is on and `CREATE FUNCTION` is refused, set `SET GLOBAL log_bin_trust_function_creators = 1;` once.

### View
```sql
-- create
CREATE VIEW test_active_users AS
SELECT id, name, email FROM users WHERE active = 1;

-- edit (CREATE OR REPLACE)
CREATE OR REPLACE VIEW test_active_users AS
SELECT id, name, email, country FROM users WHERE active = 1;

-- drop
DROP VIEW test_active_users;
```

### Procedure
```sql
-- create (BEGIN…END body — runs as one statement in the editor)
CREATE PROCEDURE test_deactivate(IN uid INT)
BEGIN
  UPDATE users SET active = 0 WHERE id = uid;
END;

-- edit (drop + recreate)
DROP PROCEDURE IF EXISTS test_deactivate;
CREATE PROCEDURE test_deactivate(IN uid INT)
BEGIN
  UPDATE users SET active = 1 WHERE id = uid;
END;

-- drop
DROP PROCEDURE test_deactivate;
```

### Function
```sql
-- create
CREATE FUNCTION test_user_orders(uid INT) RETURNS BIGINT DETERMINISTIC
RETURN (SELECT count(*) FROM orders WHERE user_id = uid);

-- edit (no OR REPLACE → drop + recreate)
DROP FUNCTION IF EXISTS test_user_orders;
CREATE FUNCTION test_user_orders(uid INT) RETURNS BIGINT DETERMINISTIC
RETURN (SELECT count(*) FROM orders WHERE user_id = uid AND total > 0);

-- drop
DROP FUNCTION test_user_orders;
```

### Trigger
```sql
-- create
CREATE TRIGGER test_orders_trg BEFORE UPDATE ON orders
FOR EACH ROW SET NEW.status = NEW.status;

-- edit (drop + recreate)
DROP TRIGGER IF EXISTS test_orders_trg;
CREATE TRIGGER test_orders_trg BEFORE INSERT ON orders
FOR EACH ROW SET NEW.status = COALESCE(NEW.status, 'pending');

-- drop
DROP TRIGGER test_orders_trg;
```

---

## SQLite

> SQLite has only **views** and **triggers**. The SQL editor keeps `BEGIN … END` trigger bodies whole, so triggers run as written (no need to isolate them).

### View
```sql
-- create
CREATE VIEW test_active_users AS
SELECT id, name, email FROM users WHERE active = 1;

-- edit (no OR REPLACE → drop + recreate)
DROP VIEW IF EXISTS test_active_users;
CREATE VIEW test_active_users AS
SELECT id, name, email, country FROM users WHERE active = 1;

-- drop
DROP VIEW test_active_users;
```

### Trigger
```sql
-- create
CREATE TRIGGER test_orders_trg AFTER UPDATE ON orders
BEGIN
  SELECT 1;
END;

-- edit (drop + recreate)
DROP TRIGGER IF EXISTS test_orders_trg;
CREATE TRIGGER test_orders_trg AFTER INSERT ON orders
BEGIN
  SELECT 1;
END;

-- drop
DROP TRIGGER test_orders_trg;
```

---

## Quick checklist (tick per engine)

| Step | PG | MySQL | SQLite |
|---|:---:|:---:|:---:|
| Sidebar shows the right classes (hide unsupported) | ☐ | ☐ | ☐ |
| Counts correct after reseed | ☐ | ☐ | ☐ |
| Open object → viewer (badge, chips, args, DDL formatted) | ☐ | ☐ | ☐ |
| Browse data (view) | ☐ | ☐ | ☐ |
| Refresh (matview) | ☐ | — | — |
| Create (each supported class) | ☐ | ☐ | ☐ |
| Edit definition → run | ☐ | ☐ | ☐ |
| Copy DDL | ☐ | ☐ | ☐ |
| Drop (confirm modal; prod typed-phrase if `production`) | ☐ | ☐ | ☐ |

## Known caveats
- **Compound bodies are handled.** The editor's statement splitter understands `BEGIN … END` (triggers / MySQL & SQLite routines) and `$$ … $$` (Postgres), so a body's inner `;` no longer breaks the statement — run compound CREATEs as written.
- **MySQL routine/trigger DDL** runs via the text protocol (handled in the app, since MySQL refuses these in the prepared-statement protocol).
- **Postgres function/procedure drop** needs the argument signature, e.g. `DROP FUNCTION name(integer)` — the in-app Drop button builds this automatically.
- **Production gate:** on a connection with `env = production`, the Drop modal requires typing the exact object name before the red Drop button arms.
- **Seeded objects** (for edit/drop tests without creating): `active_users` (view), `order_totals` (PG matview), `user_order_count` (function), `deactivate_user` (procedure), `orders_touch` (trigger).
