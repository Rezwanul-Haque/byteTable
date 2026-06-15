-- Builds test-fixtures/byteshop.db. Regenerate with:
--   rm -f test-fixtures/byteshop.db && sqlite3 test-fixtures/byteshop.db < test-fixtures/seed/sqlite.sql
CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE,
  country    TEXT,
  active     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE products (
  id    INTEGER PRIMARY KEY,
  sku   TEXT UNIQUE NOT NULL,
  name  TEXT NOT NULL,
  price REAL NOT NULL
);
CREATE TABLE orders (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total   REAL,
  status  TEXT,
  method  TEXT,
  paid    INTEGER
);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE TABLE order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty        INTEGER NOT NULL DEFAULT 1
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

-- UUID (BLOB(16)) + JSON demo. Columns are declared BLOB / JSON so ByteTable's
-- type hints drive the UUID-aware binary cell + JSON viewer; exercises binary
-- FK hop/filter (documents.account_id -> accounts.id).
CREATE TABLE accounts (
  id         BLOB PRIMARY KEY,
  handle     TEXT NOT NULL,
  prefs      JSON,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE documents (
  id         BLOB PRIMARY KEY,
  account_id BLOB NOT NULL REFERENCES accounts(id),
  title      TEXT NOT NULL,
  body       JSON,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_documents_account ON documents(account_id);

INSERT INTO accounts (id, handle, prefs) VALUES
  (x'11111111111141118111111111111111', 'ada', '{"theme":"midnight","notifications":{"email":true,"push":false},"tags":["admin","early-access"]}'),
  (x'22222222222242228222222222222222', 'grace', '{"theme":"light","notifications":{"email":false,"push":true},"tags":[]}');
INSERT INTO documents (id, account_id, title, body) VALUES
  (x'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa', x'11111111111141118111111111111111', 'Q3 Roadmap', '{"status":"published","wordCount":1280,"reviewers":["grace","alan"],"meta":{"pinned":true}}'),
  (x'bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb', x'11111111111141118111111111111111', 'Release Notes', '{"status":"draft","wordCount":340,"reviewers":[]}'),
  (x'cccccccccccc4ccc8ccccccccccccccc', x'22222222222242228222222222222222', 'Design Spec', '{"status":"review","wordCount":2110,"reviewers":["ada"],"meta":{"pinned":false}}');
