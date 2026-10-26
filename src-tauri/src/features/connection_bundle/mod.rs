//! Connection-bundle slice (M40): move a set of saved connections — secrets
//! included — between machines as one passphrase-encrypted file, with no cloud
//! sync, no account and no server.
//!
//! Layering (dependencies point left): domain ← codec ← application ← commands.
//!
//! The slice owns no storage. It composes the connections slice's two ports —
//! `ConnectionRepository` and `SecretStore` — so secrets travel keychain →
//! sealed bundle → keychain and never pass through the JSON registry or the
//! renderer. The composition root hands both slices the *same* `Arc`s; see
//! `commands::ConnectionBundleState`.
//!
//! Why it is not three more files inside `features::connections`: that slice is
//! already the largest in the tree, and this is a distinct capability that
//! merely *uses* its ports. The file format is also a long-lived public
//! contract in a way the registry file is not — bundles written today must stay
//! readable by builds years from now — so it deserves its own home and its own
//! version gate.

pub mod application;
pub mod codec;
pub mod commands;
pub mod domain;
