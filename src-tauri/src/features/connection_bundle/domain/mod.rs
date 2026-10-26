//! The connection-bundle file format and the import/export vocabulary (M40).
//!
//! A **bundle** is a single passphrase-encrypted file holding a set of saved
//! connections *and their keychain secrets*, so a user can move them to another
//! machine without cloud sync. On disk it is one JSON object: a **cleartext
//! header** (format marker, version, KDF parameters, nonce) and one base64
//! `ciphertext` holding the sealed [`BundlePayload`].
//!
//! Three properties of the format are load-bearing and cannot be changed after
//! v1 ships:
//!
//! 1. **The header is the AEAD's associated data.** Everything except
//!    `ciphertext` is re-serialized by [`Bundle::aad`] and authenticated. Without
//!    that, someone who can modify a bundle in transit could rewrite
//!    `kdf.t`/`kdf.m` down to the cheapest possible work factor and the
//!    importing app would derive the key with the weakened parameters quite
//!    happily — the ciphertext would still verify, because the header was never
//!    covered. With it, any edit to the header fails the tag check exactly like
//!    a flipped ciphertext byte.
//! 2. **The header stays cleartext.** It is what lets the import flow say "this
//!    bundle was written by a newer ByteTable" instead of "wrong passphrase",
//!    before even asking for a passphrase. It leaks nothing — a salt and an
//!    Argon2 cost are not secrets.
//! 3. **Entries hold RAW connection JSON**, not a parsed `SavedConnection` —
//!    the same choice `JsonFileConnectionRepository::read_raw` makes, for the
//!    same reason: a bundle written by a build that knows an engine this one
//!    does not must survive the round trip instead of being silently downgraded.

use serde::{Deserialize, Serialize};

use crate::shared::engine::ConnectionParams;
use crate::shared::error::AppError;

/// The `format` marker every bundle carries. A file without it is not ours.
pub const FORMAT: &str = "bytetable-connection-bundle";

/// The format version this build writes, and the highest it can read.
pub const FORMAT_VERSION: u32 = 1;

/// The KDF this build writes. Read support is limited to the same value.
pub const KDF_ALG: &str = "argon2id";

/// The AEAD this build writes. Read support is limited to the same value.
pub const CIPHER: &str = "aes-256-gcm";

/// The conventional file extension (used by both native dialogs).
pub const EXTENSION: &str = "btbundle";

// Argon2id cost. RFC 9106's second recommended option is 19 MiB / t=2 / p=1;
// this deliberately goes above it, to 64 MiB / t=3, because the threat here is
// specifically **offline** cracking — a bundle is a file that may sit in someone
// else's Downloads folder indefinitely, with unlimited guesses against it. The
// usual argument for a low cost (interactive latency) barely applies: this runs
// once per export and once per import, not per keystroke, and 64 MiB/t=3 is a
// few hundred milliseconds on hardware that can run this app at all.
//
// Raising these is always safe: the parameters are read back FROM the file, so
// bundles written at the old cost keep opening.
pub const DEFAULT_M_COST: u32 = 64 * 1024;
pub const DEFAULT_T_COST: u32 = 3;
pub const DEFAULT_P_COST: u32 = 1;

/// Shortest passphrase an export will accept.
///
/// Enforced in the **use-case**, not only in the modal: the renderer's check is
/// a convenience, and a bundle sealed under "1234" is a liability for as long as
/// the file exists. 12 is chosen to be survivable as a passphrase people
/// actually type while making a dictionary attack meaningfully expensive at the
/// Argon2 cost above.
pub const MIN_PASSPHRASE_LEN: usize = 12;

// Ceilings applied to the parameters read OUT of a file. A bundle is untrusted
// input: without these, `"m": 4000000` would have the importer try to allocate
// ~4 GiB before it could even discover the passphrase was wrong. Generous
// enough that a future build can raise its defaults several times over.
pub const MAX_M_COST: u32 = 512 * 1024; // 512 MiB
pub const MAX_T_COST: u32 = 16;
pub const MAX_P_COST: u32 = 16;

/// Argon2id parameters, stored in the clear so the importer can reproduce the
/// derivation. `m` is in KiB, matching Argon2's own units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub alg: String,
    /// Base64 salt (16 random bytes).
    pub salt: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

/// A bundle file, exactly as it is serialized to disk.
///
/// Field order is the serialized order and [`Bundle::aad`] depends on it —
/// reordering these fields changes the associated data and makes every existing
/// bundle unreadable. Don't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bundle {
    pub format: String,
    pub version: u32,
    pub kdf: KdfParams,
    pub cipher: String,
    /// Base64 AES-GCM nonce (12 bytes).
    pub nonce: String,
    /// Base64 ciphertext with the 16-byte GCM tag appended.
    pub ciphertext: String,
}

/// The header fields, in serialized order — the AEAD associated data. A
/// separate struct rather than "the bundle minus one field" so the byte string
/// being authenticated is defined in exactly one place.
#[derive(Serialize)]
struct Aad<'a> {
    format: &'a str,
    version: u32,
    kdf: &'a KdfParams,
    cipher: &'a str,
    nonce: &'a str,
}

impl Bundle {
    /// The canonical associated-data bytes for this bundle's header.
    pub fn aad(&self) -> Result<Vec<u8>, AppError> {
        Ok(serde_json::to_vec(&Aad {
            format: &self.format,
            version: self.version,
            kdf: &self.kdf,
            cipher: &self.cipher,
            nonce: &self.nonce,
        })?)
    }

    /// Reject anything this build cannot read, with a message that names the
    /// actual problem. Runs BEFORE the KDF, so a wrong-format file costs no
    /// Argon2 work and never reports itself as a passphrase failure.
    pub fn validate_header(&self) -> Result<(), AppError> {
        if self.format != FORMAT {
            return Err(AppError::Invalid(
                "this file is not a ByteTable connection bundle.".into(),
            ));
        }
        if self.version > FORMAT_VERSION {
            return Err(AppError::Invalid(format!(
                "this bundle was written by a newer version of ByteTable (bundle \
                 format v{}, this build reads v{FORMAT_VERSION}). Update ByteTable \
                 to import it.",
                self.version
            )));
        }
        if self.kdf.alg != KDF_ALG {
            return Err(AppError::Invalid(format!(
                "this bundle uses an unsupported key derivation ({}).",
                self.kdf.alg
            )));
        }
        if self.cipher != CIPHER {
            return Err(AppError::Invalid(format!(
                "this bundle uses an unsupported cipher ({}).",
                self.cipher
            )));
        }
        // Untrusted cost parameters. Rejected, never clamped: clamping would
        // derive a different key and report the file as a wrong passphrase,
        // which sends the user hunting for a problem that isn't there.
        if self.kdf.m > MAX_M_COST || self.kdf.t > MAX_T_COST || self.kdf.p > MAX_P_COST {
            return Err(AppError::Invalid(
                "this bundle asks for an unreasonable amount of work to unlock it \
                 and has been refused. It is damaged or was not produced by \
                 ByteTable."
                    .into(),
            ));
        }
        Ok(())
    }
}

/// The plaintext sealed inside a bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundlePayload {
    /// Epoch milliseconds, for the import preview's "exported on" line.
    pub exported_at: u64,
    /// The app version that wrote the bundle, for support questions.
    pub app_version: String,
    pub connections: Vec<BundleEntry>,
}

/// One connection in a bundle: its registry JSON verbatim, plus whatever
/// secrets the export was allowed to collect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleEntry {
    /// A raw registry entry — see the module docs on why this is not parsed.
    pub connection: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<EntrySecrets>,
}

impl BundleEntry {
    /// The entry's registry id, when the raw JSON has a usable one.
    pub fn id(&self) -> Option<&str> {
        self.connection.get("id").and_then(|v| v.as_str())
    }

    /// The entry's display name, falling back the way the connect screen does
    /// for an entry it cannot read.
    pub fn name(&self) -> String {
        self.connection
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("(unnamed)")
            .to_string()
    }

    /// The entry's `params`, when this build can parse them. `None` for an
    /// engine it does not know — the entry still imports, it just cannot be
    /// described in detail.
    pub fn params(&self) -> Option<ConnectionParams> {
        serde_json::from_value(self.connection.get("params")?.clone()).ok()
    }
}

/// Secret material for one connection. Both fields are optional: an engine may
/// have no password (SQLite), no SSH secret (no tunnel), or the export may have
/// been run with secrets switched off.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<String>,
}

impl EntrySecrets {
    pub fn is_empty(&self) -> bool {
        self.password.is_none() && self.ssh.is_none()
    }
}

/// What a bundle contains, reported by the inspect step — which decrypts but
/// writes nothing, so the user confirms against real contents rather than
/// against a file name.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundlePreview {
    pub exported_at: u64,
    pub app_version: String,
    pub entries: Vec<BundleEntryPreview>,
}

/// One row of the import preview table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleEntryPreview {
    pub id: String,
    pub name: String,
    /// The raw engine string — it may be one this build does not know.
    pub engine: String,
    /// "host:port · db"-style line, mirroring the connect screen's card detail.
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    /// Whether the bundle carries any secret for this entry.
    pub has_secrets: bool,
    /// The name of the LOCAL connection already using this id, when there is
    /// one. Drives the Skip/Replace/Copy choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    /// Whether this build understands the entry's engine. Unsupported entries
    /// still import — the registry preserves them and the connect screen
    /// already renders them struck-out — but the preview says so up front.
    pub supported: bool,
    /// Things the user should know before importing this entry, e.g. a
    /// referenced SSH key that is not present on this machine.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Set when choosing **Replace** would repoint an existing connection at a
    /// different destination while the password already on this machine stays
    /// in place — the one import outcome that can send a live credential
    /// somewhere it has never been sent before.
    ///
    /// Carried separately from [`Self::warnings`] rather than appended to them
    /// because it is conditional on the chosen action: shown against Replace,
    /// hidden under Skip or Copy, where it does not apply and would be noise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_warning: Option<String>,
}

/// What to do with one entry at import time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportAction {
    /// Leave the local registry untouched for this entry.
    Skip,
    /// Write it under its own id. The default when nothing local uses that id.
    Import,
    /// Overwrite the local entry (and its secrets) that shares this id.
    Replace,
    /// Write it as a new connection with a fresh id and a "Copy of …" name,
    /// leaving the local entry alone.
    Copy,
}

impl ImportAction {
    /// The action applied when the renderer did not name one for an entry.
    ///
    /// A clean id imports; a colliding id **skips**. Never silently overwriting
    /// a connection that already works is the whole reason this defaults rather
    /// than merging: the user who wanted a replace can say so per row, and the
    /// user who re-imported the same bundle by accident loses nothing.
    pub fn default_for(conflicted: bool) -> Self {
        if conflicted {
            Self::Skip
        } else {
            Self::Import
        }
    }
}

/// Per-entry failure, so one bad entry never aborts the rest of the import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub name: String,
    pub reason: String,
}

/// The tally the import toast reads from.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: usize,
    pub replaced: usize,
    pub copied: usize,
    pub skipped: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<ImportFailure>,
}

/// What the export wrote, for the confirmation toast.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub path: String,
    pub count: usize,
    /// How many of them carry secret material.
    pub with_secrets: usize,
    /// Connections whose stored secret could not be READ — the OS keychain
    /// refused or the user denied the access prompt. Their params are in the
    /// bundle; their password is not. Named rather than counted so the user can
    /// tell which ones will need the password retyped on the other machine.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unreadable_secrets: Vec<String>,
}

/// The connect-screen-style detail line for a set of params.
///
/// Mirrors `connectionDetail` in `src/features/connections/api.ts`. It is
/// duplicated here rather than shared because the import preview describes
/// entries whose engine the *renderer* may not be able to parse either — the
/// backend is the only side that can fall back to the raw JSON (see
/// [`detail_from_raw`]).
pub fn detail_line(params: &ConnectionParams) -> String {
    use ConnectionParams as P;
    match params {
        P::Sqlite { path } => path.clone(),
        P::Redis {
            host,
            port,
            db_index,
            ..
        } => format!("{host}:{port} · db{db_index}"),
        P::Dynamodb {
            region, endpoint, ..
        } => format!(
            "{region} · {}",
            if endpoint.is_some() { "Local" } else { "AWS" }
        ),
        P::Mongodb {
            uri,
            host,
            port,
            database,
            ..
        } => match uri {
            Some(uri) => uri.clone(),
            None => host_port_db(host, *port, database.as_deref()),
        },
        P::Cassandra {
            contact_points,
            port,
            keyspace,
            ..
        } => {
            let points = if contact_points.contains(':') {
                contact_points.clone()
            } else {
                format!("{contact_points}:{port}")
            };
            match keyspace {
                Some(ks) => format!("{points} · {ks}"),
                None => points,
            }
        }
        P::Typesense {
            protocol,
            host,
            port,
            default_collection,
            ..
        } => {
            let url = format!("{}://{host}:{port}", protocol.as_scheme());
            match default_collection {
                Some(c) => format!("{url} · {c}"),
                None => url,
            }
        }
        P::Mysql {
            host,
            port,
            database,
            ..
        }
        | P::Postgres {
            host,
            port,
            database,
            ..
        }
        | P::Mssql {
            host,
            port,
            database,
            ..
        }
        | P::Clickhouse {
            host,
            port,
            database,
            ..
        } => host_port_db(host, *port, database.as_deref()),
    }
}

/// A fingerprint of **where a connection sends your credentials**.
///
/// Two params with the same fingerprint authenticate to the same place; a
/// difference means an import would redirect the connection. Used only to
/// decide whether to warn, so it errs toward being sensitive: it folds in the
/// destination ([`detail_line`]), the login name, and the full SSH bastion —
/// swapping only the jump host is just as much a redirection as swapping the
/// database host, and is easier to miss in a list.
///
/// Deliberately NOT a comparison of the whole params struct: TLS mode, a Redis
/// db index or a Typesense node list can differ between two machines for
/// legitimate reasons, and warning about those would train people to click past
/// the warning that matters.
pub fn endpoint_fingerprint(params: &ConnectionParams) -> String {
    let user = match params {
        ConnectionParams::Sqlite { .. } | ConnectionParams::Dynamodb { .. } => None,
        ConnectionParams::Mysql { user, .. }
        | ConnectionParams::Postgres { user, .. }
        | ConnectionParams::Mssql { user, .. }
        | ConnectionParams::Redis { user, .. }
        | ConnectionParams::Mongodb { user, .. }
        | ConnectionParams::Cassandra { user, .. }
        | ConnectionParams::Clickhouse { user, .. } => user.as_deref(),
        ConnectionParams::Typesense { .. } => None,
    };
    let ssh = match params.ssh() {
        Some(cfg) => format!(
            "{}@{}:{} via {}",
            cfg.user,
            cfg.host,
            cfg.port,
            cfg.auth.method_name()
        ),
        None => "direct".to_string(),
    };
    format!("{}|{}|{ssh}", detail_line(params), user.unwrap_or_default())
}

fn host_port_db(host: &str, port: u16, database: Option<&str>) -> String {
    match database.filter(|d| !d.is_empty()) {
        Some(db) => format!("{host}:{port} · {db}"),
        None => format!("{host}:{port}"),
    }
}

/// Best-effort detail line for an entry whose engine this build does not know:
/// read whatever recognisable fields the raw `params` object happens to have.
/// Returns an empty string when there is nothing worth showing — the preview
/// row then shows just the name and the "unsupported" marker.
pub fn detail_from_raw(connection: &serde_json::Value) -> String {
    let Some(params) = connection.get("params") else {
        return String::new();
    };
    let s = |k: &str| params.get(k).and_then(|v| v.as_str());
    if let Some(path) = s("path") {
        return path.to_string();
    }
    if let (Some(host), Some(port)) = (s("host"), params.get("port").and_then(|v| v.as_u64())) {
        return host_port_db(host, port as u16, s("database"));
    }
    s("host").or_else(|| s("uri")).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::TlsMode;

    fn kdf() -> KdfParams {
        KdfParams {
            alg: KDF_ALG.into(),
            salt: "c2FsdA==".into(),
            m: DEFAULT_M_COST,
            t: DEFAULT_T_COST,
            p: DEFAULT_P_COST,
        }
    }

    fn bundle() -> Bundle {
        Bundle {
            format: FORMAT.into(),
            version: FORMAT_VERSION,
            kdf: kdf(),
            cipher: CIPHER.into(),
            nonce: "bm9uY2Vub25jZQ==".into(),
            ciphertext: "Y2lwaGVy".into(),
        }
    }

    #[test]
    fn a_well_formed_header_validates() {
        bundle().validate_header().unwrap();
    }

    #[test]
    fn a_newer_format_version_names_the_version_rather_than_blaming_the_passphrase() {
        let mut b = bundle();
        b.version = 99;
        let err = b.validate_header().unwrap_err().to_string();
        assert!(err.contains("v99"), "{err}");
        assert!(err.contains("newer version"), "{err}");
        assert!(!err.to_lowercase().contains("passphrase"), "{err}");
    }

    #[test]
    fn a_foreign_file_is_rejected_as_not_a_bundle() {
        let mut b = bundle();
        b.format = "something-else".into();
        let err = b.validate_header().unwrap_err().to_string();
        assert!(err.contains("not a ByteTable connection bundle"), "{err}");
    }

    #[test]
    fn unsupported_kdf_and_cipher_are_named() {
        let mut b = bundle();
        b.kdf.alg = "scrypt".into();
        assert!(b
            .validate_header()
            .unwrap_err()
            .to_string()
            .contains("scrypt"));

        let mut b = bundle();
        b.cipher = "rot13".into();
        assert!(b
            .validate_header()
            .unwrap_err()
            .to_string()
            .contains("rot13"));
    }

    #[test]
    fn absurd_kdf_costs_are_refused_before_any_allocation() {
        for mutate in [
            (|b: &mut Bundle| b.kdf.m = 4_000_000) as fn(&mut Bundle),
            |b: &mut Bundle| b.kdf.t = 10_000,
            |b: &mut Bundle| b.kdf.p = 10_000,
        ] {
            let mut b = bundle();
            mutate(&mut b);
            let err = b.validate_header().unwrap_err().to_string();
            assert!(err.contains("unreasonable amount of work"), "{err}");
        }
    }

    #[test]
    fn aad_covers_every_header_field_but_not_the_ciphertext() {
        let base = bundle();
        let aad = base.aad().unwrap();

        // A different ciphertext is the ONE change that leaves the AAD alone
        // (it is authenticated as the message, not as associated data).
        let mut other = base.clone();
        other.ciphertext = "ZGlmZmVyZW50".into();
        assert_eq!(other.aad().unwrap(), aad);

        for mutate in [
            (|b: &mut Bundle| b.version = 2) as fn(&mut Bundle),
            |b: &mut Bundle| b.kdf.m = 1024,
            |b: &mut Bundle| b.kdf.t = 1,
            |b: &mut Bundle| b.kdf.p = 2,
            |b: &mut Bundle| b.kdf.salt = "b3RoZXI=".into(),
            |b: &mut Bundle| b.nonce = "b3RoZXJub25jZQ==".into(),
            |b: &mut Bundle| b.format = "x".into(),
            |b: &mut Bundle| b.cipher = "x".into(),
        ] {
            let mut m = base.clone();
            mutate(&mut m);
            assert_ne!(m.aad().unwrap(), aad, "a header field escaped the AAD");
        }
    }

    #[test]
    fn entry_reads_id_and_name_from_raw_json_and_tolerates_their_absence() {
        let entry = BundleEntry {
            connection: serde_json::json!({ "id": "abc", "name": "Prod" }),
            secrets: None,
        };
        assert_eq!(entry.id(), Some("abc"));
        assert_eq!(entry.name(), "Prod");

        let bare = BundleEntry {
            connection: serde_json::json!({}),
            secrets: None,
        };
        assert_eq!(bare.id(), None);
        assert_eq!(bare.name(), "(unnamed)");
    }

    #[test]
    fn detail_line_matches_the_connect_screen_shapes() {
        assert_eq!(
            detail_line(&ConnectionParams::Sqlite {
                path: "/tmp/dev.db".into()
            }),
            "/tmp/dev.db"
        );
        assert_eq!(
            detail_line(&ConnectionParams::Postgres {
                host: "db.example.com".into(),
                port: 5432,
                database: Some("shop".into()),
                user: None,
                tls_mode: TlsMode::Prefer,
                ssh: None,
            }),
            "db.example.com:5432 · shop"
        );
        // Absent database drops the suffix rather than printing " · ".
        assert_eq!(
            detail_line(&ConnectionParams::Postgres {
                host: "db.example.com".into(),
                port: 5432,
                database: None,
                user: None,
                tls_mode: TlsMode::Prefer,
                ssh: None,
            }),
            "db.example.com:5432"
        );
    }

    #[test]
    fn raw_detail_salvages_what_it_can_from_an_unknown_engine() {
        let raw = serde_json::json!({
            "params": { "engine": "duckdb", "host": "h", "port": 1234, "database": "d" }
        });
        assert_eq!(detail_from_raw(&raw), "h:1234 · d");

        let file = serde_json::json!({ "params": { "engine": "duckdb", "path": "/x.duckdb" } });
        assert_eq!(detail_from_raw(&file), "/x.duckdb");

        assert_eq!(detail_from_raw(&serde_json::json!({})), "");
    }

    #[test]
    fn the_default_action_protects_an_existing_connection() {
        assert_eq!(ImportAction::default_for(false), ImportAction::Import);
        assert_eq!(ImportAction::default_for(true), ImportAction::Skip);
    }
}
