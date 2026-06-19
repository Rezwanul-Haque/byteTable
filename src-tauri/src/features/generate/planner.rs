//! Planning (pure): FK dependency graph, topological order, cycle/self-ref
//! break, role classification, count scaling. No I/O, no Tauri.
use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::features::generate::domain::{GenerateSize, TableRole};
use crate::shared::engine::TableMeta;

/// One table's ordering dependencies after cycle-breaking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableDep {
    pub table: String,
    /// In-schema, non-self, non-deferred FK target tables (ordering edges).
    pub parents: Vec<String>,
    /// Local FK columns filled in a second UPDATE pass (self-ref or a back-edge
    /// that would otherwise form a cycle).
    pub deferred_fk_columns: Vec<String>,
}

/// Build dependency edges, deferring self-refs and back-edges so the remaining
/// graph is a DAG. `tables` is `(name, meta)`; only FKs whose `ref_table` is one
/// of these names create edges.
pub fn build_deps(tables: &[(String, TableMeta)]) -> Vec<TableDep> {
    let names: BTreeSet<&str> = tables.iter().map(|(n, _)| n.as_str()).collect();

    let mut deps: BTreeMap<String, TableDep> = tables
        .iter()
        .map(|(n, _)| {
            (
                n.clone(),
                TableDep {
                    table: n.clone(),
                    parents: Vec::new(),
                    deferred_fk_columns: Vec::new(),
                },
            )
        })
        .collect();

    for (name, meta) in tables {
        let dep = deps.get_mut(name).unwrap();
        for fk in &meta.foreign_keys {
            let target = fk.ref_table.as_str();
            let local = fk.columns.first().cloned().unwrap_or_default();
            if target == name.as_str() {
                dep.deferred_fk_columns.push(local); // self-ref
            } else if names.contains(target) {
                dep.parents.push(target.to_string());
            }
        }
        dep.parents.sort();
        dep.parents.dedup();
    }

    break_cycles(&mut deps, tables);
    tables
        .iter()
        .map(|(n, _)| deps.get(n).unwrap().clone())
        .collect()
}

/// Remove back-edges so the parent graph is acyclic, recording the corresponding
/// local FK columns as deferred. Iterative DFS: a parent already on the current
/// stack ("gray") marks a back-edge. Back-edges are collected first, then
/// applied, so the `parents` vectors are never mutated mid-traversal.
fn break_cycles(deps: &mut BTreeMap<String, TableDep>, tables: &[(String, TableMeta)]) {
    // (child, parent) -> the child's local FK column, so a removed edge can name it.
    let col_for: BTreeMap<(String, String), String> = tables
        .iter()
        .flat_map(|(child, meta)| {
            meta.foreign_keys.iter().filter_map(move |fk| {
                let parent = fk.ref_table.clone();
                if parent == *child {
                    return None;
                }
                Some((
                    (child.clone(), parent),
                    fk.columns.first().cloned().unwrap_or_default(),
                ))
            })
        })
        .collect();

    let nodes: Vec<String> = deps.keys().cloned().collect();
    let mut state: BTreeMap<String, u8> = nodes.iter().map(|n| (n.clone(), 0u8)).collect(); // 0 white,1 gray,2 black
    let mut back_edges: Vec<(String, String)> = Vec::new();

    for start in &nodes {
        if state[start] != 0 {
            continue;
        }
        state.insert(start.clone(), 1);
        let mut stack: Vec<(String, usize)> = vec![(start.clone(), 0)];
        while let Some((node, idx)) = stack.last().cloned() {
            let parents = deps[&node].parents.clone();
            if idx < parents.len() {
                stack.last_mut().unwrap().1 += 1;
                let p = &parents[idx];
                match state[p] {
                    1 => back_edges.push((node.clone(), p.clone())),
                    0 => {
                        state.insert(p.clone(), 1);
                        stack.push((p.clone(), 0));
                    }
                    _ => {}
                }
            } else {
                state.insert(node.clone(), 2);
                stack.pop();
            }
        }
    }

    for (child, parent) in back_edges {
        let dep = deps.get_mut(&child).unwrap();
        dep.parents.retain(|x| x != &parent);
        if let Some(col) = col_for.get(&(child.clone(), parent.clone())) {
            dep.deferred_fk_columns.push(col.clone());
        }
    }
}

/// Kahn topological sort over the (already acyclic) parent edges. Ties broken
/// alphabetically for determinism.
pub fn topo_order(deps: &[TableDep]) -> Vec<String> {
    let mut indeg: BTreeMap<&str, usize> =
        deps.iter().map(|d| (d.table.as_str(), 0usize)).collect();
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for d in deps {
        for p in &d.parents {
            *indeg.get_mut(d.table.as_str()).unwrap() += 1;
            children
                .entry(p.as_str())
                .or_default()
                .push(d.table.as_str());
        }
    }
    let mut ready: VecDeque<&str> = indeg
        .iter()
        .filter(|(_, &n)| n == 0)
        .map(|(t, _)| *t)
        .collect();
    let mut order = Vec::with_capacity(deps.len());
    while let Some(t) = ready.pop_front() {
        order.push(t.to_string());
        if let Some(cs) = children.get(t) {
            let mut newly: Vec<&str> = Vec::new();
            for c in cs {
                let e = indeg.get_mut(*c).unwrap();
                *e -= 1;
                if *e == 0 {
                    newly.push(c);
                }
            }
            newly.sort();
            for c in newly {
                ready.push_back(c);
            }
        }
    }
    order
}

/// Name fragments that mark an enum-like reference table.
const LOOKUP_HINTS: &[&str] = &[
    "status", "type", "kind", "category", "role", "state", "country", "currency", "language",
    "gender", "priority", "level", "tier",
];

/// Classify a table for row-count scaling. Junction first (purely FK columns),
/// then lookup (name hint), else entity.
pub fn classify_role(name: &str, meta: &TableMeta) -> TableRole {
    let cols = &meta.columns;
    let all_cols_fk = !cols.is_empty() && cols.iter().all(|c| c.fk.is_some());
    if all_cols_fk && cols.len() >= 2 {
        return TableRole::Junction;
    }
    let lname = name.to_ascii_lowercase();
    if LOOKUP_HINTS.iter().any(|h| lname.contains(h)) {
        return TableRole::Lookup;
    }
    TableRole::Entity
}

/// Map a role + chosen size to a concrete row count.
pub fn scale_rows(role: TableRole, size: GenerateSize) -> u64 {
    let base = size.base_rows();
    match role {
        TableRole::Lookup => 20,
        TableRole::Entity => base,
        TableRole::Junction => base.saturating_mul(2).min(5_000_000),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::{ColumnInfo, FkRef, ForeignKeyInfo, TableMeta};

    fn meta_with_fks(fks: Vec<(&str, &str, &str)>) -> TableMeta {
        TableMeta {
            foreign_keys: fks
                .into_iter()
                .map(|(c, rt, rc)| ForeignKeyInfo {
                    name: None,
                    columns: vec![c.into()],
                    ref_table: rt.into(),
                    ref_columns: vec![rc.into()],
                    on_delete: None,
                    on_update: None,
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn parents_before_children() {
        let tables = vec![
            (
                "orders".into(),
                meta_with_fks(vec![("user_id", "users", "id")]),
            ),
            ("users".into(), meta_with_fks(vec![])),
        ];
        let deps = build_deps(&tables);
        let order = topo_order(&deps);
        let ui = order.iter().position(|t| t == "users").unwrap();
        let oi = order.iter().position(|t| t == "orders").unwrap();
        assert!(ui < oi, "users must come before orders: {order:?}");
    }

    #[test]
    fn self_ref_is_deferred_not_a_cycle() {
        let tables = vec![(
            "employees".into(),
            meta_with_fks(vec![("manager_id", "employees", "id")]),
        )];
        let deps = build_deps(&tables);
        assert_eq!(deps[0].parents, Vec::<String>::new());
        assert_eq!(deps[0].deferred_fk_columns, vec!["manager_id".to_string()]);
        assert_eq!(topo_order(&deps), vec!["employees".to_string()]);
    }

    #[test]
    fn circular_fks_are_broken_and_all_tables_ordered() {
        let tables = vec![
            ("a".into(), meta_with_fks(vec![("b_id", "b", "id")])),
            ("b".into(), meta_with_fks(vec![("a_id", "a", "id")])),
        ];
        let deps = build_deps(&tables);
        let order = topo_order(&deps);
        assert_eq!(order.len(), 2, "both tables present: {order:?}");
        let deferred: usize = deps.iter().map(|d| d.deferred_fk_columns.len()).sum();
        assert_eq!(deferred, 1, "one FK column deferred to break the cycle");
    }

    #[test]
    fn lookup_tables_detected_by_name() {
        let lookup = TableMeta {
            columns: vec![
                ColumnInfo {
                    name: "id".into(),
                    data_type: "int".into(),
                    nullable: false,
                    pk: true,
                    default_value: None,
                    fk: None,
                },
                ColumnInfo {
                    name: "name".into(),
                    data_type: "text".into(),
                    nullable: false,
                    pk: false,
                    default_value: None,
                    fk: None,
                },
            ],
            ..Default::default()
        };
        assert_eq!(classify_role("order_status", &lookup), TableRole::Lookup);
    }

    #[test]
    fn junction_is_only_fk_columns() {
        let mut j = meta_with_fks(vec![("post_id", "posts", "id"), ("tag_id", "tags", "id")]);
        j.columns = vec![
            ColumnInfo {
                name: "post_id".into(),
                data_type: "int".into(),
                nullable: false,
                pk: true,
                default_value: None,
                fk: Some(FkRef {
                    table: "posts".into(),
                    column: "id".into(),
                }),
            },
            ColumnInfo {
                name: "tag_id".into(),
                data_type: "int".into(),
                nullable: false,
                pk: true,
                default_value: None,
                fk: Some(FkRef {
                    table: "tags".into(),
                    column: "id".into(),
                }),
            },
        ];
        assert_eq!(classify_role("post_tags", &j), TableRole::Junction);
    }

    #[test]
    fn scaling_keeps_lookups_small_and_entities_at_base() {
        assert!(scale_rows(TableRole::Lookup, GenerateSize::OneM) <= 100);
        assert_eq!(scale_rows(TableRole::Entity, GenerateSize::TenK), 10_000);
        assert!(scale_rows(TableRole::Junction, GenerateSize::OneK) >= 1_000);
    }
}
