-- Postgres seed (auto-run on first init). e-commerce-shaped, multi-schema,
-- exercises FK hop, structure view, column insights, native booleans.
CREATE TABLE IF NOT EXISTS users (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  email      text UNIQUE,
  country    text,
  active     boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id    serial PRIMARY KEY,
  sku   text UNIQUE NOT NULL,
  name  text NOT NULL,
  price numeric(10,2) NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id       serial PRIMARY KEY,
  user_id  int NOT NULL REFERENCES users(id),
  total    numeric(10,2),
  status   text,
  method   text,
  paid     boolean
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE TABLE IF NOT EXISTS order_items (
  id         serial PRIMARY KEY,
  order_id   int NOT NULL REFERENCES orders(id),
  product_id int NOT NULL REFERENCES products(id),
  qty        int NOT NULL DEFAULT 1
);

INSERT INTO users (name, email, country, active) VALUES
  ('Ada Lovelace','ada@byteshop.io','GB',true),
  ('Alan Turing','alan@byteshop.io','GB',true),
  ('Grace Hopper','grace@byteshop.io','US',true),
  ('Edsger Dijkstra','edsger@byteshop.io','NL',false);
INSERT INTO products (sku, name, price) VALUES
  ('MUG-01','ByteTable Mug',12.50),
  ('TEE-01','Logo T-Shirt',24.00),
  ('STK-01','Sticker Pack',5.00);
INSERT INTO orders (user_id,total,status,method,paid) VALUES
  (1,42.50,'delivered','card',true),
  (1,19.99,'shipped','card',true),
  (2,99.00,'pending','paypal',false),
  (3,5.00,'cancelled','card',false),
  (3,36.50,'delivered','paypal',true);
INSERT INTO order_items (order_id,product_id,qty) VALUES
  (1,1,2),(1,3,1),(2,2,1),(3,2,3),(5,1,1),(5,3,2);

CREATE SCHEMA IF NOT EXISTS analytics;
CREATE TABLE IF NOT EXISTS analytics.events (
  id      serial PRIMARY KEY,
  kind    text NOT NULL,
  user_id int REFERENCES public.users(id),
  ts      timestamptz DEFAULT now()
);
INSERT INTO analytics.events (kind,user_id) VALUES ('login',1),('view',1),('purchase',2);

-- UUID (bytea) + JSONB demo. Exercises: UUID-aware binary cells, the JSON
-- viewer, and binary FK hop/filter (documents.account_id → accounts.id).
CREATE TABLE IF NOT EXISTS accounts (
  id         bytea PRIMARY KEY,
  handle     varchar(64) NOT NULL,
  prefs      jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS documents (
  id         bytea PRIMARY KEY,
  account_id bytea NOT NULL REFERENCES accounts(id),
  title      varchar(160) NOT NULL,
  body       jsonb,
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_account ON documents(account_id);

INSERT INTO accounts (id, handle, prefs) VALUES
  (decode(replace('11111111-1111-4111-8111-111111111111','-',''),'hex'), 'ada',
    '{"theme":"midnight","notifications":{"email":true,"push":false},"tags":["admin","early-access"]}'),
  (decode(replace('22222222-2222-4222-8222-222222222222','-',''),'hex'), 'grace',
    '{"theme":"light","notifications":{"email":false,"push":true},"tags":[]}');
INSERT INTO documents (id, account_id, title, body) VALUES
  (decode(replace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','-',''),'hex'),
   decode(replace('11111111-1111-4111-8111-111111111111','-',''),'hex'),
    'Q3 Roadmap', '{"status":"published","wordCount":1280,"reviewers":["grace","alan"],"meta":{"pinned":true}}'),
  (decode(replace('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','-',''),'hex'),
   decode(replace('11111111-1111-4111-8111-111111111111','-',''),'hex'),
    'Release Notes', '{"status":"draft","wordCount":340,"reviewers":[]}'),
  (decode(replace('cccccccc-cccc-4ccc-8ccc-cccccccccccc','-',''),'hex'),
   decode(replace('22222222-2222-4222-8222-222222222222','-',''),'hex'),
    'Design Spec', '{"status":"review","wordCount":2110,"reviewers":["ada"],"meta":{"pinned":false}}');

-- ── Schema objects (exercise the object browser: views / matviews / routines / triggers) ──
CREATE OR REPLACE VIEW active_users AS
  SELECT id, name, email, country FROM users WHERE active;

DROP MATERIALIZED VIEW IF EXISTS order_totals;
CREATE MATERIALIZED VIEW order_totals AS
  SELECT user_id, count(*) AS orders, coalesce(sum(total), 0) AS spent
  FROM orders GROUP BY user_id;

CREATE OR REPLACE FUNCTION user_order_count(uid integer)
  RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM orders WHERE user_id = uid;
$$;

CREATE OR REPLACE PROCEDURE deactivate_user(uid integer)
  LANGUAGE sql AS $$
  UPDATE users SET active = false WHERE id = uid;
$$;

CREATE OR REPLACE FUNCTION trg_orders_noop() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS orders_touch ON orders;
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_orders_noop();
