//! Use-cases for the privileges slice (M39): resolve the connection's
//! privilege-catalog capability, read the three lists, and optionally fold role
//! inheritance into them. No Tauri, no drivers.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::error::AppError;
use crate::shared::privileges::PrivilegeSnapshot;

use super::domain;

/// Everything the Privileges tab shows, in one round trip.
///
/// `schema` scopes the grant listing (wildcard and database-level grants come
/// back regardless). `effective` folds role inheritance in via
/// [`domain::resolve_effective`]; with it off the caller gets the catalog's
/// literal direct grants, which is the honest thing to show when someone wants
/// to know what is actually written down rather than what it adds up to.
pub async fn privilege_snapshot(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: Option<&str>,
    effective: bool,
) -> Result<PrivilegeSnapshot, AppError> {
    let reader = manager.get_privilege_reader(handle).await?;

    let principals = reader.list_principals().await.map_err(catalog_access)?;
    let memberships = reader.list_memberships().await.map_err(catalog_access)?;
    let page = reader.list_grants(schema).await.map_err(catalog_access)?;

    let grants = if effective {
        domain::resolve_effective(&principals, &memberships, &page.grants)
    } else {
        page.grants
    };

    Ok(PrivilegeSnapshot {
        principals,
        memberships,
        grants,
        truncated: page.truncated,
    })
}

/// Rewrap a "you may not read the privilege catalog" engine error into a
/// sentence that says so.
///
/// This matters more here than almost anywhere else in the app. Reading
/// `mysql.user` / `sys.database_permissions` / `pg_authid` needs privileges the
/// connected account often lacks, and several engines answer a blocked catalog
/// read with an empty result rather than an error. An empty privileges matrix
/// reads as "nobody has any access" — the single most dangerous lie this
/// feature could tell — so where the engine *does* raise, we keep it an error
/// and explain it instead of letting it look like a clean, empty answer.
fn catalog_access(err: AppError) -> AppError {
    let AppError::Database(ref message) = err else {
        return err;
    };
    let lowered = message.to_lowercase();
    let denied = [
        "permission denied",               // Postgres
        "permission was denied",           // SQL Server
        "access denied",                   // MySQL
        "command denied",                  // MySQL
        "not enough privileges",           // ClickHouse
        "accessdenied",                    // ClickHouse error code text
        "insufficient privilege",          // Postgres (SQLSTATE 42501 wording)
        "the user specified as a definer", // MySQL view-definer catalogs
    ]
    .iter()
    .any(|needle| lowered.contains(needle));

    if denied {
        AppError::Database(format!(
            "This connection cannot read the privilege catalog, so the list \
             would be incomplete rather than empty. Connect as an account with \
             rights to the engine's system catalogs to see users and grants. \
             The engine said: {message}"
        ))
    } else {
        err
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_a_denied_catalog_read_instead_of_passing_it_through() {
        let err = catalog_access(AppError::Database(
            "permission denied for table pg_authid".into(),
        ));
        let AppError::Database(message) = err else {
            panic!("expected a Database error");
        };
        assert!(message.contains("cannot read the privilege catalog"));
        // The engine's own words survive — the §5 contract is a complete
        // sentence, not a replacement that hides what happened.
        assert!(message.contains("permission denied for table pg_authid"));
    }

    #[test]
    fn leaves_an_unrelated_engine_error_alone() {
        let err = catalog_access(AppError::Database("connection reset by peer".into()));
        let AppError::Database(message) = err else {
            panic!("expected a Database error");
        };
        assert_eq!(message, "connection reset by peer");
    }

    #[test]
    fn leaves_non_database_errors_alone() {
        let err = catalog_access(AppError::Unsupported("no privilege catalog".into()));
        assert!(matches!(err, AppError::Unsupported(_)));
    }
}
