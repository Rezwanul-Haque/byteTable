# ByteTable: Feature Gap Analysis & Roadmap Proposal

**Author:** Product / PM review
**Date:** 2026-11-11
**Source of truth for "current":** the "Big list of features" on `landing/index.html` (which is kept to what ships today)

---

## 1. Where we stand

ByteTable already covers more ground than most paid clients. The landing page lists **~130 shipped capabilities** in 10 groups:

| Area              | Strength today                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Connect           | 10 engines, SSH/TLS, keychain secrets, URL/ODBC paste, encrypted connection bundles, production flag                               |
| Workspace & UI    | Colored multi-workspaces, sub-workspaces, read-only lock, ⌘K palette, cross-table value search, 16 themes, 8 languages + RTL       |
| SQL editor        | Dialect-aware autocomplete, params, snippets, formatter, vim mode, saved and scheduled queries, real EXPLAIN                       |
| Table data        | Virtualized grid, filter builder with SQL preview, staged edits + batch review, FK peek, column insights                           |
| Schema            | Structure editing staged as ALTERs, object explorer, interactive schema map, schema diff (PG/MySQL/SQLite), brainstorm board       |
| Users & access    | Grants matrix for PG/MySQL/MSSQL/ClickHouse                                                                                        |
| Import / export   | CSV/SQL/JSON export, schema-to-SQL, CSV/.sql import, fake-data generator                                                           |
| Beyond SQL        | Real depth for Redis (+Cluster), DynamoDB, MongoDB, Cassandra, ClickHouse, Typesense                                               |
| Terminal & ops    | Per-engine REPLs, process list + kill, engine dashboards                                                                           |
| Privacy           | Local-first, no telemetry, no account, Apache 2.0, nothing paywalled                                                               |

**Takeaway:** breadth is no longer the problem. The gaps sit in three areas:
1. **Safety around writes**: transactions, undo, guardrails on destructive SQL.
2. **Getting from answer to insight**: charts, visual query building, data comparison.
3. **Reach**: engines and auth methods that enterprise and cloud users need (Oracle, DuckDB, cloud IAM, bastion chains).

---

## 2. Proposed features (14)

Priority key: **P0** = next release cycle, **P1** = next quarter, **P2** = later / validate demand first.
Effort: **S** ≤ 1 week, **M** 2–4 weeks, **L** 1–2 months, **XL** > 2 months.

### F1. Manual transaction mode (BEGIN / COMMIT / ROLLBACK) · P0 · M
**Problem:** Today every statement run from the SQL editor commits on its own. Power users coming from DataGrip/DBeaver expect to run a few statements, check the results, then commit or roll back.
**Scope:**
- Per-workspace toggle: *Auto-commit* ⇄ *Manual*. In Manual mode the status bar shows "Transaction open · N statements · ⌘⇧↩ commit / ⌘⇧⌫ rollback".
- Warn on tab/workspace close or app quit while a transaction is open.
- Production-flagged connections default to Manual (configurable).
- Engines: PG, MySQL, SQLite, SQL Server, ClickHouse (where supported). Not shown for non-transactional engines.
**Acceptance:** an UPDATE in Manual mode is invisible to a second connection until it is committed; rollback restores the prior state; quitting with an open transaction prompts first.

### F2. Destructive-query guardrails · P0 · S
**Problem:** The production flag asks before writes, but nothing catches the classic `UPDATE users SET …` with no `WHERE`.
**Scope:**
- Statement analysis before execution: flag `UPDATE`/`DELETE` without `WHERE`, `DROP`, `TRUNCATE`, and `ALTER … DROP COLUMN`.
- Where the engine supports it, show the affected-row estimate (`EXPLAIN`/`COUNT(*)` dry run) in the confirm dialog.
- Settings: *Off / Warn on production only / Always warn*.
**Acceptance:** `DELETE FROM orders;` on a production connection shows a confirm with the row estimate; `DELETE … WHERE id = 1` does not.

### F3. Charts & quick visualization of results · P0 · M
**Problem:** Users export to a spreadsheet just to see a trend. Every modern competitor (Beekeeper, DataGrip, TablePlus Pro) has some form of this.
**Scope:**
- A "Chart" toggle on any result or table tab: line, bar, area, scatter, pie. Pick the X and Y columns, plus group-by.
- Auto-suggest a chart type from column types (time + numeric → line).
- Export as PNG/SVG (reuse the schema-map export pipeline), and pin a chart to a saved query.
**Acceptance:** `SELECT date_trunc('day', created_at), count(*) … GROUP BY 1` renders as a line chart in one click.

### F4. Data diff & sync between tables / connections · P1 · L
**Problem:** Schema diff exists, but "why does staging have 12 more rows than prod?" still needs hand-written SQL.
**Scope:**
- Compare two tables by primary key (same or different connection): rows only in A, only in B, and changed rows with a cell-level highlight.
- Generate the sync SQL (INSERT/UPDATE/DELETE) and send it through the existing staged-review flow.
- Streamed and chunked by PK range, so memory stays flat (in line with "Built for big tables").
**Acceptance:** diffing two 1M-row tables with 50 differences finishes without loading either table fully into memory, and the generated SQL makes them identical.

### F5. Apply schema diff (migration generator) · P1 · M
**Problem:** Schema diff shows the change DDL but stops at "copy it out". The natural next step is to run it.
**Scope:**
- "Apply to target" runs the DDL through staged review, in a transaction where the engine supports transactional DDL (PG, SQLite).
- "Save as migration" writes timestamped `up`/`down` files in common layouts (plain SQL, Flyway `V__`, golang-migrate, Prisma-compatible).
- Respects the read-only lock and the production confirm.
**Acceptance:** diff → apply leaves the two schemas with a clean diff (zero changes).

### F6. Visual query builder for SQL engines · P1 · L
**Problem:** Mongo and Cassandra have builders, but SQL engines don't. That puts off analysts and juniors, which is a big part of the TablePlus-switcher audience.
**Scope:**
- Drag tables in from the sidebar (or from the schema map). Joins are inferred from FKs and can be edited.
- Column picker, filters (reuse the 13-operator filter builder), group/aggregate, sort, limit.
- Two-way sync with the SQL editor for queries the builder can represent; it falls back to read-only for queries it can't.
**Acceptance:** a three-table join with a GROUP BY can be built without typing, and the generated SQL runs unchanged.

### F7. Cloud-native auth: AWS RDS IAM, GCP Cloud SQL, Azure AD · P1 · M
**Problem:** Enterprise and cloud teams increasingly ban static DB passwords, and without IAM tokens ByteTable can't connect at all in those shops.
**Scope:**
- RDS/Aurora IAM token auth for PG/MySQL (reuses the AWS profile plumbing already built for DynamoDB). Tokens refresh automatically before the 15-minute expiry.
- GCP Cloud SQL IAM / connector, and Azure AD (Entra) auth for SQL Server and Azure PG.
**Acceptance:** connect to an RDS instance with only an AWS SSO profile; the session survives past the 15-minute token lifetime.

### F8. Advanced SSH: jump hosts, SSH agent, ~/.ssh/config · P1 · S–M
**Problem:** Single-hop SSH covers hobby setups. Companies use bastion chains, hardware keys and agent forwarding.
**Scope:**
- ProxyJump chains (n hops), SSH agent / 1Password / Secretive agent support, and import of a host from `~/.ssh/config`.
- Keep-alive interval and auto-reconnect of a dropped tunnel.
**Acceptance:** connect through `laptop → bastion → private-db` using only keys held in the agent.

### F9. New engines: DuckDB, Oracle, Elasticsearch/OpenSearch · P1/P2 · L each
**Problem:** "More engines on the way" is on the landing page. Based on demand from competitors' issue trackers:
- **DuckDB (P1)**: local analytics is growing fast, and it fits the local-first story and the existing CSV-workspace feature (DuckDB could power it and add Parquet).
- **Oracle (P2)**: enterprise demand, harder licensing/driver story (pure-Rust driver options need evaluation).
- **Elasticsearch / OpenSearch (P2)**: natural next step from the Typesense slice (index browser, query DSL console, mappings).
- Cheap wins along the way: **libSQL/Turso** and **CockroachDB** (mostly PG wire-compatible, mainly needs verification and dialect tweaks).
**Acceptance (per engine):** connect, browse, query, edit, export, and the terminal REPL, the same baseline every current engine meets.

### F10. Excel & Parquet import / export · P1 · S–M
**Problem:** Export is CSV/SQL/JSON only. Business users ask for `.xlsx`, and data engineers ask for Parquet.
**Scope:** XLSX export (one table per sheet for multi-table export) and XLSX import with a sheet picker; Parquet export and import; "Copy as Markdown table / INSERT statements / JSON" from the grid selection.
**Acceptance:** a 100k-row export to XLSX and Parquet opens correctly in Excel and DuckDB, with types preserved.

### F11. Backup & restore · P2 · M
**Problem:** "Export schema as SQL" doesn't give you a real backup. Users want a one-click dump they can trust and a restore path.
**Scope:**
- Wrap native tools when present (`pg_dump`/`pg_restore`, `mysqldump`, `sqlite3 .backup`, `mongodump`), with a built-in fallback.
- Scheduled backups reuse the existing query scheduler (folder target, retention count).
- Restore wizard with a target picker that refuses a production target unless explicitly confirmed.
**Acceptance:** back up a PG database, restore it into a fresh database, and the schema diff shows no differences.

### F12. Local AI assistant (opt-in, bring your own model) · P2 · L
**Problem:** Natural-language-to-SQL and "explain this query/plan" are now table stakes in DataGrip, Beekeeper and Postico. The challenge is doing it without breaking the **no telemetry, local-first** promise.
**Scope:**
- **Off by default.** Providers: a local model via Ollama/LM Studio (recommended), or the user's own API key (Anthropic/OpenAI-compatible), stored in the keychain.
- Only schema metadata is sent by default. Sending row data needs an explicit per-request toggle, and the exact prompt is shown before sending.
- Features: NL → SQL in the editor, explain query, explain EXPLAIN plan, suggest an index, fix a failed statement (hooks into "a failed result tab points at the statement").
- Disabled automatically on read-only-locked or production workspaces unless allowed.
**Acceptance:** with the network off and a local model running, "top 10 customers by revenue last month" produces runnable SQL against the real schema.

### F13. Mutation audit log & undo of applied batches · P2 · M
**Problem:** Staged edits protect users *before* commit. Once applied, nothing helps if a change was wrong.
**Scope:**
- A local, per-connection log of every applied write: SQL, timestamp, row count, plus the previous values for grid edits.
- "Revert this batch" generates the inverse statements (from the captured prior values) and sends them through staged review.
- Stored locally, encrypted at rest, with configurable retention.
**Acceptance:** edit 5 cells, apply, then revert from the log; the rows match their original values.

### F14. Sensitive-data masking / presentation mode · P2 · S
**Problem:** Users screen-share and stream DB sessions. One unmasked email column can be a GDPR incident.
**Scope:**
- Mark columns as sensitive, or auto-detect them (email, phone, card, token patterns). Values render masked (`j•••@•••.com`) until hovered with a modifier key.
- A global "Presentation mode" toggle in the status bar masks all sensitive columns and connection hosts.
- Masking applies to exports only if the user chooses.
**Acceptance:** with presentation mode on, no unmasked email or connection hostname is visible anywhere in the UI.

---

## 3. Prioritized roadmap

| Phase                       | Features                                                                | Theme                          |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| **Next release (P0)**       | F1 Transactions · F2 Guardrails · F3 Charts                             | Trust your writes, see results |
| **Next quarter (P1)**       | F5 Apply diff · F8 Advanced SSH · F10 XLSX/Parquet · F7 Cloud IAM · F9 DuckDB | Enterprise reach & workflow   |
| **Following quarter (P1)**  | F4 Data diff & sync · F6 Visual query builder                           | Insight without SQL            |
| **Validate demand (P2)**    | F11 Backup/restore · F12 Local AI · F13 Audit/undo · F14 Masking · F9 Oracle/Elastic | Differentiators          |

**Sequencing rationale:**
- F1 and F2 are cheap and make the "production" story credible. They should land before we market to teams.
- F5 builds directly on the shipped schema diff, so it's a quick win. F4 reuses the staged-review pipeline, so it comes after F5.
- F7 and F8 unblock whole companies that currently *cannot* connect. That makes them high leverage even though fewer people ask for them.
- F12 is the most-requested category industry-wide but the riskiest for our brand. It ships only once the opt-in privacy design has been reviewed publicly.

---

## 4. How we'll measure success (without telemetry)

ByteTable has no telemetry, so the signals have to come from public channels:
- **GitHub:** issue/discussion upvotes per feature (open one tracking issue per item above), stars, release download counts per version.
- **Adoption proxies:** downloads per release after a feature ships vs. the 3-release baseline.
- **Quality:** bug reports tagged per feature within 30 days of release (goal: < 5 for P0 items).
- **Opt-in survey:** an in-app "What should we build next?" link that opens a GitHub Discussion poll. No data is collected in-app.

---

## 5. Risks & open questions

| Risk                                                         | Mitigation                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| AI feature perceived as breaking the privacy promise          | Off by default, local-model first, show the exact prompt, public design doc first   |
| Oracle driver licensing / native client dependency            | Spike on pure-Rust drivers before committing. Keep it P2 until one is viable        |
| Manual transactions hold locks if users forget them            | Idle-transaction timer + status-bar warning + prompt on close                        |
| Data diff on huge tables is slow                               | PK-range chunking, hash-per-chunk comparison, progress bar + cancel                  |
| Scope creep diluting the "fast, focused" feel                  | Every feature must fit the existing staged-review / workspace patterns, not add new modes |

**Open questions for maintainers:**
1. Is DuckDB a separate engine or the backend for the existing CSV/TSV workspace (or both)?
2. Should the AI assistant live in core, or ship as the first extension of a future plugin API?
3. Do we want a "team" story at all (shared snippets/connections via a git repo) without a cloud service?
