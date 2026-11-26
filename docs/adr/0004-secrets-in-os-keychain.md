# ADR-0004 — Connection secrets live in the OS keychain, never in the registry

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature)
- **Area:** Connections
- **Related:** ADR-0008, ADR-0009, ADR-0048, `docs/M12-mysql-postgres-ssh-tls.md`

## Context

Saved connections are persisted as plain JSON (`connections.json` in the app
config dir, `JsonFileConnectionRepository`). Server engines need a database
password. Tunnelled connections also need an SSH key passphrase or bastion
password. DynamoDB static keys need a secret access key. A cross-cutting
requirement is that secrets live in the OS keychain (`keyring` crate). The
keychain store shipped with M12 Task 3 (`0a12290`, 2026-06-13).

## Decision

- **Secret-free wire and disk types.** `ConnectionParams` server variants have no
  password field. `SshAuth` (`Key { key_path } | Password | Agent`) and
  `DynamoAuth::Keys { access_key_id }` carry only non-secret metadata
  (`src-tauri/src/shared/ports/sql/params.rs`). The SSH private key file itself
  is never copied. Only its path is stored.
- **Port + adapter** in `src-tauri/src/features/connections/secrets.rs`:
  - `SecretStore` trait with `set` / `get` / `delete`. Deleting a missing entry
    is not an error.
  - `KeyringSecretStore` uses `keyring` 3 with `apple-native`, `windows-native`
    and `sync-secret-service` (macOS Keychain, Windows Credential Manager,
    Secret Service).
  - `InMemorySecretStore` (`#[cfg(test)]`) lets the save/open/delete
    orchestration be unit-tested without the OS keychain.
- **Key scheme:** service `"ByteTable"`; account `{connection_id}` for the DB
  password (or DynamoDB secret key), and `{connection_id}:ssh` for the SSH
  secret. `db_account` / `ssh_account` are the single source of truth. The AI
  assistant reuses the adapter under its own service via
  `KeyringSecretStore::with_service(features::assistant::infrastructure::KEYCHAIN_SERVICE)`
  (ADR-0048).
- **Flow** (module docs):
  - `connection_save` writes only the secrets that were supplied. An empty
    field keeps the stored secret.
  - `connection_open` reads the keychain, but a secret typed into the form
    during this attempt (a transient secret) takes precedence.
  - `connection_test` uses only the transient secret and never touches the
    keychain.
  - `connection_delete` removes both entries on a best-effort basis.
  - Since `5861bbe` (2026-06-14), open no longer reads keychain items the
    connection does not use, which had caused a double prompt.
- **Process-lifetime cache.** `KeyringSecretStore` caches hits *and* misses, so
  each account touches the keychain at most once per session. The secret is
  already in RAM in the live pool, so the comment says this "adds no new
  exposure". `lib.rs` builds one `Arc<dyn SecretStore>` shared by `connections`
  and `connection_bundle`, so the cache is shared too.
- **Dev keychain prompts.** `scripts/codesign-dev.sh` addresses them; `make dev-cert`
  runs its `setup`. Ad-hoc-signed debug builds get a new designated requirement
  on every rebuild, so macOS re-prompts. `setup` reuses an existing codesigning
  identity or creates a self-signed "ByteTable Dev" one. `make build-debug` /
  `make run` then call `sign` with `--identifier com.bytetable.app`. After one
  "Always Allow", later builds stop prompting. On non-macOS the script exits 0.

## Alternatives considered

- **Encrypt secrets into the JSON registry with an app key.** Not recorded.
  Inferred: the key would have to live on disk next to the file, which adds
  little, and the keychain was already a requirement.
- **Store secrets in plaintext in `connections.json`.** Excluded by the keychain
  requirement and by the type design above.
- **No cache, read the keychain on every open.** This was the first behaviour. It
  was replaced because dev builds prompted repeatedly
  (`secrets.rs`, "Why the cache").

## Consequences

- **Positive:** the registry file and the renderer never hold a secret. Users can
  revoke secrets with OS tools. The design is testable without the OS keychain.
- **Negative / trade-offs:** prompts depend on the OS (macOS asks per binary
  signature). The keychain can be unavailable, for example a Linux desktop with
  no Secret Service; that surfaces as `AppError::Io("the OS keychain is
  unavailable …")`. Secrets do not follow the registry file between machines,
  which is why the encrypted bundle exists (ADR-0009). The cache keeps secrets
  in memory until the app quits.
- **Follow-ups:** `codesign-dev.sh` still uses `BUNDLE_ID="com.bytetable.app"`,
  while `tauri.conf.json`'s identifier has been `com.bytetable.desktop` since
  `92d8403` (2026-07-02). This is harmless for the dev ACL but inconsistent.
