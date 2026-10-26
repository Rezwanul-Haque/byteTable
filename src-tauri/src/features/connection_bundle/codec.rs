//! The bundle crypto: Argon2id → AES-256-GCM (M40).
//!
//! Two functions, [`seal`] and [`open`], and nothing else — every other module
//! in the slice treats the envelope as opaque.
//!
//! ## The construction
//!
//! - **Key derivation**: Argon2id over the user's passphrase with a 16-byte
//!   random salt, at the cost parameters recorded in the bundle header (RFC
//!   9106's second recommended option by default: 19 MiB / 2 passes / 1 lane).
//!   32 bytes out.
//! - **Encryption**: AES-256-GCM with a 12-byte random nonce, over the
//!   JSON-serialized payload, with the **cleartext header as associated data**
//!   (see `domain::Bundle::aad` for why that matters).
//! - **Hygiene**: the derived key and the serialized plaintext are wiped on
//!   drop. The caller's passphrase `&str` is not ours to wipe; the command
//!   layer keeps it in a `Zeroizing<String>`.
//!
//! ## Error vocabulary
//!
//! At the crypto layer a wrong passphrase, a flipped ciphertext byte and an
//! edited header are one and the same failure — GCM just reports "tag
//! mismatch". To the user they are not the same thing at all, so everything
//! this module *can* distinguish is distinguished before the tag check
//! (`validate_header`), and what remains is reported as the honest disjunction:
//! the passphrase is wrong, or the file was modified. A raw serde or aead error
//! must never reach the renderer.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::RngCore;
use zeroize::Zeroizing;

use crate::shared::error::AppError;

use super::domain::{
    Bundle, BundlePayload, KdfParams, CIPHER, DEFAULT_M_COST, DEFAULT_P_COST, DEFAULT_T_COST,
    FORMAT, FORMAT_VERSION, KDF_ALG,
};

/// Argon2 output length — an AES-256 key.
const KEY_LEN: usize = 32;
/// Salt length. 16 bytes is Argon2's recommended size.
const SALT_LEN: usize = 16;
/// AES-GCM standard nonce length.
const NONCE_LEN: usize = 12;

/// Seal a payload into a bundle under `passphrase`.
///
/// Every call draws a fresh salt AND a fresh nonce from the OS CSPRNG, so
/// sealing the same payload twice produces two unrelated files — and, more to
/// the point, a user who exports twice with the same passphrase never reuses a
/// (key, nonce) pair, which is the one mistake that would break AES-GCM
/// outright.
pub fn seal(payload: &BundlePayload, passphrase: &str) -> Result<Bundle, AppError> {
    seal_at_cost(
        payload,
        passphrase,
        DEFAULT_M_COST,
        DEFAULT_T_COST,
        DEFAULT_P_COST,
    )
}

/// [`seal`] with the Argon2 cost spelled out.
///
/// Exists for the tests: the shipped cost is ~50 ms per derivation by design,
/// and the suite derives a few dozen times. Lowering the cost here keeps the
/// tests exercising the *real* code path — including the AAD — rather than
/// mocking the derivation out, which is exactly the part worth testing.
fn seal_at_cost(
    payload: &BundlePayload,
    passphrase: &str,
    m: u32,
    t: u32,
    p: u32,
) -> Result<Bundle, AppError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    let mut rng = rand::rngs::OsRng;
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let kdf = KdfParams {
        alg: KDF_ALG.to_string(),
        salt: B64.encode(salt),
        m,
        t,
        p,
    };
    // The header is built first and in full, because it IS the associated
    // data — the ciphertext cannot be computed without it. `ciphertext` is
    // filled in below; it is excluded from the AAD by construction.
    let mut bundle = Bundle {
        format: FORMAT.to_string(),
        version: FORMAT_VERSION,
        kdf,
        cipher: CIPHER.to_string(),
        nonce: B64.encode(nonce_bytes),
        ciphertext: String::new(),
    };

    let key = derive_key(passphrase, &salt, &bundle.kdf)?;
    let aad = bundle.aad()?;
    let plaintext = Zeroizing::new(serde_json::to_vec(payload)?);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::Io("the connection bundle could not be encrypted.".into()))?;

    bundle.ciphertext = B64.encode(sealed);
    Ok(bundle)
}

/// Open a bundle with `passphrase`.
///
/// Header validation runs first, so a file from a newer build, a foreign file,
/// or one with absurd KDF costs is named for what it is instead of costing the
/// user a second of Argon2 work and then blaming their passphrase.
pub fn open(bundle: &Bundle, passphrase: &str) -> Result<BundlePayload, AppError> {
    bundle.validate_header()?;

    let salt = decode(&bundle.kdf.salt)?;
    let nonce_bytes = decode(&bundle.nonce)?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(damaged());
    }
    let ciphertext = decode(&bundle.ciphertext)?;

    let key = derive_key(passphrase, &salt, &bundle.kdf)?;
    let aad = bundle.aad()?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            // The only place the disjunction is unavoidable: GCM cannot tell a
            // wrong key from tampered bytes, so neither can we.
            .map_err(|_| wrong_passphrase())?,
    );

    // Past the tag check the bytes are authentic, so a parse failure here means
    // a bundle that was *written* malformed — not an attack, but still not
    // something to surface as a serde message.
    serde_json::from_slice(&plaintext).map_err(|_| {
        AppError::Invalid(
            "this bundle unlocked, but its contents could not be read. It may have \
             been written by an incompatible build of ByteTable."
                .into(),
        )
    })
}

/// The one error a user with the wrong passphrase sees.
fn wrong_passphrase() -> AppError {
    AppError::Invalid(
        "the passphrase is incorrect, or this bundle has been modified since it \
         was exported."
            .into(),
    )
}

fn damaged() -> AppError {
    AppError::Invalid("this connection bundle is damaged and cannot be read.".into())
}

fn decode(value: &str) -> Result<Vec<u8>, AppError> {
    B64.decode(value).map_err(|_| damaged())
}

/// Argon2id over `passphrase`, at the parameters recorded in the header.
///
/// Returns a `Zeroizing` array so the key is wiped when the caller drops it —
/// it is the one piece of material in this module that would otherwise sit in
/// freed heap/stack memory after an export.
fn derive_key(
    passphrase: &str,
    salt: &[u8],
    kdf: &KdfParams,
) -> Result<Zeroizing<[u8; KEY_LEN]>, AppError> {
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(KEY_LEN)).map_err(|_| {
        AppError::Invalid("this bundle's key-derivation settings are not usable.".into())
    })?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        // Argon2 only fails here for a salt below its minimum length, which a
        // bundle we wrote never has — so this is a damaged/forged file.
        .map_err(|_| damaged())?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::connection_bundle::domain::{BundleEntry, EntrySecrets};

    /// Seal at a deliberately cheap Argon2 cost — see [`seal_at_cost`].
    fn seal_cheap(payload: &BundlePayload, passphrase: &str) -> Bundle {
        seal_at_cost(payload, passphrase, 64, 1, 1).unwrap()
    }

    fn payload() -> BundlePayload {
        BundlePayload {
            exported_at: 1_700_000_000_000,
            app_version: "0.0.41".into(),
            connections: vec![BundleEntry {
                connection: serde_json::json!({
                    "id": "abc-123",
                    "name": "Prod",
                    "engine": "postgres",
                    "params": {
                        "engine": "postgres",
                        "host": "db.example.com",
                        "port": 5432,
                        "tlsMode": "require"
                    },
                    "env": "production"
                }),
                secrets: Some(EntrySecrets {
                    password: Some("hunter2".into()),
                    ssh: None,
                }),
            }],
        }
    }

    #[test]
    fn a_sealed_payload_round_trips() {
        let p = payload();
        let bundle = seal_cheap(&p, "correct horse battery staple");
        let back = open(&bundle, "correct horse battery staple").unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn the_wrong_passphrase_says_so() {
        let bundle = seal_cheap(&payload(), "right");
        let err = open(&bundle, "wrong").unwrap_err().to_string();
        assert!(err.contains("passphrase is incorrect"), "{err}");
    }

    #[test]
    fn a_flipped_ciphertext_byte_fails_the_tag_check() {
        let mut bundle = seal_cheap(&payload(), "pass");
        let mut raw = B64.decode(&bundle.ciphertext).unwrap();
        raw[0] ^= 0x01;
        bundle.ciphertext = B64.encode(raw);
        assert!(open(&bundle, "pass").is_err());
    }

    /// The reason the header is associated data: an attacker who downgrades the
    /// KDF cost in transit must not produce a bundle that still opens.
    #[test]
    fn downgrading_the_kdf_cost_in_the_header_fails_the_tag_check() {
        let mut bundle = seal_cheap(&payload(), "pass");
        assert!(
            open(&bundle, "pass").is_ok(),
            "control: it opens as written"
        );

        bundle.kdf.t = 1;
        bundle.kdf.m = 8;
        assert!(
            open(&bundle, "pass").is_err(),
            "a rewritten work factor must not authenticate"
        );
    }

    #[test]
    fn swapping_the_nonce_fails_the_tag_check() {
        let mut bundle = seal_cheap(&payload(), "pass");
        bundle.nonce = B64.encode([7u8; NONCE_LEN]);
        assert!(open(&bundle, "pass").is_err());
    }

    #[test]
    fn a_truncated_nonce_is_reported_as_damage_not_as_a_bad_passphrase() {
        let mut bundle = seal_cheap(&payload(), "pass");
        bundle.nonce = B64.encode([1u8; 4]);
        let err = open(&bundle, "pass").unwrap_err().to_string();
        assert!(err.contains("damaged"), "{err}");
    }

    #[test]
    fn two_seals_of_one_payload_share_no_salt_nonce_or_ciphertext() {
        let p = payload();
        let a = seal(&p, "same").unwrap();
        let b = seal(&p, "same").unwrap();
        assert_ne!(a.kdf.salt, b.kdf.salt);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn a_bundle_file_leaks_nothing_in_the_clear() {
        let bundle = seal(&payload(), "pass").unwrap();
        let on_disk = serde_json::to_string(&bundle).unwrap();
        for secret in ["hunter2", "db.example.com", "Prod", "postgres"] {
            assert!(
                !on_disk.contains(secret),
                "{secret:?} appears in the serialized bundle"
            );
        }
    }

    #[test]
    fn the_header_survives_a_json_round_trip_byte_for_byte() {
        let bundle = seal_cheap(&payload(), "pass");
        let reparsed: Bundle =
            serde_json::from_str(&serde_json::to_string(&bundle).unwrap()).unwrap();
        assert_eq!(reparsed, bundle);
        assert!(
            open(&reparsed, "pass").is_ok(),
            "a file round trip must not disturb the AAD"
        );
    }
}
