//! Export / inspect / import use-cases for connection bundles (M40).
//!
//! The slice owns no storage of its own. It composes the two ports the
//! connections slice already defines — `ConnectionRepository` for the registry
//! and `SecretStore` for the OS keychain — so secrets travel keychain → bundle
//! → keychain and never take a detour through the registry file or the
//! renderer.
//!
//! The import is deliberately **two steps**: `inspect_bundle` decrypts and
//! reports, writing nothing, and only then does `import_bundle` act on the
//! choices the user made against real contents. A one-shot import would have
//! to guess what to do about id collisions, and the only safe guess (skip
//! everything that exists) is also the one that makes the feature useless for
//! keeping two machines in step.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use zeroize::Zeroizing;

use crate::features::connections::application::copy_name;
use crate::features::connections::domain::SavedConnection;
use crate::features::connections::ports::ConnectionRepository;
use crate::features::connections::secrets::{db_account, ssh_account, SecretStore};
use crate::shared::engine::{ConnectionParams, SshAuth};
use crate::shared::error::AppError;

use super::codec;
use super::domain::{
    detail_from_raw, detail_line, endpoint_fingerprint, Bundle, BundleEntry, BundleEntryPreview,
    BundlePayload, BundlePreview, EntrySecrets, ExportOutcome, ImportAction, ImportFailure,
    ImportOutcome, MIN_PASSPHRASE_LEN,
};

/// Write a bundle of saved connections to `path`.
///
/// `ids` empty means every saved connection; otherwise exactly those, in
/// registry order. An id that does not resolve is an **error**, not a silent
/// omission — a bundle that looks complete but quietly dropped the one
/// connection the user cared about is worse than a failed export.
///
/// `include_secrets = false` still encrypts the file. Host names, ports,
/// database names and usernames are not things to hand around in the clear
/// either; the toggle is about what the *recipient* gets, not about whether the
/// file is protected.
pub fn export_bundle<R: ConnectionRepository + ?Sized, S: SecretStore + ?Sized>(
    repository: &R,
    secret_store: &S,
    path: &Path,
    ids: &[String],
    passphrase: &str,
    include_secrets: bool,
    app_version: &str,
) -> Result<ExportOutcome, AppError> {
    // Enforced here and not only in the modal. The renderer's check is a
    // convenience; this one is the rule. A bundle is a file that may outlive
    // the conversation it was shared in, with unlimited offline guesses against
    // it, so a weak passphrase is a liability for as long as the file exists.
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        return Err(AppError::Invalid(format!(
            "the export passphrase must be at least {MIN_PASSPHRASE_LEN} characters"
        )));
    }

    let all = repository.list()?;
    let selected: Vec<_> = if ids.is_empty() {
        all
    } else {
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let picked: Vec<_> = all
            .into_iter()
            .filter(|c| wanted.contains(&*c.id))
            .collect();
        if picked.len() != wanted.len() {
            let found: HashSet<&str> = picked.iter().map(|c| c.id.as_str()).collect();
            let missing: Vec<&str> = ids
                .iter()
                .map(String::as_str)
                .filter(|id| !found.contains(id))
                .collect();
            return Err(AppError::NotFound(format!(
                "saved connection(s) {} — the list may be out of date; reopen the \
                 export dialog and try again",
                missing.join(", ")
            )));
        }
        picked
    };

    if selected.is_empty() {
        return Err(AppError::Invalid(
            "select at least one connection to export".into(),
        ));
    }

    let mut entries = Vec::with_capacity(selected.len());
    let mut with_secrets = 0usize;
    let mut unreadable_secrets = Vec::new();
    for connection in &selected {
        // Only ask the keychain about accounts that can exist. A SQLite entry
        // or a profile-auth DynamoDB entry has no password, and reading a
        // missing account is a pointless OS round trip (and, on macOS, a
        // pointless access prompt).
        let secrets = if include_secrets {
            let mut denied = false;
            let password = if connection.params.uses_password() {
                read_secret(secret_store, &db_account(&connection.id), &mut denied)
            } else {
                None
            };
            let ssh = if connection.params.ssh().is_some() {
                read_secret(secret_store, &ssh_account(&connection.id), &mut denied)
            } else {
                None
            };
            if denied {
                unreadable_secrets.push(connection.name.clone());
            }
            let found = EntrySecrets { password, ssh };
            if found.is_empty() {
                None
            } else {
                with_secrets += 1;
                Some(found)
            }
        } else {
            None
        };
        entries.push(BundleEntry {
            connection: serde_json::to_value(connection)?,
            secrets,
        });
    }

    let payload = BundlePayload {
        exported_at: now_epoch_ms(),
        app_version: app_version.to_string(),
        connections: entries,
    };
    let bundle = codec::seal(&payload, passphrase)?;
    write_atomically(path, &serde_json::to_vec_pretty(&bundle)?)?;

    Ok(ExportOutcome {
        path: path.display().to_string(),
        count: selected.len(),
        with_secrets,
        unreadable_secrets,
    })
}

/// Read one secret for the export, treating a keychain *failure* as "no secret
/// here" and flagging it, rather than aborting the run.
///
/// This exists because of how macOS actually behaves: every keychain item has
/// its own access ACL, so exporting N connections pops N separate "allow
/// access?" dialogs. With a `?` here, clicking Deny — or mis-clicking — on the
/// seventh of twelve threw the whole export away *after* the user had already
/// answered six prompts, and wrote nothing. Finishing the export and naming the
/// connections whose secret could not be read is both less infuriating and more
/// honest: the params still travel, and the caller reports exactly what did not.
///
/// A genuinely absent secret (`Ok(None)`) is NOT a failure and is not flagged —
/// only an actual error is.
fn read_secret<S: SecretStore + ?Sized>(
    secret_store: &S,
    account: &str,
    denied: &mut bool,
) -> Option<String> {
    match secret_store.get(account) {
        Ok(secret) => secret,
        Err(_) => {
            *denied = true;
            None
        }
    }
}

/// Decrypt a bundle and describe it — **no writes of any kind**.
///
/// This is where the two warnings the user needs before committing are
/// produced; see [`entry_warnings`].
pub fn inspect_bundle<R: ConnectionRepository + ?Sized>(
    repository: &R,
    path: &Path,
    passphrase: &str,
) -> Result<BundlePreview, AppError> {
    let payload = read_and_open(path, passphrase)?;
    let local = local_names_by_id(repository)?;

    let entries = payload
        .connections
        .iter()
        .map(|entry| {
            let params = entry.params();
            let id = entry.id().unwrap_or_default().to_string();
            BundleEntryPreview {
                name: entry.name(),
                engine: entry
                    .connection
                    .get("engine")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                detail: match &params {
                    Some(p) => detail_line(p),
                    None => detail_from_raw(&entry.connection),
                },
                project: entry.connection.get("project").and_then(json_str),
                env: entry.connection.get("env").and_then(json_str),
                has_secrets: entry.secrets.as_ref().is_some_and(|s| !s.is_empty()),
                conflict: local.get(&id).cloned(),
                supported: params.is_some(),
                warnings: entry_warnings(entry),
                replace_warning: replace_warning(repository, &id, entry, params.as_ref()),
                id,
            }
        })
        .collect();

    Ok(BundlePreview {
        exported_at: payload.exported_at,
        app_version: payload.app_version,
        entries,
    })
}

/// The warning shown against **Replace** when accepting it would repoint an
/// existing connection at a different destination while leaving the password
/// already stored on this machine in place.
///
/// That combination is the one import outcome that can send a live credential
/// somewhere it has never been sent before, and it is not hypothetical: a
/// bundle hands every recipient the exporter's connection **ids**, so someone
/// who legitimately received one can return a doctored bundle reusing those ids
/// with the hosts changed and the secrets omitted. `write_entry` honours
/// `connection_save`'s "absent means keep" rule, so the local password survives
/// the replace and is then offered to the new host.
///
/// Returns `None` when the bundle carries its own secret for the entry (nothing
/// local is reused), when the destination is unchanged, when there is no local
/// entry to replace, or for an engine with no password to misdirect.
///
/// **Reads no secrets.** Whether a password is actually stored would require a
/// keychain `get` per conflicting row — one OS access prompt each, during a
/// step whose whole purpose is to preview without side effects. So the warning
/// is phrased for the password that *may* be stored rather than asserting one
/// is, which is the honest claim available at zero cost.
fn replace_warning<R: ConnectionRepository + ?Sized>(
    repository: &R,
    id: &str,
    entry: &BundleEntry,
    incoming: Option<&ConnectionParams>,
) -> Option<String> {
    // The bundle brings its own credential — nothing local gets reused.
    if entry.secrets.as_ref().is_some_and(|s| s.password.is_some()) {
        return None;
    }
    let incoming = incoming?;
    if !incoming.uses_password() {
        return None;
    }
    let existing = repository.get(id).ok().flatten()?;
    if endpoint_fingerprint(&existing.params) == endpoint_fingerprint(incoming) {
        return None;
    }
    Some(format!(
        "Replacing this changes where “{}” connects — from {} to {} — and this \
         bundle brings no password of its own, so the password already saved on \
         this machine would be sent to the new destination. Only replace it if \
         you trust whoever produced this bundle.",
        existing.name,
        detail_line(&existing.params),
        detail_line(incoming),
    ))
}

/// What the user should know about an entry before importing it.
///
/// Only one warning is produced today, and it is the reason the preview step
/// exists at all rather than importing straight from the file picker: an
/// `SshAuth::Key` carries an **absolute path** to a private key on the
/// *exporting* machine. Inspect runs on the importing one, so it can simply
/// check — and warns only when the file really is missing, rather than crying
/// wolf on the common case of two machines with the same `~/.ssh` layout.
fn entry_warnings(entry: &BundleEntry) -> Vec<String> {
    let mut warnings = Vec::new();
    if let Some(params) = entry.params() {
        if let Some(SshAuth::Key { key_path }) = params.ssh().map(|s| &s.auth) {
            if !Path::new(key_path).exists() {
                warnings.push(format!(
                    "This connection tunnels through SSH using the private key \
                     {key_path}, which does not exist on this machine. It will \
                     import, but you will need to point it at a local key before \
                     it can connect."
                ));
            }
        }
    }
    warnings
}

/// Apply a bundle to the local registry, one entry at a time.
///
/// `actions` is keyed by the entry's bundle id; an entry the renderer did not
/// name falls back to [`ImportAction::default_for`] — import when the id is
/// free, skip when it collides.
///
/// A single entry failing (an unwritable keychain, a malformed row) is recorded
/// in [`ImportOutcome::failed`] and the rest still import. Aborting the batch
/// would leave the user with a half-applied registry and no way to tell which
/// half.
pub fn import_bundle<R: ConnectionRepository + ?Sized, S: SecretStore + ?Sized>(
    repository: &R,
    secret_store: &S,
    path: &Path,
    passphrase: &str,
    actions: &HashMap<String, ImportAction>,
) -> Result<ImportOutcome, AppError> {
    let payload = read_and_open(path, passphrase)?;
    let local = local_names_by_id(repository)?;
    // Taken names are collected once and kept current as copies are written, so
    // importing two colliding entries in one pass cannot mint the same
    // "Copy of …" name twice.
    let mut taken = local_names(repository)?;

    let mut outcome = ImportOutcome::default();
    for entry in &payload.connections {
        let Some(id) = entry.id().map(str::to_string) else {
            outcome.failed.push(ImportFailure {
                name: entry.name(),
                reason: "this entry has no id and cannot be imported".into(),
            });
            continue;
        };
        // The decrypted payload is UNTRUSTED. Decryption proves the file was
        // not altered in transit; it says nothing about whoever authored it.
        if let Err(reason) = validate_entry(&id, entry) {
            outcome.failed.push(ImportFailure {
                name: entry.name(),
                reason,
            });
            continue;
        }
        let conflicted = local.contains_key(&id);
        let action = actions
            .get(&id)
            .copied()
            .unwrap_or_else(|| ImportAction::default_for(conflicted));

        let result = match action {
            ImportAction::Skip => {
                outcome.skipped += 1;
                continue;
            }
            ImportAction::Import | ImportAction::Replace => write_entry(
                repository,
                secret_store,
                entry,
                &id,
                entry.connection.clone(),
            ),
            ImportAction::Copy => {
                let new_id = uuid::Uuid::new_v4().to_string();
                let name = copy_name(&entry.name(), &taken);
                let mut raw = entry.connection.clone();
                if let Some(object) = raw.as_object_mut() {
                    object.insert("id".into(), serde_json::Value::String(new_id.clone()));
                    object.insert("name".into(), serde_json::Value::String(name.clone()));
                    object.insert("createdAt".into(), serde_json::json!(now_epoch_ms()));
                }
                let written = write_entry(repository, secret_store, entry, &new_id, raw);
                if written.is_ok() {
                    taken.push(name);
                }
                written
            }
        };

        match result {
            Ok(()) => match action {
                ImportAction::Import => outcome.imported += 1,
                ImportAction::Replace => outcome.replaced += 1,
                ImportAction::Copy => outcome.copied += 1,
                ImportAction::Skip => unreachable!("skip returns above"),
            },
            Err(err) => outcome.failed.push(ImportFailure {
                name: entry.name(),
                reason: err.to_string(),
            }),
        }
    }
    Ok(outcome)
}

/// Reject a bundle entry that cannot have come from a legitimate export.
///
/// Two checks, each closing a concrete hole in the import boundary.
///
/// **1. The id must be a UUID.** It is used verbatim as a keychain account, and
/// that namespace is ambiguous: `db_account(id) = id` while
/// `ssh_account(id) = "{id}:ssh"`, so an entry whose id is `"<other-uuid>:ssh"`
/// writes its password straight over *another* connection's SSH secret. Worse,
/// such an id matches nothing in the registry, so the conflict check reports no
/// collision and the default action is `Import` — the Skip-on-conflict guard,
/// which is the main safety property of this whole flow, never engages. Every
/// id ByteTable mints is a v4 UUID (`save_connection` assigns one whenever the
/// id is blank, and every save path sends it blank for new entries), so this
/// rejects nothing legitimate and closes the entire class rather than one case.
///
/// **2. `engine` must agree with `params`.** `save_connection` enforces exactly
/// this and refuses the mismatch; `save_raw` writes verbatim and cannot. Left
/// unchecked, an entry can claim `"engine": "sqlite"` — a local file that
/// plausibly needs no password — while its params dial a remote server, and the
/// connect screen believes the badge. Entries this build cannot parse at all
/// are untouched: those are the genuine unknown-engine rows `save_raw` exists
/// to carry, and there is nothing to cross-check them against.
fn validate_entry(id: &str, entry: &BundleEntry) -> Result<(), String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(format!(
            "its id ({id}) is not a valid identifier, so it was not produced by \
             a ByteTable export and has been refused"
        ));
    }
    if let Ok(parsed) = serde_json::from_value::<SavedConnection>(entry.connection.clone()) {
        if parsed.engine != parsed.params.engine() {
            return Err(format!(
                "it claims to be a {} connection but its settings are for {}",
                parsed.engine.display_name(),
                parsed.params.engine().display_name(),
            ));
        }
    }
    Ok(())
}

/// Write one entry's registry row and its secrets under `target_id`.
///
/// Secrets follow `connection_save`'s long-standing "absent means keep" rule:
/// a bundle exported *without* secrets does not blank the password of the
/// connection it replaces. The alternative — treating absence as "clear it" —
/// would turn a secret-free bundle into a destructive operation, which is the
/// opposite of what someone who ticked "don't include passwords" expects.
fn write_entry<R: ConnectionRepository + ?Sized, S: SecretStore + ?Sized>(
    repository: &R,
    secret_store: &S,
    entry: &BundleEntry,
    target_id: &str,
    raw: serde_json::Value,
) -> Result<(), AppError> {
    repository.save_raw(&raw)?;
    if let Some(secrets) = &entry.secrets {
        if let Some(password) = secrets.password.as_deref().filter(|p| !p.is_empty()) {
            secret_store.set(&db_account(target_id), password)?;
        }
        if let Some(ssh) = secrets.ssh.as_deref().filter(|s| !s.is_empty()) {
            secret_store.set(&ssh_account(target_id), ssh)?;
        }
    }
    Ok(())
}

/// Read a bundle file and unseal it.
///
/// The passphrase is copied into a `Zeroizing` so the plaintext does not
/// linger in freed memory once the call returns — the derived key is wiped
/// inside the codec, but the passphrase itself is the caller's.
fn read_and_open(path: &Path, passphrase: &str) -> Result<BundlePayload, AppError> {
    let contents = fs::read_to_string(path).map_err(|err| {
        AppError::Io(format!(
            "the bundle {} could not be read ({err}).",
            path.display()
        ))
    })?;
    let bundle: Bundle = serde_json::from_str(&contents)
        .map_err(|_| AppError::Invalid("this file is not a ByteTable connection bundle.".into()))?;
    let passphrase = Zeroizing::new(passphrase.to_string());
    codec::open(&bundle, &passphrase)
}

/// id → name for every LOCAL registry entry, parseable or not. Unsupported
/// rows are included deliberately: their ids are just as taken as any other's,
/// and reporting a collision the user cannot see on the connect screen is far
/// better than silently overwriting it.
fn local_names_by_id<R: ConnectionRepository + ?Sized>(
    repository: &R,
) -> Result<HashMap<String, String>, AppError> {
    let mut map: HashMap<String, String> = repository
        .list()?
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect();
    for unsupported in repository.list_unsupported()? {
        map.insert(unsupported.id, unsupported.name);
    }
    Ok(map)
}

fn local_names<R: ConnectionRepository + ?Sized>(repository: &R) -> Result<Vec<String>, AppError> {
    Ok(local_names_by_id(repository)?.into_values().collect())
}

fn json_str(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

/// Temp sibling + rename, matching `JsonFileConnectionRepository::write_raw`:
/// a crash mid-write must never leave a half-written bundle that looks
/// importable.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_extension("btbundle.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::connections::domain::{Env, SavedConnection, UnsupportedConnection};
    use crate::features::connections::secrets::InMemorySecretStore;
    use crate::shared::engine::{ConnectionParams, Engine, TlsMode};
    use std::sync::Mutex;

    /// A registry fake that keeps RAW entries, like the real JSON adapter — so
    /// the unknown-engine round trip is actually exercised rather than being
    /// quietly parsed away by a `Vec<SavedConnection>` fake.
    #[derive(Default)]
    struct FakeRepo {
        entries: Mutex<Vec<serde_json::Value>>,
    }

    impl FakeRepo {
        fn with(connections: &[SavedConnection]) -> Self {
            Self {
                entries: Mutex::new(
                    connections
                        .iter()
                        .map(|c| serde_json::to_value(c).unwrap())
                        .collect(),
                ),
            }
        }
        fn raw(&self, id: &str) -> Option<serde_json::Value> {
            self.entries
                .lock()
                .unwrap()
                .iter()
                .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id))
                .cloned()
        }
        fn len(&self) -> usize {
            self.entries.lock().unwrap().len()
        }
    }

    impl ConnectionRepository for FakeRepo {
        fn list(&self) -> Result<Vec<SavedConnection>, AppError> {
            Ok(self
                .entries
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| serde_json::from_value(e.clone()).ok())
                .collect())
        }
        fn list_unsupported(&self) -> Result<Vec<UnsupportedConnection>, AppError> {
            Ok(self
                .entries
                .lock()
                .unwrap()
                .iter()
                .filter(|e| serde_json::from_value::<SavedConnection>((*e).clone()).is_err())
                .filter_map(|e| {
                    let s = |k: &str| e.get(k).and_then(|v| v.as_str()).map(str::to_string);
                    Some(UnsupportedConnection {
                        id: s("id")?,
                        name: s("name").unwrap_or_else(|| "(unnamed)".into()),
                        engine: s("engine").unwrap_or_else(|| "unknown".into()),
                        env: s("env"),
                        project: s("project"),
                        color: s("color"),
                        reason: "unknown engine".into(),
                    })
                })
                .collect())
        }
        fn get(&self, id: &str) -> Result<Option<SavedConnection>, AppError> {
            Ok(self.list()?.into_iter().find(|c| c.id == id))
        }
        fn save(&self, connection: &SavedConnection) -> Result<(), AppError> {
            self.save_raw(&serde_json::to_value(connection)?)
        }
        fn save_raw(&self, entry: &serde_json::Value) -> Result<(), AppError> {
            let id = entry
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::Invalid("no id".into()))?
                .to_string();
            let mut entries = self.entries.lock().unwrap();
            match entries
                .iter_mut()
                .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(&id))
            {
                Some(slot) => *slot = entry.clone(),
                None => entries.push(entry.clone()),
            }
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), AppError> {
            self.entries
                .lock()
                .unwrap()
                .retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(id));
            Ok(())
        }
    }

    fn pg(id: &str, name: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: name.into(),
            engine: Engine::Postgres,
            params: ConnectionParams::Postgres {
                host: "db.example.com".into(),
                port: 5432,
                database: Some("shop".into()),
                user: Some("app".into()),
                tls_mode: TlsMode::Require,
                ssh: None,
            },
            env: Env::Production,
            color: None,
            project: Some("ByteShop".into()),
            read_only: false,
            created_at: Some(1_700_000_000_000),
        }
    }

    fn sqlite(id: &str, name: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: name.into(),
            engine: Engine::Sqlite,
            params: ConnectionParams::Sqlite {
                path: "/tmp/dev.db".into(),
            },
            env: Env::Dev,
            color: None,
            project: None,
            read_only: false,
            created_at: Some(1_700_000_000_000),
        }
    }

    const PASS: &str = "a good long passphrase";

    struct Fixture {
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("bundle.btbundle");
            Self { _dir: dir, path }
        }
    }

    fn export<S: SecretStore + ?Sized>(
        repo: &FakeRepo,
        secrets: &S,
        path: &Path,
        ids: &[String],
        include_secrets: bool,
    ) -> ExportOutcome {
        export_bundle(
            repo,
            secrets,
            path,
            ids,
            PASS,
            include_secrets,
            "0.0.41-test",
        )
        .unwrap()
    }

    #[test]
    fn a_bundle_round_trips_connections_and_their_secrets() {
        let f = Fixture::new();
        let source = FakeRepo::with(&[
            pg("11111111-1111-4111-8111-111111111111", "Prod"),
            sqlite("22222222-2222-4222-8222-222222222222", "Local"),
        ]);
        let source_secrets = InMemorySecretStore::default();
        source_secrets
            .set(
                &db_account("11111111-1111-4111-8111-111111111111"),
                "hunter2",
            )
            .unwrap();

        let out = export(&source, &source_secrets, &f.path, &[], true);
        assert_eq!(out.count, 2);
        assert_eq!(out.with_secrets, 1, "SQLite carries no secret");

        let target = FakeRepo::default();
        let target_secrets = InMemorySecretStore::default();
        let result =
            import_bundle(&target, &target_secrets, &f.path, PASS, &HashMap::new()).unwrap();

        assert_eq!(result.imported, 2);
        assert!(result.failed.is_empty());
        // The id is preserved, which is what lets a second import of an updated
        // bundle update in place rather than duplicating.
        assert_eq!(
            target
                .get("11111111-1111-4111-8111-111111111111")
                .unwrap()
                .unwrap()
                .name,
            "Prod"
        );
        assert_eq!(
            target_secrets
                .get(&db_account("11111111-1111-4111-8111-111111111111"))
                .unwrap()
                .as_deref(),
            Some("hunter2")
        );
    }

    #[test]
    fn re_importing_the_same_bundle_changes_nothing_by_default() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "Prod")]);
        let secrets = InMemorySecretStore::default();
        secrets
            .set(
                &db_account("11111111-1111-4111-8111-111111111111"),
                "hunter2",
            )
            .unwrap();
        export(&repo, &secrets, &f.path, &[], true);

        // Local edit after the export.
        repo.save(&pg(
            "11111111-1111-4111-8111-111111111111",
            "Prod (renamed)",
        ))
        .unwrap();

        let result = import_bundle(&repo, &secrets, &f.path, PASS, &HashMap::new()).unwrap();
        assert_eq!(result.skipped, 1);
        assert_eq!(result.imported, 0);
        assert_eq!(
            repo.get("11111111-1111-4111-8111-111111111111")
                .unwrap()
                .unwrap()
                .name,
            "Prod (renamed)",
            "a colliding id must never be silently overwritten"
        );
    }

    #[test]
    fn replace_overwrites_the_entry_and_its_secrets() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "Prod")]);
        let secrets = InMemorySecretStore::default();
        secrets
            .set(
                &db_account("11111111-1111-4111-8111-111111111111"),
                "old-password",
            )
            .unwrap();
        export(&repo, &secrets, &f.path, &[], true);

        repo.save(&pg(
            "11111111-1111-4111-8111-111111111111",
            "Prod (renamed)",
        ))
        .unwrap();
        secrets
            .set(
                &db_account("11111111-1111-4111-8111-111111111111"),
                "local-password",
            )
            .unwrap();

        let actions = HashMap::from([(
            "11111111-1111-4111-8111-111111111111".to_string(),
            ImportAction::Replace,
        )]);
        let result = import_bundle(&repo, &secrets, &f.path, PASS, &actions).unwrap();

        assert_eq!(result.replaced, 1);
        assert_eq!(
            repo.get("11111111-1111-4111-8111-111111111111")
                .unwrap()
                .unwrap()
                .name,
            "Prod"
        );
        assert_eq!(
            secrets
                .get(&db_account("11111111-1111-4111-8111-111111111111"))
                .unwrap()
                .as_deref(),
            Some("old-password")
        );
    }

    /// A secret-free bundle must not blank the password of what it replaces —
    /// the same "absent means keep" rule `connection_save` follows.
    #[test]
    fn replace_from_a_secret_free_bundle_keeps_the_existing_secret() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "Prod")]);
        let secrets = InMemorySecretStore::default();
        secrets
            .set(
                &db_account("11111111-1111-4111-8111-111111111111"),
                "keep-me",
            )
            .unwrap();
        let out = export(&repo, &secrets, &f.path, &[], false);
        assert_eq!(out.with_secrets, 0);

        let actions = HashMap::from([(
            "11111111-1111-4111-8111-111111111111".to_string(),
            ImportAction::Replace,
        )]);
        import_bundle(&repo, &secrets, &f.path, PASS, &actions).unwrap();

        assert_eq!(
            secrets
                .get(&db_account("11111111-1111-4111-8111-111111111111"))
                .unwrap()
                .as_deref(),
            Some("keep-me")
        );
    }

    #[test]
    fn copy_mints_a_new_id_and_a_copy_of_name_and_leaves_the_original_alone() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "Prod")]);
        let secrets = InMemorySecretStore::default();
        secrets
            .set(
                &db_account("11111111-1111-4111-8111-111111111111"),
                "hunter2",
            )
            .unwrap();
        export(&repo, &secrets, &f.path, &[], true);

        let actions = HashMap::from([(
            "11111111-1111-4111-8111-111111111111".to_string(),
            ImportAction::Copy,
        )]);
        let result = import_bundle(&repo, &secrets, &f.path, PASS, &actions).unwrap();

        assert_eq!(result.copied, 1);
        assert_eq!(repo.len(), 2);
        let copy = repo
            .list()
            .unwrap()
            .into_iter()
            .find(|c| c.id != "11111111-1111-4111-8111-111111111111")
            .expect("a second entry was written");
        assert_eq!(copy.name, "Copy of Prod");
        assert_eq!(
            copy.project.as_deref(),
            Some("ByteShop"),
            "grouping survives"
        );
        assert_eq!(
            repo.get("11111111-1111-4111-8111-111111111111")
                .unwrap()
                .unwrap()
                .name,
            "Prod"
        );
        // The copy gets its own keychain entry, so it connects without retyping.
        assert_eq!(
            secrets.get(&db_account(&copy.id)).unwrap().as_deref(),
            Some("hunter2")
        );
    }

    #[test]
    fn exporting_a_selection_takes_exactly_those_connections() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[
            pg("11111111-1111-4111-8111-111111111111", "A"),
            pg("22222222-2222-4222-8222-222222222222", "B"),
            sqlite("33333333-3333-4333-8333-333333333333", "C"),
        ]);
        let secrets = InMemorySecretStore::default();

        let out = export(
            &repo,
            &secrets,
            &f.path,
            &[
                "11111111-1111-4111-8111-111111111111".into(),
                "33333333-3333-4333-8333-333333333333".into(),
            ],
            true,
        );
        assert_eq!(out.count, 2);

        let preview = inspect_bundle(&FakeRepo::default(), &f.path, PASS).unwrap();
        let names: Vec<_> = preview.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["A", "C"]);
    }

    #[test]
    fn exporting_an_unknown_id_fails_rather_than_producing_a_short_bundle() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "A")]);
        let secrets = InMemorySecretStore::default();
        let err = export_bundle(
            &repo,
            &secrets,
            &f.path,
            &[
                "11111111-1111-4111-8111-111111111111".into(),
                "ghost".into(),
            ],
            PASS,
            true,
            "0.0.41",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("ghost"), "{err}");
        assert!(!f.path.exists(), "nothing is written on a failed export");
    }

    #[test]
    fn inspect_reports_conflicts_against_the_local_name_and_writes_nothing() {
        let f = Fixture::new();
        let source = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "Prod")]);
        let secrets = InMemorySecretStore::default();
        export(&source, &secrets, &f.path, &[], true);

        let target = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "My local prod")]);
        let preview = inspect_bundle(&target, &f.path, PASS).unwrap();

        assert_eq!(preview.entries.len(), 1);
        let entry = &preview.entries[0];
        assert_eq!(entry.conflict.as_deref(), Some("My local prod"));
        assert_eq!(entry.detail, "db.example.com:5432 · shop");
        assert_eq!(entry.project.as_deref(), Some("ByteShop"));
        assert!(!entry.has_secrets, "no secret was ever stored for id-1");
        assert!(entry.supported);
        // Unchanged: inspect is read-only.
        assert_eq!(
            target
                .get("11111111-1111-4111-8111-111111111111")
                .unwrap()
                .unwrap()
                .name,
            "My local prod"
        );
    }

    #[test]
    fn the_wrong_passphrase_fails_before_the_preview() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "Prod")]);
        let secrets = InMemorySecretStore::default();
        export(&repo, &secrets, &f.path, &[], true);

        let err = inspect_bundle(&FakeRepo::default(), &f.path, "not it")
            .unwrap_err()
            .to_string();
        assert!(err.contains("passphrase is incorrect"), "{err}");
    }

    #[test]
    fn a_non_bundle_file_is_named_as_such() {
        let f = Fixture::new();
        fs::write(&f.path, b"{\"hello\":1}").unwrap();
        let err = inspect_bundle(&FakeRepo::default(), &f.path, PASS)
            .unwrap_err()
            .to_string();
        assert!(err.contains("not a ByteTable connection bundle"), "{err}");

        fs::write(&f.path, b"not json at all").unwrap();
        let err = inspect_bundle(&FakeRepo::default(), &f.path, PASS)
            .unwrap_err()
            .to_string();
        assert!(err.contains("not a ByteTable connection bundle"), "{err}");
    }

    /// An entry whose engine this build does not know must survive the whole
    /// round trip — that is the reason entries are carried as raw JSON.
    #[test]
    fn an_unknown_engine_entry_round_trips_and_is_flagged_unsupported() {
        let f = Fixture::new();
        let source = FakeRepo::default();
        source
            .save_raw(&serde_json::json!({
                "id": "aaaaaaaa-0000-4000-8000-000000000000",
                "name": "Future DB",
                "engine": "duckdb",
                "params": { "engine": "duckdb", "path": "/tmp/x.duckdb" },
                "env": "dev"
            }))
            .unwrap();
        let secrets = InMemorySecretStore::default();

        // `list()` cannot see it, so an "export all" of an unparseable-only
        // registry has nothing to take — the entry is reachable only once a
        // build that understands it exports it. What we assert here is the
        // import half: a bundle containing one still lands intact.
        let payload = BundlePayload {
            exported_at: 1,
            app_version: "future".into(),
            connections: vec![BundleEntry {
                connection: source.raw("aaaaaaaa-0000-4000-8000-000000000000").unwrap(),
                secrets: None,
            }],
        };
        let bundle = codec::seal(&payload, PASS).unwrap();
        fs::write(&f.path, serde_json::to_vec(&bundle).unwrap()).unwrap();

        let target = FakeRepo::default();
        let preview = inspect_bundle(&target, &f.path, PASS).unwrap();
        assert!(!preview.entries[0].supported);
        assert_eq!(preview.entries[0].engine, "duckdb");
        assert_eq!(preview.entries[0].detail, "/tmp/x.duckdb");

        let result = import_bundle(&target, &secrets, &f.path, PASS, &HashMap::new()).unwrap();
        assert_eq!(result.imported, 1);
        assert_eq!(
            target.raw("aaaaaaaa-0000-4000-8000-000000000000").unwrap()["params"]["path"],
            "/tmp/x.duckdb",
            "the raw entry is preserved byte for byte"
        );
    }

    #[test]
    fn an_id_less_entry_is_reported_and_the_rest_still_import() {
        let f = Fixture::new();
        let payload = BundlePayload {
            exported_at: 1,
            app_version: "t".into(),
            connections: vec![
                BundleEntry {
                    connection: serde_json::json!({ "name": "No id here" }),
                    secrets: None,
                },
                BundleEntry {
                    connection: serde_json::to_value(pg(
                        "22222222-2222-4222-8222-222222222222",
                        "Good",
                    ))
                    .unwrap(),
                    secrets: None,
                },
            ],
        };
        let bundle = codec::seal(&payload, PASS).unwrap();
        fs::write(&f.path, serde_json::to_vec(&bundle).unwrap()).unwrap();

        let repo = FakeRepo::default();
        let secrets = InMemorySecretStore::default();
        let result = import_bundle(&repo, &secrets, &f.path, PASS, &HashMap::new()).unwrap();

        assert_eq!(result.imported, 1, "the good entry still lands");
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].name, "No id here");
    }

    #[test]
    fn an_empty_passphrase_or_an_empty_selection_is_refused() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "A")]);
        let secrets = InMemorySecretStore::default();

        assert!(export_bundle(&repo, &secrets, &f.path, &[], "", true, "v")
            .unwrap_err()
            .to_string()
            .contains("at least"));
        assert!(export_bundle(
            &FakeRepo::default(),
            &secrets,
            &f.path,
            &[],
            PASS,
            true,
            "v"
        )
        .unwrap_err()
        .to_string()
        .contains("at least one connection"));
    }

    /// Seal an arbitrary payload to `path` — for the malicious-bundle tests,
    /// which need to write entries no legitimate export would produce.
    fn seal_to(path: &Path, connections: Vec<BundleEntry>) {
        let payload = BundlePayload {
            exported_at: 1,
            app_version: "attacker".into(),
            connections,
        };
        let bundle = codec::seal(&payload, PASS).unwrap();
        fs::write(path, serde_json::to_vec(&bundle).unwrap()).unwrap();
    }

    /// The keychain-namespace attack: `db_account("X:ssh")` is the same account
    /// as `ssh_account("X")`, and an id of that shape collides with NOTHING in
    /// the registry — so the conflict check sees no collision, the default
    /// action is Import, and the victim's SSH secret is overwritten with no
    /// prompt and no indication of which connection was touched.
    #[test]
    fn an_entry_id_that_targets_another_connections_ssh_account_is_refused() {
        let f = Fixture::new();
        let victim = "7f3a2c1e-0b4d-4a7e-9c11-2d3e4f5a6b7c";
        let repo = FakeRepo::with(&[pg(victim, "Prod via bastion")]);
        let secrets = InMemorySecretStore::default();
        secrets
            .set(&ssh_account(victim), "the-real-bastion-pass")
            .unwrap();

        let mut raw = serde_json::to_value(pg(victim, "Innocent looking")).unwrap();
        raw["id"] = serde_json::json!(format!("{victim}:ssh"));
        seal_to(
            &f.path,
            vec![BundleEntry {
                connection: raw,
                secrets: Some(EntrySecrets {
                    password: Some("attacker-chosen".into()),
                    ssh: None,
                }),
            }],
        );

        let result = import_bundle(&repo, &secrets, &f.path, PASS, &HashMap::new()).unwrap();

        assert_eq!(result.imported, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(
            secrets.get(&ssh_account(victim)).unwrap().as_deref(),
            Some("the-real-bastion-pass"),
            "the victim's SSH secret must be untouched"
        );
    }

    /// Any non-UUID id is refused, not just the `:ssh` shape — the point is to
    /// close the class, so the namespace can never be reached at all.
    #[test]
    fn a_non_uuid_entry_id_is_refused_outright() {
        let f = Fixture::new();
        for hostile in ["../../etc/passwd", "", "admin", "7f3a2c1e-not-a-uuid"] {
            let mut raw = serde_json::to_value(pg("x", "Entry")).unwrap();
            raw["id"] = serde_json::json!(hostile);
            seal_to(
                &f.path,
                vec![BundleEntry {
                    connection: raw,
                    secrets: None,
                }],
            );
            let repo = FakeRepo::default();
            let secrets = InMemorySecretStore::default();
            let result = import_bundle(&repo, &secrets, &f.path, PASS, &HashMap::new()).unwrap();
            assert_eq!(result.imported, 0, "id {hostile:?} must not import");
            assert_eq!(repo.len(), 0, "id {hostile:?} must write nothing");
        }
    }

    /// A real export always carries UUID ids, so the guard costs nothing.
    #[test]
    fn a_genuine_export_still_round_trips_under_the_id_guard() {
        let f = Fixture::new();
        let source = FakeRepo::default();
        let secrets = InMemorySecretStore::default();
        // Save through the real use-case so the id is minted the way the app
        // mints it — this is what proves the guard is not over-tight.
        let saved = crate::features::connections::application::save_connection(
            &source,
            &secrets,
            SavedConnection {
                id: String::new(),
                ..pg("ignored", "Prod")
            },
            &crate::features::connections::application::TransientSecrets::new(
                Some("hunter2".into()),
                None,
            ),
        )
        .unwrap();

        export(&source, &secrets, &f.path, &[], true);

        let target = FakeRepo::default();
        let target_secrets = InMemorySecretStore::default();
        let result =
            import_bundle(&target, &target_secrets, &f.path, PASS, &HashMap::new()).unwrap();
        assert_eq!(result.imported, 1);
        assert!(result.failed.is_empty());
        assert_eq!(
            target_secrets
                .get(&db_account(&saved.id))
                .unwrap()
                .as_deref(),
            Some("hunter2")
        );
    }

    /// `save_raw` bypasses the engine/params consistency rule `save_connection`
    /// enforces, so the import boundary has to re-assert it — otherwise an
    /// entry can wear a SQLite badge while dialling a remote server.
    #[test]
    fn an_entry_whose_engine_contradicts_its_params_is_refused() {
        let f = Fixture::new();
        let mut raw =
            serde_json::to_value(pg("7f3a2c1e-0b4d-4a7e-9c11-2d3e4f5a6b7c", "Looks local"))
                .unwrap();
        raw["engine"] = serde_json::json!("sqlite"); // params stay postgres
        seal_to(
            &f.path,
            vec![BundleEntry {
                connection: raw,
                secrets: None,
            }],
        );

        let repo = FakeRepo::default();
        let secrets = InMemorySecretStore::default();
        let result = import_bundle(&repo, &secrets, &f.path, PASS, &HashMap::new()).unwrap();

        assert_eq!(result.imported, 0);
        assert_eq!(repo.len(), 0);
        let reason = &result.failed[0].reason;
        assert!(
            reason.contains("SQLite") && reason.contains("PostgreSQL"),
            "{reason}"
        );
    }

    /// An unknown-engine entry has no parseable params to cross-check, so the
    /// consistency rule must not catch it — that row is the whole reason the
    /// raw path exists.
    #[test]
    fn an_unknown_engine_entry_passes_the_consistency_check() {
        let f = Fixture::new();
        seal_to(
            &f.path,
            vec![BundleEntry {
                connection: serde_json::json!({
                    "id": "7f3a2c1e-0b4d-4a7e-9c11-2d3e4f5a6b7c",
                    "name": "Future DB",
                    "engine": "duckdb",
                    "params": { "engine": "duckdb", "path": "/tmp/x.duckdb" },
                    "env": "dev"
                }),
                secrets: None,
            }],
        );
        let repo = FakeRepo::default();
        let secrets = InMemorySecretStore::default();
        let result = import_bundle(&repo, &secrets, &f.path, PASS, &HashMap::new()).unwrap();
        assert_eq!(result.imported, 1, "{:?}", result.failed);
    }

    // ---- the Replace redirection warning ---------------------------------

    /// The attack the warning exists for: a bundle reusing the victim's ids,
    /// hosts repointed, secrets omitted — so Replace keeps the local password
    /// and offers it to the attacker's host.
    #[test]
    fn replace_that_repoints_a_connection_without_bringing_a_password_is_flagged() {
        let f = Fixture::new();
        let victim = "7f3a2c1e-0b4d-4a7e-9c11-2d3e4f5a6b7c";
        let local = FakeRepo::with(&[pg(victim, "Prod")]);

        let mut hostile = pg(victim, "Prod");
        hostile.params = ConnectionParams::Postgres {
            host: "bob-relay.example.com".into(),
            port: 5432,
            database: Some("shop".into()),
            user: Some("app".into()),
            tls_mode: TlsMode::Require,
            ssh: None,
        };
        seal_to(
            &f.path,
            vec![BundleEntry {
                connection: serde_json::to_value(&hostile).unwrap(),
                secrets: None,
            }],
        );

        let preview = inspect_bundle(&local, &f.path, PASS).unwrap();
        let warning = preview.entries[0]
            .replace_warning
            .as_deref()
            .expect("a repointing replace must be flagged");
        assert!(warning.contains("db.example.com:5432"), "{warning}");
        assert!(warning.contains("bob-relay.example.com:5432"), "{warning}");
    }

    /// Swapping only the SSH bastion is just as much a redirection, and is
    /// easier to miss than a changed database host.
    #[test]
    fn replace_that_only_swaps_the_ssh_bastion_is_still_flagged() {
        let f = Fixture::new();
        let victim = "7f3a2c1e-0b4d-4a7e-9c11-2d3e4f5a6b7c";
        let local = FakeRepo::with(&[pg(victim, "Prod")]);

        let mut hostile = pg(victim, "Prod");
        hostile.params = ConnectionParams::Postgres {
            host: "db.example.com".into(),
            port: 5432,
            database: Some("shop".into()),
            user: Some("app".into()),
            tls_mode: TlsMode::Require,
            ssh: Some(crate::shared::engine::SshConfig {
                host: "bob-bastion.example.com".into(),
                port: 22,
                user: "tunnel".into(),
                auth: SshAuth::Password,
            }),
        };
        seal_to(
            &f.path,
            vec![BundleEntry {
                connection: serde_json::to_value(&hostile).unwrap(),
                secrets: None,
            }],
        );

        let preview = inspect_bundle(&local, &f.path, PASS).unwrap();
        assert!(preview.entries[0].replace_warning.is_some());
    }

    /// No warning when there is nothing to misdirect: an unchanged endpoint, a
    /// bundle that brings its own password, or a fresh id with no local entry.
    /// Each of these firing would train people to click past the real one.
    #[test]
    fn the_replace_warning_stays_quiet_when_nothing_is_redirected() {
        let victim = "7f3a2c1e-0b4d-4a7e-9c11-2d3e4f5a6b7c";
        let local = FakeRepo::with(&[pg(victim, "Prod")]);

        // Same endpoint, no password in the bundle.
        let same = Fixture::new();
        seal_to(
            &same.path,
            vec![BundleEntry {
                connection: serde_json::to_value(pg(victim, "Prod")).unwrap(),
                secrets: None,
            }],
        );
        assert!(inspect_bundle(&local, &same.path, PASS).unwrap().entries[0]
            .replace_warning
            .is_none());

        // Repointed, but the bundle carries its own password — nothing local
        // is reused, so there is nothing to warn about.
        let withpw = Fixture::new();
        let mut hostile = pg(victim, "Prod");
        hostile.params = ConnectionParams::Postgres {
            host: "elsewhere.example.com".into(),
            port: 5432,
            database: None,
            user: None,
            tls_mode: TlsMode::Require,
            ssh: None,
        };
        seal_to(
            &withpw.path,
            vec![BundleEntry {
                connection: serde_json::to_value(&hostile).unwrap(),
                secrets: Some(EntrySecrets {
                    password: Some("its-own".into()),
                    ssh: None,
                }),
            }],
        );
        assert!(
            inspect_bundle(&local, &withpw.path, PASS).unwrap().entries[0]
                .replace_warning
                .is_none()
        );

        // No local entry with this id at all — this is a plain Import.
        let fresh = Fixture::new();
        seal_to(
            &fresh.path,
            vec![BundleEntry {
                connection: serde_json::to_value(pg("11111111-2222-4333-8444-555555555555", "New"))
                    .unwrap(),
                secrets: None,
            }],
        );
        assert!(
            inspect_bundle(&local, &fresh.path, PASS).unwrap().entries[0]
                .replace_warning
                .is_none()
        );
    }

    /// Warning only — Replace still works. The user was told; the decision is
    /// theirs, exactly as with a legitimately moved database.
    #[test]
    fn a_flagged_replace_is_still_permitted() {
        let f = Fixture::new();
        let victim = "7f3a2c1e-0b4d-4a7e-9c11-2d3e4f5a6b7c";
        let local = FakeRepo::with(&[pg(victim, "Prod")]);
        let secrets = InMemorySecretStore::default();
        secrets.set(&db_account(victim), "local-password").unwrap();

        let mut moved = pg(victim, "Prod");
        moved.params = ConnectionParams::Postgres {
            host: "new-host.example.com".into(),
            port: 5432,
            database: Some("shop".into()),
            user: Some("app".into()),
            tls_mode: TlsMode::Require,
            ssh: None,
        };
        seal_to(
            &f.path,
            vec![BundleEntry {
                connection: serde_json::to_value(&moved).unwrap(),
                secrets: None,
            }],
        );

        assert!(inspect_bundle(&local, &f.path, PASS).unwrap().entries[0]
            .replace_warning
            .is_some());

        let actions = HashMap::from([(victim.to_string(), ImportAction::Replace)]);
        let result = import_bundle(&local, &secrets, &f.path, PASS, &actions).unwrap();
        assert_eq!(result.replaced, 1);
        assert_eq!(
            local.get(victim).unwrap().unwrap().params,
            moved.params,
            "the replace went through"
        );
    }

    /// Inspect must not read secrets: that would cost one OS access prompt per
    /// conflicting row during a step whose point is to preview without side
    /// effects.
    #[test]
    fn inspect_never_touches_the_keychain() {
        let f = Fixture::new();
        let victim = "7f3a2c1e-0b4d-4a7e-9c11-2d3e4f5a6b7c";
        let local = FakeRepo::with(&[pg(victim, "Prod")]);
        let mut hostile = pg(victim, "Prod");
        hostile.params = ConnectionParams::Postgres {
            host: "elsewhere.example.com".into(),
            port: 5432,
            database: None,
            user: None,
            tls_mode: TlsMode::Require,
            ssh: None,
        };
        seal_to(
            &f.path,
            vec![BundleEntry {
                connection: serde_json::to_value(&hostile).unwrap(),
                secrets: None,
            }],
        );
        // The guarantee is structural: `inspect_bundle` takes no `SecretStore`
        // at all, so it cannot read one. This call pins that signature — adding
        // a secret-store parameter to produce a richer warning (e.g. "a
        // password IS stored") would stop compiling here, which is the point.
        // The warning below is produced with zero keychain access.
        let preview = inspect_bundle(&local, &f.path, PASS).unwrap();
        assert!(preview.entries[0].replace_warning.is_some());
    }

    #[test]
    fn an_export_passphrase_below_the_minimum_is_refused_by_the_use_case() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "A")]);
        let secrets = InMemorySecretStore::default();
        // Not merely non-empty: the modal's check is a convenience, this is
        // the rule.
        let err = export_bundle(&repo, &secrets, &f.path, &[], "short", true, "v")
            .unwrap_err()
            .to_string();
        assert!(err.contains("at least"), "{err}");
        assert!(!f.path.exists());
    }

    /// A keychain that refuses to be read, standing in for the user clicking
    /// "Deny" on the macOS access prompt (or a locked/unavailable keychain).
    struct DenyingSecretStore;

    impl SecretStore for DenyingSecretStore {
        fn set(&self, _account: &str, _secret: &str) -> Result<(), AppError> {
            Ok(())
        }
        fn get(&self, _account: &str) -> Result<Option<String>, AppError> {
            Err(AppError::Io("the OS keychain is unavailable".into()))
        }
        fn delete(&self, _account: &str) -> Result<(), AppError> {
            Ok(())
        }
    }

    /// Denying one access prompt must not throw away the whole export — the
    /// user has already answered the earlier prompts by then.
    #[test]
    fn a_denied_keychain_prompt_still_produces_a_bundle_and_names_what_is_missing() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[
            pg("11111111-1111-4111-8111-111111111111", "Prod"),
            sqlite("22222222-2222-4222-8222-222222222222", "Local"),
        ]);

        let out = export(&repo, &DenyingSecretStore, &f.path, &[], true);

        assert!(f.path.exists(), "the bundle is still written");
        assert_eq!(out.count, 2);
        assert_eq!(out.with_secrets, 0);
        // Only the Postgres entry was ASKED about — SQLite has no password, so
        // it is never read and never reported as denied.
        assert_eq!(out.unreadable_secrets, vec!["Prod".to_string()]);

        // And the params still travelled, so the import is useful.
        let preview = inspect_bundle(&FakeRepo::default(), &f.path, PASS).unwrap();
        assert_eq!(preview.entries.len(), 2);
        assert!(preview.entries.iter().all(|e| !e.has_secrets));
    }

    /// A secret that is simply absent is not a failure and must not be reported
    /// as one — otherwise every passwordless server would raise a false alarm.
    #[test]
    fn an_absent_secret_is_not_reported_as_unreadable() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[pg("11111111-1111-4111-8111-111111111111", "Prod")]);
        let secrets = InMemorySecretStore::default();

        let out = export(&repo, &secrets, &f.path, &[], true);
        assert_eq!(out.with_secrets, 0);
        assert!(out.unreadable_secrets.is_empty());
    }

    /// The export must not go fishing in the keychain for engines that have no
    /// secret — on macOS every needless read is a potential access prompt.
    #[test]
    fn a_sqlite_entry_costs_no_keychain_reads() {
        let f = Fixture::new();
        let repo = FakeRepo::with(&[sqlite("11111111-1111-4111-8111-111111111111", "Local")]);
        let secrets = InMemorySecretStore::default();
        // Plant a secret under the SQLite id; a correct export never finds it,
        // because it never asks.
        secrets
            .set(
                &db_account("11111111-1111-4111-8111-111111111111"),
                "should-not-travel",
            )
            .unwrap();

        let out = export(&repo, &secrets, &f.path, &[], true);
        assert_eq!(out.with_secrets, 0);

        let preview = inspect_bundle(&FakeRepo::default(), &f.path, PASS).unwrap();
        assert!(!preview.entries[0].has_secrets);
    }
}
