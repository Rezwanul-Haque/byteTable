# ADR-0043 — MongoDB engine: official driver, tagged JSON, guarded mongosh

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-20 (first commit that shipped the feature)
- **Area:** Engines
- **Related:** ADR-0003, ADR-0004, ADR-0006, ADR-0020, ADR-0030, ADR-0035, ADR-0036, ADR-0042, ADR-0051, `docs/M18-mongodb-engine.md`

## Context

MongoDB is databases → collections → schemaless BSON documents, queried with filter/projection/
sort documents and aggregation pipelines, with optional JSON-Schema validators. Its BSON types
(ObjectId, DateTime, Int32/Int64, Decimal128, Binary) do not map one-to-one onto JSON. Users
connect with a `mongodb://` or Atlas `mongodb+srv://` string, or with host/port/user fields.
The module doc of `src-tauri/src/shared/ports/mongo.rs` records that its query and aggregation
shape differs enough from the SQL, Redis (ADR-0041) and DynamoDB (ADR-0042) ports to need its
own family.

## Decision

- **Own port family.** `src-tauri/src/shared/ports/mongo.rs` defines `MongoReader` (list,
  bounded find, count, aggregate, explain, schema inference, indexes) and `MongoWriter` (CRUD,
  index and validator DDL), bundled as `MongoConnection`, carried by `OpenConnection::Mongo` and
  resolved by `ConnectionManager::get_mongo`.
- **Driver: official `mongodb` 3** with default features. The `src-tauri/Cargo.toml` comment
  records: async on Tauri's tokio runtime, rustls TLS, the SRV resolver for Atlas, and `bson`
  re-exported for the value layer.
- **Two connection modes** (`src-tauri/src/engines/mongo/mod.rs`): a URI parsed by
  `ClientOptions::parse` with its embedded credentials, or `ClientOptions` built from fields
  with the password from the keychain (ADR-0004). Connect timeout 8 s; a `listDatabases`
  round-trip proves reachability because the driver connects lazily. `TlsMode` maps to driver
  TLS: `disable`/`prefer` → none, `require` → TLS allowing invalid certs, `verify-*` → verified.
  No SSH tunnel.
- **Tagged JSON on the wire** (`src-tauri/src/engines/mongo/value.rs`): ObjectId →
  `{"$oid": …}`, DateTime → `{"$date": rfc3339}`, Timestamp → `{"$timestamp": "t:i"}`, so
  ids and dates survive read → edit → write. Decimal128 and regex become strings, Binary
  becomes base64, unknown variants are stringified instead of panicking.
- **Safety contract** (stated in `ports/mongo.rs`): counts from
  `estimatedDocumentCount`/`collStats`, never a scan; every `find` is bounded by a limit
  (default 50) with `skip` paging; schema inference samples 200 documents (`SCHEMA_SAMPLE` in
  `src-tauri/src/engines/mongo/reader.rs`) and unions their fields.
- **Tauri commands** (`src-tauri/src/features/mongo/commands.rs`): `mongo_list_databases`,
  `mongo_list_collections`, `mongo_find`, `mongo_count`, `mongo_aggregate`, `mongo_explain`,
  `mongo_explain_aggregate`, `mongo_infer_schema`, `mongo_list_indexes`, `mongo_insert_one`,
  `mongo_replace_one`, `mongo_delete_one`, `mongo_delete_many`, `mongo_insert_many`,
  `mongo_create_collection`, `mongo_drop_collection`, `mongo_truncate_collection`,
  `mongo_empty_database`, `mongo_drop_database`, `mongo_create_index`, `mongo_set_validator`.
  Document edits are whole-document `replace_one` by `_id`.
- **Read-only workspaces** (ADR-0006): writers call `ensure_writable`; `mongo_aggregate` also
  refuses a pipeline containing `$out` or `$merge` (`refuse_writing_pipeline`), since those
  stages write.
- **Process list** (ADR-0035): `src-tauri/src/engines/mongo/processes.rs` maps `currentOp` to
  processes and kills with `killOp` on `admin`.
- **Renderer slice** `src/features/browse/mongo/`: `MongoWorkspace.tsx`, sidebar and dashboard,
  `MongoCollectionTab.tsx` (Find with filter/projection/sort/limit, plus an Aggregate mode),
  `MongoPipelineTab.tsx` and `MongoStageRail.tsx` (stage list from `pipeline.ts`),
  `MongoExplainPanel.tsx`, `MongoStructure.tsx` (inferred fields, indexes, validator),
  `MongoDocModal.tsx`, `MongoSchemaMap.tsx` (reference edges inferred from `<field>Id` names,
  since MongoDB declares no references), `MongoIoModals.tsx`, `MongoDdlModals.tsx`.
- **mongosh is emulated, not spawned.** `MongoShellTab.tsx` and
  `src/features/console/components/MongoShellSession.tsx` accept a guarded command set —
  `find`, `findOne`, `aggregate`, `countDocuments`, `getIndexes`, `show dbs`,
  `show collections`, `use <db>` — and route each through the same backend commands. The
  transcript persists per panel session in `shellState.ts`.

## Alternatives considered

- **Reuse the DynamoDB document port.** Rejected; recorded in the `ports/mongo.rs` module doc.
- **Send raw BSON Extended JSON to the renderer.** Not chosen; the renderer gets plain JSON
  with only the `$oid`/`$date`/`$timestamp` tags it must render distinctly (module doc of
  `value.rs`).
- **Bundle or spawn the real `mongosh`.** Not done. The shell's header comment describes the
  guarded subset; why a real shell was not used is not recorded (inferred: no external binary
  and no JavaScript evaluation to sandbox).
- **`updateOne` with `$set` for edits.** Not used; edits replace the whole document. The reason
  is not recorded (inferred: the editor composes a full document).

## Consequences

- **Positive:** ObjectIds and dates round-trip; Atlas SRV strings work; no full scans for
  counts; read-only mode also catches pipelines that write.
- **Negative / trade-offs:** values that become strings (Decimal128, Binary, regex) are written
  back as strings if the document is edited and saved; integers come back as Int32 when they fit
  (`json_to_bson`), so an Int64 field holding a small value changes type on save. Whole-document
  replace overwrites concurrent changes to other fields. The shell runs only the listed commands.
  Schema and references are inferred from a 200-document sample.
- **Testing:** no Rust integration test exists for this engine. Manual and fixture testing use
  `mongo:7` on port 27017 in `test-fixtures/docker-compose.yml`, seeded from
  `test-fixtures/seed/mongo.js`. Pure renderer logic has Vitest suites (`helpers.test.ts`,
  `pipeline.test.ts`).
- **Follow-ups:** lossless handling of Decimal128/Binary/Int64 on write, an SSH tunnel, and
  more shell commands are not implemented.
