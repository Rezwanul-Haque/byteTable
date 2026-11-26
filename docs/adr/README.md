# Architecture Decision Records

ByteTable's ADRs, one per major capability. They were written retroactively on 2026-11-26
from the shipped implementation (code, commit history, and `docs/M*.md`),
so each records what the code actually does — not what was planned. Where a reason was
never written down, the ADR says "inferred".

New ADRs: copy [`template.md`](template.md), take the next number, and add a row below.

| ADR | Title | Area | Date |
| --- | ----- | ---- | ---- |
| [0001](0001-tauri-rust-core-react-renderer.md) | Tauri 2 with a Rust core and a React/Vite renderer | Architecture | 2026-06-12 |
| [0002](0002-vertical-slice-clean-architecture.md) | Vertical slices with clean-architecture layers inside each | Architecture | 2026-06-12 |
| [0003](0003-engine-adapter-abstraction.md) | Engine adapters behind per-family port traits | Engines | 2026-06-13 |
| [0004](0004-secrets-in-os-keychain.md) | Connection secrets live in the OS keychain, never in the registry | Connections | 2026-06-13 |
| [0005](0005-frontend-state-zustand-and-typed-invoke.md) | Per-slice Zustand stores, typed invoke wrappers, one structured error | Architecture | 2026-06-12 |
| [0006](0006-workspaces-sub-workspaces-read-only.md) | Workspace rail, schema sub-workspaces, and read-only workspaces | App shell | 2026-06-12 |
| [0007](0007-tab-system.md) | A closed `Tab` union per workspace, with per-tab staged state | Data browsing | 2026-06-13 |
| [0008](0008-ssh-tunnels-and-tls.md) | SSH local-forward tunnels via russh, and a five-level TLS mode | Connections | 2026-06-13 |
| [0009](0009-connection-url-import-and-encrypted-bundles.md) | Connection import from URL/ODBC strings, and encrypted `.btbundle` files | Connections | 2026-08-13 |
| [0010](0010-virtualized-data-grid.md) | Paged table grid, virtualized within the page | Data browsing | 2026-06-13 |
| [0011](0011-filter-builder.md) | Stackable filter builder compiled to a bound WHERE clause | Data browsing | 2026-06-13 |
| [0012](0012-inline-editing-and-staged-changes.md) | Inline cell editing through a per-tab staged batch | Data browsing | 2026-06-13 |
| [0013](0013-row-inspector-drawer.md) | Row inspector as a non-modal drawer that stages into the grid | Data browsing | 2026-07-15 |
| [0014](0014-fk-hop-and-column-insights.md) | FK peek / hop and column insights as thin engine-port lookups | Data browsing | 2026-06-13 |
| [0015](0015-row-lineage-graph.md) | Row lineage built in the renderer from bounded existing reads | Data browsing | 2026-11-26 |
| [0016](0016-change-history-undo-redo.md) | Local change history with checked, transactional undo and redo | Data browsing | 2026-11-25 |
| [0017](0017-data-masking-mode.md) | Display-only data masking behind one renderer entry point | Data browsing | 2026-11-25 |
| [0018](0018-sql-editor-codemirror.md) | CodeMirror 6 as the SQL editor, with per-engine dialects | SQL | 2026-06-13 |
| [0019](0019-query-execution-results-and-run-history.md) | Query execution: per-statement result tabs and workspace run history | SQL | 2026-06-13 |
| [0020](0020-explain-plans.md) | Explain plans come from the engine, with a modelled fallback | SQL | 2026-06-14 |
| [0021](0021-query-debug-mode.md) | Query debug mode: step a SELECT by running each clause prefix | SQL | 2026-11-24 |
| [0022](0022-query-params-and-snippets.md) | Query parameters by text substitution; a separate snippet library | SQL | 2026-10-25 |
| [0023](0023-saved-queries.md) | Saved queries: one global JSON store, optional workspace attachment, tab link | SQL | 2026-06-13 |
| [0024](0024-result-chart.md) | Result chart: hand-drawn charts of the in-memory result, off-thread when large | SQL | 2026-11-24 |
| [0025](0025-result-compare.md) | Result compare: backend runs both sides, renderer diffs | SQL | 2026-11-26 |
| [0026](0026-query-notebooks.md) | Query notebooks stored as one plain Markdown file | SQL | 2026-11-24 |
| [0027](0027-scheduled-queries-and-checks.md) | Scheduled queries and checks run in-process, read-only, from a resolved SQL snapshot | SQL | 2026-10-26 |
| [0028](0028-introspection-and-sidebar-cache.md) | Introspection slice and renderer sidebar cache | Schema | 2026-06-13 |
| [0029](0029-structure-view-and-editing.md) | Structure view and staged ALTER editing | Schema | 2026-06-13 |
| [0030](0030-schema-map.md) | Schema map (ER diagram) with persisted layout, groups, and visual editing | Schema | 2026-06-13 |
| [0031](0031-brainstorm-board.md) | Brainstorm board: renderer-only canvas that diffs sketches against the live schema | Schema | 2026-10-11 |
| [0032](0032-object-explorer-and-db-objects.md) | Object explorer and non-table database objects | Schema | 2026-06-26 |
| [0033](0033-schema-diff.md) | Schema diff: structure-only comparison with a planned migration | Schema | 2026-07-30 |
| [0034](0034-privileges-view.md) | Privileges view: normalised grant matrix with a staged editor | Schema | 2026-10-24 |
| [0035](0035-processes-view.md) | Processes view: live session list with kill | Schema | 2026-07-24 |
| [0036](0036-import-and-export.md) | SQL/CSV import and export through the engine port | Data movement | 2026-06-14 |
| [0037](0037-generate-data.md) | Schema-aware fake data generation | Data movement | 2026-06-19 |
| [0038](0038-csv-tsv-data-file-workspaces.md) | CSV/TSV data files as workspaces | Data browsing | 2026-08-18 |
| [0039](0039-value-search-across-tables.md) | Value search across every table | Data browsing | 2026-10-27 |
| [0040](0040-open-database-files-from-os.md) | Opening database and script files from the OS | App shell | 2026-10-18 |
| [0041](0041-redis-engine-and-cluster.md) | Redis engine: key-value port family, per-node cluster view, clients tab | Engines | 2026-06-13 |
| [0042](0042-dynamodb-engine.md) | DynamoDB engine: document port family on the AWS SDK | Engines | 2026-06-19 |
| [0043](0043-mongodb-engine.md) | MongoDB engine: official driver, tagged JSON, guarded mongosh | Engines | 2026-06-20 |
| [0044](0044-cassandra-engine.md) | Cassandra engine: wide-column port on the `scylla` driver, CQL rules enforced | Engines | 2026-06-23 |
| [0045](0045-typesense-engine.md) | Typesense engine: search port family over HTTP, relevance playground, minimal writes | Engines | 2026-08-11 |
| [0046](0046-clickhouse-engine.md) | ClickHouse engine: relational ports over the HTTP interface with `reqwest` | Engines | 2026-07-23 |
| [0047](0047-mssql-engine.md) | SQL Server engine: `tiberius` TDS driver behind the relational ports | Engines | 2026-07-02 |
| [0048](0048-local-ai-assistant.md) | Opt-in, bring-your-own-model AI assistant | SQL | 2026-11-12 |
| [0049](0049-settings-and-themes.md) | Settings store, pre-mount bootstrap and themes (incl. glass materials) | App shell | 2026-06-23 |
| [0050](0050-i18n-and-localization.md) | In-house i18n runtime with per-locale string tables, RTL and per-script fonts | App shell | 2026-08-11 |
| [0051](0051-terminal-panel.md) | Docked multi-session terminal panel built on existing engine commands | SQL | 2026-06-13 |
| [0052](0052-auto-updater-and-release-pipeline.md) | Signed in-app updates from GitHub Releases, cut by `make tag` | App shell | 2026-06-15 |
| [0053](0053-app-shell-tray-single-instance-splash.md) | App shell: close-to-tray, single instance, splash, own-resource readout, report issue | App shell | 2026-06-13 |
| [0054](0054-command-palette-and-menus.md) | In-window app menus, a `bt:cmd` bus, the command palette and shared context menus | App shell | 2026-06-13 |
