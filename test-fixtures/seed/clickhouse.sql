-- ClickHouse seed (auto-run on first init, via /docker-entrypoint-initdb.d).
-- Columnar OLAP: no SERIAL/PK/FK — every table uses a MergeTree ENGINE with an
-- ORDER BY sort key (the sparse primary index) and an optional PARTITION BY.
-- Mirrors the ByteShop e-commerce model of the other engines, adapted to
-- ClickHouse. Two datasets, matching the connect modal's schema switcher:
--   * `default`   — the shared e-commerce tables (users/orders/products/…).
--   * `analytics` — the analytics dataset + the object set (view/matview/function)
--                   and a data-skipping (secondary) index.
--   * `system`    — ClickHouse's built-in catalog (always present, not seeded).

-- ── default: shared e-commerce tables ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS default.users
(
    id         UInt32,
    name       String,
    email      String,
    country    String,
    active     Bool DEFAULT true,
    created_at DateTime64(3, 'UTC') DEFAULT now64()
)
ENGINE = MergeTree()
ORDER BY id;

CREATE TABLE IF NOT EXISTS default.products
(
    id    UInt32,
    sku   String,
    name  String,
    price Decimal(10, 2)
)
ENGINE = MergeTree()
ORDER BY id;

CREATE TABLE IF NOT EXISTS default.orders
(
    id         UInt32,
    user_id    UInt32,
    total      Decimal(10, 2),
    status     String,
    method     String,
    paid       Bool,
    created_at DateTime64(3, 'UTC') DEFAULT now64()
)
ENGINE = MergeTree()
ORDER BY id;

CREATE TABLE IF NOT EXISTS default.order_items
(
    id         UInt32,
    order_id   UInt32,
    product_id UInt32,
    qty        UInt32 DEFAULT 1
)
ENGINE = MergeTree()
ORDER BY id;

-- UUID + JSON-in-String demo (binary/UUID cells + the JSON viewer).
CREATE TABLE IF NOT EXISTS default.accounts
(
    id         UUID,
    handle     String,
    prefs      String,
    created_at DateTime64(3, 'UTC') DEFAULT now64()
)
ENGINE = MergeTree()
ORDER BY id;

CREATE TABLE IF NOT EXISTS default.documents
(
    id         UUID,
    account_id UUID,
    title      String,
    body       String,
    updated_at DateTime64(3, 'UTC') DEFAULT now64()
)
ENGINE = MergeTree()
ORDER BY id;

INSERT INTO default.users (id, name, email, country, active) VALUES
    (1, 'Ada Lovelace',    'ada@byteshop.io',   'GB', 1),
    (2, 'Alan Turing',     'alan@byteshop.io',  'GB', 1),
    (3, 'Grace Hopper',    'grace@byteshop.io', 'US', 1),
    (4, 'Edsger Dijkstra', 'edsger@byteshop.io','NL', 0);

INSERT INTO default.products (id, sku, name, price) VALUES
    (1, 'MUG-01', 'ByteTable Mug', 12.50),
    (2, 'TEE-01', 'Logo T-Shirt',  24.00),
    (3, 'STK-01', 'Sticker Pack',   5.00);

INSERT INTO default.orders (id, user_id, total, status, method, paid) VALUES
    (1, 1, 42.50, 'delivered', 'card',   1),
    (2, 1, 19.99, 'shipped',   'card',   1),
    (3, 2, 99.00, 'pending',   'paypal', 0),
    (4, 3,  5.00, 'cancelled', 'card',   0),
    (5, 3, 36.50, 'delivered', 'paypal', 1);

INSERT INTO default.order_items (order_id, product_id, qty) VALUES
    (1, 1, 2), (1, 3, 1), (2, 2, 1), (3, 2, 3), (5, 1, 1), (5, 3, 2);

INSERT INTO default.accounts (id, handle, prefs) VALUES
    ('11111111-1111-4111-8111-111111111111', 'ada',
     '{"theme":"midnight","notifications":{"email":true,"push":false},"tags":["admin","early-access"]}'),
    ('22222222-2222-4222-8222-222222222222', 'grace',
     '{"theme":"light","notifications":{"email":false,"push":true},"tags":[]}');

INSERT INTO default.documents (id, account_id, title, body) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
     'Q3 Roadmap',    '{"status":"published","wordCount":1280,"reviewers":["grace","alan"],"meta":{"pinned":true}}'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111',
     'Release Notes', '{"status":"draft","wordCount":340,"reviewers":[]}'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222',
     'Design Spec',   '{"status":"review","wordCount":2110,"reviewers":["ada"],"meta":{"pinned":false}}');

-- ── analytics: the analytics dataset + object set ───────────────────────────
CREATE DATABASE IF NOT EXISTS analytics;

-- Fact table with a PARTITION BY (month) and a data-skipping / secondary index
-- on `kind` (exercises introspection of system.data_skipping_indices + the
-- Structure indexes accordion).
CREATE TABLE IF NOT EXISTS analytics.events
(
    id      UInt32,
    kind    String,
    user_id UInt32,
    ts      DateTime64(3, 'UTC') DEFAULT now64(),
    INDEX idx_kind kind TYPE set(100) GRANULARITY 4
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (kind, ts);

INSERT INTO analytics.events (id, kind, user_id) VALUES
    (1, 'login', 1), (2, 'view', 1), (3, 'purchase', 2), (4, 'login', 3);

-- View (object browser: view).
CREATE VIEW analytics.active_users AS
    SELECT id, name, email, country FROM default.users WHERE active;

-- Materialized view backed by a SummingMergeTree, aggregating orders per day
-- (object browser: matview). POPULATE backfills from the existing rows.
CREATE MATERIALIZED VIEW analytics.orders_by_day
ENGINE = SummingMergeTree()
ORDER BY (day)
POPULATE AS
    SELECT toDate(created_at) AS day, count() AS orders
    FROM default.orders
    GROUP BY day;

-- SQL UDF (object browser: function). Requires access management (set in compose).
CREATE FUNCTION IF NOT EXISTS line_total AS (qty, price) -> qty * price;
