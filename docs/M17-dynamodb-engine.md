# Milestone 17 — DynamoDB engine (parallel track)

> Implement after the SQL milestones (M0–M12) exist; depends only on **M0–M1** (shell + workspace rail/connect modal) and **M4** (tab system). Like Redis (M13), DynamoDB is **not** forced into the relational table UI — it is its own vertical slice built around the NoSQL key/value + single-table-design model. This file expands the milestone into independently shippable subtasks; build them in order, one per session.

Conventions carry over from `MILESTONES.md`:
- Recreate visuals from the prototype — do not improvise colors/spacing/copy. Open `ByteTable.html`, connect the DynamoDB workspace, and interact with each surface at 100% zoom before coding.
- Backend work lands in a new vertical slice `engine_dynamo` behind **key-value/document port traits** (a separate port family from the SQL `SchemaReader`/`QueryExecutor` and from Redis's KV ports). All AWS SDK access lives in the Rust core behind Tauri commands; the renderer never holds credentials or raw client handles.
- Definition of done = acceptance criteria pass **and** the pixel checklist matches the prototype side-by-side **and** the slice's use-cases have unit tests.

---

## Design files to follow (DynamoDB)

All under `bytetable/` in the design project. These are the source of truth for layout, behavior, and copy — recreate them, don't reinvent.

| File | What it defines |
|---|---|
| `bytetable/dynamo-data.js` | Mock data shape & the **data model contract**: `window.BT_DYNAMO = { tableNames, getTable(name), region, account }`; per-table `{ name, keySchema:{pk,sk}, attrTypes, gsis[], lsis[], billing, rcu/wcu, ttlAttribute, items[], itemCount, sizeBytes }`. Single-table design (USER/ORDER/PRODUCT sharing a partition) + classic tables (Sessions, EventLog). Mirror these field names in the Rust DTOs. |
| `bytetable/dynamo-engine.js` | Query semantics: `scan`, `query` (PK + sort-key conditions: eq/lt/lte/gt/gte/begins_with/between, on base table **or** a GSI/LSI), `getItem`, PartiQL-lite, and item ops. This is the spec for the `engine_dynamo` adapter's read/query behavior + capacity accounting. |
| `bytetable/dynamo.jsx` | The workspace **sidebar** (table list, search, per-table context menu), the **item browser / query tab** (Scan vs Query mode, PK/SK condition row, index selector, results grid, capacity readout), the **item editor modal** (PK/SK locked, all other attributes editable + typed, add/remove attribute, manual Save), and the **table-tab ⋮ actions menu**. |
| `bytetable/dynamo-shell.jsx` | The DynamoDB **workspace host**: tab bar, tab kinds (`dashboard` / `table` / `partiql` / `map`), **PartiQL terminal**, **tables dashboard** (Items / GSIs / Billing / Size table), status bar, and modal wiring. **Opens on the Dashboard tab.** |
| `bytetable/dynamo-map.jsx` | The **schema map** (single-table-design visualization): entity-type cards derived from item data, item-collection edges (shared partition = 1:N), GSI access-pattern edges, draggable/pan-zoom. Uses the `hub` icon. |
| `bytetable/dynamo-export.js` | Export engine: Plain JSON / DynamoDB-typed JSON / CSV, per-table or whole-account, structure-only / items-only / both; chunked with progress callback; `CreateTable`-style definitions for structure. |
| `bytetable/dynamo-import.js` | Import engine: JSON (auto-detect plain vs DynamoDB-typed, unmarshal) / CSV (type coercion) → simulated `BatchWriteItem` with progress; preview with missing-key detection. |
| `bytetable/dynamo-io.jsx` | The **export & import modals** (format/contents pickers, progress bars, preview grid). Counterparts to the SQL `export-progress.jsx` / `import.jsx`. |
| `bytetable/connect.jsx` | The DynamoDB branch of the **connect modal**: Local endpoint vs AWS toggle, region selector, credentials (profile / access-key+secret / session token), endpoint URL for DynamoDB Local. |
| `ByteTable.html` | All DynamoDB CSS (search `ddb-`, `.export-`, `.import-`, `.ctx-menu`, `.structure-table`, `.ddb-dash-num`) and the script-tag load order. |

Shared chrome (workspace rail, tab system, toast, buttons, `MIcon`, modal scrim) is reused from the SQL build — do not re-style it.

---

## 17.0 — Slice scaffold + DynamoDB connection
**Goal:** a DynamoDB workspace can be created and connects (Local or AWS), routed by engine in the workspace host.

Scope:
- New renderer slice `dynamo_browse` and backend slice `engine_dynamo`. Route by engine in the workspace host: `dynamodb` → `DynamoWorkspace`, `redis` → `RedisWorkspace`, else relational `Workspace`.
- Connect modal DynamoDB branch per `connect.jsx`: **Local endpoint vs AWS** toggle; **region** selector; **credential mode** (named profile / access-key + secret + optional session token); **endpoint URL** field for DynamoDB Local; environment color + workspace name/project as for other engines.
- Backend `connect`/`test_connection` commands: build an AWS SDK DynamoDB client from the chosen credential mode + region (or a custom endpoint for Local), `ListTables` as the round-trip check.
- **Port family**: define `DocumentStoreReader` / `DocumentStoreWriter` (or similarly named) traits — distinct from SQL and Redis ports.

Pixel checklist: connect-modal DynamoDB form matches `connect.jsx` (Local/AWS segmented toggle, region/credential layout, no horizontal scroll); rail tile + env color identical to other engines.
Acceptance: create a DynamoDB workspace against **DynamoDB Local** and against a **real AWS region** via a named profile; test-connection round-trips `ListTables`; SQL/Redis workspaces in adjacent rail tiles are unaffected.

## 17.1 — Sidebar + tables dashboard (read-only)
**Goal:** the workspace chrome — table list and the dashboard it opens on.

Scope:
- **Sidebar** per `dynamo.jsx`: real `ListTables`/`DescribeTable` introspection → table list with search, key-schema preview, refresh; sidebar header icons (schema map `hub`, export-all `download`, dashboard `monitoring`); PartiQL footer button.
- **Tables dashboard** per `dynamo-shell.jsx`: one row per table — **Items / GSIs / Billing / Size** — left-aligned numeric cells (`.ddb-dash-num`; do **not** use `.cell-num`, which is `display:block` and breaks `<td>` layout). This is the **default tab** when a DynamoDB workspace opens.
- Map the DTOs to the `dynamo-data.js` shape (`keySchema`, `attrTypes`, `gsis`, `lsis`, `billing`, `rcu/wcu`, `ttlAttribute`, `itemCount`, `sizeBytes`). Item/size counts come from `DescribeTable` (approximate) — never a full scan to count.

Pixel checklist: dashboard column alignment matches the prototype (numbers left-aligned, billing/size in their own columns); sidebar row + search + header-icon geometry identical.
Acceptance: open a workspace → lands on Dashboard with accurate per-table item/GSI/billing/size from `DescribeTable`; refresh picks up an out-of-band new table.

## 17.2 — Item browser: Scan & Query tab
**Goal:** the heart of the engine — browse and query items.

Scope:
- **Table tab** per `dynamo.jsx`: **Scan** vs **Query** mode toggle. Query mode exposes the **PK value** field + a **sort-key condition** row (operators eq / lt / lte / gt / gte / begins_with / between, with the second value for `between`) and an **index selector** (base table + each GSI/LSI).
- Results render in the schemaless **item grid** (attribute-union columns; nested maps/lists shown compactly, click to open the item).
- **Capacity readout**: `N items · M scanned · X RCU`, matching `dynamo-engine.js` accounting.
- Backend: `scan` (with `Limit` + pagination token; **never** unbounded) and `query` (key-condition + optional GSI/LSI) behind the document ports. Default page size mirrors the SQL grid's limit/offset philosophy — bounded so a huge table can't kill the app.

Pixel checklist: Scan/Query toggle, condition row, index dropdown, grid header, capacity readout match the prototype.
Acceptance: scan a table (bounded + paged); query a single partition with each sort-key operator on base table and on a GSI; capacity/scanned counts correct.

## 17.3 — Item editor (keys locked, attributes editable)
**Goal:** safe item mutation per the prototype's item modal.

Scope:
- **Item editor modal** per `dynamo.jsx`: PK and SK shown **locked** (lock icon, read-only — changing identity = delete+recreate, out of scope here); every other attribute editable with a **type selector** (S / N / BOOL / NULL / L / M), add-attribute and remove-attribute controls, live raw-JSON preview.
- **No auto-submit** — a manual **Save** button, enabled only when dirty (dirty dot), consistent with the SQL editing model. Save issues `PutItem` (or an attribute-level `UpdateItem`) behind the writer port.
- Production-env confirm before write, matching the SQL/Redis safety pattern.

Pixel checklist: locked-key styling, type selectors, add/remove rows, dirty Save state match the prototype.
Acceptance: edit non-key attributes (incl. boolean→select, add a new attribute, delete one) and persist to DynamoDB Local; PK/SK are not editable; discard reverts; Save disabled until dirty.

## 17.4 — PartiQL terminal
**Goal:** the raw query surface per `dynamo-shell.jsx`.

Scope:
- **PartiQL editor/terminal** tab: run `SELECT … FROM table WHERE …` PartiQL statements via `ExecuteStatement`; tabular result rendering (reuse the terminal's table formatting); history; presets.
- Map results back through the same unmarshalling as the import engine so typed JSON renders as plain values.

Acceptance: run a PartiQL `SELECT` with a `WHERE` key condition; results render as a table; history restores a prior statement.

## 17.5 — Schema map (single-table design)
**Goal:** the NoSQL schema visualization per `dynamo-map.jsx`.

Scope:
- Derive **entity types** from item data (e.g. by `PK`/`SK` prefix patterns), draw **item-collection** edges (items sharing a partition = 1:N) and **GSI access-pattern** edges; cards show PK/SK patterns + GSIs.
- Draggable cards with persisted positions, pan + zoom; reachable from the sidebar `hub` icon and a table's context menu ("Show in schema map").

Pixel checklist: entity cards, edge styles, `hub` icon, toolbar match the prototype.
Acceptance: open the map → entity types + item-collection + GSI edges render readably; drag persists; a 20+-entity model stays usable.

## 17.6 — Export / Import
**Goal:** parity with the SQL export/import, adapted to DynamoDB.

Scope:
- **Export** per `dynamo-export.js` + `dynamo-io.jsx`: per-table (context menu / table-tab ⋮) and **whole-account** (sidebar `download`); formats **Plain JSON / DynamoDB-typed JSON / CSV**; contents **Structure+items / Structure only / Items only**; live progress bar. Structure emits a real `CreateTable` definition (key schema, GSIs, billing, TTL). CSV is per-table, items-only. Backend streams via paginated `Scan` so large tables export without loading everything into memory.
- **Import** per `dynamo-import.js` + `dynamo-io.jsx`: JSON (auto-detect plain vs DynamoDB-typed, unmarshal) / CSV (type coercion) → **`BatchWriteItem`** in chunks with progress; preview grid + **missing-key warning**.

Pixel checklist: export/import modals (format + contents pickers, progress bars, preview grid) match `dynamo-io.jsx`.
Acceptance: export a table in all three formats + structure-only; export all tables to one account-level JSON; import JSON (both typed and plain) and CSV into a table with progress and a missing-key warning; round-trip an exported file back in.

---

## Notes / safety
- **Never** count rows or export by loading a whole table into memory — use `DescribeTable` for counts and paginated `Scan` for export.
- Bound every Scan with a `Limit` + continuation token, exactly as the SQL grid bounds with limit/offset, so a million-item table can't crash the app.
- Destructive ops (delete item, future delete-table/truncate) confirm when the connection env is `production`, matching the SQL/Redis pattern.
- DynamoDB has no fixed schema — keep the grid attribute-union-based and tolerate heterogeneous items; do not assume a column set.
