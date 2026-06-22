-- ByteTable test data — Cassandra (M19), the query-first wide-column ByteShop
-- model (ported from the prototype's cassandra-data.js):
--   byteshop   — users_by_id, orders_by_user (+ orders_by_status MV),
--                order_items_by_order, products_by_category. A 2i on email.
--   analytics  — events_by_user, sessions_by_day.
-- Fixed uuid/timeuuid literals keep the denormalized tables referentially
-- consistent (so the schema map's shared-key edges line up). Run via
-- seed/seed-cassandra.sh (Cassandra has no auto-init dir).
--
-- Single-node Docker: byteshop uses NetworkTopologyStrategy {'dc1': 1} (the node
-- is configured into datacenter dc1, matching the connect modal's default local
-- datacenter); analytics uses SimpleStrategy RF 1 (mirrors the prototype).

DROP KEYSPACE IF EXISTS byteshop;
DROP KEYSPACE IF EXISTS analytics;

CREATE KEYSPACE byteshop
  WITH replication = {'class': 'NetworkTopologyStrategy', 'dc1': 1}
  AND durable_writes = true;

CREATE KEYSPACE analytics
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
  AND durable_writes = true;

-- ============================ byteshop ============================
USE byteshop;

CREATE TABLE users_by_id (
  user_id uuid,
  name text,
  email text,
  country text,
  created_at timestamp,
  tags set<text>,
  PRIMARY KEY ((user_id))
) WITH comment = 'Lookup a user by id';

CREATE INDEX users_by_id_email_idx ON users_by_id (email);

CREATE TABLE orders_by_user (
  user_id uuid,
  order_id timeuuid,
  status text,
  total decimal,
  item_count int,
  created_at timestamp,
  PRIMARY KEY ((user_id), order_id)
) WITH CLUSTERING ORDER BY (order_id DESC)
  AND comment = 'A user''s orders, newest first';

CREATE MATERIALIZED VIEW orders_by_status AS
  SELECT * FROM orders_by_user
  WHERE status IS NOT NULL AND user_id IS NOT NULL AND order_id IS NOT NULL
  PRIMARY KEY ((status), order_id, user_id);

CREATE TABLE order_items_by_order (
  order_id timeuuid,
  product_id uuid,
  product_name text,
  qty int,
  price decimal,
  PRIMARY KEY ((order_id), product_id)
) WITH CLUSTERING ORDER BY (product_id ASC)
  AND comment = 'Line items for an order';

CREATE TABLE products_by_category (
  category text,
  price double,
  product_id uuid,
  name text,
  sku text,
  stock int,
  tags set<text>,
  PRIMARY KEY ((category), price, product_id)
) WITH CLUSTERING ORDER BY (price ASC, product_id ASC)
  AND comment = 'Browse a category by price';

-- users
INSERT INTO users_by_id (user_id, name, email, country, created_at, tags) VALUES
  (11111111-1111-4111-8111-111111111111, 'Zoe Costa', 'zoe.costa@proton.me', 'DE', '2023-11-02T09:14:00+0000', {'vip','newsletter'});
INSERT INTO users_by_id (user_id, name, email, country, created_at, tags) VALUES
  (22222222-2222-4222-8222-222222222222, 'Liam Park', 'liam.park@fastmail.com', 'NL', '2023-12-19T16:40:00+0000', {'newsletter'});
INSERT INTO users_by_id (user_id, name, email, country, created_at, tags) VALUES
  (33333333-3333-4333-8333-333333333333, 'Aria Meyer', 'aria.meyer@gmail.com', 'US', '2024-01-08T11:05:00+0000', {'beta','newsletter'});

-- orders (order_id is a timeuuid; user_id references users_by_id)
INSERT INTO orders_by_user (user_id, order_id, status, total, item_count, created_at) VALUES
  (11111111-1111-4111-8111-111111111111, 50554d6e-29bb-11e5-b345-feff819cdc9f, 'delivered', 258.50, 2, '2024-02-11T11:01:00+0000');
INSERT INTO orders_by_user (user_id, order_id, status, total, item_count, created_at) VALUES
  (11111111-1111-4111-8111-111111111111, 60554d6e-29bb-11e5-b345-feff819cdc9f, 'shipped', 129.00, 1, '2024-03-04T14:22:00+0000');
INSERT INTO orders_by_user (user_id, order_id, status, total, item_count, created_at) VALUES
  (22222222-2222-4222-8222-222222222222, 70554d6e-29bb-11e5-b345-feff819cdc9f, 'paid', 379.00, 1, '2024-03-18T09:47:00+0000');

-- order line items (order_id references orders; product_id references products)
INSERT INTO order_items_by_order (order_id, product_id, product_name, qty, price) VALUES
  (50554d6e-29bb-11e5-b345-feff819cdc9f, aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa, 'Mechanical Keyboard MK-87', 1, 129.00);
INSERT INTO order_items_by_order (order_id, product_id, product_name, qty, price) VALUES
  (50554d6e-29bb-11e5-b345-feff819cdc9f, bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb, 'Noise-Cancelling Headset', 1, 129.50);
INSERT INTO order_items_by_order (order_id, product_id, product_name, qty, price) VALUES
  (60554d6e-29bb-11e5-b345-feff819cdc9f, aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa, 'Mechanical Keyboard MK-87', 1, 129.00);
INSERT INTO order_items_by_order (order_id, product_id, product_name, qty, price) VALUES
  (70554d6e-29bb-11e5-b345-feff819cdc9f, cccc3333-cccc-4ccc-8ccc-cccccccccccc, '4K Monitor 27"', 1, 379.00);

-- products by category
INSERT INTO products_by_category (category, price, product_id, name, sku, stock, tags) VALUES
  ('keyboards', 129.00, aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa, 'Mechanical Keyboard MK-87', 'P-1001', 212, {'bestseller'});
INSERT INTO products_by_category (category, price, product_id, name, sku, stock, tags) VALUES
  ('audio', 129.50, bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb, 'Noise-Cancelling Headset', 'P-1011', 0, {'sale'});
INSERT INTO products_by_category (category, price, product_id, name, sku, stock, tags) VALUES
  ('displays', 379.00, cccc3333-cccc-4ccc-8ccc-cccccccccccc, '4K Monitor 27"', 'P-1004', 34, {'new'});
INSERT INTO products_by_category (category, price, product_id, name, sku, stock, tags) VALUES
  ('storage', 164.99, dddd4444-dddd-4ddd-8ddd-dddddddddddd, 'NVMe SSD 2TB', 'P-1014', 188, {'bestseller'});

-- ============================ analytics ============================
USE analytics;

CREATE TABLE events_by_user (
  user_id uuid,
  ts timeuuid,
  type text,
  ip inet,
  props map<text,text>,
  PRIMARY KEY ((user_id), ts)
) WITH CLUSTERING ORDER BY (ts DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy'}
  AND comment = 'User event stream, newest first';

CREATE TABLE sessions_by_day (
  day date,
  started_at timeuuid,
  user_id uuid,
  country text,
  duration_s int,
  PRIMARY KEY ((day), started_at)
) WITH CLUSTERING ORDER BY (started_at DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy'}
  AND comment = 'Sessions bucketed by day';

INSERT INTO events_by_user (user_id, ts, type, ip, props) VALUES
  (11111111-1111-4111-8111-111111111111, 50554d6e-29bb-11e5-b345-feff819cdc9f, 'page_view', '203.0.113.5', {'path':'/home','ref':'email'});
INSERT INTO events_by_user (user_id, ts, type, ip, props) VALUES
  (11111111-1111-4111-8111-111111111111, 60554d6e-29bb-11e5-b345-feff819cdc9f, 'add_to_cart', '203.0.113.5', {'sku':'P-1001'});
INSERT INTO events_by_user (user_id, ts, type, ip, props) VALUES
  (22222222-2222-4222-8222-222222222222, 70554d6e-29bb-11e5-b345-feff819cdc9f, 'checkout', '198.51.100.22', {'total':'379.00'});

INSERT INTO sessions_by_day (day, started_at, user_id, country, duration_s) VALUES
  ('2024-05-01', 50554d6e-29bb-11e5-b345-feff819cdc9f, 11111111-1111-4111-8111-111111111111, 'DE', 842);
INSERT INTO sessions_by_day (day, started_at, user_id, country, duration_s) VALUES
  ('2024-05-01', 60554d6e-29bb-11e5-b345-feff819cdc9f, 33333333-3333-4333-8333-333333333333, 'US', 311);
INSERT INTO sessions_by_day (day, started_at, user_id, country, duration_s) VALUES
  ('2024-05-02', 70554d6e-29bb-11e5-b345-feff819cdc9f, 22222222-2222-4222-8222-222222222222, 'NL', 1280);
