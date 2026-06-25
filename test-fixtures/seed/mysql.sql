-- MySQL seed (auto-run on first init). Same e-commerce shape as Postgres.
CREATE TABLE IF NOT EXISTS users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  email      VARCHAR(190) UNIQUE,
  country    VARCHAR(2),
  active     TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  sku   VARCHAR(32) UNIQUE NOT NULL,
  name  VARCHAR(120) NOT NULL,
  price DECIMAL(10,2) NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  total   DECIMAL(10,2),
  status  VARCHAR(20),
  method  VARCHAR(20),
  paid    TINYINT(1),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE TABLE IF NOT EXISTS order_items (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  order_id   INT NOT NULL,
  product_id INT NOT NULL,
  qty        INT NOT NULL DEFAULT 1,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

INSERT INTO users (name,email,country,active) VALUES
  ('Ada Lovelace','ada@byteshop.io','GB',1),
  ('Alan Turing','alan@byteshop.io','GB',1),
  ('Grace Hopper','grace@byteshop.io','US',1),
  ('Edsger Dijkstra','edsger@byteshop.io','NL',0);
INSERT INTO products (sku,name,price) VALUES
  ('MUG-01','ByteTable Mug',12.50),
  ('TEE-01','Logo T-Shirt',24.00),
  ('STK-01','Sticker Pack',5.00);
INSERT INTO orders (user_id,total,status,method,paid) VALUES
  (1,42.50,'delivered','card',1),
  (1,19.99,'shipped','card',1),
  (2,99.00,'pending','paypal',0),
  (3,5.00,'cancelled','card',0),
  (3,36.50,'delivered','paypal',1);
INSERT INTO order_items (order_id,product_id,qty) VALUES
  (1,1,2),(1,3,1),(2,2,1),(3,2,3),(5,1,1),(5,3,2);

-- UUID (BINARY(16)) + JSON demo. Exercises: UUID-aware binary cells, the JSON
-- viewer, and binary FK hop/filter (documents.account_id → accounts.id).
CREATE TABLE IF NOT EXISTS accounts (
  id         BINARY(16) PRIMARY KEY,
  handle     VARCHAR(64) NOT NULL,
  prefs      JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS documents (
  id         BINARY(16) PRIMARY KEY,
  account_id BINARY(16) NOT NULL,
  title      VARCHAR(160) NOT NULL,
  body       JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
CREATE INDEX idx_documents_account ON documents(account_id);

INSERT INTO accounts (id, handle, prefs) VALUES
  (UUID_TO_BIN('11111111-1111-4111-8111-111111111111'), 'ada',
    '{"theme":"midnight","notifications":{"email":true,"push":false},"tags":["admin","early-access"]}'),
  (UUID_TO_BIN('22222222-2222-4222-8222-222222222222'), 'grace',
    '{"theme":"light","notifications":{"email":false,"push":true},"tags":[]}');
INSERT INTO documents (id, account_id, title, body) VALUES
  (UUID_TO_BIN('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), UUID_TO_BIN('11111111-1111-4111-8111-111111111111'),
    'Q3 Roadmap', '{"status":"published","wordCount":1280,"reviewers":["grace","alan"],"meta":{"pinned":true}}'),
  (UUID_TO_BIN('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), UUID_TO_BIN('11111111-1111-4111-8111-111111111111'),
    'Release Notes', '{"status":"draft","wordCount":340,"reviewers":[]}'),
  (UUID_TO_BIN('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), UUID_TO_BIN('22222222-2222-4222-8222-222222222222'),
    'Design Spec', '{"status":"review","wordCount":2110,"reviewers":["ada"],"meta":{"pinned":false}}');

-- ── Schema objects (views / routines / triggers — MySQL has no matviews) ──
CREATE OR REPLACE VIEW active_users AS
  SELECT id, name, email, country FROM users WHERE active = 1;

DROP FUNCTION IF EXISTS user_order_count;
CREATE FUNCTION user_order_count(uid INT) RETURNS BIGINT DETERMINISTIC
  RETURN (SELECT count(*) FROM orders WHERE user_id = uid);

DROP PROCEDURE IF EXISTS deactivate_user;
CREATE PROCEDURE deactivate_user(IN uid INT)
  UPDATE users SET active = 0 WHERE id = uid;

DROP TRIGGER IF EXISTS orders_touch;
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW SET NEW.status = NEW.status;
