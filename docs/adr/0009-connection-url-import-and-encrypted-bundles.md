# ADR-0009 — Connection import from URL/ODBC strings, and encrypted `.btbundle` files

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-08-13 (first commit that shipped the feature)
- **Area:** Connections
- **Related:** ADR-0003, ADR-0004, ADR-0008

## Context

Two ways of getting connections into ByteTable were missing.

1. Users already have connection strings (`DATABASE_URL`, JDBC URLs, Atlas
   `mongodb+srv://`, Azure/SSMS ADO.NET strings), and retyping them field by
   field is slow and error-prone. Import from URL shipped in `da4389a` and
   `c178fce` on 2026-08-13.
2. Saved connections and their secrets are machine-local: the registry is a JSON
   file and the secrets are in the OS keychain (ADR-0004). Moving them to
   another machine needs a way that involves no cloud sync. The connection
   bundle (M40) shipped in `3773b6b` on 2026-10-26.

## Decision

**Import from URL (`src/features/connections/urlImport.ts`, renderer only)**

- `parseConnUri(raw)` runs on every keystroke in `ImportUrlSheet.tsx`, which is
  an overlay above the connect modal. It never throws. It returns `null`, an
  `ImportError` with a human message, or an `ImportedConnection`, which holds
  only the keys present in the input. `applyImport` in `NewConnectionModal.tsx` fills the form and leaves
  other fields alone. Nothing is saved or connected.
- `IMP_SCHEMES` maps a scheme to an engine and its default port (`postgres`,
  `mysql`/`mariadb`, `sqlserver`/`mssql`, `clickhouse[+http|+https]`,
  `redis`/`rediss`, `mongodb[+srv]`, `cassandra`, `http(s)` → Typesense,
  `sqlite`/`file`). A `jdbc:` prefix is stripped. Schemes in `IMP_SECURE` set
  TLS on, and `sslmode`/`ssl`/`tls` query keys map onto `TlsMode`. Options with
  no form field are kept as `opts` rather than dropped. `mongodb+srv` keeps the
  URI verbatim so driver options survive.
- `IMP_UNSUPPORTED` recognises `oracle`, `neo4j`, `bolt` and returns
  "not supported yet" rather than a parse error.
- `parseKvConnStr` handles the ODBC/ADO.NET `key=value;` dialect (`Server=tcp:host,1433`,
  `host\INSTANCE`). There is no scheme to go on, so the engine is guessed from
  the port (3306 → MySQL, 5432 → Postgres, else SQL Server), and
  `confident: false` tells the sheet to say it is a guess.
- When the URL contains a password, the sheet warns that it "goes to your OS
  keychain on save and is never written into the connection file".

**Encrypted bundles (`src-tauri/src/features/connection_bundle/`, `src/features/connections/bundle.ts`)**

- This is its own slice, `domain ← codec ← application ← commands`. It composes the
  `connections` slice's `ConnectionRepository` and `SecretStore` and uses the same
  `Arc` instances from `lib.rs`. Secrets go keychain → sealed file → keychain and
  never pass through the renderer.
- Commands: `connection_bundle_export(path, ids, passphrase, include_secrets)`
  (empty `ids` means all connections; secrets are included by default),
  `connection_bundle_inspect` (decrypt and preview without writing), and
  `connection_bundle_import(path, passphrase, actions)`. The import actions are
  `skip | import | replace | copy` per entry. By default an entry is imported
  when its id is free and skipped when the id collides. The preview flags
  conflicts and SSH key paths missing on this machine. Passphrases are held in
  `Zeroizing<String>`.
- File format (`domain/mod.rs`): a JSON object with a cleartext header
  (`format: "bytetable-connection-bundle"`, `version: 1`, `kdf`, `cipher`,
  `nonce`) and a base64 `ciphertext`. Three properties are fixed for v1:
  - The header is the AEAD associated data, so a header edited to a weaker
    KDF cost fails the tag check.
  - The header stays readable, so "newer version" errors appear before a
    passphrase is asked for.
  - Entries hold raw connection JSON, so unknown engines survive the round
    trip.
- Crypto (`codec.rs`): Argon2id with a 16-byte salt from `OsRng`, at
  **64 MiB / t=3 / p=1** (`DEFAULT_*_COST`). That is deliberately above RFC
  9106's 19 MiB/t=2 because the threat is offline cracking. The derived
  32-byte key feeds AES-256-GCM with a fresh 12-byte nonce on every seal. Cost
  values read from a file are capped (`MAX_M_COST` 512 MiB, `MAX_T_COST`/`MAX_P_COST`
  16) because the file is untrusted input. A wrong passphrase and a tampered
  file are reported together, as "the passphrase is incorrect, or this bundle has
  been modified …" (`codec.rs`).
- Passphrase policy: `MIN_PASSPHRASE_LEN = 12` is enforced in the Rust use case.
  `passphraseStrength.ts` scores `weak | fair | good | strong` from length,
  character classes and obvious patterns, only to drive the UI meter. It
  deliberately makes no crack-time claim.

## Alternatives considered

- **`new URL()` for parsing.** Rejected in the `urlImport.ts` header: it rejects
  `mongodb+srv://`, mangles comma-separated host lists, and re-encodes
  credentials.
- **Cloud sync or an account.** Rejected. The slice moves connections "with no cloud
  sync, no account and no server".
- **Folding the bundle into `features::connections`.** Rejected. That slice is
  "already the largest", and the file format is a long-lived public contract that
  needs its own version gate.
- **RC versions of `aes-gcm`/`argon2`, which russh already pulls in.** Rejected
  (Cargo.toml): "a release candidate's API moves under us, and the file format …
  has to stay readable by every future build."
- **Exporting the plain registry file.** Not recorded. Inferred: it carries no
  secrets, so a full move would still need re-entering every password.

## Consequences

- **Positive:** a pasted string fills the form, and unsupported or ambiguous input
  is labelled as such. Connections, secrets included, move between machines
  as a single file, protected by authenticated encryption that can detect
  tampering.
- **Negative / trade-offs:** a bundle with secrets is an offline-attackable file,
  only as strong as its passphrase. SSH private keys do not travel, only
  their paths. The ODBC engine guess can be wrong. URL import covers no
  DynamoDB URL form.
- **Follow-ups:** the `codec.rs` module doc still says the default cost is "19 MiB / 2
  passes / 1 lane", which contradicts the shipped `DEFAULT_*_COST` (64 MiB / 3 / 1).
  Only `FORMAT_VERSION = 1` exists, and there is no migration path yet.
