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
