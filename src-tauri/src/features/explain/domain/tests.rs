//! Parser tests over output captured verbatim from real servers (Postgres 16,
//! MySQL 8.4, SQLite 3) in `fixtures/`. Recording the real thing rather than
//! hand-writing JSON is the point: these formats have corners — MySQL nests
//! operations instead of nodes, Postgres reports time inclusive of children and
//! per loop — that invented fixtures would quietly get wrong.

use super::*;

/// A single-text-column result, as psql and the mysql client return JSON plans.
fn text_rows(json: &str) -> Vec<Vec<serde_json::Value>> {
    json.lines()
        .map(|l| vec![serde_json::Value::String(l.to_string())])
        .collect()
}

fn pg(fixture: &str) -> ServerPlan {
    parse(
        Engine::Postgres,
        &["QUERY PLAN".into()],
        &text_rows(fixture),
    )
    .expect("postgres plan parses")
}

fn my(fixture: &str) -> ServerPlan {
    parse(Engine::Mysql, &["EXPLAIN".into()], &text_rows(fixture)).expect("mysql plan parses")
}

fn sqlite_case(name: &str) -> ServerPlan {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/sqlite_eqp.json")).unwrap();
    let case = &doc[name];
    let columns: Vec<String> = case["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_string())
        .collect();
    let rows: Vec<Vec<serde_json::Value>> = case["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_array().unwrap().clone())
        .collect();
    parse(Engine::Sqlite, &columns, &rows).expect("sqlite plan parses")
}

const PG_PLAN: &str = include_str!("fixtures/pg_plan.json");
const PG_ANALYZE: &str = include_str!("fixtures/pg_analyze.json");
const PG_DERIVED: &str = include_str!("fixtures/pg_derived.json");
const MY_PLAN: &str = include_str!("fixtures/my_plan.json");
const MY_DERIVED: &str = include_str!("fixtures/my_derived.json");

#[test]
fn postgres_reads_node_names_relations_and_depths() {
    let plan = pg(PG_PLAN);
    let names: Vec<&str> = plan.nodes.iter().map(|n| n.node.as_str()).collect();
    assert_eq!(
        names,
        [
            "Limit",
            "Sort",
            "HashAggregate",
            "Hash Join",
            "Seq Scan on orders o",
            "Hash",
            "Seq Scan on users u",
        ]
    );
    let depths: Vec<usize> = plan.nodes.iter().map(|n| n.depth).collect();
    assert_eq!(depths, [0, 1, 2, 3, 4, 4, 5]);
    assert_eq!(plan.listing, Listing::OutermostFirst);
    // No ANALYZE: cost only, and no execution time to report.
    assert_eq!(plan.share, Some(Share::Cost));
    assert!(plan.total_ms.is_none());
    assert!(plan.nodes.iter().all(|n| n.ms.is_none()));
}

#[test]
fn postgres_carries_conditions_and_sort_keys_onto_the_detail_line() {
    let plan = pg(PG_PLAN);
    let by_name = |name: &str| {
        plan.nodes
            .iter()
            .find(|n| n.node == name)
            .unwrap_or_else(|| panic!("{name} present"))
            .clone()
    };
    assert_eq!(by_name("Sort").detail, "Sort Key: (count(*)) DESC");
    assert_eq!(by_name("HashAggregate").detail, "Group Key: o.status");
    assert_eq!(by_name("Hash Join").detail, "Hash Cond: (o.user_id = u.id)");
    assert!(by_name("Seq Scan on orders o")
        .detail
        .starts_with("Filter: "));
}

#[test]
fn postgres_kinds_classify_every_node() {
    let kinds: Vec<NodeKind> = pg(PG_PLAN).nodes.iter().map(|n| n.kind).collect();
    assert_eq!(
        kinds,
        [
            NodeKind::Limit,
            NodeKind::Sort,
            NodeKind::Agg,
            NodeKind::Join,
            NodeKind::Scan,
            // `Hash` matches nothing and must land on the catch-all rather than
            // being forced into a kind it is not.
            NodeKind::Other,
            NodeKind::Scan,
        ]
    );
}

/// The bug this guards: Postgres reports time and cost INCLUSIVE of the
/// subtree, so ranking nodes by the reported figure always crowns the root.
#[test]
fn postgres_self_work_excludes_children_so_the_root_does_not_win() {
    let plan = pg(PG_ANALYZE);
    assert_eq!(plan.share, Some(Share::Time));
    assert!(plan.total_ms.is_some());

    let root = &plan.nodes[0];
    assert_eq!(root.node, "Limit");
    // The root's inclusive time is the largest in the plan...
    let max_inclusive = plan
        .nodes
        .iter()
        .filter_map(|n| n.ms)
        .fold(f64::MIN, f64::max);
    assert_eq!(root.ms.unwrap(), max_inclusive);
    // ...but its own share is not, because its children account for nearly all
    // of it.
    let heaviest = plan
        .nodes
        .iter()
        .max_by(|a, b| {
            a.self_work
                .unwrap_or(0.0)
                .partial_cmp(&b.self_work.unwrap_or(0.0))
                .unwrap()
        })
        .unwrap();
    assert_ne!(heaviest.node, "Limit");
    assert!(heaviest.node.starts_with("Seq Scan"));
    // Self time never exceeds inclusive time, and is never negative.
    for node in &plan.nodes {
        let (Some(self_work), Some(ms)) = (node.self_work, node.ms) else {
            continue;
        };
        assert!(self_work >= 0.0, "{} went negative", node.node);
        assert!(
            self_work <= ms + f64::EPSILON,
            "{} exceeds its own total",
            node.node
        );
    }
}

#[test]
fn postgres_analyze_reports_actual_rows_and_what_the_filter_removed() {
    let plan = pg(PG_ANALYZE);
    let scan = plan
        .nodes
        .iter()
        .find(|n| n.node == "Seq Scan on orders o")
        .unwrap();
    let removed = scan.removed.expect("rows removed reported");
    let rows = scan.rows.expect("actual rows reported");
    // Rows read is what survived plus what the filter threw away.
    assert_eq!(scan.scanned, Some(rows + removed));
}

#[test]
fn postgres_handles_a_derived_table() {
    let plan = pg(PG_DERIVED);
    assert!(plan.nodes.iter().any(|n| n.kind == NodeKind::Agg));
    assert!(plan
        .nodes
        .iter()
        .any(|n| n.node.starts_with("Seq Scan on orders")));
    assert!(plan.nodes.iter().any(|n| n.node.contains("users u")));
}

#[test]
fn mysql_names_access_types_and_the_chosen_index() {
    let plan = my(MY_PLAN);
    let names: Vec<&str> = plan.nodes.iter().map(|n| n.node.as_str()).collect();
    assert_eq!(
        names,
        [
            "Sort (filesort)",
            "Aggregate using temporary table",
            "Nested Loop",
            "Seq Scan on o",
            "Unique Index Lookup using PRIMARY on u",
        ]
    );
    let lookup = plan.nodes.last().unwrap();
    assert_eq!(lookup.index.as_deref(), Some("PRIMARY"));
    assert_eq!(lookup.detail, "Ref: byteshop.o.user_id");
    // The scan MySQL did NOT index is the one with a filter attached.
    let scan = &plan.nodes[3];
    assert!(scan.detail.starts_with("Filter: "));
    assert_eq!(scan.index, None);
}

/// MySQL costs are per-node already, so they must not be corrected — and they
/// must not carry float noise from summing its decimal strings.
#[test]
fn mysql_costs_are_per_node_and_rounded() {
    let plan = my(MY_PLAN);
    assert_eq!(plan.share, Some(Share::Cost));
    assert!(plan.nodes.iter().all(|n| n.self_work.is_none()));
    let lookup = plan.nodes.last().unwrap();
    assert_eq!(lookup.cost, Some(1.84));
}

#[test]
fn mysql_estimates_what_a_filter_discards_from_the_filtered_percentage() {
    let scan = my(MY_PLAN)
        .nodes
        .into_iter()
        .find(|n| n.node == "Seq Scan on o")
        .unwrap();
    assert_eq!(scan.scanned, Some(5));
    assert_eq!(scan.rows, Some(1));
    assert_eq!(scan.removed, Some(4));
}

#[test]
fn mysql_nests_a_derived_table_under_the_table_that_reads_it() {
    let plan = my(MY_DERIVED);
    let materialize = plan
        .nodes
        .iter()
        .position(|n| n.node == "Materialize")
        .expect("derived table marked");
    // Everything from the marker down belongs to the derived query.
    assert!(plan.nodes[materialize..].iter().all(|n| n.subplan));
    assert!(plan.nodes[..materialize].iter().any(|n| !n.subplan));
    let inner = plan.nodes.last().unwrap();
    assert_eq!(inner.node, "Seq Scan on orders");
    assert!(inner.depth > plan.nodes[materialize].depth);
}

#[test]
fn sqlite_rewrites_prose_into_access_paths_and_keeps_the_original() {
    let plan = sqlite_case("join_group");
    let names: Vec<&str> = plan.nodes.iter().map(|n| n.node.as_str()).collect();
    assert_eq!(
        names,
        [
            "Seq Scan on o",
            "Index Lookup using PRIMARY KEY on u",
            "USE TEMP B-TREE FOR GROUP BY",
            "USE TEMP B-TREE FOR ORDER BY",
        ]
    );
    // SQLite's own words are kept underneath, since they are the plan.
    assert_eq!(
        plan.nodes[1].detail,
        "SEARCH u USING INTEGER PRIMARY KEY (rowid=?)"
    );
    assert_eq!(plan.nodes[1].index.as_deref(), Some("PRIMARY KEY"));
    assert_eq!(plan.nodes[2].kind, NodeKind::Agg);
    assert_eq!(plan.nodes[3].kind, NodeKind::Sort);
}

/// SQLite lists steps in the order they RUN, not outermost-first. Getting this
/// wrong numbers the "#" column backwards.
#[test]
fn sqlite_reports_execution_order_and_no_figures() {
    let plan = sqlite_case("join_group");
    assert_eq!(plan.listing, Listing::Execution);
    assert_eq!(plan.share, None);
    assert!(plan
        .nodes
        .iter()
        .all(|n| n.rows.is_none() && n.cost.is_none() && n.ms.is_none()));
}

#[test]
fn sqlite_nests_a_coroutine_subquery_by_its_parent_link() {
    let plan = sqlite_case("derived");
    let root = plan
        .nodes
        .iter()
        .position(|n| n.node.contains("CO-ROUTINE"));
    let root = root.expect("co-routine present");
    assert_eq!(plan.nodes[root].depth, 0);
    // Its steps hang off it rather than sitting beside it.
    assert_eq!(plan.nodes[root + 1].depth, 1);
    assert!(plan.nodes[root + 1].subplan);
}

#[test]
fn statements_are_built_per_engine_and_never_execute_for_the_tree() {
    let sql = "SELECT 1;";
    assert_eq!(
        structured_statement(Engine::Postgres, sql).as_deref(),
        Some("EXPLAIN (FORMAT JSON) SELECT 1")
    );
    assert_eq!(
        structured_statement(Engine::Mysql, sql).as_deref(),
        Some("EXPLAIN FORMAT=JSON SELECT 1")
    );
    assert_eq!(
        structured_statement(Engine::Sqlite, sql).as_deref(),
        Some("EXPLAIN QUERY PLAN SELECT 1")
    );
    // No structured plan is not the same as no plan at all.
    assert_eq!(structured_statement(Engine::Clickhouse, sql), None);
    assert!(raw_statement(Engine::Clickhouse, sql, false).is_some());
    // Nothing to explain.
    assert_eq!(structured_statement(Engine::Postgres, "  ;  "), None);
}

#[test]
fn analyze_is_refused_where_the_engine_has_no_such_form() {
    assert_eq!(
        raw_statement(Engine::Postgres, "SELECT 1", true).as_deref(),
        Some("EXPLAIN (ANALYZE, BUFFERS) SELECT 1")
    );
    assert_eq!(
        raw_statement(Engine::Mysql, "SELECT 1", true).as_deref(),
        Some("EXPLAIN ANALYZE SELECT 1")
    );
    assert_eq!(raw_statement(Engine::Sqlite, "SELECT 1", true), None);
    assert_eq!(raw_statement(Engine::Mssql, "SELECT 1", false), None);
    assert!(capabilities(Engine::Mssql).note.is_some());
}

/// A plan we cannot read must yield nothing, so the renderer keeps its modelled
/// tree — never half a tree, and never a panic.
#[test]
fn unreadable_plans_yield_nothing_instead_of_failing() {
    let junk = vec![vec![serde_json::Value::String("not json at all".into())]];
    assert!(parse(Engine::Postgres, &["QUERY PLAN".into()], &junk).is_none());
    assert!(parse(Engine::Mysql, &["EXPLAIN".into()], &junk).is_none());
    // Right shape, wrong columns.
    assert!(parse(Engine::Sqlite, &["nope".into()], &junk).is_none());
    // An engine with no parser at all.
    assert!(parse(Engine::Mssql, &["QUERY PLAN".into()], &junk).is_none());
    // Empty results.
    assert!(parse(Engine::Postgres, &[], &[]).is_none());
    assert!(parse(
        Engine::Sqlite,
        &["id".into(), "parent".into(), "detail".into()],
        &[]
    )
    .is_none());
}

/// The wire shape the renderer destructures. A rename here is a silent break on
/// the other side, so the field names are asserted rather than assumed.
#[test]
fn plan_nodes_serialize_to_the_names_the_renderer_reads() {
    let plan = pg(PG_ANALYZE);
    let json = serde_json::to_value(&plan).unwrap();
    let node = &json["nodes"][0];
    for key in [
        "node", "kind", "rows", "detail", "ms", "depth", "scanned", "removed", "method", "rel",
        "alias", "index", "cost", "subplan", "selfWork",
    ] {
        assert!(node.get(key).is_some(), "PlanNode is missing `{key}`");
    }
    for key in ["nodes", "source", "totalMs", "share", "listing"] {
        assert!(json.get(key).is_some(), "ServerPlan is missing `{key}`");
    }
    // Enums cross the wire as the lowercase / kebab strings the TS unions use.
    assert_eq!(json["source"], "postgres");
    assert_eq!(json["share"], "time");
    assert_eq!(json["listing"], "outermost-first");
    assert_eq!(json["nodes"][0]["kind"], "limit");
    let caps = serde_json::to_value(capabilities(Engine::Sqlite)).unwrap();
    for key in ["plan", "analyze", "structured", "note"] {
        assert!(
            caps.get(key).is_some(),
            "ExplainCapabilities is missing `{key}`"
        );
    }
}
