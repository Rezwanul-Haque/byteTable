# Milestone 19 — Cassandra engine (parallel track)

> Implement after the SQL milestones (M0–M12) exist; depends only on **M0–M1** (shell + workspace rail/connect modal) and **M4** (tab system). Like Redis (M13), DynamoDB (M17) and MongoDB (M18), Cassandra is **not** forced into the relational table UI — it is its own vertical slice built around the **query-first wide-column** model (cluster → keyspaces → tables with partition/clustering keys, denormalized "*_by_*" tables, CQL). This file expands the milestone into independently shippable subtasks; build them in order, one per session.

Conventions carry over from `MILESTONES.md`:
- Recreate visuals from the prototype — do not improvise colors/spacing/copy. Open `ByteTable.html`, connect the **byteshop_cassandra** workspace (ByteShop project), and interact with each surface at 100% zoom before coding.
- Backend work lands in a new vertical slice `engine_cassandra` behind **wide-column port traits** (a separate port family from the SQL `SchemaReader`/`QueryExecutor`, Redis KV ports, DynamoDB document ports, and MongoDB document ports — CQL's partition-key/clustering/ALLOW FILTERING semantics warrant their own traits). All driver access (the DataStax / ScyllaDB Rust driver) lives in the Rust core behind Tauri commands; the renderer never holds a session handle.
- Definition of done = acceptance criteria pass **and** the pixel checklist matches the prototype side-by-side **and** the slice's use-cases have unit tests.

---

## Design files to follow (Cassandra)

All under `bytetable/` in the design project. These are the source of truth for layout, behavior, and copy — recreate them, don't reinvent.

| File | What it defines |
|---|---|
| `bytetable/cassandra-data.js` | Mock data shape & the **data model contract**: `window.BT_CASSANDRA = { version, cluster, keyspaceNames, keyspaces, defaultKeyspace, getKeyspace(n), tableNames(ks), getTable(ks,t), references, connection }`. A keyspace = `{ name, replication:{class, replication_factor|dc1}, durableWrites, tables:{...} }`. A table = `{ name, columns:[{name,type,kind}], partitionKey:[colName], clustering:[{name,type,order}], primaryKey, indexes:[{name,target}], mvs:[{name,partitionKey[],clustering[]}], rows[], estRows, comment }`. `kind ∈ {partition_key, clustering, static, regular}`. The demo is a **query-first** model: canonical entities denormalized into `*_by_*` tables (e.g. `orders_by_user`). CQL types (`uuid`, `timeuuid`, `text`, `int`, `timestamp`, `set<…>`, `list<…>`, `map<…>`, …) drive value rendering — mirror this typing in the Rust DTOs. `cluster` carries node/topology info for `nodetool status`. |
| `bytetable/cassandra-engine.js` | Query semantics — the spec for the `engine_cassandra` adapter. `window.BT_CASSANDRA_ENGINE = { query, runCql, describeTable, describeKeyspace, insertRow, updateRow, deleteRow, keyOf, clusterStatus, createKeyspace, createTable, createIndex, createMv, dropIndex, dropMv, buildPrimaryKey, colByName, partitionCols, clusteringCols, indexedCols }`. `query(ks, table, {where:[{col,op,val}], orderBy:[{col,order}], limit, allowFiltering})` enforces **CQL query rules**: partition key required for an efficient query, clustering columns usable in order, and **non-key/non-indexed predicates require `ALLOW FILTERING`** (returns/raises accordingly + emits warnings). `runCql(ks, cql)` is a small CQL parser for the cqlsh terminal (`SELECT … FROM [ks.]table [WHERE …] [LIMIT n] [ALLOW FILTERING]`, `DESCRIBE`, `USE`). `keyOf(t,row)` = the full-primary-key identity string used by all CRUD. `clusterStatus()` returns the ring for `nodetool status`. |
| `bytetable/cassandra.jsx` | **Value rendering** (`CassValue`, `cqlColor`/`CQL_TYPE_COLOR`, `baseType`, `cassIsComplex` — the set/list/map/tuple/frozen/blob/counter/vector classifier), the **sidebar** (`CassandraSidebar`: keyspace selector, table list, per-table + keyspace-actions context menus, header icons `hub`/`refresh`/`monitoring`, cqlsh footer button), the **`KeyBadge`** (PK/CK/S markers), and the **wide-column grid** (`CassRowGrid`): attribute columns with kind-colored headers, **hybrid inline editing** (double-click a regular scalar cell → inline input; **key columns locked**; complex types route to the row modal via an `open_in_full` affordance), edited-cell highlight, row-number opens the full row editor. |
| `bytetable/cassandra-table.jsx` | The **table tab** (`CassandraTableTab`): **Query / Structure** segmented modes; the **Filters** toggle that reveals a SQL-engine-style stacked condition builder (partition-key rows, clustering-key rows with operator selects, **non-key filter rows** with enable checkboxes + `ALLOW FILTERING` toggle, View-CQL preview, Clear/Apply); a **consistency-level** select; **bottom limit pager** (100/300/1000/5000/All) + ⌘I add-row + ⌘S save-edits + staged-edit **save bar**; the **row editor modal** (`CassRowModal`) for full-row / complex-type editing; the **Structure** surface (`CassStructure`: filterable columns table with Kind badges + PRIMARY KEY summary, right-rail **accordion** of Secondary indexes / Materialized views / CQL with **add/drop + pending-CQL bar**); and the **standalone CQL query tab** (`CassandraQueryTab`: highlight-overlay editor, Format, statement-at-cursor execution, results grid). |
| `bytetable/cassandra-shell.jsx` | The Cassandra **workspace host** (`CassandraWorkspace`): tab bar (`CassandraTabBar`, with a `+` that opens a new CQL query tab and a cqlsh tool button), tab kinds (`dashboard` / `table` / `cql` / `map`), the **keyspace dashboard** (`CassandraDashboard`: Tables / Indexes / Views / replication stats + per-table panel + **Cluster** ring panel — numeric cells left-aligned, panels spaced), the **cqlsh terminal** (`CassandraShellTab` using shared `.rcli-*` chrome; supports `nodetool status`, `DESCRIBE`, `USE`, `SELECT …`), status bar, and modal wiring. **Opens on the Dashboard tab.** Exports `CassTermTable` for terminal result tables. |
| `bytetable/cassandra-map.jsx` | The **schema map** (`CassandraSchemaMap`): one card per table with its columns + key badges, **denormalization edges** derived from `references` (which entity each query-table is built from), draggable cards, pan + zoom, the shared `hub` schema icon. Mirrors the SQL/Mongo map design language. |
| `bytetable/cassandra-create.jsx` | The **create flows**: `CassCreateKeyspaceModal` (replication strategy + RF/DC, durable writes), `CassCreateTableModal` (columns with type + kind, partition/clustering selection, clustering order, CQL preview), `CassAddIndexModal` (secondary index / materialized view). Exported on `window`. |
| `bytetable/cassandra-export.js` | Export engine: **CQL script** (`CREATE KEYSPACE` + `CREATE TABLE` + `INSERT`) / **CSV** / **JSON**; per-table or whole-keyspace; contents structure+data / structure / data; chunked with progress callback. CQL types serialized faithfully (uuid/timeuuid/timestamp as strings, collections as CQL literals). |
| `bytetable/cassandra-import.js` | Import engine: **CQL script** / **CSV** (type coercion to CQL types) / **JSON** → simulated **`INSERT`** in chunks with progress; preview + count. |
| `bytetable/cassandra-io.jsx` | The **export & import modals** (`CassExportModal` / `CassImportModal`): format + contents pickers, target-table select, progress bars, preview grid. Counterparts to the SQL `export-progress.jsx` / `import.jsx`. |
| `bytetable/connect.jsx` | The Cassandra branch of the **connect modal**: **contact points** (host[s]) + native port (default **9042**), optional **keyspace**, optional **local datacenter** (`dc1`), TLS mode, auth (username/password), and the "connects to contact points and discovers the ring" note. Default consistency belongs to the workspace, not the connect form. Saved connection card grouped under its project. |
| `ByteTable.html` | All Cassandra CSS (search `cass-` — e.g. `.cass-grid*`, `.cass-cell*`, `.cass-qb-*`/`.cass-key-*` query builder, `.cass-kbadge`, `.cass-pk-summary`, `.cass-cql-*`, `.rdash*` dashboard reuse) plus `.filter-*`/`.seg`/`.save-bar`/`.pager`/`.structure-*`/`.acc-*` reuse, and the script-tag load order (`cassandra-data.js` → `cassandra-engine.js` → `cassandra-export.js` → `cassandra-import.js`, then babel `cassandra.jsx` → `cassandra-table.jsx` → `cassandra-map.jsx` → `cassandra-io.jsx` → `cassandra-create.jsx` → `cassandra-shell.jsx`). |

Shared chrome (workspace rail, tab system, toast, buttons, `MIcon`, modal scrim, `.filter-select`, `.seg`, `.save-bar`, `.pager`, `.structure-*`/`.acc-*`, shared `.rcli-*` terminal) is reused from the SQL/Redis builds — do not re-style it.

---

## 19.0 — Slice scaffold + Cassandra connection
**Goal:** a Cassandra workspace can be created and connects to a cluster, routed by engine in the workspace host.

Scope:
- New renderer slice `cassandra_browse` and backend slice `engine_cassandra`. Route by engine in the workspace host: `cassandra` → `CassandraWorkspace`, `mongodb` → `MongoWorkspace`, `dynamodb` → `DynamoWorkspace`, `redis` → `RedisWorkspace`, else relational `Workspace`. Register the engine badge (`Cs`, the Cassandra accent) so the rail tile + connect card render like the others.
- Connect modal Cassandra branch per `connect.jsx`: **contact points** host field + native port (default **9042**); optional **keyspace**; optional **local datacenter** (`dc1`); TLS mode; username/password auth; the "discovers the ring" note; environment color + workspace name/project as for other engines. No horizontal scroll at any width.
- Backend `connect`/`test_connection` commands: build a session from the contact points + local DC + auth via the DataStax/ScyllaDB Rust driver; run a `SELECT release_version FROM system.local` (or driver metadata fetch) as the check. Parse credentials locally; never surface them to the renderer.
- **Port family**: define `WideColumnReader` / `WideColumnWriter` (or similarly named) traits — distinct from SQL, Redis, DynamoDB, and MongoDB ports.

Pixel checklist: connect-modal Cassandra form matches `connect.jsx` (contact points, port 9042, optional keyspace + datacenter, TLS, note, optional-field layout, no horizontal scroll); rail tile + `Cs` badge + env color identical to other engines.
Acceptance: create a Cassandra workspace against a local/Docker Cassandra (and a multi-node ring); test-connection round-trips a metadata/version query and discovers the cluster; SQL/Redis/DynamoDB/Mongo workspaces in adjacent rail tiles are unaffected.

## 19.1 — Sidebar + keyspace dashboard (read-only)
**Goal:** the workspace chrome — keyspace selector, table list, and the dashboard it opens on.

Scope:
- **Sidebar** per `cassandra.jsx`: **keyspace selector** (from cluster metadata); **table list** with search and per-table + keyspace-actions context menus; header icons (schema map `hub`, refresh, dashboard `monitoring`); **Tables** section label formatted like SQL (count + actions `⋯` grouped on the right — not run together); cqlsh footer button. **Do not show per-table row counts in the list** (Cassandra has no cheap `COUNT(*)`; matching the earlier decision to drop row counts from the SQL list).
- **Keyspace dashboard** per `cassandra-shell.jsx`: stat tiles (**Tables / Indexes / Materialized views / replication**) + a per-table panel and a **Cluster** ring panel (node status/load/owns/DC/rack from `clusterStatus`). Numeric cells **left-aligned**; the Tables and Cluster panels are **spaced apart** (16px gap), not overlapping. This is the **default tab** when a Cassandra workspace opens.
- Map DTOs to the `cassandra-data.js` table shape (`columns[].kind`, `partitionKey`, `clustering[].order`, `indexes`, `mvs`, `primaryKey`). Schema comes from `system_schema` keyspaces/tables/columns; ring from driver metadata / `nodetool`-equivalent — never a full scan.

Pixel checklist: table rows, the "Tables N ⋯" label layout, dashboard stat tiles + per-table panel + Cluster panel (left-aligned numbers, spaced panels) match the prototype.
Acceptance: open a workspace → lands on Dashboard with accurate table/index/view counts + replication + ring; switching keyspaces reloads the table list; refresh picks up an out-of-band new table; no `COUNT(*)` is issued to populate the list.

## 19.2 — Table tab: Query builder (keys + ALLOW FILTERING)
**Goal:** the core read surface — browse a table and build partition/clustering/non-key predicates the CQL-correct way.

Scope:
- **Filters** toggle per `cassandra-table.jsx`: hidden by default; opens the stacked builder. **Partition-key rows** (`= value`), **clustering-key rows** (operator select limited to the legal set, in clustering order), and **non-key filter rows** (column + operator + value, each with an **enable checkbox**). A **`ALLOW FILTERING`** toggle sits on the first key row; a **View CQL** preview; **Clear / Apply**. On open, **no filter is applied** — just a bounded `SELECT … LIMIT n` so rows are visible (do not auto-seed the partition key).
- **Consistency-level** select in the toolbar (`ONE/QUORUM/LOCAL_ONE/LOCAL_QUORUM/ALL`), applied per query; the applied-WHERE summary renders after it (with right padding so the italic empty-state isn't clipped).
- **Bottom limit pager** (100/300/1000/5000/All) reusing the SQL `.pager`; returned-of-total + timing live in the footer (not the toolbar). Bound every query so a huge partition/table can't kill the app.
- Backend `query` behind the reader port enforces CQL rules: refuse a non-key/non-indexed predicate unless `ALLOW FILTERING` is set, surface the same warning the prototype shows; require the partition key for an efficient path; honor clustering order. *All* maps to a paged/streamed read, not an unbounded load.

Pixel checklist: Filters toggle + builder rows (PK/CK/non-key with checkboxes), ALLOW FILTERING toggle, View-CQL preview, consistency select, applied-WHERE summary, bottom pager all match the prototype.
Acceptance: open a table → bounded rows render with no filter applied; add a partition-key + clustering predicate and Apply; a non-key filter is rejected until ALLOW FILTERING is enabled (with the warning); the limit pager re-runs the bounded query; the applied-WHERE summary isn't clipped.

## 19.3 — Hybrid inline editing + row modal
**Goal:** safe wide-column mutation per the prototype's grid + modal.

Scope:
- **Hybrid inline editing** in `CassRowGrid`: double-click a **regular scalar** cell → inline input (type-coerced on commit); **partition/clustering key cells are locked** (changing identity = delete + re-insert, not an UPDATE); **complex types** (`set/list/map/tuple/frozen/blob/counter/vector` via `cassIsComplex`) show an `open_in_full` affordance that routes to the **row modal** (`CassRowModal`). Edited cells highlight; edits are **staged** (not written live).
- **Save bar** + **⌘S**: staged edits accumulate in a bar ("N cells edited · unsaved … nothing is written until you save"); Save runs `UPDATE … WHERE <full primary key>` per changed row behind the writer port; Discard reverts. **⌘I** opens the row modal seeded for a new row (full INSERT). Row-number cell opens the modal for full-row edit.
- Backend: `updateRow`/`insertRow`/`deleteRow` keyed by `keyOf` (full primary key). **No partial-key UPDATE** — guard that a row carries its complete key before allowing an inline edit. Counters are `+=`/`-=` only (modal-only); never set a counter via the inline path.

Pixel checklist: inline input + edited-cell highlight, locked key cells, complex-type `open_in_full` affordance, save bar, row modal match the prototype.
Acceptance: inline-edit a regular scalar, see the save bar, ⌘S persists via a full-PK UPDATE; key cells refuse inline edit; a `map`/`set` cell opens the modal; ⌘I inserts a new row; production-env confirm matches the SQL/Redis safety pattern.

## 19.4 — Structure (columns + indexes/MVs with edit)
**Goal:** the table-structure surface per `CassStructure`, reusing the SQL structure shell.

Scope:
- **Columns table**: filterable, with key/sort/pin icons + **Kind** badges (partition key / clustering ASC·DESC / static / regular) and the **PRIMARY KEY** summary line (left-padded to align with the columns header). Columns are read-only inline (fixed at `CREATE TABLE` time) — state that in the hint.
- **Right-rail accordion** (one section open at a time): **Secondary indexes**, **Materialized views**, **CQL**. Indexes and MVs each have a **+** add affordance (add-index picks a column; add-view takes name + partition-key chips + optional clustering chips) and a per-card **delete**. Edits **stage** into a **pending-CQL bar** (Review CQL / Discard / Apply) emitting real `CREATE INDEX` / `DROP INDEX` / `CREATE MATERIALIZED VIEW` / `DROP MATERIALIZED VIEW` — nothing mutates until applied, same safety model as SQL.
- Backend: schema introspection from `system_schema`; `createIndex`/`dropIndex`/`createMv`/`dropMv` behind the writer port; `describeTable` → the CQL shown in the CQL section.

Pixel checklist: columns table (Kind badges, icons, PRIMARY KEY summary alignment), accordion sections, add forms, per-card delete, pending-CQL bar match the prototype.
Acceptance: structure renders columns with correct kinds + primary key; add a secondary index and a materialized view, drop one, and see staged CQL apply via the pending bar; the accordion keeps one section open and each section scrolls independently when long.

## 19.5 — Standalone CQL query tab + cqlsh terminal
**Goal:** the raw-CQL surfaces — a top-level query tab (like SQL's) and the cqlsh terminal.

Scope:
- **Standalone CQL query tab** (`CassandraQueryTab`) opened from the tab bar **`+`** (⌘T): highlight-overlay editor (reuse the SQL `.sql-highlight`/`.sql-input` + CQL keyword set), a **Format** action, **statement-at-cursor** execution (cursor after a `;` selects the statement *before* it), consistency select, and results through the shared grid. Bound every result.
- **cqlsh terminal** (`CassandraShellTab`) using the **shared terminal chrome** (`.rcli`/`.rcli-body`/`.rcli-inputline`/`.rcli-prompt`/`.rcli-input` — do **not** invent `.term-input*` classes): banner, `cqlsh:<ks>>` prompt, history (↑/↓), and the demo command set routed through `runCql` (`SELECT … [ALLOW FILTERING]`, `DESCRIBE`, `USE`, `nodetool status`, `clear`). Toggle with Ctrl/Cmd+`. Results render via `CassTermTable`.
- Backend: a guarded CQL surface (read-first) for both; statement parsing + consistency applied per execution.

Pixel checklist: query-tab editor (highlight, Format), `+`/⌘T tab open, terminal body/input/prompt/result table match the prototype and the SQL/Redis terminals.
Acceptance: `+` opens a CQL query tab; Format beautifies; statement-at-cursor runs the right statement incl. cursor-after-`;`; cqlsh runs `SELECT … ALLOW FILTERING`, `DESCRIBE TABLE`, `USE <ks>`, `nodetool status`; history restores a prior command.

## 19.6 — Create flows (keyspace / table)
**Goal:** create a keyspace and a table from the app, per `cassandra-create.jsx`.

Scope:
- **Create keyspace** (`CassCreateKeyspaceModal`): name, **replication strategy** (SimpleStrategy RF / NetworkTopologyStrategy per-DC), durable writes; CQL preview; opened from the keyspace-actions menu.
- **Create table** (`CassCreateTableModal`): columns (name + CQL type + **kind**), **partition-key** + **clustering** selection with **clustering order**, primary-key assembly via `buildPrimaryKey`, live CQL preview; opened from the table-list actions menu.
- Backend: `createKeyspace`/`createTable` behind the writer port emitting the previewed CQL; refresh the sidebar on success.

Pixel checklist: both modals (field layout, kind selectors, partition/clustering pickers, CQL preview) match the prototype; the create-table CQL preview matches `describeTable` output.
Acceptance: create a keyspace (both replication strategies) and a query-first table with a composite partition key + clustering order; the sidebar refreshes and the new table opens; the emitted CQL matches the preview.

## 19.7 — Schema map (denormalization)
**Goal:** the wide-column model visualization per `cassandra-map.jsx`.

Scope:
- One **card per table** with its columns + **key badges**; draw **denormalization edges** from `references` (which canonical entity each `*_by_*` table is built from); draggable cards with persisted positions, pan + zoom; reachable from the sidebar `hub` icon and a table's context menu. Use the shared schema `hub` icon and the same design language as the SQL/Mongo maps.

Pixel checklist: table cards (columns + PK/CK badges), denormalization edges, `hub` icon, toolbar match the prototype.
Acceptance: open the map → table cards + edges render readably (e.g. `orders_by_user` traces back to the orders/users entities); drag persists; a query-first model with several `*_by_*` tables stays usable.

## 19.8 — Export / Import
**Goal:** parity with the SQL export/import, adapted to Cassandra.

Scope:
- **Export** per `cassandra-export.js` + `cassandra-io.jsx`: per-table (context menu / table-tab ⋮) and **whole-keyspace** (sidebar `download`); formats **CQL script / CSV / JSON**; contents **Structure+data / Structure only / Data only**; live progress bar. The CQL format emits `CREATE KEYSPACE` + `CREATE TABLE` + `INSERT`. Backend streams via a paged cursor so large tables export without loading everything into memory.
- **Import** per `cassandra-import.js` + `cassandra-io.jsx`: **CQL script** / **CSV** (coercion to CQL types) / **JSON** → simulated **`INSERT`** in chunks with progress; preview grid + count.

Pixel checklist: export/import modals (format + contents pickers, target-table select, progress bars, preview grid) match `cassandra-io.jsx`.
Acceptance: export a table in all three formats + structure-only; export a whole keyspace to one file; import CQL/CSV/JSON into a table with progress; round-trip an exported CQL script back in with types intact.

---

## Notes / safety
- **Never** issue `COUNT(*)` to populate the table list or a row count — Cassandra has no cheap count; counts come from a deliberate query only, and the list shows none.
- Bound every read with a default limit + paged cursor, exactly as the SQL grid bounds with limit/offset, so a huge partition or table can't crash the app. *All* in the Limit pager = paged cursor, not an unbounded load.
- Enforce CQL query rules end-to-end: partition key required for an efficient path; clustering columns used in order; **non-key/non-indexed predicates require `ALLOW FILTERING`** (surface the prototype's warning) — `ALLOW FILTERING` is opt-in and a red flag, never silently added.
- Primary-key columns are immutable identity: inline editing is **regular-scalar only**, key cells are **locked**, and changing a key = delete + re-insert. **No partial-key UPDATE** — require the full primary key. Counters are `+=`/`-=` only (modal path), never set inline.
- Preserve CQL types through read → edit → write (uuid/timeuuid/timestamp/collections); complex types (`set/list/map/tuple/frozen/blob/counter/vector`) edit in the row modal, not inline.
- Destructive ops (delete row, drop index/MV, future drop-table/keyspace) confirm when the connection env is `production`, matching the SQL/Redis/DynamoDB/Mongo pattern.
- Reuse the **shared terminal chrome**, `.filter-*`/`.seg`/`.save-bar`/`.pager`/`.structure-*`/`.acc-*`/modal/`MIcon` primitives; the only Cassandra-specific CSS is the `cass-` family already in `ByteTable.html`.
