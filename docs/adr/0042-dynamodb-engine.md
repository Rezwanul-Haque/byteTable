# ADR-0042 — DynamoDB engine: document port family on the AWS SDK

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-19 (first commit that shipped the feature)
- **Area:** Engines
- **Related:** ADR-0003, ADR-0004, ADR-0006, ADR-0012, ADR-0013, ADR-0030, ADR-0036, ADR-0041, ADR-0051, `docs/M17-dynamodb-engine.md`

## Context

DynamoDB is a managed key/value + single-table-design store. A table has a partition key, an
optional sort key, GSIs/LSIs, and schemaless items whose attributes are typed values
(`S`, `N`, `B`, `BOOL`, `NULL`, `L`, `M`, `SS`, `NS`, `BS`). Reads are `Query` (by key) or
`Scan` (paged, billed per item read). It fits neither the SQL trait nor Redis's key-value port
(ADR-0041) — the module doc of `src-tauri/src/shared/ports/document.rs` records that both would
need `Unsupported` stubs. Users connect to AWS with a shared profile or access keys, or to
DynamoDB Local / LocalStack.

## Decision

- **Own port family.** `src-tauri/src/shared/ports/document.rs` defines `DocumentStoreReader`
  and `DocumentStoreWriter`, bundled as `DocumentStoreConnection`; `OpenConnection::Document`
  (`ConnectionKind::Document`) carries it and `ConnectionManager::get_document` enforces the kind.
- **Driver: the official AWS SDK** — `aws-config`, `aws-sdk-dynamodb`, `aws-credential-types`
  (all `behavior-version-latest`). The `src-tauri/Cargo.toml` comment records: typed client for
  every call used, reproducible default behaviours, rustls by default (no OpenSSL), and static
  `Credentials` for the access-key mode.
- **Auth and endpoint** (`src-tauri/src/engines/dynamo/mod.rs`): `DynamoAuth::Profile` resolves
  through the SDK's shared-profile chain; `Keys` takes the access-key id from params and the
  secret from the keychain (ADR-0004). A custom `endpoint` switches to local mode, where dummy
  static credentials are injected and the region is only a label. There is no SSH tunnel or TLS
  option for this engine.
- **Renderer sees plain JSON.** `src-tauri/src/engines/dynamo/value.rs` marshals
  `AttributeValue` ⇄ `serde_json::Value`. `N` becomes a JSON number when it fits i64/u64/f64,
  otherwise a string, to keep precision. `B` becomes base64. Sets are tagged as `{"$ss":[…]}`,
  `{"$ns":[…]}`, `{"$bs":[…]}` — the module doc records why: untagged sets came back as `L` and
  a read-then-write silently turned every set into a list.
- **Safety contract** (written into `document.rs`): item
  counts and sizes come from `DescribeTable` (approximate), never a scan; every scan is bounded
  by `Limit` plus an opaque continuation token wrapping `ExclusiveStartKey`/`LastEvaluatedKey`.
- **Tauri commands** (`src-tauri/src/features/dynamo/commands.rs`): `dynamo_list_table_names`,
  `dynamo_list_tables`, `dynamo_describe_table`, `dynamo_scan`, `dynamo_query` (base table or a
  named index, key condition built with `#pk`/`#sk` placeholders), `dynamo_get_item`,
  `dynamo_put_item`, `dynamo_delete_item`, `dynamo_batch_write`, `dynamo_batch_delete`,
  `dynamo_execute_statement` (PartiQL), `dynamo_create_table` (waits for ACTIVE),
  `dynamo_delete_table`, `dynamo_truncate_table`. The slice has no domain/infrastructure layer.
- **Writes are whole-item `PutItem`.** Batches are chunked at 25 (the `BatchWriteItem` limit)
  with a bounded retry of `UnprocessedItems`. Truncate scans with a key-only projection and
  batch-deletes; DynamoDB has no native truncate.
- **Read-only workspaces** (ADR-0006): each write command calls `ensure_writable`; PartiQL is
  classified by `sql_is_read_only` in `src-tauri/src/shared/readonly.rs`.
- **Renderer slice** `src/features/browse/dynamo/`: `DynamoWorkspace.tsx`, a sidebar and
  dashboard of tables, `DynamoTableTab.tsx` (Scan / Query modes over `DynamoItemGrid.tsx`, with
  column order from `attrOrder`), `DynamoItemDrawer.tsx` (shares the SQL row inspector's
  `.ri-drawer` shell, ADR-0013; PK/SK locked, other attributes typed and editable, edits staged
  into the grid buffer and committed with the save bar, ADR-0012), `DynamoPartiqlTab.tsx` plus a
  PartiQL session in the bottom panel (`src/features/console/components/DynamoPartiqlSession.tsx`),
  `DynamoSchemaMap.tsx` (entity cards and edges inferred from a bounded sample scan per table),
  `DynamoIoModals.tsx` (export/import) and `DynamoDdlModals.tsx` (create/delete/empty table).

## Alternatives considered

- **Reuse the SQL or key-value port.** Rejected; recorded in the `document.rs` module doc.
- **Expose DynamoDB-typed JSON to the renderer.** Not chosen; the slice keeps it in Rust so the
  grid, drawer and import/export work on plain values. The drawer can still preview the typed
  form. That this keeps the frontend simpler is inferred.
- **Untagged sets.** Shipped first and replaced, because of the set-to-list round-trip bug.
- **`UpdateItem` for partial edits.** Not used; edits recompose the whole item and `PutItem` it.
  The reason is not recorded (inferred: one write path for create, edit and import).
- **Allow key edits.** Out of scope per M17 §17.3 and the drawer comment: changing PK/SK means
  delete and recreate.

## Consequences

- **Positive:** set types and large numbers survive a read-edit-write; no hidden full-table
  scans for counts; works against AWS and DynamoDB Local with the same code.
- **Negative / trade-offs:** `PutItem` replaces the whole item, so a concurrent change to another
  attribute between read and save is overwritten (no condition expression is sent). Truncate is a
  scan-and-delete that costs read and write capacity in proportion to table size. The schema map
  is a guess from sampled items. Only two auth modes exist (`DynamoAuth::Profile`, `DynamoAuth::Keys`
  in `src-tauri/src/shared/ports/sql/params.rs`); there is no SSH tunnel.
- **Testing:** `src-tauri/tests/dynamo_integration.rs`, gated on `BYTETABLE_TEST_DYNAMODB_URL`,
  against `amazon/dynamodb-local` on port 8000 (`test-fixtures/docker-compose.yml`), seeded by
  `test-fixtures/seed/seed-dynamo.sh`. Pure renderer logic has Vitest suites
  (`setTypes.test.ts`, `attrOrder.test.ts`, `isoTimestamp.test.ts`, `schemaMapModel.test.ts`).
- **Follow-ups:** key (identity) editing, and conditional writes are not implemented.
