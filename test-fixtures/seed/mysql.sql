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
