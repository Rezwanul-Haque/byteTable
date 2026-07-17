# Milestone 23 — Oracle Database engine (PL/SQL dialect)

> Like SQL Server (M21), Oracle is **relational** — it does **not** get its own vertical slice or bespoke UI. It is a **fifth relational engine** that plugs into the *existing* SQL surfaces (`Workspace`, sidebar, data grid, filter builder, SQL editor, Structure, schema map, inline editing, export/import) built in **M4–M12**, differing only by **dialect**: Oracle SQL / PL/SQL syntax, `sqlplus` terminal, the Oracle type system, `GENERATED … AS IDENTITY`, `OFFSET … ROWS FETCH NEXT … ROWS ONLY` paging, the `ALL_*` catalog, user-schemas (uppercase), and real materialized views. Build after **M21** — this milestone extends the same relational matrix. Build the subtasks in order, one per session.

Conventions carry over from `MILESTONES.md`:
- Recreate visuals from the prototype — do not improvise colors/spacing/copy. Open `ByteTable.html`, connect the **byteshop_ora** (production) or **byteshop_ora_dev** (dev) workspace in the ByteShop project, and interact with each surface at 100% zoom before coding.
- Backend work lands in a new **`engines::oracle` adapter** behind the *existing relational ports* (`Connector` / `EngineConnection` over `shared::ports::sql` — the same traits `sqlite`/`mysql`/`postgres`/`mssql` implement). No new port family: Oracle is relational. All driver access lives in the Rust core behind Tauri commands; the renderer never holds a session handle or credentials.
- Definition of done = acceptance criteria pass **and** the pixel checklist matches the prototype side-by-side **and** the adapter's dialect logic has unit tests (DDL generation, type mapping, terminal meta-commands).

## Runtime / driver note (ByteTable-specific — not in the prototype)

The prototype is a mocked React app; ByteTable is a **Rust + Tauri** desktop app. Two adaptations the design files don't mention:

1. **Frontend is TypeScript** (`src/**/*.tsx`), not the prototype's `.jsx`. The single-file prototype (`ui.jsx`, `connect.jsx`, `structure.jsx`, …) maps onto the feature-sliced `src/` tree — each prototype `engine === 'oracle'` branch is recreated in the corresponding real file (mapping table below). Values, copy and colors are copied **verbatim** from the prototype.
2. **Oracle has no pure-Rust driver.** Every existing adapter (`sqlx`, `tiberius`, `redis`, `mongodb`, `scylla`) is pure-Rust + `rustls` — no OpenSSL/system dependency, cross-compiles clean. The two Oracle options both break exactly one half of that ethos:
   - `oracle` crate (OCI) — mature and stable, but dlopen's the **Oracle Instant Client** native libs at runtime.
   - `oracledb` crate (thin, pure-protocol) — no Instant Client, but pulls **nightly Rust** (`asupersync`/`try_trait_v2`) + `pyo3` (a Python build dep) + Apache Arrow, and is brand-new/experimental.

   **Decision:** the adapter uses the mature `oracle` (OCI) crate **behind a Cargo feature `engine-oracle`**. The default build (CI + release) stays pure-Rust and stable and does **not** compile the Oracle driver or require Instant Client; an opt-in build (`cargo build --features engine-oracle`, dev or a dedicated Oracle release variant) compiles the adapter and registers the connector. Everything driver-independent — the `Engine::Oracle` seam, all frontend branches, the dialect/DDL logic, unit tests — is compiled unconditionally so the engine is fully present in the type system and UI regardless of the feature. See §23.0 for the wiring.

   Instant Client (Basic / Basic-Light package): macOS arm64 → unzip + `DYLD_LIBRARY_PATH`; Linux → unzip + `LD_LIBRARY_PATH` (or Oracle yum repo + `ldconfig`); Windows → unzip + `PATH` (+ VC++ redist). ODPI-C (which the `oracle` crate wraps) loads it at **runtime**, so only running an Oracle connection needs the libs — building the feature needs just a C compiler (already required by `rusqlite bundled`).

---

## Design files to follow (Oracle)

Oracle reuses the relational design files; there is **no** `oracle-*.jsx`. Each prototype file below carries an `engine === 'oracle'` branch; the "Real file" column is where that branch is recreated in the Tauri app.

| Prototype file | Real file(s) | Oracle-specific content |
|---|---|---|
| `bytetable/ui.jsx` | `src/shared/ui/EngineBadge.tsx` (`ENGINE_META`) | Engine registry entry: `oracle: { label: 'Oracle', short: 'Or', color: '#c74634' }` — drives the engine picker, rail tile, connect card, and sidebar badge (`Or`, brick-red). |
| `bytetable/data.js` | (real connections are user-created + stored in the JSON registry; no seed) | Demo connections are a prototype-only mock. Real introspection replaces them. The `BYTESHOP` / `SALES` / `AUDIT` uppercase user-schemas come from live `ALL_USERS`. `test-fixtures/seed/oracle.sql` seeds the Docker Oracle (`gvenzl/oracle-free:23-slim`, native arm64) for the live/regression run. |
| `bytetable/connect.jsx` | `src/features/connections/components/NewConnectionModal.tsx`, `src/features/workspaces/components/ConnectScreen.tsx` | Connect-modal branch (`isOracle`): default port **1521** (`defaultPorts.oracle`), **Service name** field (placeholder `ORCLPDB1`, replaces the "Database" label), user placeholder `byteshop`, the Oracle form-note (service name vs. users), plus the shared optional SSH-tunnel + TLS controls. No horizontal scroll at any width. Footnote lists Oracle. |
| `bytetable/dbobjects.jsx` | `src/shared/api/engine.ts` (`OBJECT_CAPS`), `src/features/db_objects/kinds.ts` | `oracle: ['view','materialized_view','function','procedure','trigger']` — the full object set (same list Postgres/SQL Server expose). |
| `bytetable/sidebar.jsx` | `src/features/db_objects/kinds.ts` (create templates) | PL/SQL **create templates** per object class (`oracle` branch): `CREATE OR REPLACE VIEW`; MV = `CREATE MATERIALIZED VIEW … BUILD IMMEDIATE REFRESH COMPLETE ON DEMAND`; `CREATE OR REPLACE FUNCTION … RETURN NUMBER IS BEGIN … END;`; `CREATE OR REPLACE PROCEDURE … AS BEGIN NULL; END;`; `CREATE OR REPLACE TRIGGER … BEFORE INSERT … FOR EACH ROW BEGIN NULL; END;`. |
| `bytetable/structure.jsx` | `src/features/structure/ops.ts`, `src/features/browse/components/StructureView.tsx`, `src/features/export/components/CreateTableModal.tsx` | (1) `toOracleType` — generic/Postgres → Oracle type map. (2) `toOracleDefault` — `now()/CURRENT_TIMESTAMP→SYSTIMESTAMP`, `true/false→1/0`, `gen_random_uuid()→SYS_GUID()`. (3) `generateDDL(..., 'oracle')` — identity via `GENERATED BY DEFAULT AS IDENTITY`, **DEFAULT precedes NOT NULL**, identity columns take no DEFAULT, FK `ON DELETE` limited to CASCADE / SET NULL (else omit). (4) `ST_ORACLE_TYPES` — the Oracle type dropdown; `stTypesFor('oracle')`. |
| `bytetable/terminal.jsx` | `src/features/console/state.ts` (`termConfig`), `src/features/console/SqlTerminalTab.tsx` | The **`sqlplus`** terminal branch: `termConfig('oracle')` → `shell: 'sqlplus'`, `metaChar: null`, prompt `SQL> ` / cont `  2  `, banner "SQL*Plus · … PL/SQL blocks end with /", `errPrefix: 'ORA-00942: '`. Oracle **help lines** (`DESC name`, `SELECT table_name FROM user_tables;`, `ALTER SESSION SET CURRENT_SCHEMA=X;`, `EXIT`) and **snippet chips** (`SELECT table_name FROM user_tables;`, `DESC orders`, `SELECT * FROM users WHERE country = 'DE';`). `DESC` reuses the shared describe path. |
| `bytetable/workspace.jsx` | `src/features/console/*` + workspace tab code | Terminal **tab title + shell name**: `conn.engine === 'oracle'` → `'sqlplus'` (tab reads `sqlplus 1`); command-palette entry "Open sqlplus terminal". |
| `bytetable/app.jsx` | `src/App.tsx` / workspace host routing | Oracle falls into the **default** `kind: 'sql'` branch → shared `Workspace` (no new host). Verify no redis/dynamo/mongo/cassandra branch catches it. |
| (backend seam) | `src-tauri/src/shared/ports/sql/params.rs` | `Engine::Oracle`, `ConnectionParams::Oracle { host, port, service_name, sid?, user?, tls_mode, ssh? }`, `display_name`, and the custom-deserialize branch. Compiled unconditionally. |
| (backend adapter) | `src-tauri/src/engines/oracle/*` (feature-gated) | The `oracle` (OCI) adapter: `mod` + `sql` + `introspect` + `query` + `mutate` + `structure` + `objects` + `error` (+ `bulk`), mirroring `engines::mssql`. Registered in `lib.rs` under `#[cfg(feature = "engine-oracle")]`. |

Shared chrome (workspace rail, tab system, data grid + row inspector, filter builder, SQL editor, Structure shell, object explorer, schema map, inline editing, export/import, terminal panel, toast, `MIcon`, modal scrim) is engine-agnostic — **do not fork it**. Oracle only supplies dialect.

---

## 23.0 — Engine registration & routing
**Goal:** an Oracle workspace can be created and connects, routed through the *relational* workspace host (not a bespoke one).

Scope:
- Register `oracle` in the frontend engine registry (`EngineBadge.tsx` `ENGINE_META`): label **"Oracle"**, short badge **`Or`**, brick-red accent `#c74634`. Add `"oracle"` to the `Engine` union (`src/shared/types.ts`). Rail tile, connect card, engine picker, and sidebar badge render like the other relational engines.
- Route `oracle` to the **relational `Workspace`** (default `kind: 'sql'`) — **not** a new vertical slice. Only DynamoDB/MongoDB/Cassandra/Redis get bespoke hosts.
- Backend seam (compiled unconditionally): add `Engine::Oracle` + `ConnectionParams::Oracle` in `params.rs` (`display_name` → "Oracle"; `engine()`/`ssh()`/`uses_password()` arms; custom-deserialize branch: default port **1521**, **service name** primary + optional legacy **SID**, optional `user`, `tls_mode`, optional `ssh`).
- Backend adapter (feature `engine-oracle`): new **`engines::oracle`** `OracleConnector` implementing `Connector`/`EngineConnection` via the `oracle` crate. `test`/`open` build an Oracle DSN from host/port/**service name** (+ optional SID), SQL auth, optional SSH tunnel, TLS; the check runs `SELECT * FROM v$version` (or `banner FROM v$version`). Registered in `lib.rs` under the feature cfg.

Pixel checklist: engine picker `Or` badge + brick-red accent; rail tile matches; connect-modal Oracle form appears; the connect-screen footnote lists Oracle.
Acceptance: with `--features engine-oracle`, create an Oracle workspace against a real/Docker Oracle (23ai Free on Apple Silicon via `gvenzl/oracle-free`; XE 21c / 19c on amd64); test-connection round-trips `v$version`; the workspace opens in the **relational** host with the sidebar populated; the default build compiles + runs unchanged without the feature (Oracle picker present, connect returns the "engine arrives in a later build" style message).

## 23.1 — Connect modal (Oracle form)
**Goal:** the connect modal's Oracle branch matches the prototype and produces a working connection.

Scope:
- `NewConnectionModal.tsx` `isOracle` branch: default port **1521**; **Service name** field (placeholder `ORCLPDB1`) in place of "Database"; user placeholder `byteshop`; the Oracle form-note ("Oracle connects by **service name** … Schemas are users — uppercase by default."); shared optional SSH tunnel + TLS. `ConnectScreen.tsx` footnote includes Oracle.
- Backend DSN: prefer **service name**; support legacy **SID**; accept easy-connect (`host:port/service`) and TNS-alias forms.

Pixel checklist: the Oracle form matches `connect.jsx` (port 1521, Service name field, auth, optional tunnel/TLS) with **no horizontal scroll** at any modal width.
Acceptance: the Oracle form renders the service-name field + form-note; saving produces a working Oracle connection (feature build); the tunnel/TLS controls behave as for MySQL/Postgres/SQL Server.

## 23.2 — Introspection: sidebar objects + Oracle DDL
**Goal:** the sidebar object browser and Structure DDL, backed by real Oracle catalog introspection.

Scope:
- **Object set** (`OBJECT_CAPS`, `kinds.ts`): `['view','materialized_view','function','procedure','trigger']`.
- **Introspection** in `engines::oracle`: tables/columns from `ALL_TAB_COLUMNS`/`ALL_TABLES`; primary/unique/foreign keys from `ALL_CONSTRAINTS`/`ALL_CONS_COLUMNS`; indexes from `ALL_INDEXES`/`ALL_IND_COLUMNS`; views from `ALL_VIEWS`; materialized views from `ALL_MVIEWS`; routines from `ALL_PROCEDURES`/`ALL_OBJECTS`; triggers from `ALL_TRIGGERS`. Schemas = users (`ALL_USERS`, uppercase). Object DDL may use `DBMS_METADATA.GET_DDL` server-side.
- **Oracle DDL** (`generateDDL(..., 'oracle')`): identity columns (`GENERATED BY DEFAULT AS IDENTITY`), DEFAULT-before-NOT NULL ordering, CASCADE/SET NULL-only FK actions, `toOracleType`/`toOracleDefault` mapping.
- **Create templates** (`kinds.ts`, `oracle` branch): recreate the exact PL/SQL for view / MV / function / procedure / trigger.

Pixel checklist: sidebar object sections (Views / Materialized Views / Functions / Procedures / Triggers with counts) render for an Oracle workspace exactly as for Postgres; DDL uses Oracle syntax; create templates match the prototype strings.
Acceptance: the sidebar lists all object classes for `BYTESHOP`; the Structure tab's DDL and the type dropdown match the prototype's Oracle output; create templates open in the SQL editor verbatim.

## 23.3 — Structure editing (types + ALTER)
**Goal:** the Structure type dropdown offers the Oracle type set and column edits stage valid Oracle ALTER DDL.

Scope:
- `ST_ORACLE_TYPES` powers the column-type dropdown (scrollable, capped height like MSSQL — the same custom `.st-type-menu`, never a native `<select>`).
- Column add/edit/drop stages Oracle `ALTER TABLE … ADD/MODIFY/DROP COLUMN …`; identity, DEFAULT, and NOT NULL ordering follow Oracle syntax.
- Indexes / FKs / referenced-by / DDL accordions work as in the shared Structure shell.

Pixel checklist: the type menu opens compact (≤260px tall), scrolls through the Oracle types, current type ticked, anchored under the cell.
Acceptance: editing a column produces valid Oracle ALTER DDL; the type dropdown scrolls and matches `ST_ORACLE_TYPES`; Apply/Discard behaves like the other engines.

## 23.4 — Query, filter, browse, terminal
**Goal:** the full relational read/browse/terminal surface works on Oracle.

Scope:
- SQL editor + clause-order/explain surfaces work unchanged (Oracle `EXPLAIN PLAN` / `DBMS_XPLAN` for the analyze path in the adapter).
- Filter builder, browse grid, row inspector, inline editing, LIMIT/OFFSET (Oracle `OFFSET … ROWS FETCH NEXT … ROWS ONLY`), export/import — all shared.
- **`sqlplus` terminal** (`state.ts` + `SqlTerminalTab.tsx`): prompt `SQL> `, PL/SQL banner, `DESC` describe, Oracle help + snippet chips, tab titled `sqlplus N`, command-palette "Open sqlplus terminal".

Pixel checklist: banner, `SQL>`/`  2  ` prompts, help text, snippet chips, tab title (`sqlplus 1`) all read Oracle / sqlplus — no psql `\dt`/`\d` leakage.
Acceptance: run a SELECT and see results; `DESC orders` describes the table; the terminal tab reads `sqlplus`; pagination caps result size; export/import round-trip works.

## 23.5 — QA checklist
- [ ] `Or` badge + brick-red accent everywhere (picker, rail, connect card, sidebar).
- [ ] Oracle routes to the relational Workspace (no bespoke host).
- [ ] Connect form: port 1521, Service name, auth, optional tunnel/TLS, no h-scroll.
- [ ] Sidebar shows table/view/matview/function/procedure/trigger for `BYTESHOP`.
- [ ] Structure DDL: identity, DEFAULT-before-NOT NULL, CASCADE/SET NULL FKs, Oracle types.
- [ ] Type dropdown = `ST_ORACLE_TYPES`, scrollable, capped height.
- [ ] Create templates are valid PL/SQL and open in the SQL editor.
- [ ] Terminal = `sqlplus` (SQL> prompt, PL/SQL banner, DESC, Oracle chips).
- [ ] Browse LIMIT/OFFSET, row inspector, inline edit, export/import all work.
- [ ] Backend `engines::oracle` unit tests: DDL gen, type map, terminal meta-commands.
- [ ] Default build (no `engine-oracle` feature) compiles + runs pure-Rust; feature build links the OCI adapter.

---

## Notes / dialect
- Oracle is **relational** — reuse the M4–M12 UI and the existing `Connector`/`EngineConnection` SQL ports; the only new code is the `engines::oracle` adapter + the dialect branches in the design files. Do **not** create an `oracle_browse` slice or an `oracle-*.tsx`.
- **Dialect specifics** to honor wherever Oracle SQL is generated: unquoted identifiers are folded to UPPERCASE (schemas/tables/columns are uppercase); paging via `OFFSET … ROWS FETCH NEXT … ROWS ONLY` (12c+) — not `LIMIT/OFFSET`; identity via `GENERATED BY DEFAULT AS IDENTITY` (not `SERIAL`/`IDENTITY(1,1)`); `SYSTIMESTAMP`/`SYS_GUID()` defaults; `NUMBER(1)` for booleans; `CREATE OR REPLACE` for views/routines; PL/SQL blocks terminate with `/` in the terminal.
- **Type mapping** (`toOracleType`): `BOOLEAN→NUMBER(1)`, `TEXT/JSON→CLOB`, `UUID→RAW(16)`, `SMALLINT→NUMBER(5)`, `INTEGER→NUMBER(10)`, `BIGINT→NUMBER(19)`, `TIMESTAMPTZ→TIMESTAMP WITH TIME ZONE`, `DOUBLE PRECISION→BINARY_DOUBLE`, `REAL→BINARY_FLOAT`, `BYTEA→BLOB`, `VARCHAR(n)→VARCHAR2(n)`, `NUMERIC/DECIMAL→NUMBER`, `BINARY(n)→RAW(n)`.
- **Materialized views** are real (`ALL_MVIEWS`), unlike SQL Server's indexed-view stand-in; the create template emits `CREATE MATERIALIZED VIEW … BUILD IMMEDIATE REFRESH COMPLETE ON DEMAND`.
- **Schemas are users**: the schema switcher lists Oracle users (`ALL_USERS`), uppercase; the default schema is the connected user.
- The **type dropdown stays the custom scrollable menu** (shared with SQL Server); never a native `<select>`.
- Destructive ops (drop object, delete row, apply ALTER) confirm when the connection env is `production`, matching every other engine.
- Reuse the **shared terminal chrome** — `sqlplus` is a dialect skin (prompts/banner/meta), not a new terminal.
- **Driver is feature-gated** (`engine-oracle`, OCI/Instant Client) — see the runtime/driver note above. The default build never compiles the Oracle driver; all non-driver code (seam, UI, dialect, tests) is unconditional.
</content>
</invoke>
