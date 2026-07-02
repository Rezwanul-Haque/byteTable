-- SQL Server (T-SQL) seed — run MANUALLY via ./seed/seed-mssql.sh (the SQL
-- Server images have no /docker-entrypoint-initdb.d auto-init dir, unlike
-- Postgres/MySQL). e-commerce-shaped, multi-schema (dbo / sales / audit —
-- matching the connect defaults), exercising the FK hop, structure view + staged
-- ALTER, column insights, BIT booleans, IDENTITY, DECIMAL/MONEY, UNIQUEIDENTIFIER
-- + VARBINARY, and the full object browser (view / indexed view = "matview" /
-- function / procedure / trigger). Idempotent: drops + recreates everything, so
-- re-running re-seeds cleanly. Batches are separated by GO (sqlcmd).

IF DB_ID('byteshop') IS NULL CREATE DATABASE byteshop;
GO
USE byteshop;
GO
-- Indexed views (and the tables they schemabind) require these SET options ON
-- at CREATE time; the mssql-tools sqlcmd session defaults them OFF. Setting them
-- here applies to every subsequent batch in this sqlcmd run.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO
IF SCHEMA_ID('sales') IS NULL EXEC('CREATE SCHEMA sales');
GO
IF SCHEMA_ID('audit') IS NULL EXEC('CREATE SCHEMA audit');
GO

-- ── Drop in dependency order (children/objects first) so re-seed is clean. ──
DROP VIEW IF EXISTS dbo.order_totals;   -- indexed view ("matview")
DROP VIEW IF EXISTS dbo.active_users;
DROP FUNCTION IF EXISTS dbo.user_order_count;
DROP PROCEDURE IF EXISTS dbo.deactivate_user;
DROP TABLE IF EXISTS audit.events;
DROP TABLE IF EXISTS sales.invoices;
DROP TABLE IF EXISTS dbo.order_items;
DROP TABLE IF EXISTS dbo.orders;
DROP TABLE IF EXISTS dbo.products;
DROP TABLE IF EXISTS dbo.documents;
DROP TABLE IF EXISTS dbo.accounts;
DROP TABLE IF EXISTS dbo.users;
GO

-- ── Core tables (dbo) — IDENTITY pks, BIT booleans, DECIMAL money. ──
CREATE TABLE dbo.users (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  name       NVARCHAR(120) NOT NULL,
  email      NVARCHAR(160) UNIQUE,
  country    NVARCHAR(2),
  active     BIT NOT NULL DEFAULT 1,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.products (
  id    INT IDENTITY(1,1) PRIMARY KEY,
  sku   NVARCHAR(32) NOT NULL UNIQUE,
  name  NVARCHAR(120) NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0
);
CREATE TABLE dbo.orders (
  id      INT IDENTITY(1,1) PRIMARY KEY,
  user_id INT NOT NULL CONSTRAINT FK_orders_users REFERENCES dbo.users(id),
  total   DECIMAL(10,2),
  status  NVARCHAR(20),
  method  NVARCHAR(20),
  paid    BIT
);
CREATE INDEX idx_orders_user ON dbo.orders(user_id);
CREATE TABLE dbo.order_items (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  order_id   INT NOT NULL CONSTRAINT FK_items_orders REFERENCES dbo.orders(id),
  product_id INT NOT NULL CONSTRAINT FK_items_products REFERENCES dbo.products(id),
  qty        INT NOT NULL DEFAULT 1
);
GO

-- ── sales / audit schemas (multi-schema switcher + cross-schema FK hop). ──
CREATE TABLE sales.invoices (
  id       INT IDENTITY(1,1) PRIMARY KEY,
  order_id INT NOT NULL CONSTRAINT FK_invoices_orders REFERENCES dbo.orders(id),
  amount   MONEY NOT NULL,
  issued   DATE NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE)
);
CREATE TABLE audit.events (
  id      BIGINT IDENTITY(1,1) PRIMARY KEY,
  kind    NVARCHAR(40) NOT NULL,
  user_id INT NULL CONSTRAINT FK_events_users REFERENCES dbo.users(id),
  ts      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ── UNIQUEIDENTIFIER + VARBINARY demo (binary cells, JSON viewer, binary FK). ──
CREATE TABLE dbo.accounts (
  id         UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  handle     NVARCHAR(64) NOT NULL,
  prefs      NVARCHAR(MAX),
  avatar     VARBINARY(16),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.documents (
  id         UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  account_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_docs_accounts REFERENCES dbo.accounts(id),
  title      NVARCHAR(160) NOT NULL,
  body       NVARCHAR(MAX),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX idx_documents_account ON dbo.documents(account_id);
GO

-- ── Seed rows (IDENTITY assigns 1-based ids on a fresh DB, so FKs are stable). ──
INSERT INTO dbo.users (name, email, country, active) VALUES
  (N'Ada Lovelace',   N'ada@byteshop.io',   N'GB', 1),
  (N'Alan Turing',    N'alan@byteshop.io',  N'GB', 1),
  (N'Grace Hopper',   N'grace@byteshop.io', N'US', 1),
  (N'Edsger Dijkstra',N'edsger@byteshop.io',N'NL', 0);
INSERT INTO dbo.products (sku, name, price) VALUES
  (N'MUG-01', N'ByteTable Mug', 12.50),
  (N'TEE-01', N'Logo T-Shirt',  24.00),
  (N'STK-01', N'Sticker Pack',   5.00);
INSERT INTO dbo.orders (user_id, total, status, method, paid) VALUES
  (1, 42.50, N'delivered', N'card',   1),
  (1, 19.99, N'shipped',   N'card',   1),
  (2, 99.00, N'pending',   N'paypal', 0),
  (3,  5.00, N'cancelled', N'card',   0),
  (3, 36.50, N'delivered', N'paypal', 1);
INSERT INTO dbo.order_items (order_id, product_id, qty) VALUES
  (1,1,2),(1,3,1),(2,2,1),(3,2,3),(5,1,1),(5,3,2);
INSERT INTO sales.invoices (order_id, amount) VALUES
  (1, 42.50),(2, 19.99),(5, 36.50);
INSERT INTO audit.events (kind, user_id) VALUES
  (N'login', 1),(N'view', 1),(N'purchase', 2);
GO

-- Deterministic GUIDs so the FK hop / binary filter demos are reproducible.
INSERT INTO dbo.accounts (id, handle, prefs, avatar) VALUES
  ('11111111-1111-4111-8111-111111111111', N'ada',
   N'{"theme":"midnight","notifications":{"email":true,"push":false},"tags":["admin","early-access"]}',
   0xDEADBEEF),
  ('22222222-2222-4222-8222-222222222222', N'grace',
   N'{"theme":"light","notifications":{"email":false,"push":true},"tags":[]}',
   0xCAFEBABE);
INSERT INTO dbo.documents (id, account_id, title, body) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',
   N'Q3 Roadmap',    N'{"status":"published","wordCount":1280,"reviewers":["grace","alan"]}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111',
   N'Release Notes', N'{"status":"draft","wordCount":340,"reviewers":[]}'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','22222222-2222-4222-8222-222222222222',
   N'Design Spec',   N'{"status":"review","wordCount":2110,"reviewers":["ada"]}');
GO

-- ── Schema objects (object browser: view / indexed view / function / proc / trigger). ──
CREATE VIEW dbo.active_users AS
  SELECT id, name, email, country FROM dbo.users WHERE active = 1;
GO

-- Indexed view (surfaced under the "Materialized Views" section): a schemabound
-- view carrying a unique clustered index. COUNT_BIG(*) is required.
CREATE VIEW dbo.order_totals
WITH SCHEMABINDING AS
  SELECT user_id, COUNT_BIG(*) AS orders
  FROM dbo.orders
  GROUP BY user_id;
GO
CREATE UNIQUE CLUSTERED INDEX IX_order_totals_user ON dbo.order_totals(user_id);
GO

CREATE FUNCTION dbo.user_order_count(@uid INT)
RETURNS INT
AS
BEGIN
  RETURN (SELECT COUNT(*) FROM dbo.orders WHERE user_id = @uid);
END;
GO

CREATE PROCEDURE dbo.deactivate_user @uid INT
AS
BEGIN
  UPDATE dbo.users SET active = 0 WHERE id = @uid;
END;
GO

CREATE TRIGGER dbo.orders_touch
ON dbo.orders
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;  -- no-op audit hook
END;
GO
