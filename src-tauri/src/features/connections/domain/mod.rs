//! Domain model for saved connections. Pure value objects; the only outward
//! dependency is the shared kernel (`Engine`, `ConnectionParams`), which is
//! allowed by the layering rules.
//!
//! Design note: as in the preferences slice, the plain `serde` derives below
//! double as the wire/persisted representation (camelCase fields, lowercase
//! enum values) so the renderer's TS literals match exactly.

use serde::{Deserialize, Serialize};

use crate::shared::engine::{ConnectionParams, Engine};

/// Deployment environment a connection points at (drives the EnvTag tint).
/// Mirrors `Env` in `src/shared/types.ts`. The canonical set is
/// `dev | staging | production` (m15 env-picker redesign); connections
/// persisted before m15 used `"local"` for what is now `"dev"`, so the `Dev`
/// variant carries `alias = "local"` to keep those entries loading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Env {
    #[default]
    #[serde(alias = "local")]
    Dev,
    Staging,
    Production,
}

/// A connection the user has saved in the registry.
///
/// - `id` is a UUID assigned by the save use-case when empty (new entry).
/// - `engine` is denormalized from `params` for renderer convenience; the
///   save use-case rejects mismatches.
/// - `created_at` is Unix epoch milliseconds, assigned on first save (kept
///   as a plain integer to avoid pulling a date-time crate for one field).
/// - SQLite params carry only a file path — no secrets — so persisting the
///   whole struct as plain JSON is fine. Server passwords never live here
///   (OS keychain, M12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    pub params: ConnectionParams,
    pub env: Env,
    /// Tile/accent color (m15 env picker): the env's chosen swatch, used for
    /// the workspace rail tile + sidebar bar. Optional — absent for entries
    /// saved before m15 (the renderer falls back to its auto-cycle palette).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Optional project label used to group connections on the connect screen
    /// (absent ⇒ "Ungrouped"). Free-form text the user assigns/creates in the
    /// new-connection modal; persisted so the grouping survives restarts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
}

/// A saved-registry entry this build cannot fully parse — almost always a
/// connection whose `engine` is unknown here (saved by a newer/experimental
/// build). It is NOT dropped: the raw entry stays in the file (so a build that
/// *does* know the engine still sees it), and it is surfaced to the connect
/// screen as a struck-out, non-openable card with a delete action, so the user
/// can remove it deliberately instead of hand-editing the file. Only the
/// non-secret display fields are salvaged from the raw JSON (best-effort).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedConnection {
    pub id: String,
    pub name: String,
    /// The raw engine string from the file (unknown to this build).
    pub engine: String,
    /// Best-effort display fields, salvaged from the raw entry when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Human explanation shown when the user clicks the struck-out card.
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SavedConnection {
        SavedConnection {
            id: "abc-123".into(),
            name: "Local dev".into(),
            engine: Engine::Sqlite,
            params: ConnectionParams::Sqlite {
                path: "/tmp/dev.db".into(),
            },
            env: Env::Dev,
            color: Some("#56b6c2".into()),
            project: None,
            created_at: Some(1_700_000_000_000),
        }
    }

    #[test]
    fn wire_format_is_camel_case_with_lowercase_enums() {
        let json = serde_json::to_value(sample()).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "id": "abc-123",
                "name": "Local dev",
                "engine": "sqlite",
                "params": { "engine": "sqlite", "path": "/tmp/dev.db" },
                "env": "dev",
                "color": "#56b6c2",
                "createdAt": 1_700_000_000_000u64,
            })
        );
    }

    #[test]
    fn legacy_local_env_deserializes_to_dev() {
        // Connections persisted before m15 used `"local"`; the `Dev` variant's
        // serde alias keeps them loading.
        let json = serde_json::json!({
            "id": "x",
            "name": "n",
            "engine": "sqlite",
            "params": { "engine": "sqlite", "path": "/p" },
            "env": "local",
        });
        let conn: SavedConnection = serde_json::from_value(json).expect("deserialize");
        assert_eq!(conn.env, Env::Dev);
    }

    #[test]
    fn color_is_optional_on_the_wire() {
        let json = serde_json::json!({
            "id": "x",
            "name": "n",
            "engine": "sqlite",
            "params": { "engine": "sqlite", "path": "/p" },
            "env": "dev",
        });
        let conn: SavedConnection = serde_json::from_value(json).expect("deserialize");
        assert_eq!(conn.color, None);
    }

    #[test]
    fn serde_round_trip_preserves_all_fields() {
        let conn = sample();
        let json = serde_json::to_string(&conn).expect("serialize");
        let back: SavedConnection = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, conn);
    }

    #[test]
    fn created_at_is_optional_on_the_wire() {
        let json = serde_json::json!({
            "id": "x",
            "name": "n",
            "engine": "sqlite",
            "params": { "engine": "sqlite", "path": "/p" },
            "env": "staging",
        });
        let conn: SavedConnection = serde_json::from_value(json).expect("deserialize");
        assert_eq!(conn.created_at, None);
        assert_eq!(conn.env, Env::Staging);
    }
}
