use super::*;

fn steps(sql: &str) -> Vec<DebugStep> {
    plan(sql, Engine::Postgres, None)
        .unwrap_or_else(|e| panic!("no plan for {sql}: {e:?}"))
        .steps
}

fn keys(sql: &str) -> Vec<String> {
    steps(sql).into_iter().map(|s| s.key).collect()
}

fn get<'a>(steps: &'a [DebugStep], key: &str) -> &'a DebugStep {
    steps
        .iter()
        .find(|s| s.key == key)
        .unwrap_or_else(|| panic!("no {key} step"))
}

/// The text a step's range covers in the editor (ASCII tests only).
fn covered<'a>(sql: &'a str, st: &DebugStep) -> &'a str {
    &sql[st.range[0]..st.range[1]]
}

// ---- A2 · eligibility ------------------------------------------------------

#[test]
fn each_reason_is_its_own_error() {
    let reason = |sql: &str| plan(sql, Engine::Postgres, None).unwrap_err();
    assert_eq!(reason(""), CannotDebug::Empty);
    assert_eq!(
        reason("  -- just a note\n /* and this */ "),
        CannotDebug::Empty
    );
    assert_eq!(reason(";"), CannotDebug::Empty);
    assert_eq!(
        reason("SELECT 1 FROM a; SELECT 2 FROM b"),
        CannotDebug::Multiple
    );
    assert_eq!(reason("INSERT INTO t VALUES (1)"), CannotDebug::NotSelect);
    assert_eq!(
        reason("SELECT * INTO backup FROM users"),
        CannotDebug::NotSelect
    );
    assert_eq!(reason("SELECT * FROM t FOR UPDATE"), CannotDebug::NotSelect);
    assert_eq!(reason("SELECT 1"), CannotDebug::NoFrom);
}

#[test]
fn one_trailing_semicolon_is_still_one_statement() {
    assert_eq!(keys("SELECT * FROM t;"), ["from", "select"]);
    assert_eq!(keys("SELECT * FROM t;;\n"), ["from", "select"]);
}

// ---- A1 · clause spans ------------------------------------------------------

#[test]
fn finds_every_clause_in_run_order() {
    let sql = "SELECT DISTINCT o.status, COUNT(*) FROM orders o JOIN users u ON u.id = o.user_id \
               LEFT JOIN payments p ON p.order_id = o.id WHERE o.total > 100 GROUP BY o.status \
               ORDER BY o.status LIMIT 5";
    assert_eq!(
        keys(sql),
        ["from", "join0", "join1", "where", "groupBy", "select", "distinct", "orderBy", "limit"]
    );
    let s = steps(sql);
    assert_eq!(covered(sql, get(&s, "from")), "FROM orders o");
    assert_eq!(
        covered(sql, get(&s, "join0")),
        "JOIN users u ON u.id = o.user_id"
    );
    assert_eq!(
        covered(sql, get(&s, "join1")),
        "LEFT JOIN payments p ON p.order_id = o.id"
    );
    assert_eq!(covered(sql, get(&s, "where")), "WHERE o.total > 100");
    assert_eq!(covered(sql, get(&s, "groupBy")), "GROUP BY o.status");
    assert_eq!(
        covered(sql, get(&s, "select")),
        "SELECT DISTINCT o.status, COUNT(*)"
    );
    assert_eq!(covered(sql, get(&s, "orderBy")), "ORDER BY o.status");
    assert_eq!(covered(sql, get(&s, "limit")), "LIMIT 5");
    assert_eq!(get(&s, "join1").kw, "LEFT JOIN");
    assert_eq!(get(&s, "where").text, "o.total > 100");
    assert_eq!(get(&s, "groupBy").text, "o.status");
}

#[test]
fn keywords_in_strings_comments_and_quoted_names_are_not_clauses() {
    let sql = "SELECT \"from\", 'where x' AS w -- order by nothing\n\
               FROM \"group by\" g /* limit 1 */ WHERE g.note <> 'join me'";
    assert_eq!(keys(sql), ["from", "where", "select"]);
    let s = steps(sql);
    assert_eq!(covered(sql, get(&s, "from")), "FROM \"group by\" g");
    assert_eq!(covered(sql, get(&s, "where")), "WHERE g.note <> 'join me'");
}

#[test]
fn a_subquerys_clauses_belong_to_the_subquery() {
    let sql =
        "SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE active ORDER BY id)";
    assert_eq!(keys(sql), ["from", "where", "select"]);
}

#[test]
fn ranges_count_utf16_units_not_bytes() {
    let sql = "SELECT naïve FROM café WHERE naïve = 'niño'";
    let s = steps(sql);
    let w = get(&s, "where");
    let units: Vec<u16> = sql.encode_utf16().collect();
    let text = String::from_utf16(&units[w.range[0]..w.range[1]]).unwrap();
    assert_eq!(text, "WHERE naïve = 'niño'");
}

// ---- A3 · step queries ------------------------------------------------------

#[test]
fn each_step_runs_a_growing_prefix() {
    let sql = "SELECT o.status, COUNT(*) AS n FROM orders o JOIN payments p ON p.order_id = o.id \
               WHERE o.total > 100 GROUP BY o.status HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 3";
    let s = steps(sql);
    assert_eq!(get(&s, "from").sql, "SELECT *\nFROM orders o");
    assert_eq!(
        get(&s, "join0").sql,
        "SELECT *\nFROM orders o JOIN payments p ON p.order_id = o.id"
    );
    assert_eq!(
        get(&s, "where").sql,
        "SELECT *\nFROM orders o JOIN payments p ON p.order_id = o.id WHERE o.total > 100"
    );
    assert_eq!(
        get(&s, "groupBy").sql,
        "SELECT o.status, COUNT(*) AS n\nFROM orders o JOIN payments p ON p.order_id = o.id \
         WHERE o.total > 100 GROUP BY o.status HAVING COUNT(*) > 1"
    );
    assert_eq!(get(&s, "groupBy").notes, [StaticNote::Having]);
    assert!(get(&s, "select").grouped);
    assert!(!get(&s, "select").aggregate);
    assert!(get(&s, "limit").ordered);
}

/// Done-when for A3: the last step is the statement as written.
#[test]
fn the_last_step_is_the_original_statement() {
    for sql in [
        "SELECT * FROM t",
        "SELECT a FROM t WHERE b = 1",
        "SELECT DISTINCT a FROM t ORDER BY a",
        "SELECT a, COUNT(*) FROM t GROUP BY a ORDER BY 2 DESC LIMIT 10 OFFSET 5",
    ] {
        let last = steps(sql).pop().unwrap();
        assert_eq!(one_line(&last.sql), one_line(sql), "for {sql}");
    }
}

#[test]
fn select_drops_distinct_and_distinct_puts_it_back() {
    let sql = "SELECT DISTINCT country FROM users";
    let s = steps(sql);
    assert_eq!(get(&s, "select").sql, "SELECT country\nFROM users");
    assert_eq!(get(&s, "select").text, "country");
    assert_eq!(
        get(&s, "distinct").sql,
        "SELECT DISTINCT country\nFROM users"
    );
    // Postgres DISTINCT ON keeps its column list with the keyword.
    let on = steps("SELECT DISTINCT ON (a) a, b FROM t ORDER BY a, b");
    assert_eq!(get(&on, "select").sql, "SELECT a, b\nFROM t");
    assert_eq!(get(&on, "distinct").text, "DISTINCT ON (a)");
}

#[test]
fn an_aggregate_without_group_by_folds_but_a_window_does_not() {
    let s = steps("SELECT COUNT(*) FROM orders");
    assert!(get(&s, "select").aggregate);
    let w = steps("SELECT id, SUM(total) OVER (ORDER BY id) FROM orders");
    assert!(!get(&w, "select").aggregate);
    assert_eq!(get(&w, "select").notes, [StaticNote::Window]);
    // An aggregate inside a scalar subquery does not fold the outer rows.
    let sub = steps("SELECT id, (SELECT MAX(x) FROM y) FROM orders");
    assert!(!get(&sub, "select").aggregate);
}

#[test]
fn sql_server_top_is_the_limit_step_and_leaves_the_earlier_ones() {
    let sql = "SELECT TOP (10) WITH TIES name FROM users ORDER BY name";
    let p = plan(sql, Engine::Mssql, None).unwrap();
    let keys: Vec<_> = p.steps.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, ["from", "select", "orderBy", "limit"]);
    assert_eq!(get(&p.steps, "select").sql, "SELECT name\nFROM users");
    assert_eq!(
        get(&p.steps, "orderBy").sql,
        "SELECT name\nFROM users ORDER BY name"
    );
    let top = get(&p.steps, "limit");
    assert_eq!(top.kw, "TOP");
    assert_eq!(covered(sql, top), "TOP (10) WITH TIES");
    assert_eq!(one_line(&top.sql), one_line(sql));
    // Counting an ordered step drops the ORDER BY SQL Server refuses in a
    // derived table.
    assert!(get(&p.steps, "orderBy")
        .count_sql
        .iter()
        .all(|c| !c.contains("ORDER BY")));
}

#[test]
fn offset_and_fetch_form_one_limit_step() {
    let sql = "SELECT a FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY";
    let s = steps(sql);
    let l = get(&s, "limit");
    assert_eq!(l.kw, "OFFSET");
    assert_eq!(covered(sql, l), "OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY");
}

// ---- A4 · counts ------------------------------------------------------------

#[test]
fn row_steps_count_directly_and_later_steps_wrap() {
    let s = steps("SELECT DISTINCT a FROM t WHERE b = 1");
    assert_eq!(get(&s, "from").count_sql, ["SELECT COUNT(*)\nFROM t"]);
    assert_eq!(
        get(&s, "where").count_sql,
        ["SELECT COUNT(*)\nFROM t WHERE b = 1"]
    );
    assert_eq!(
        get(&s, "distinct").count_sql,
        ["SELECT COUNT(*) FROM (\nSELECT DISTINCT a\nFROM t WHERE b = 1\n) bt_step"]
    );
    // A plain SELECT keeps every row, so `1` per row is a valid fallback.
    assert_eq!(get(&s, "select").count_sql.len(), 2);
    assert!(get(&s, "select").count_sql[1].contains("SELECT 1 AS bt_one"));
}

// ---- A5 · sampling ----------------------------------------------------------

#[test]
fn a_sampled_plan_caps_the_base_table_in_every_step() {
    let sql = "SELECT * FROM public.orders JOIN users u ON u.id = orders.user_id WHERE total > 1";
    let p = plan(sql, Engine::Postgres, Some(1000)).unwrap();
    assert_eq!(p.sampled, Some(1000));
    assert_eq!(p.sources, ["orders", "users"]);
    for st in &p.steps {
        assert!(
            st.sql
                .contains("(SELECT * FROM public.orders LIMIT 1000) orders"),
            "{}: {}",
            st.key,
            st.sql
        );
    }
    // Ranges still point at the text the user wrote.
    assert_eq!(covered(sql, get(&p.steps, "where")), "WHERE total > 1");

    let ms = plan("SELECT * FROM dbo.orders o", Engine::Mssql, Some(50)).unwrap();
    assert_eq!(
        ms.steps[0].sql,
        "SELECT *\nFROM (SELECT TOP (50) * FROM dbo.orders) o"
    );
}

#[test]
fn a_derived_table_or_cte_is_one_opaque_source_and_is_not_sampled() {
    let d = plan(
        "SELECT * FROM (SELECT * FROM t) x WHERE a = 1",
        Engine::Postgres,
        Some(5),
    )
    .unwrap();
    assert!(!d.can_sample);
    assert_eq!(d.sampled, None);
    assert_eq!(d.steps[0].notes, [StaticNote::OpaqueSource]);
    assert_eq!(d.steps[0].sql, "SELECT *\nFROM (SELECT * FROM t) x");

    let c = plan(
        "WITH recent AS (SELECT * FROM orders WHERE id > 5) SELECT * FROM recent r WHERE r.total > 1",
        Engine::Postgres,
        None,
    )
    .unwrap();
    assert!(!c.can_sample);
    assert_eq!(c.steps[0].notes, [StaticNote::OpaqueSource]);
    // The CTE list is kept in front of every step.
    assert_eq!(
        c.steps[0].sql,
        "WITH recent AS (SELECT * FROM orders WHERE id > 5)\nSELECT *\nFROM recent r"
    );
    assert!(c.steps[0].count_sql[0].starts_with("WITH recent AS"));
}

// ---- A6 · constructs that are not broken out ---------------------------------

#[test]
fn a_set_operation_steps_the_first_branch_then_runs_the_whole() {
    let sql = "SELECT id FROM a WHERE x = 1 UNION ALL SELECT id FROM b ORDER BY id";
    let s = steps(sql);
    let keys: Vec<_> = s.iter().map(|st| st.key.as_str()).collect();
    assert_eq!(keys, ["from", "where", "select", "setOp"]);
    let set = get(&s, "setOp");
    assert_eq!(set.kw, "UNION");
    assert_eq!(one_line(&set.sql), one_line(sql));
    assert_eq!(
        set.notes,
        [StaticNote::SetOperation {
            keyword: "UNION".into()
        }]
    );
    assert_eq!(get(&s, "where").sql, "SELECT *\nFROM a WHERE x = 1");
}

// ---- A7 · join diagnostics --------------------------------------------------

#[test]
fn an_equality_join_gets_anti_join_and_repeat_counts() {
    let s = steps("SELECT * FROM orders o JOIN payments p ON p.order_id = o.id");
    let j = get(&s, "join0").join.clone().expect("probe");
    assert!(!j.left);
    assert_eq!(j.on, "p.order_id = o.id");
    assert_eq!(j.alias, "p");
    assert_eq!(
        j.none_sql,
        "SELECT COUNT(*)\nFROM orders o\nWHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)"
    );
    assert_eq!(
        j.many_sql,
        "SELECT COUNT(*)\nFROM orders o\nWHERE (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id) > 1"
    );
    // Either side may name the joined table.
    let r = steps("SELECT * FROM orders o LEFT JOIN payments ON o.id = payments.order_id");
    let j = get(&r, "join0").join.clone().expect("probe");
    assert!(j.left);
    assert!(j.none_sql.contains("WHERE payments.order_id = o.id"));
}

#[test]
fn joins_the_counts_cannot_describe_get_no_probe() {
    for sql in [
        "SELECT * FROM a RIGHT JOIN b ON b.id = a.id",
        "SELECT * FROM a CROSS JOIN b",
        "SELECT * FROM a JOIN b USING (id)",
        "SELECT * FROM a JOIN b ON b.id = a.id AND b.x = 1",
        "SELECT * FROM a JOIN b ON a.id = c.id",
    ] {
        assert_eq!(get(&steps(sql), "join0").join, None, "for {sql}");
    }
}

// ---- A8 · WHERE per condition -----------------------------------------------

#[test]
fn where_splits_on_top_level_and_but_not_between() {
    let s = steps(
        "SELECT * FROM orders o JOIN payments p ON p.order_id = o.id \
         WHERE o.total BETWEEN 1 AND 500 AND (p.status = 'a' OR p.status = 'b') AND o.id > 0",
    );
    let w = get(&s, "where");
    let conds = w.conds.clone().expect("conds");
    let texts: Vec<_> = conds.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(
        texts,
        [
            "o.total BETWEEN 1 AND 500",
            "(p.status = 'a' OR p.status = 'b')",
            "o.id > 0"
        ]
    );
    assert_eq!(
        conds[2].sql,
        "SELECT COUNT(*)\nFROM orders o JOIN payments p ON p.order_id = o.id\nWHERE o.id > 0"
    );
    assert!(!w.has_or);
}

#[test]
fn a_top_level_or_cannot_be_split() {
    let s = steps("SELECT * FROM t WHERE a = 1 OR b = 2");
    let w = get(&s, "where");
    assert!(w.has_or);
    assert_eq!(w.conds, None);
    // One condition: nothing to compare.
    assert_eq!(
        get(&steps("SELECT * FROM t WHERE a = 1"), "where").conds,
        None
    );
}

/// The milestone's acceptance query.
#[test]
fn the_acceptance_query_plans_as_expected() {
    let sql = "SELECT * FROM orders o JOIN payments p ON p.order_id = o.id \
               WHERE o.total > 100 AND p.status = 'zzz'";
    let s = steps(sql);
    assert_eq!(keys(sql), ["from", "join0", "where", "select"]);
    assert!(get(&s, "join0").join.is_some());
    let conds = get(&s, "where").conds.clone().unwrap();
    assert_eq!(conds[1].text, "p.status = 'zzz'");
}

// ---- UPDATE / DELETE as a dry run -------------------------------------------

fn write_plan(sql: &str, engine: Engine) -> DebugPlan {
    plan(sql, engine, None).unwrap_or_else(|e| panic!("no plan for {sql}: {e:?}"))
}

fn plan_keys(p: &DebugPlan) -> Vec<&str> {
    p.steps.iter().map(|s| s.key.as_str()).collect()
}

#[test]
fn an_update_is_stepped_as_the_select_of_its_rows() {
    let sql =
        "UPDATE orders o SET status = 'void', total = total * 0 WHERE o.total > 100 AND o.paid = 0";
    let p = write_plan(sql, Engine::Postgres);
    assert_eq!(plan_keys(&p), ["from", "where", "write"]);
    let w = p.write.as_ref().unwrap();
    assert_eq!(
        (w.kind.as_str(), w.table.as_str(), w.joined, w.preview),
        ("update", "orders", false, true)
    );
    assert_eq!(get(&p.steps, "from").sql, "SELECT *\nFROM orders o");
    // The WHERE's range is on the text the user wrote, and still split by AND.
    assert_eq!(
        covered(sql, get(&p.steps, "where")),
        "WHERE o.total > 100 AND o.paid = 0"
    );
    assert_eq!(get(&p.steps, "where").conds.as_ref().unwrap().len(), 2);
    let last = get(&p.steps, "write");
    assert_eq!(last.kw, "UPDATE");
    assert_eq!(covered(sql, last), "SET status = 'void', total = total * 0");
    assert_eq!(
        last.sql,
        "SELECT o.*, 'void' AS \"→ status\", total * 0 AS \"→ total\"\nFROM orders o\nWHERE o.total > 100 AND o.paid = 0"
    );
    assert_eq!(last.notes, [StaticNote::DryRun]);
    // Every query the dry run sends reads.
    for st in &p.steps {
        assert!(
            crate::shared::readonly::sql_is_read_only(&st.sql),
            "{}",
            st.sql
        );
    }
}

#[test]
fn a_delete_shows_the_rows_that_would_go() {
    let sql = "DELETE FROM sessions WHERE expires_at < '2026-01-01'";
    let p = write_plan(sql, Engine::Sqlite);
    assert_eq!(plan_keys(&p), ["from", "where", "write"]);
    let last = get(&p.steps, "write");
    assert_eq!(last.kw, "DELETE");
    assert_eq!(covered(sql, last), "DELETE FROM sessions");
    assert_eq!(
        last.sql,
        "SELECT sessions.*\nFROM sessions\nWHERE expires_at < '2026-01-01'"
    );
    assert!(!p.write.as_ref().unwrap().preview);
}

#[test]
fn mysql_order_by_and_limit_on_a_write_are_steps() {
    let p = write_plan(
        "DELETE FROM logs WHERE level = 'debug' ORDER BY id LIMIT 1000",
        Engine::Mysql,
    );
    assert_eq!(
        plan_keys(&p),
        ["from", "where", "orderBy", "limit", "write"]
    );
    assert!(one_line(&get(&p.steps, "write").sql).ends_with("ORDER BY id LIMIT 1000"));
}

#[test]
fn each_dialects_joined_write_maps_to_one_from_list() {
    // Postgres / SQLite: UPDATE … FROM, the target first.
    let pg = write_plan(
        "UPDATE orders o SET status = p.status FROM payments p WHERE p.order_id = o.id",
        Engine::Postgres,
    );
    assert_eq!(
        get(&pg.steps, "from").sql,
        "SELECT *\nFROM orders o, payments p"
    );
    assert!(pg.write.as_ref().unwrap().joined);
    // Postgres DELETE … USING.
    let using = write_plan(
        "DELETE FROM orders o USING users u WHERE u.id = o.user_id AND u.banned",
        Engine::Postgres,
    );
    assert_eq!(
        get(&using.steps, "from").sql,
        "SELECT *\nFROM orders o, users u"
    );
    assert_eq!(
        get(&using.steps, "write").sql.lines().next(),
        Some("SELECT o.*")
    );
    // MySQL: the joins sit between UPDATE and SET, and get JOIN diagnostics.
    let my = write_plan(
        "UPDATE orders o JOIN payments p ON p.order_id = o.id SET o.status = 'paid' WHERE p.ok = 1",
        Engine::Mysql,
    );
    assert_eq!(plan_keys(&my), ["from", "join0", "where", "write"]);
    assert!(get(&my.steps, "join0").join.is_some());
    assert!(get(&my.steps, "write").sql.contains("'paid' AS `→ status`"));
    // SQL Server: the target is an alias declared in the FROM list.
    let ms = write_plan(
        "UPDATE o SET o.status = 'x' FROM dbo.orders o JOIN dbo.users u ON u.id = o.user_id WHERE u.vip = 1",
        Engine::Mssql,
    );
    assert_eq!(get(&ms.steps, "from").sql, "SELECT *\nFROM dbo.orders o");
    assert_eq!(ms.write.as_ref().unwrap().table, "orders");
    assert!(get(&ms.steps, "write").sql.contains("[→ status]"));
    // MySQL / SQL Server: DELETE alias FROM … JOIN.
    let del = write_plan(
        "DELETE o FROM orders o JOIN users u ON u.id = o.user_id WHERE u.banned = 1",
        Engine::Mysql,
    );
    assert_eq!(plan_keys(&del), ["from", "join0", "where", "write"]);
    assert_eq!(
        get(&del.steps, "write").sql.lines().next(),
        Some("SELECT o.*")
    );
}

#[test]
fn a_joined_write_counts_distinct_target_rows_first() {
    let p = write_plan(
        "UPDATE orders o SET status = 'x' FROM payments p WHERE p.order_id = o.id",
        Engine::Postgres,
    );
    let last = get(&p.steps, "write");
    assert!(last.always_count);
    assert!(
        last.count_sql[0].contains("SELECT DISTINCT o.*"),
        "{}",
        last.count_sql[0]
    );
    assert!(
        last.count_sql.len() >= 2,
        "the joined count is the fallback"
    );
}

#[test]
fn sql_server_top_and_output_on_a_write() {
    let sql = "DELETE TOP (10) FROM dbo.logs OUTPUT deleted.id WHERE level = 1";
    let p = write_plan(sql, Engine::Mssql);
    assert_eq!(plan_keys(&p), ["from", "where", "limit", "write"]);
    let last = get(&p.steps, "write");
    assert!(
        last.sql.starts_with("SELECT TOP (10) logs.*"),
        "{}",
        last.sql
    );
    assert!(
        !last.sql.contains("OUTPUT"),
        "OUTPUT is about the write, not the rows"
    );
}

#[test]
fn a_cte_in_front_of_a_write_stays_in_front_of_every_step() {
    let p = write_plan(
        "WITH old AS (SELECT id FROM orders WHERE created < '2020-01-01') DELETE FROM orders WHERE id IN (SELECT id FROM old)",
        Engine::Postgres,
    );
    for st in &p.steps {
        assert!(st.sql.starts_with("WITH old AS"), "{}", st.sql);
    }
}

#[test]
fn writes_that_cannot_be_dry_run_say_why() {
    let reason = |sql: &str, e: Engine| plan(sql, e, None).unwrap_err();
    assert_eq!(
        reason("DELETE a, b FROM a JOIN b ON b.id = a.id", Engine::Mysql),
        CannotDebug::MultipleTargets
    );
    assert_eq!(
        reason("UPDATE orders", Engine::Postgres),
        CannotDebug::UnreadableWrite
    );
    assert_eq!(
        reason("INSERT INTO t VALUES (1)", Engine::Postgres),
        CannotDebug::NotSelect
    );
    assert_eq!(
        reason("UPDATE t SET a = 1; DELETE FROM t", Engine::Postgres),
        CannotDebug::Multiple
    );
}

#[test]
fn a_tuple_assignment_still_counts_without_a_preview() {
    let p = write_plan(
        "UPDATE t SET (a, b) = (1, 2) WHERE id = 3",
        Engine::Postgres,
    );
    assert!(!p.write.as_ref().unwrap().preview);
    assert_eq!(
        get(&p.steps, "write").sql.lines().next(),
        Some("SELECT t.*")
    );
}
