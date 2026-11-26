# ADR-0048 — Opt-in, bring-your-own-model AI assistant

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-11-12 (`8634973 feat: local AI assistant`; non-SQL engines followed in `fa78107`, 2026-11-13)
- **Area:** SQL
- **Related:** ADR-0003, ADR-0004, ADR-0006, ADR-0018, ADR-0020, ADR-0049, ADR-0051

## Context

Users wanted help writing queries from plain language, explaining a query or an EXPLAIN plan,
suggesting an index and fixing a failed statement. ByteTable has a no-telemetry, local-first
stance, so the design set four rules that every layer repeats (`src-tauri/src/features/assistant/mod.rs`):
off until turned on; structure, not data; you see what is sent; it proposes, you run. ByteTable
ships no model, so the user has to supply one, either local or hosted.

## Decision

- **Providers.** The `ModelProvider` port (`ports.rs`: `list_models`, `ping`, `complete` →
  `TokenStream`) has three HTTP adapters in `infrastructure/`:
  - `OllamaProvider`: `POST /api/chat`, NDJSON stream; default `http://localhost:11434`.
  - `OpenAiProvider`: `/models` + `/chat/completions`, SSE, optional bearer key. It serves LM
    Studio (default `http://localhost:1234/v1`), any custom OpenAI-compatible URL, and hosted
    OpenAI (default model `gpt-4.1-mini`).
  - `AnthropicProvider`: `api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`;
    default model `claude-sonnet-5-5` (`domain/dest.rs`).
  All three share one `reqwest` client with a 5 s connect timeout and no overall timeout, because
  local models can stream for a long time. Dropping the stream aborts the request, and that is
  the whole cancel mechanism.
- **Local is decided by URL.** `dest::host_of` treats only `localhost`, `127.x` IPv4 literals
  and `[::1]` as local. A LAN address counts as remote even when the runtime is "Ollama". The UI
  colours the destination chip from this: accent for local, amber for remote.
- **Gates live in Rust** (`application.rs`, `dest::state_for`). The assistant is enabled per
  saved connection (`aiEnabledFor`) and is always off with no workspace open. While it is off
  no provider is even constructed, so no model discovery happens either. Production connections
  stay `Locked` until the user allows them by id (`aiAllowed`). `rows_allowed` is `!production`,
  whether or not the connection is allowed. Production is resolved from the connection registry,
  not from anything the renderer sends.
- **Build once, show, send.** `assistant_prepare` introspects the schema, builds the prompt
  (`domain/prompt.rs::build_prompt`, with `[system]`/`[schema]`/`[sample rows]`/`[query]`/
  `[plan]`/`[error]`/`[request]` sections) and parks the text under an id. The renderer shows that
  exact text for review. `assistant_send` re-checks every gate, logs the parked text and streams
  it to the provider over a Tauri `Channel`. Other commands: `assistant_cancel`, `_discard`,
  `_describe`, `_schema`, `_models`, `_test`, `_key_info/_set/_remove`, `_log_read/_clear`.
- **Settings travel with each call.** The `ai*` keys sit in the main `Settings` blob (ADR-0049).
  The renderer passes them with every command instead of having Rust read `settings.json`. The
  reason is recorded in the `commands.rs` header: the mirror is written fire-and-forget, so
  reading it back added no trust and opened a stale-switch window.
- **Engines.** `engines.rs::Conn` covers SQL, Cassandra (CQL), DynamoDB (PartiQL), MongoDB,
  Typesense and Redis behind one enum, so the use-cases never branch on engine. MongoDB fields
  come from `infer_schema`. Redis "schema" is key patterns with id-like segments masked
  (`domain::key_pattern`, e.g. `user:*:session`), and Redis values are never sent. Plan and Index
  prompts are SQL-only (`Language::supports`).
- **Secrets and log.** API keys go to the OS keychain under the service `bytetable.assistant`
  (ADR-0004). `assistant-keys.json` stores only masked labels (`sk-ant-••••3f9a`), so the UI can
  render without a keychain read, which can prompt on macOS. `assistant-log.jsonl` keeps prompts
  only, never responses or keys, capped at 500 entries.
- **Renderer** (`src/features/assistant/`). The SQL tab hosts `AiPanel` and `AiFix` (on the error
  card). `AiWorkspaceHost` puts the same drawer on the non-SQL workspaces, where "Use in terminal"
  injects the command into the docked shell (ADR-0051) without running it. `logic.ts::validateFor`
  checks generated code locally against the introspected schema: tables and columns for SQL/CQL,
  table/collection names and read-vs-write elsewhere. Chat sessions are in memory only
  (`state.ts`). The UI carries an "Alpha" tag (`AiAlphaTag`, `278669a`).

## Alternatives considered

- **Bundle a model or runtime.** Rejected: ByteTable ships no model. A
  bundled model would also add gigabytes to the installers (inferred).
- **Gate only in the UI.** Rejected. The module docs make the backend the copy that refuses,
  which is the same pattern as read-only enforcement (ADR-0006). The renderer keeps a display copy
  of the rules.
- **A provider SDK per vendor.** Inferred: the three wire formats are small enough to hand-write
  over `reqwest`, which is already a dependency, and the wire tests in `infrastructure/mod.rs`
  pin them against a local chunked server.
- **Validate on a real SQL parser.** This was the original plan. The shipped `validate` is a
  conservative hand-written shape check in TypeScript that lets through names it cannot place.

## Consequences

- **Positive:** Nothing is sent until the user turns the assistant on for a specific connection,
  and the reviewed bytes are the sent bytes. One drawer and one prompt contract serve six query
  languages.
- **Negative / trade-offs:** Token counts are an estimate (`chars / 3.7`, shown with "≈"); no
  provider tokenizer is used. Quality depends on the user's model. Hosted vendors are fixed to
  Anthropic and OpenAI-compatible. Chat history does not survive a restart.
- **Follow-ups:** `state_for` carries a HOOK comment for a read-only-connection lock that has not
  shipped. The Alpha tag marks the feature as still in progress.
