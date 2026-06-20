# Milestone 18 — MongoDB engine (parallel track)

> Implement after the SQL milestones (M0–M12) exist; depends only on **M0–M1** (shell + workspace rail/connect modal) and **M4** (tab system). Like Redis (M13) and DynamoDB (M17), MongoDB is **not** forced into the relational table UI — it is its own vertical slice built around the **document / collection / BSON** model (databases → collections → schemaless documents, an aggregation pipeline, mongosh). This file expands the milestone into independently shippable subtasks; build them in order, one per session.

Conventions carry over from `MILESTONES.md`:
- Recreate visuals from the prototype — do not improvise colors/spacing/copy. Open `ByteTable.html`, connect the **byteshop_mongo** workspace (ByteShop project), and interact with each surface at 100% zoom before coding.
- Backend work lands in a new vertical slice `engine_mongo` behind **document-store port traits** (a separate port family from the SQL `SchemaReader`/`QueryExecutor`, from Redis's KV ports, and from DynamoDB's document ports — MongoDB's query/aggregation surface is distinct enough to warrant its own traits). All driver access lives in the Rust core behind Tauri commands; the renderer never holds a connection handle.
- Definition of done = acceptance criteria pass **and** the pixel checklist matches the prototype side-by-side **and** the slice's use-cases have unit tests.

---

## Design files to follow (MongoDB)

All under `bytetable/` in the design project. These are the source of truth for layout, behavior, and copy — recreate them, don't reinvent.

| File | What it defines |
|---|---|
| `bytetable/mongo-data.js` | Mock data shape & the **data model contract**: `window.BT_MONGO = { version, server:{host,topology,storageEngine}, dbNames, databases, defaultDb, references[], getDb(n), getColl(db,c), collNames(db), connection, OID, DATE }`. A database = `{ name, collections:{...} }`; a collection = `{ name, docs[], count, indexes:[{name,keys,unique?,sparse?}], validator:{ $jsonSchema }|null, storageBytes, avgDocBytes }`. Two databases (`byteshop`: users/products/orders/reviews; `analytics`: events/sessions). `references[]` (`{from, field, to}`, incl. nested `items.productId`) drives the schema map. `OID`/`DATE` are the ObjectId/ISODate constructors — mirror this Extended-JSON-ish tagging (`{$oid}`, `{$date}`) in the Rust DTOs. |
| `bytetable/mongo-engine.js` | Query semantics — the spec for the `engine_mongo` adapter: `find(db,coll,{filter,projection,sort,limit})` with **index selection** (`chooseIndex`), `aggregate(db,coll,pipeline)` (subset: **$match $project $group $sort $limit $unwind $count $lookup**, with accumulators $sum/$avg/$min/$max/$first/$push/$addToSet), `inferSchema`/`fieldUnion`, `explain` (→ `IXSCAN`/`COLLSCAN`, `nReturned`/`docsExamined`/`keysExamined`/`ratio`, winningPlan stage tree), and CRUD `insertOne`/`replaceOne`/`deleteOne`. Helpers `bsonType`, `scalar`, `getPath`, `isOid`, `isDate`, `isPlainObj`, `matchDoc` define value/BSON semantics. |
| `bytetable/mongo.jsx` | **Value rendering** (`MongoValue`, `mType`, type colors — ObjectId/Date/number/bool/null styling), the **sidebar** (`MongoSidebar`: database selector, collection list with index sub-rows, search, per-collection + database-actions context menus, header icons `hub`/`refresh`/`monitoring`), the **table (grid) view** (`MongoDocGrid`, attribute-union columns), the **tree view** (`MongoDocTree`/`MongoTreeNode`: expandable nested docs, per-doc **edit** ✎ and **delete** 🗑 with two-click arm), and the **JSON document editor modal** (`MongoDocModal`: ObjectId/ISODate preservation, `$jsonSchema` validation, delete). |
| `bytetable/mongo-coll.jsx` | The **collection tab** (`MongoCollectionTab`): **Find / Aggregate / Structure** segmented modes; the **Find bar** (Filter / **Projection** / Sort / **Limit** as a preset `.filter-select` incl. *All*); **Tree ⇄ Table** view toggle; **Explain** panel (`MongoExplainPanel`); **Insert**. Also the **Structure** surface (`MongoStructure`: Inferred schema / Indexes / Validation tabs) and the **standalone aggregation tab** (`MongoPipelineTab`: collection picker, stage rail, Run pipeline, **Copy pipeline**). Constants `PIPELINE_STAGES`, `STAGE_TEMPLATES`, `FIND_LIMITS`. |
| `bytetable/mongo-shell.jsx` | The MongoDB **workspace host** (`MongoWorkspace`): tab bar (`MongoTabBar`, with a `+` that opens a new aggregation pipeline), tab kinds (`dashboard` / `collection` / `pipeline` / `map`), the **database dashboard** (`MongoDashboard`: Collections / Documents / Size / Indexes stats + per-collection table), the **mongosh terminal** (`MongoShellTab`), status bar, and modal wiring. **Opens on the Dashboard tab.** |
| `bytetable/mongo-map.jsx` | The **schema map** (`MongoSchemaMap`): one card per collection with inferred field types, **reference edges** from `references[]` (dashed `field → collection`), draggable cards, pan + zoom. Uses the `hub` icon. |
| `bytetable/mongo-export.js` | Export engine: **JSON array** / **mongosh script** (`createCollection` validator + `createIndex` + `insertMany`) / **CSV**; per-collection or whole-database (**mongodump**-style); contents structure+docs / structure / docs; chunked with progress callback. ObjectId/ISODate serialized as Extended-JSON-ish tags. |
| `bytetable/mongo-import.js` | Import engine: **JSON** (auto-detect a plain array vs a runnable mongosh script; parse `ObjectId(...)`/`ISODate(...)`) / **CSV** (type coercion) → simulated **`insertMany`** in chunks with progress; preview + count. |
| `bytetable/mongo-io.jsx` | The **export & import modals** (`MongoExportModal` / `MongoImportModal`): format + contents pickers, target-collection select, progress bars, preview grid. Counterparts to the SQL `export-progress.jsx` / `import.jsx`. |
| `bytetable/connect.jsx` | The MongoDB branch of the **connect modal**: **Host/port ⇄ Connection string** toggle; connection-string field accepting both `mongodb://` and `mongodb+srv://` (Atlas SRV); optional database / user / password; TLS; default port `27017`. Saved connection card grouped under its project. |
| `ByteTable.html` | All MongoDB CSS (search `mg-` — e.g. `.mg-tree-*`, `.mg-find-*`, `.mg-pipeline`/`.mg-stage*`, `.mg-explain*`, `.mg-struct*`, `.mg-pipe-*`, `.mg-doc-*`, `.mg-map-*`) plus `.filter-select` reuse, and the script-tag load order (`mongo-data.js` → `mongo-engine.js` → `mongo.jsx` → `mongo-coll.jsx` → `mongo-shell.jsx` → `mongo-map.jsx` → `mongo-export.js` → `mongo-import.js` → `mongo-io.jsx`). |

Shared chrome (workspace rail, tab system, toast, buttons, `MIcon`, modal scrim, `.filter-select`, `.seg`) is reused from the SQL build — do not re-style it.

---

## 18.0 — Slice scaffold + MongoDB connection
**Goal:** a MongoDB workspace can be created and connects (local or Atlas SRV), routed by engine in the workspace host.

Scope:
- New renderer slice `mongo_browse` and backend slice `engine_mongo`. Route by engine in the workspace host: `mongodb` → `MongoWorkspace`, `dynamodb` → `DynamoWorkspace`, `redis` → `RedisWorkspace`, else relational `Workspace`. Register the engine badge (`Mg`, green) so the rail tile + connect card render like the others.
- Connect modal MongoDB branch per `connect.jsx`: **Host/port ⇄ Connection string** segmented toggle; connection-string field accepting **`mongodb://` and `mongodb+srv://`**; host/port/database/user/password fields for the fields mode; TLS; default port `27017`; environment color + workspace name/project as for other engines.
- Backend `connect`/`test_connection` commands: build a driver client from the URI (or assembled host/port/auth), run a `ping` / `listDatabases` round-trip as the check. Parse credentials locally; never surface them to the renderer.
- **Port family**: define `DocumentDbReader` / `DocumentDbWriter` (or similarly named) traits — distinct from SQL, Redis, and DynamoDB ports.

Pixel checklist: connect-modal MongoDB form matches `connect.jsx` (Host/port vs Connection string toggle, URI note, optional-field layout, no horizontal scroll); rail tile + `Mg` badge + env color identical to other engines.
Acceptance: create a MongoDB workspace against a **local mongod** and against an **Atlas `mongodb+srv://`** cluster; test-connection round-trips `ping`/`listDatabases`; SQL/Redis/DynamoDB workspaces in adjacent rail tiles are unaffected.

## 18.1 — Sidebar + database dashboard (read-only)
**Goal:** the workspace chrome — database selector, collection list, and the dashboard it opens on.

Scope:
- **Sidebar** per `mongo.jsx`: **database selector** (from `listDatabases`); **collection list** via `listCollections` with search, each row expandable to show its **indexes** (`listIndexes`, `_id_` + secondary, unique/sparse flags); header icons (schema map `hub`, refresh, dashboard `monitoring`); **Collections** section label formatted like SQL (count + actions `⋯` grouped on the right — not run together); mongosh footer button.
- **Database dashboard** per `mongo-shell.jsx`: stat tiles (**Collections / Documents / Size / Indexes**) + a per-collection table (docs, indexes, size, validator badge). This is the **default tab** when a MongoDB workspace opens.
- Map DTOs to the `mongo-data.js` collection shape (`count`, `indexes:[{name,keys,unique?,sparse?}]`, `validator`, `storageBytes`, `avgDocBytes`). Counts/size come from `collStats`/`$collStats` — never a full scan to count.

Pixel checklist: collection rows + index sub-rows, the "Collections N ⋯" label layout, and dashboard stat tiles + table match the prototype.
Acceptance: open a workspace → lands on Dashboard with accurate per-collection doc/index/size from `collStats`; switching databases reloads the collection list; refresh picks up an out-of-band new collection.

## 18.2 — Collection tab: Find (filter / projection / sort / limit)
**Goal:** the core read surface — browse and query documents with both views.

Scope:
- **Find bar** per `mongo-coll.jsx`: **Filter** (`WHERE`-equivalent), **Projection** (the `SELECT`-equivalent — honor the `_id`-included-by-default rule and the include-vs-exclude constraint), **Sort**, and **Limit** as a preset `.filter-select` (`10/25/50/100/200/500/All`, where *All* = unbounded but still streamed/paged on the backend).
- **Tree ⇄ Table** toggle: `MongoDocTree` (expandable nested docs; per-doc **edit** and **delete**) and `MongoDocGrid` (attribute-union columns). Both reuse `MongoValue` for typed rendering (ObjectId/Date/number/bool/null colors).
- Backend `find` with projection/sort/limit behind the reader port; **bound every query** (default limit, cursor/batch paging) so a huge collection can't kill the app — *All* maps to a paged cursor, not a single unbounded load.
- Value semantics per `mongo-engine.js` helpers (`bsonType`, `scalar`, `getPath`, `matchDoc`): tolerate heterogeneous/missing fields; never assume a fixed column set.

Pixel checklist: Find bar fields + Limit select, Tree/Table toggle, doc-card head (index, `_id`, "N fields", ✎/🗑), grid header all match the prototype. Tree doc-cards must keep natural height (no flex-shrink collapse) and the list scrolls.
Acceptance: run a find with filter + projection + sort; toggle Tree/Table; *All* returns the full set via paging without freezing; projection drops/keeps the right fields (incl. `_id` default).

## 18.3 — Document editor + inline delete
**Goal:** safe document mutation per the prototype's editor and tree card.

Scope:
- **JSON document editor modal** (`MongoDocModal`): edit a document as JSON with **`ObjectId("…")` / `ISODate("…")` preserved** (round-trip through the Extended-JSON-ish tags); live parse-error + `$jsonSchema` **validation** feedback; **manual Save** (dirty-gated) → `replaceOne` (or field-level `updateOne`) behind the writer port; an explicit **Delete** action. **Insert** opens the same modal seeded with a fresh `ObjectId`.
- **Inline delete** on each Tree doc-card: a 🗑 button with a **two-click arm** (first click arms red → "Click again to delete"), then `deleteOne` + refresh. Only on **find** results — never on aggregation output. Production-env confirm matches the SQL/Redis safety pattern.

Pixel checklist: editor modal (validity/typed-preservation hints, dirty Save), tree-card ✎/🗑 styling + armed state match the prototype.
Acceptance: edit a document (incl. a value that must keep its ObjectId/ISODate), save, and see it persist; `$jsonSchema` violation blocks save with a message; inline-delete arms then removes a doc and the count refreshes; insert creates a new doc.

## 18.4 — Aggregation pipeline (inline + standalone tab)
**Goal:** the pipeline builder per `mongo-coll.jsx`, both as the collection-tab Aggregate mode and the standalone tab.

Scope:
- **Stage rail**: add/remove/reorder stages; each stage is an op `<select>` (`PIPELINE_STAGES`) + a JSON body seeded from `STAGE_TEMPLATES`; bodies **auto-size and stay equal height** across stages. **Run pipeline** executes via `aggregate`; results render through the same Tree/Table views with a result count + timing.
- **Copy pipeline**: emit `db.<coll>.aggregate([...])` to the clipboard, with the `execCommand` fallback for sandboxed contexts (don't report failure when `navigator.clipboard` merely rejects).
- **Standalone pipeline tab** (`MongoPipelineTab`): opened from the tab bar **`+`**, the sidebar/database-actions menu — defaults to the **active collection**; has a collection picker; tab title reflects the collection and stays in sync.
- Backend `aggregate` supports the stage subset in `mongo-engine.js` (**$match $project $group $sort $limit $unwind $count $lookup** + the listed accumulators); `$lookup` joins another collection in the same database.

Pixel checklist: stage cards (uniform height), Run/Copy buttons, standalone-tab toolbar (title + `db.<coll>.aggregate()` picker), `+` tab button match the prototype.
Acceptance: build a 3-stage pipeline ($match → $group → $sort) and run it; reorder/remove a stage; Copy pipeline puts valid runnable text on the clipboard; `+` opens a standalone pipeline against the current collection and a `$lookup` resolves cross-collection.

## 18.5 — Explain & Structure
**Goal:** the query-plan and collection-structure surfaces.

Scope:
- **Explain panel** (`MongoExplainPanel`) per `mongo-engine.js` `explain`: stage (`IXSCAN` vs `COLLSCAN`), **nReturned / docsExamined / keysExamined / selectivity**, chosen index, and the COLLSCAN→index tip. Behaves like `explain("executionStats")` (real counts, not just estimates). Optionally surface the nested `winningPlan` stage tree as genuine `explain()` JSON.
- **Structure** tab (`MongoStructure`): **Inferred schema** (field union with type chips + presence %, via `inferSchema`), **Indexes** (key pattern, unique/sparse, with a Create-index affordance), and **Validation** (`$jsonSchema` validator pretty-printed, or an empty state).
- Backend: real `explain` for plan/stats; `$collStats`/sampling for inferred schema; `listIndexes` + `collMod`/`createIndex` for the index and validation surfaces.

Pixel checklist: explain plan card + stats, schema table (type chips, presence bars), index cards, validation block match the prototype.
Acceptance: a filter on an indexed field reports `IXSCAN` with low examined/returned; an un-indexed filter reports `COLLSCAN` + the tip; the inferred-schema field union (incl. nested `items[].productId`) and the index/validation tabs render from real introspection.

## 18.6 — mongosh terminal
**Goal:** the raw shell surface per `mongo-shell.jsx`.

Scope:
- **mongosh tab/panel** (`MongoShellTab`) using the **shared terminal chrome** (`.rcli`/`.rcli-body`/`.rcli-inputline`/`.rcli-prompt`/`.rcli-input` — do **not** invent `.term-input*` classes): banner, `db>` prompt, history (↑/↓), presets, result rendering (`MongoTermTable` for cursors, JSON for docs).
- Support the demo command set (`db.<coll>.find(...)`, `.aggregate([...])`, `.countDocuments()`, `show collections`, `use <db>`) routed through the same engine functions; toggle with Ctrl/Cmd+`.
- Backend: a guarded command surface (read-first); reuse the export unmarshalling so typed BSON renders as plain values.

Pixel checklist: terminal body (mono), input line, footer presets, result table match the prototype and the SQL/Redis terminals.
Acceptance: run `db.orders.aggregate([...])` and `db.users.countDocuments()` in mongosh; history restores a prior command; `use <db>` switches the active database.

## 18.7 — Schema map (document references)
**Goal:** the document-model visualization per `mongo-map.jsx`.

Scope:
- One **card per collection** with inferred field types (from `inferSchema`); draw **reference edges** from `references[]` (`field → target collection`, dashed), including nested array paths (`items.productId`).
- Draggable cards with persisted positions, pan + zoom; reachable from the sidebar `hub` icon and a collection's context menu.

Pixel checklist: collection cards, dashed reference edges, `hub` icon, toolbar match the prototype.
Acceptance: open the map → collection cards + reference edges render readably (incl. the nested `orders.items.productId → products` edge); drag persists; an 8+-collection model stays usable.

## 18.8 — Export / Import
**Goal:** parity with the SQL export/import, adapted to MongoDB.

Scope:
- **Export** per `mongo-export.js` + `mongo-io.jsx`: per-collection (context menu / collection-tab ⋮) and **whole-database** (sidebar `download`, *mongodump*-style); formats **JSON array / mongosh script / CSV**; contents **Structure+docs / Structure only / Docs only**; live progress bar. The script format emits `createCollection` (with validator) + `createIndex` + `insertMany`. Backend streams via a cursor so large collections export without loading everything into memory.
- **Import** per `mongo-import.js` + `mongo-io.jsx`: **JSON** (auto-detect a plain array vs a runnable mongosh script; parse `ObjectId(...)`/`ISODate(...)`) / **CSV** (type coercion) → **`insertMany`** in chunks with progress; preview grid + count.

Pixel checklist: export/import modals (format + contents pickers, target-collection select, progress bars, preview grid) match `mongo-io.jsx`.
Acceptance: export a collection in all three formats + structure-only; export a whole database to one *mongodump*-style file; import JSON (both a plain array and a mongosh script) and CSV into a collection with progress; round-trip an exported file back in with ObjectId/ISODate intact.

---

## Notes / safety
- **Never** count documents or export by loading a whole collection into memory — use `collStats`/`$collStats` for counts and a **cursor/batch** for export.
- Bound every find/aggregate with a default limit + cursor paging, exactly as the SQL grid bounds with limit/offset, so a million-document collection can't crash the app. *All* in the Limit select = paged cursor, not an unbounded load.
- Preserve BSON types end-to-end: ObjectId and ISODate must survive read → edit → write (the prototype's `{$oid}`/`{$date}` tagging is the contract).
- Projection has MongoDB-specific rules — `_id` is included unless explicitly excluded, and inclusion/exclusion can't be mixed (except `_id: 0`). Enforce these so the field behaves like the prototype.
- Destructive ops (delete document, future drop-collection) confirm when the connection env is `production`, matching the SQL/Redis/DynamoDB pattern.
- MongoDB is schemaless — keep the grid attribute-union-based and tolerate heterogeneous/missing fields; do not assume a column set.
- Reuse the **shared terminal chrome** and `.filter-select`/`.seg`/modal/`MIcon` primitives; the only Mongo-specific CSS is the `mg-` family already in `ByteTable.html`.
