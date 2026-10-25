//! Effective-grant resolution (M39 Task 3) — the slice's own domain.
//!
//! Engine-neutral and **pure**: it takes the three lists an adapter read out of
//! a catalog and folds role inheritance into them, so it unit-tests without a
//! database. Nothing here speaks SQL; the engines do that.
//!
//! The rules, in the order they matter:
//!
//! 1. **`Denied` beats everything**, including a grant inherited through a
//!    nearer role. This is why [`PrivilegeState`] is four states and not a
//!    boolean — SQL Server's `DENY` is not the absence of a grant.
//! 2. Otherwise more access wins: `Grantable` > `Granted` > `None`.
//! 3. On a tie, the **nearest** role chain wins, so `via` names the shortest
//!    honest path rather than an arbitrary one.
//! 4. The membership walk is **cycle-guarded**. Postgres and MySQL both permit
//!    role cycles, and an unguarded walk would hang the tab rather than fail.
//! 5. A **superuser is not expanded** — see [`resolve_effective`].
//!
//! What this deliberately does NOT do is collapse wildcard scopes. A global
//! `GRANT … ON *.*` and a schema-scoped `REVOKE` are different cells here, and
//! both survive, because expanding a wildcard needs the object list and only
//! the renderer has it. The renderer resolves that last step with
//! [`GrantEntry::specificity`] — narrower scope first, then state rank.

pub mod ops;

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use crate::shared::privileges::{GrantEntry, MembershipEdge, Principal};

/// Postgres' implicit grantee: a grant to `PUBLIC` is held by every principal,
/// which makes it the usual answer to "why can everyone read this table?". The
/// Postgres adapter also lists it as a synthetic principal so it is visible in
/// its own right, not just as an invisible source of inherited rows.
pub const PUBLIC: &str = "PUBLIC";

/// Fold role inheritance into `direct`, returning one [`GrantEntry`] per
/// principal × object × privilege cell with [`GrantEntry::via`] naming the
/// chain each grant arrived through (empty = granted directly).
///
/// **Superusers are passed through unexpanded.** A superuser implicitly holds
/// every privilege on every object, and the catalog does not record those
/// grants anywhere — expanding its roles would produce a matrix that looks
/// authoritative while omitting almost everything the account can actually do.
/// The renderer shows a badge instead, and only the principal's literal direct
/// rows survive here.
///
/// Grants to a grantee that is not a listed principal pass through untouched
/// rather than disappearing. For this feature an under-reported privilege is
/// the dangerous direction.
pub fn resolve_effective(
    principals: &[Principal],
    memberships: &[MembershipEdge],
    direct: &[GrantEntry],
) -> Vec<GrantEntry> {
    let mut by_grantee: HashMap<&str, Vec<&GrantEntry>> = HashMap::new();
    for grant in direct {
        by_grantee
            .entry(grant.grantee.as_str())
            .or_default()
            .push(grant);
    }

    let mut roles_of: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in memberships {
        roles_of
            .entry(edge.member.as_str())
            .or_default()
            .push(edge.role.as_str());
    }

    let has_public = by_grantee.contains_key(PUBLIC);
    let known: HashSet<&str> = principals.iter().map(|p| p.name.as_str()).collect();
    let mut out: Vec<GrantEntry> = Vec::new();

    for principal in principals {
        if principal.is_superuser {
            out.extend(
                by_grantee
                    .get(principal.name.as_str())
                    .into_iter()
                    .flatten()
                    .map(|g| (*g).clone()),
            );
            continue;
        }

        // One winning entry per cell, keyed by the object coordinates. BTreeMap
        // so the per-principal output is already in a stable order.
        let mut best: BTreeMap<CellKey, GrantEntry> = BTreeMap::new();

        for (source, chain) in ancestry(&principal.name, &roles_of, has_public) {
            for grant in by_grantee.get(source.as_str()).into_iter().flatten() {
                let key = (
                    grant.schema.clone(),
                    grant.object.clone(),
                    grant.privilege.clone(),
                );
                let candidate = GrantEntry {
                    grantee: principal.name.clone(),
                    via: chain.clone(),
                    ..(*grant).clone()
                };
                let replace = match best.get(&key) {
                    Some(existing) => supersedes(&candidate, existing),
                    None => true,
                };
                if replace {
                    best.insert(key, candidate);
                }
            }
        }
        out.extend(best.into_values());
    }

    for grant in direct {
        if !known.contains(grant.grantee.as_str()) {
            out.push(grant.clone());
        }
    }

    out.sort_by(|a, b| {
        (&a.grantee, &a.schema, &a.object, &a.privilege).cmp(&(
            &b.grantee,
            &b.schema,
            &b.object,
            &b.privilege,
        ))
    });
    out
}

/// `(schema, object, privilege)` — one matrix cell.
type CellKey = (Option<String>, Option<String>, String);

/// Does `a` win the cell over `b`? Rule 1 then rule 3 from the module docs.
fn supersedes(a: &GrantEntry, b: &GrantEntry) -> bool {
    match a.state.rank().cmp(&b.state.rank()) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => a.via.len() < b.via.len(),
    }
}

/// `name` plus every role it transitively belongs to, each paired with the
/// chain that reaches it (nearest first; empty for `name` itself).
///
/// Breadth-first, so the first chain found for a role is the shortest one, and
/// the `seen` set doubles as the cycle guard (rule 4).
fn ancestry(
    name: &str,
    roles_of: &HashMap<&str, Vec<&str>>,
    has_public: bool,
) -> Vec<(String, Vec<String>)> {
    let mut out = vec![(name.to_string(), Vec::new())];
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(name.to_string());

    let mut queue: VecDeque<(String, Vec<String>)> = VecDeque::new();
    queue.push_back((name.to_string(), Vec::new()));

    while let Some((current, chain)) = queue.pop_front() {
        for role in roles_of.get(current.as_str()).into_iter().flatten() {
            if !seen.insert((*role).to_string()) {
                continue;
            }
            let mut next = chain.clone();
            next.push((*role).to_string());
            out.push(((*role).to_string(), next.clone()));
            queue.push_back(((*role).to_string(), next));
        }
    }

    if has_public && name != PUBLIC {
        out.push((PUBLIC.to_string(), vec![PUBLIC.to_string()]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::privileges::{PrincipalKind, PrincipalScope, PrivilegeState};

    fn principal(name: &str) -> Principal {
        Principal {
            name: name.into(),
            kind: PrincipalKind::User,
            scope: PrincipalScope::Database,
            can_login: true,
            is_superuser: false,
            attributes: Vec::new(),
        }
    }

    fn superuser(name: &str) -> Principal {
        Principal {
            is_superuser: true,
            ..principal(name)
        }
    }

    fn edge(member: &str, role: &str) -> MembershipEdge {
        MembershipEdge {
            member: member.into(),
            role: role.into(),
            admin_option: false,
        }
    }

    fn grant(grantee: &str, privilege: &str, state: PrivilegeState) -> GrantEntry {
        GrantEntry {
            grantee: grantee.into(),
            schema: Some("public".into()),
            object: Some("orders".into()),
            privilege: privilege.into(),
            state,
            via: Vec::new(),
        }
    }

    fn find<'a>(
        grants: &'a [GrantEntry],
        grantee: &str,
        privilege: &str,
    ) -> Option<&'a GrantEntry> {
        grants
            .iter()
            .find(|g| g.grantee == grantee && g.privilege == privilege)
    }

    #[test]
    fn inherits_through_a_role_chain_and_records_the_path_nearest_first() {
        let out = resolve_effective(
            &[principal("app_rw")],
            &[edge("app_rw", "writer"), edge("writer", "owner")],
            &[grant("owner", "SELECT", PrivilegeState::Granted)],
        );

        let got = find(&out, "app_rw", "SELECT").expect("inherited grant");
        assert_eq!(got.state, PrivilegeState::Granted);
        assert_eq!(got.via, vec!["writer".to_string(), "owner".to_string()]);
    }

    #[test]
    fn a_direct_grant_has_an_empty_via_chain() {
        let out = resolve_effective(
            &[principal("app_rw")],
            &[],
            &[grant("app_rw", "SELECT", PrivilegeState::Granted)],
        );
        assert!(find(&out, "app_rw", "SELECT").unwrap().via.is_empty());
    }

    #[test]
    fn deny_beats_a_grant_inherited_through_a_nearer_role() {
        // `app_rw` is granted SELECT directly through `writer` (one hop) but
        // denied it through `restricted` (also one hop). DENY must win — this
        // is the SQL Server rule the four-state cell exists for.
        let out = resolve_effective(
            &[principal("app_rw")],
            &[edge("app_rw", "writer"), edge("app_rw", "restricted")],
            &[
                grant("writer", "SELECT", PrivilegeState::Granted),
                grant("restricted", "SELECT", PrivilegeState::Denied),
            ],
        );

        let got = find(&out, "app_rw", "SELECT").expect("resolved cell");
        assert_eq!(got.state, PrivilegeState::Denied);
        assert_eq!(got.via, vec!["restricted".to_string()]);
    }

    #[test]
    fn deny_beats_even_a_direct_grant() {
        let out = resolve_effective(
            &[principal("app_rw")],
            &[edge("app_rw", "restricted")],
            &[
                grant("app_rw", "SELECT", PrivilegeState::Granted),
                grant("restricted", "SELECT", PrivilegeState::Denied),
            ],
        );
        assert_eq!(
            find(&out, "app_rw", "SELECT").unwrap().state,
            PrivilegeState::Denied
        );
    }

    #[test]
    fn grantable_outranks_a_plain_grant_on_the_same_cell() {
        let out = resolve_effective(
            &[principal("app_rw")],
            &[edge("app_rw", "writer")],
            &[
                grant("app_rw", "SELECT", PrivilegeState::Granted),
                grant("writer", "SELECT", PrivilegeState::Grantable),
            ],
        );
        assert_eq!(
            find(&out, "app_rw", "SELECT").unwrap().state,
            PrivilegeState::Grantable
        );
    }

    #[test]
    fn the_nearest_chain_wins_when_the_state_ties() {
        let out = resolve_effective(
            &[principal("app_rw")],
            &[
                edge("app_rw", "writer"),
                edge("app_rw", "far_a"),
                edge("far_a", "far_b"),
            ],
            &[
                grant("writer", "SELECT", PrivilegeState::Granted),
                grant("far_b", "SELECT", PrivilegeState::Granted),
            ],
        );
        assert_eq!(
            find(&out, "app_rw", "SELECT").unwrap().via,
            vec!["writer".to_string()]
        );
    }

    #[test]
    fn a_membership_cycle_terminates() {
        // a → b → c → a. Without the guard this never returns.
        let out = resolve_effective(
            &[principal("a")],
            &[edge("a", "b"), edge("b", "c"), edge("c", "a")],
            &[grant("c", "SELECT", PrivilegeState::Granted)],
        );
        let got = find(&out, "a", "SELECT").expect("grant through the cycle");
        assert_eq!(got.via, vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn a_superuser_is_not_expanded_and_keeps_only_its_direct_rows() {
        let out = resolve_effective(
            &[superuser("postgres")],
            &[edge("postgres", "writer")],
            &[
                grant("postgres", "SELECT", PrivilegeState::Granted),
                grant("writer", "INSERT", PrivilegeState::Granted),
            ],
        );

        assert!(find(&out, "postgres", "SELECT").is_some());
        // The role grant is NOT folded in: the badge says "holds everything",
        // and a half-expanded matrix would contradict it.
        assert!(find(&out, "postgres", "INSERT").is_none());
    }

    #[test]
    fn public_grants_reach_every_principal() {
        let out = resolve_effective(
            &[principal("alice"), principal("bob")],
            &[],
            &[grant(PUBLIC, "SELECT", PrivilegeState::Granted)],
        );

        for who in ["alice", "bob"] {
            let got = find(&out, who, "SELECT").expect("PUBLIC grant");
            assert_eq!(got.via, vec![PUBLIC.to_string()]);
        }
    }

    #[test]
    fn a_direct_grant_outranks_the_same_privilege_from_public() {
        let out = resolve_effective(
            &[principal("alice")],
            &[],
            &[
                grant(PUBLIC, "SELECT", PrivilegeState::Granted),
                grant("alice", "SELECT", PrivilegeState::Grantable),
            ],
        );
        let got = find(&out, "alice", "SELECT").unwrap();
        assert_eq!(got.state, PrivilegeState::Grantable);
        assert!(got.via.is_empty());
    }

    #[test]
    fn grants_to_an_unlisted_grantee_are_not_dropped() {
        let out = resolve_effective(
            &[principal("alice")],
            &[],
            &[grant("ghost_role", "SELECT", PrivilegeState::Granted)],
        );
        assert!(find(&out, "ghost_role", "SELECT").is_some());
    }

    #[test]
    fn distinct_objects_stay_distinct_cells() {
        let mut other = grant("app_rw", "SELECT", PrivilegeState::Granted);
        other.object = Some("customers".into());
        let out = resolve_effective(
            &[principal("app_rw")],
            &[],
            &[grant("app_rw", "SELECT", PrivilegeState::Granted), other],
        );
        assert_eq!(out.len(), 2);
    }
}
