//! The staged grant edits the editor accumulates (M39 Phase 2) — the slice's
//! own model, the mirror of `features::structure::domain::AlterOp`.
//!
//! Engine-neutral and inert: an op says *what the user asked for*, never how
//! any engine spells it. Statement generation lives in `crate::engines::*`
//! behind `PrivilegeReader::apply_grants`, exactly as DDL generation lives
//! there for `AlterOp`.

use serde::{Deserialize, Serialize};

use crate::shared::error::AppError;
use crate::shared::privileges::{PrincipalKind, PrincipalScope};

/// What a password is replaced with in any statement that will be SHOWN.
///
/// `CREATE USER … IDENTIFIED BY '…'` carries a plaintext secret, and the
/// Review SQL panel's whole value is that it shows what will run — so the one
/// place those two requirements collide gets a narrow, *labelled* exception:
/// the statements an adapter returns always carry this instead of the real
/// password, the statements it executes never leave the adapter, and the panel
/// says so in as many words.
pub const MASKED_SECRET: &str = "••••••••";

/// What an op targets, reusing the Phase 1 wildcard encoding so an op can name
/// the same three shapes the matrix reads:
///
/// - both set — that one object,
/// - `schema` only — every object in it,
/// - neither — everything (engine-wide).
///
/// Not every engine can express all three: Postgres has no instance-wide table
/// grant, so the adapter rejects the empty scope with a §5 sentence rather than
/// inventing a statement.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
}

/// One staged change.
///
/// [`GrantOp::Deny`] is only expressible on SQL Server (a real `DENY`) and
/// ClickHouse (a partial revoke, which behaves the same way). Postgres and
/// MySQL have no such concept, and their adapters refuse it — see
/// [`crate::shared::privileges::GrantCapabilities`], which the renderer reads
/// so the state is never offered there in the first place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GrantOp {
    #[serde(rename_all = "camelCase")]
    Grant {
        grantee: String,
        privilege: String,
        #[serde(default)]
        scope: Scope,
        /// `WITH GRANT OPTION` — the recipient may pass the privilege on.
        #[serde(default)]
        grantable: bool,
    },
    #[serde(rename_all = "camelCase")]
    Revoke {
        grantee: String,
        privilege: String,
        #[serde(default)]
        scope: Scope,
    },
    #[serde(rename_all = "camelCase")]
    Deny {
        grantee: String,
        privilege: String,
        #[serde(default)]
        scope: Scope,
    },
    /// Drop `WITH GRANT OPTION` while keeping the privilege itself.
    ///
    /// Its own op because "revoke then re-grant without the option" is NOT
    /// equivalent on every engine. Verified against live servers: Postgres and
    /// ClickHouse do clear the option that way, but **MySQL does not** — it
    /// stores `GRANT OPTION` as a separate privilege bit, so `REVOKE SELECT`
    /// leaves it set and the re-grant comes back grantable. MySQL needs
    /// `REVOKE GRANT OPTION ON …`, which is a different statement, so the
    /// intent has to survive as far as the adapter instead of being
    /// pre-translated into a revoke/grant pair.
    #[serde(rename_all = "camelCase")]
    RevokeGrantOption {
        grantee: String,
        privilege: String,
        #[serde(default)]
        scope: Scope,
    },
    /// Add `member` to `role`.
    #[serde(rename_all = "camelCase")]
    AddMember { member: String, role: String },
    /// Remove `member` from `role`.
    #[serde(rename_all = "camelCase")]
    DropMember { member: String, role: String },
    /// Create a user, role, or (SQL Server) server login.
    ///
    /// `password` is `None` for a role, and for an account that authenticates
    /// some other way. It is the only secret this feature handles, and it is
    /// masked in every statement that is displayed — see [`MASKED_SECRET`].
    #[serde(rename_all = "camelCase")]
    CreatePrincipal {
        name: String,
        /// Not `kind`: that name is taken by the enum's own serde tag.
        principal_kind: PrincipalKind,
        /// SQL Server only: `Server` makes a LOGIN, `Database` a USER. Every
        /// other engine has one principal space and ignores this.
        #[serde(default = "database_scope")]
        scope: PrincipalScope,
        #[serde(default)]
        password: Option<String>,
    },
    /// Drop a user, role, or server login.
    #[serde(rename_all = "camelCase")]
    DropPrincipal {
        name: String,
        principal_kind: PrincipalKind,
        #[serde(default = "database_scope")]
        scope: PrincipalScope,
    },
}

fn database_scope() -> PrincipalScope {
    PrincipalScope::Database
}

impl GrantOp {
    /// The principal whose access this op changes — the subject of the
    /// self-lockout guard, not the role being handed out.
    pub fn subject(&self) -> &str {
        match self {
            Self::Grant { grantee, .. }
            | Self::Revoke { grantee, .. }
            | Self::Deny { grantee, .. }
            | Self::RevokeGrantOption { grantee, .. } => grantee,
            Self::AddMember { member, .. } | Self::DropMember { member, .. } => member,
            Self::CreatePrincipal { name, .. } | Self::DropPrincipal { name, .. } => name,
        }
    }

    /// True when the op takes access away. Only these need the self-lockout
    /// guard and the production arming gate — granting yourself more can't lock
    /// you out of anything.
    pub fn removes_access(&self) -> bool {
        matches!(
            self,
            Self::Revoke { .. }
                | Self::Deny { .. }
                | Self::DropMember { .. }
                | Self::DropPrincipal { .. }
                | Self::RevokeGrantOption { .. }
        )
    }

    /// True when the op could sever the connection it is run on — the
    /// self-lockout guard's question, which is narrower than
    /// [`Self::removes_access`]: losing the grant option, or a role you were
    /// never using, does not stop you talking to the server.
    pub fn breaks_connection(&self) -> bool {
        matches!(
            self,
            Self::Revoke { .. }
                | Self::Deny { .. }
                | Self::DropMember { .. }
                | Self::DropPrincipal { .. }
        )
    }

    /// A short human label for error messages.
    pub fn verb(&self) -> &'static str {
        match self {
            Self::Grant { .. } => "grant",
            Self::Revoke { .. } => "revoke",
            Self::Deny { .. } => "deny",
            Self::RevokeGrantOption { .. } => "remove the grant option from",
            Self::AddMember { .. } => "add to a role",
            Self::DropMember { .. } => "remove from a role",
            Self::CreatePrincipal { .. } => "create",
            Self::DropPrincipal { .. } => "drop",
        }
    }
}

/// Reject a privilege token that is not a bare SQL privilege name.
///
/// Privilege names cannot be quoted — `GRANT "SELECT"` is a syntax error — so
/// unlike every identifier in these statements, this token reaches the engine
/// verbatim. It is the one injection surface in the whole write path, hence an
/// allowlist of letters and single interior spaces (`SELECT`, `VIEW
/// DEFINITION`, `ALL PRIVILEGES`) rather than an escape.
pub fn validate_privilege(privilege: &str) -> Result<(), AppError> {
    // Validate the EXACT string the statement will carry, not a trimmed copy of
    // it. Checking a cleaned-up version and emitting the original is how a
    // validator ends up blessing bytes it never looked at.
    if privilege.is_empty() {
        return Err(AppError::Invalid("A privilege name is required.".into()));
    }
    let shaped = privilege
        .chars()
        .all(|c| c.is_ascii_uppercase() || c == ' ')
        && !privilege.contains("  ")
        && !privilege.starts_with(' ')
        && !privilege.ends_with(' ');
    if !shaped {
        return Err(AppError::Invalid(format!(
            "'{privilege}' is not a valid privilege name. Privilege names are \
             uppercase words such as SELECT or VIEW DEFINITION."
        )));
    }
    Ok(())
}

/// Validate every op in a batch, and reject an empty one.
pub fn validate_ops(ops: &[GrantOp]) -> Result<(), AppError> {
    if ops.is_empty() {
        return Err(AppError::Invalid("No privilege changes to apply.".into()));
    }
    for op in ops {
        match op {
            GrantOp::Grant {
                grantee, privilege, ..
            }
            | GrantOp::Revoke {
                grantee, privilege, ..
            }
            | GrantOp::Deny {
                grantee, privilege, ..
            }
            | GrantOp::RevokeGrantOption {
                grantee, privilege, ..
            } => {
                if grantee.trim().is_empty() {
                    return Err(AppError::Invalid("A grantee is required.".into()));
                }
                validate_privilege(privilege)?;
            }
            GrantOp::AddMember { member, role } | GrantOp::DropMember { member, role } => {
                if member.trim().is_empty() || role.trim().is_empty() {
                    return Err(AppError::Invalid(
                        "Both a member and a role are required.".into(),
                    ));
                }
            }
            GrantOp::CreatePrincipal { name, .. } | GrantOp::DropPrincipal { name, .. } => {
                if name.trim().is_empty() {
                    return Err(AppError::Invalid("A name is required.".into()));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(privilege: &str) -> GrantOp {
        GrantOp::Grant {
            grantee: "app".into(),
            privilege: privilege.into(),
            scope: Scope::default(),
            grantable: false,
        }
    }

    #[test]
    fn accepts_real_privilege_names_including_multiword_ones() {
        assert!(validate_privilege("SELECT").is_ok());
        assert!(validate_privilege("VIEW DEFINITION").is_ok());
        assert!(validate_privilege("ALL PRIVILEGES").is_ok());
    }

    #[test]
    fn rejects_anything_that_could_carry_sql() {
        // The token reaches the engine unquoted, so this is the injection guard.
        for bad in [
            "SELECT; DROP TABLE t",
            "SELECT'",
            "select",
            "SELECT  DEFINITION",
            " SELECT",
            "SELECT ",
            "",
        ] {
            assert!(
                validate_privilege(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn an_empty_batch_is_refused() {
        assert!(validate_ops(&[]).is_err());
    }

    #[test]
    fn a_bad_privilege_fails_the_whole_batch() {
        assert!(validate_ops(&[grant("SELECT"), grant("oops; --")]).is_err());
    }

    #[test]
    fn subject_is_the_principal_losing_access_not_the_role() {
        let op = GrantOp::DropMember {
            member: "app".into(),
            role: "writer".into(),
        };
        assert_eq!(op.subject(), "app");
        assert!(op.removes_access());
    }

    #[test]
    fn granting_never_counts_as_removing_access() {
        assert!(!grant("SELECT").removes_access());
        assert!(!GrantOp::AddMember {
            member: "app".into(),
            role: "writer".into(),
        }
        .removes_access());
    }
}
