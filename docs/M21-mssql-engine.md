# Milestone 21 — Microsoft SQL Server engine (T-SQL dialect)

> Unlike Redis (M13), DynamoDB (M17), MongoDB (M18) and Cassandra (M19), SQL Server is **relational** — it does **not** get its own vertical slice or bespoke UI. It is a **fourth relational engine** that plugs into the *existing* SQL surfaces (`Workspace`, sidebar, data grid, filter builder, SQL editor, Structure, schema map, inline editing, export/import) built in **M4–M12**, differing only by **dialect**: T-SQL syntax, `sqlcmd` terminal, bracket-quoted identifiers, the SQL Server type system, `dbo` default schema, and indexed views in place of materialized views. Implement after **M12** (which completes the Postgres/MySQL/SQLite matrix) — this milestone extends that same matrix. Build the subtasks in order, one per session.

Conventions carry over from `MILESTONES.md`:
- Recreate visuals from the prototype — do not improvise colors/spacing/copy. Open `ByteTable.html`, connect the **byteshop_sql** (production) or **byteshop_sql_dev** workspace in the ByteShop project, and interact with each surface at 100% zoom before coding.
- Backend work lands in a new **`engine_mssql` adapter** behind the *existing relational ports* (`SchemaReader` / `QueryExecutor` / `SchemaWriter` — the same traits MySQL/Postgres/SQLite implement). No new port family: SQL Server is relational. All driver access (the `tiberius` Rust TDS driver, or ODBC) lives in the Rust core behind Tauri commands; the renderer never holds a session handle or credentials.
- Definition of done = acceptance criteria pass **and** the pixel checklist matches the prototype side-by-side **and** the adapter's dialect logic has unit tests (DDL generation, type mapping, terminal meta-commands).

---

## Design files to follow (SQL Server)

SQL Server reuses the relational design files; there is **no** `mssql-*.jsx`. Each file below already carries an `engine === 'mssql'` branch — recreate those branches, don't reinvent. Everything else (grid, filters, tabs, map) is engine-agnostic and already correct.

| File | SQL Server-specific content |
|---|---|
| `bytetable/ui.jsx` | Engine registry entry: `mssql: { label: 'MS SQL Server', short: 'MSS', color: '#d1495b' }` — drives the engine picker, rail tile, connect card, and sidebar badge (`MSS`, crimson accent). Recreate the badge exactly. |
| `bytetable/data.js` | Two seeded demo connections (`prod-mssql` = `byteshop_sql`, production, `sql.byteshop.io:1433`, SSH tunnel; `dev-mssql` = `byteshop_sql_dev`, dev, `localhost:1433`) under the **ByteShop** project. Both: `engine: 'mssql'`, `version: 'SQL Server 2022 (16.0)'`, `schemas: ['dbo','sales','audit']`, `defaultSchema: 'dbo'`. Confirms the data-model contract; real introspection replaces the mock. |
| `bytetable/connect.jsx` | Connect-modal branch: default port **1433** (`defaultPorts.mssql`), host/instance, database, username/password (SQL auth) — plus the shared optional SSH-tunnel + TLS controls. Same relational form as Postgres/MySQL, only the default port differs. |
| `bytetable/dbobjects.jsx` | `ENGINE_OBJECTS.mssql = ['table', 'view', 'matview', 'function', 'procedure', 'trigger']` — SQL Server exposes the **full** object set (same list Postgres does). `matview` label is reused for **indexed views**. |
| `bytetable/sidebar.jsx` | T-SQL **create templates** per object class (`newTemplate`, `mssql` branch): indexed view = `CREATE VIEW … WITH SCHEMABINDING …` + `CREATE UNIQUE CLUSTERED INDEX …`; function = `CREATE OR ALTER FUNCTION dbo.…`; procedure = `CREATE OR ALTER PROCEDURE dbo.…`; trigger = `CREATE OR ALTER TRIGGER … ON … AFTER INSERT …`. Recreate the exact SQL. |
| `bytetable/structure.jsx` | (1) `generateDDL(table, meta, 'mssql')` → **T-SQL DDL**: bracket-quoted identifiers (`[name]`), T-SQL column/constraint syntax. (2) `ST_MSSQL_TYPES` — the full SQL Server type list surfaced in the Structure **type dropdown** (`stTypesFor('mssql')`): `INT/BIGINT/SMALLINT/TINYINT/BIT`, `DECIMAL(18,2)/NUMERIC(18,2)/MONEY/SMALLMONEY/FLOAT/REAL`, the `CHAR/VARCHAR/VARCHAR(MAX)/NCHAR/NVARCHAR/NVARCHAR(MAX)/TEXT/NTEXT` string family, `DATE/TIME/DATETIME/DATETIME2/SMALLDATETIME/DATETIMEOFFSET`, `BINARY/VARBINARY(MAX)/IMAGE`, `UNIQUEIDENTIFIER/XML/SQL_VARIANT/GEOGRAPHY/GEOMETRY/HIERARCHYID/ROWVERSION`. (3) The **custom scrollable type menu** (`StTypeCell` → `.st-type-menu`): a capped-height (260px), scrollable popup anchored under the cell with the current type checkmarked — **not** a native `<select>` (whose OS popup renders full-screen with 36 options). Recreate this custom menu. |
| `bytetable/terminal.jsx` | The **`sqlcmd`** terminal branch: `termConfig('mssql')` → `shell: 'sqlcmd'`, `metaChar: ':'`, prompts `1> ` / `2> `, banner "sqlcmd · type :help for usage. Batch ends with GO.", `errPrefix: 'Msg 102, Level 15, State 1: '`. `helpText()` mssql branch (sqlcmd usage). Snippet chips: `['SELECT name FROM sys.tables;', 'sp_help users', "SELECT * FROM users WHERE country = 'DE';"]`. `runMeta` understands the T-SQL forms: `SELECT … FROM sys.tables` → list tables, `SELECT … FROM sys.schemas` → list schemas, `sp_help <name>` / `EXEC sp_help <name>` → describe. |
| `bytetable/workspace.jsx` | Terminal **tab title + shell name**: `conn.engine === 'mssql'` → `'sqlcmd'` (e.g. tab reads `sqlcmd 1`); command-palette entry "Open sqlcmd terminal". |
| `ByteTable.html` | The `.st-type-*` CSS (`.st-type-wrap`, `.st-type-menu`, `.st-type-opt`, `.on .msym`) for the custom type menu; script-tag load order already includes the shared relational files. No mssql-only CSS beyond the type menu. |

Shared chrome (workspace rail, tab system, data grid, filter builder, SQL editor, Structure shell, schema map, inline editing, export/import, toast, `MIcon`, modal scrim, `.filter-*`/`.seg`/`.save-bar`/`.pager`/`.structure-*`/`.acc-*`, shared `.rcli-*` terminal) is **reused unchanged** from M4–M12 — do not restyle or fork it. SQL Server only supplies dialect.

---

## 22.0 — Engine registration + connection
**Goal:** a SQL Server workspace can be created and connects, routed through the *relational* workspace host (not a bespoke one).

Scope:
- Register `mssql` in the engine registry (`ui.jsx`): label **"MS SQL Server"**, short badge **`MSS`**, crimson accent `#d1495b`. Rail tile, connect card, engine picker, and sidebar badge render like the other relational engines.
- Route `mssql` to the **relational `Workspace`** in the workspace host (same component as postgres/mysql/sqlite) — **not** a new vertical slice. Only DynamoDB/MongoDB/Cassandra/Redis get bespoke hosts.
- Connect-modal branch (`connect.jsx`): default port **1433**; host/instance, database, SQL-auth username/password; shared optional SSH tunnel + TLS. No horizontal scroll at any width.
- Backend: new **`engine_mssql`** adapter implementing the existing `SchemaReader`/`QueryExecutor`/`SchemaWriter` ports via the `tiberius` TDS driver (or ODBC). `connect`/`test_connection` commands build a session from host+port+database+auth and run `SELECT @@VERSION` (or `SELECT SERVERPROPERTY('ProductVersion')`) as the check. Credentials parsed locally, never surfaced to the renderer.

Pixel checklist: engine picker `MSS` badge + crimson accent; connect-modal SQL Server form matches `connect.jsx` (port 1433, host/database/auth, optional tunnel/TLS, no horizontal scroll); rail tile identical to other relational engines.
Acceptance: create a SQL Server workspace against a real/Docker `mssql` (2019/2022); test-connection round-trips `@@VERSION`; the workspace opens in the **relational** host with the sidebar populated; adjacent Postgres/MySQL/SQLite workspaces are unaffected.

## 22.1 — Introspection: sidebar objects + T-SQL DDL
**Goal:** the sidebar object browser and Structure DDL, backed by real SQL Server catalog introspection.

Scope:
- **Object set** (`dbobjects.jsx`): SQL Server exposes `['table','view','matview','function','procedure','trigger']` — the full list, with **indexed views** reusing the `matview` section/label. The sidebar groups objects by class exactly as for Postgres.
- **Introspection** in `engine_mssql`: tables/columns from `sys.tables`/`sys.columns`/`sys.types`; primary/unique/foreign keys from `sys.key_constraints`/`sys.foreign_keys`; indexes from `sys.indexes`; views/indexed views from `sys.views` (+ `sys.indexes` for the clustered index that makes it "materialized"); functions/procedures/triggers from `sys.objects`/`sys.sql_modules`. Default schema **`dbo`**; schema switcher lists all schemas (`dbo`, `sales`, `audit`, …).
- **T-SQL DDL** (`generateDDL(..., 'mssql')`): bracket-quoted identifiers (`[table]`, `[column]`), T-SQL column/constraint/`IDENTITY` syntax; `describe`/DDL modal shows real `sp_help`/`OBJECT_DEFINITION`-derived output.
- **Create templates** (`sidebar.jsx`, `mssql` branch): recreate the exact T-SQL for indexed view (`WITH SCHEMABINDING` + `CREATE UNIQUE CLUSTERED INDEX`), `CREATE OR ALTER FUNCTION/PROCEDURE/TRIGGER dbo.…`.

Pixel checklist: sidebar object sections (Views / Materialized Views / Functions / Procedures / Triggers with counts) render for a SQL Server workspace exactly as for Postgres; DDL uses bracket-quoting; create templates match the prototype strings.
Acceptance: open a SQL Server workspace → sidebar lists tables + all object classes with correct counts from `sys.*`; the Structure DDL renders valid bracket-quoted T-SQL; "new" object templates prefill correct T-SQL; refresh picks up an out-of-band new view.

## 22.2 — Structure type system (SQL Server types + scrollable menu)
**Goal:** the Structure type dropdown offers the full SQL Server type set through the custom scrollable menu.

Scope:
- **Type list** (`ST_MSSQL_TYPES` via `stTypesFor('mssql')`): the complete SQL Server type family — numerics (`INT/BIGINT/SMALLINT/TINYINT/BIT/DECIMAL/NUMERIC/MONEY/SMALLMONEY/FLOAT/REAL`), strings (`CHAR/VARCHAR/VARCHAR(MAX)/NCHAR/NVARCHAR/NVARCHAR(MAX)/TEXT/NTEXT`), date/time (`DATE/TIME/DATETIME/DATETIME2/SMALLDATETIME/DATETIMEOFFSET`), binary (`BINARY/VARBINARY(MAX)/IMAGE`), and specials (`UNIQUEIDENTIFIER/XML/SQL_VARIANT/GEOGRAPHY/GEOMETRY/HIERARCHYID/ROWVERSION`).
- **Custom scrollable type menu** (`StTypeCell` → `.st-type-menu`): because the list is ~36 entries, the type cell must **not** use a native `<select>` (its OS popup renders full-screen). Recreate the custom popup: double-click the type cell → an absolutely-positioned menu anchored under the cell, **capped at 260px height with `overflow-y:auto`**, ~170px wide, each option mono-styled with the current type checkmarked (`.on .msym` accent tick); click-outside closes; picking commits the type into the staged-ALTER flow. All other engines keep the same menu (their shorter lists just don't scroll).
- Backend type mapping in `engine_mssql`: map introspected `sys.types` → these display types and back to valid T-SQL for the staged `ALTER TABLE … ALTER COLUMN` in M8's editing flow.

Pixel checklist: the type menu opens compact (≤260px tall) and scrolls through all 36 types, current type ticked, anchored under the cell — never the full-screen native popup.
Acceptance: on a SQL Server table, double-click a column type → the scrollable menu lists all SQL Server types and scrolls; selecting one stages an `ALTER COLUMN` that applies as valid T-SQL; Postgres/MySQL type menus still show their own (shorter) lists.

## 22.3 — sqlcmd terminal
**Goal:** the terminal opens as `sqlcmd` for SQL Server, with T-SQL meta-commands and snippets — not psql.

Scope:
- **`sqlcmd` config** (`terminal.jsx`, `termConfig('mssql')`): shell `sqlcmd`, meta char `:`, prompts `1> ` / `2> `, banner "sqlcmd · type :help for usage. Batch ends with GO.", `errPrefix` "Msg 102, Level 15, State 1: ". `helpText()` mssql branch shows sqlcmd usage (`GO`, `sp_help`, `sys.tables`, `USE`).
- **Terminal tab title + palette** (`workspace.jsx`): SQL Server terminals title as `sqlcmd N` (e.g. `sqlcmd 1`); command-palette entry reads "Open sqlcmd terminal".
- **T-SQL meta handling** (`runMeta`): `SELECT … FROM sys.tables` → list tables; `SELECT … FROM sys.schemas` → list schemas; `sp_help <name>` / `EXEC sp_help <name>` (bracket/quote/`dbo.`-tolerant) → describe table; `USE <schema>` switches schema. **Snippet chips**: `SELECT name FROM sys.tables;`, `sp_help users`, `SELECT * FROM users WHERE country = 'DE';` — each must actually execute.
- Backend: route terminal statements through the same guarded relational execution path; `GO` ends a batch. sqlcmd stays a thin dialect skin over the shared `.rcli-*` chrome — do **not** fork terminal styling.

Pixel checklist: banner, `1>`/`2>` prompts, help text, snippet chips, tab title (`sqlcmd 1`) all read SQL Server / sqlcmd — no psql `\dt`/`\d` leakage.
Acceptance: opening a terminal on a SQL Server workspace shows the sqlcmd banner + `1>` prompt (not psql); the three snippet chips run (`sys.tables` lists tables, `sp_help users` describes, the WHERE query returns rows); `USE sales` switches schema; a bad statement shows the `Msg 102 …` error prefix.

## 22.4 — Full relational parity regression
**Goal:** confirm SQL Server behaves identically to the other relational engines across every M4–M12 surface.

Scope:
- Run the **full relational regression** with a SQL Server workspace: data grid (virtualized browse, density, selection), stackable filter builder (compiled to T-SQL `WHERE`, `TOP`/`OFFSET…FETCH` paging), SQL editor (run SELECTs, save/load queries cross-workspace, history, error card), Structure read + **staged ALTER** editing (add/rename/retype column → `ALTER TABLE` T-SQL → apply/discard), schema map (FKs from `sys.foreign_keys`), FK-hop + column insights, inline cell editing (⌘I insert, ⌘S save, production-env confirm), export/import (structure/data/both; T-SQL script uses bracket-quoting + `INSERT`).
- Fix any engine-agnostic surface that assumed psql/MySQL/SQLite specifics (paging keyword, identifier quoting, boolean/`BIT` rendering, `IDENTITY` vs `SERIAL`, `GETDATE()` vs `now()` defaults).
- Backend: ensure the `engine_mssql` adapter satisfies every port method the shared UI calls, with T-SQL generation unit-tested (DDL, ALTER, paging, quoting, type round-trip).

Pixel checklist: every M4–M12 surface looks identical with a SQL Server workspace open; the only visible differences are the `MSS` badge, `sqlcmd` terminal, bracket-quoted DDL, and the SQL Server type list.
Acceptance: the complete M4–M12 acceptance list passes against a real SQL Server instance; production-env destructive-op confirms fire; SSH-tunnel + TLS connect works; Postgres/MySQL/SQLite regressions still pass (no dialect leakage between engines).

---

## Notes / dialect
- SQL Server is **relational** — reuse the M4–M12 UI and the existing `SchemaReader`/`QueryExecutor`/`SchemaWriter` ports; the only new code is the `engine_mssql` adapter + the dialect branches already present in the design files. Do **not** create a `mssql_browse` slice or an `mssql-*.jsx`.
- **Dialect specifics** to honor everywhere T-SQL is generated: bracket-quoted identifiers (`[name]`); paging via `OFFSET … ROWS FETCH NEXT … ROWS ONLY` (or `TOP`) — not `LIMIT/OFFSET`; `IDENTITY` not `SERIAL`/`AUTO_INCREMENT`; `GETDATE()`/`SYSUTCDATETIME()` defaults; `BIT` for booleans; `CREATE OR ALTER` for routines; `GO` batch separator in the terminal.
- **Indexed views** stand in for materialized views: the `matview` object section lists schemabound views that carry a unique clustered index; the create template emits `CREATE VIEW … WITH SCHEMABINDING` + `CREATE UNIQUE CLUSTERED INDEX`.
- **Default schema is `dbo`**; SQL Server has a database→schema→object hierarchy — the schema switcher lists schemas within the connected database, matching the Postgres model.
- The **type dropdown must stay a custom scrollable menu** for SQL Server (36 types) — a native `<select>` renders a full-screen OS popup. Keep the capped-height/scroll popup; shorter-list engines share the same component.
- Destructive ops (drop object, delete row, apply ALTER) confirm when the connection env is `production`, matching the Postgres/MySQL/SQLite/Redis/Dynamo/Mongo/Cassandra pattern.
- Reuse the **shared terminal chrome** (`.rcli-*`) — sqlcmd is a dialect skin (prompts/banner/meta), not a new terminal. The only SQL Server-specific CSS is the `.st-type-*` custom type menu already in `ByteTable.html`.
