use serde_json::json;

use super::capture::{analyze, with_returning, InsertHow, Plan};
use super::sql::{reverse, select_by_keys, ColType, ColTypes, Dialect};
use super::*;
use crate::shared::engine::Engine;

fn rows(columns: &[&str], rows: Vec<Vec<Value>>) -> Rows {
    Rows {
        columns: columns.iter().map(|c| c.to_string()).collect(),
        rows,
    }
}

fn pk() -> Vec<String> {
    vec!["id".into()]
}

fn entry(changes: Vec<Change>) -> Entry {
    Entry {
        id: "e".into(),
        connection_id: "c".into(),
        at: 0,
        source: Source::Statement,
        schema_name: "public".into(),
        sql: String::new(),
        verb: String::new(),
        rows: Some(changes.len() as u64),
        changes,
        cant: None,
        limit: None,
        tables: Vec::new(),
        side_effects: false,
        undone: Vec::new(),
        history: Vec::new(),
    }
}

/// The orders table before and after `UPDATE orders SET status = 'shipped'`.
fn shipped() -> Vec<Change> {
    let before = rows(
        &["id", "status", "note"],
        vec![vec![json!(1), json!("paid"), json!("a")]],
    );
    let after = rows(
        &["id", "status", "note"],
        vec![vec![json!(1), json!("shipped"), json!("a")]],
    );
    diff("public", "orders", &pk(), &before, &after)
}

fn now(table_rows: Option<Rows>) -> Current {
    let mut c = Current::new();
    c.insert(("public".into(), "orders".into()), table_rows);
    c
}

// ---- diff ---------------------------------------------------------------------

#[test]
fn diff_finds_inserts_updates_and_deletes_by_key() {
    let before = rows(
        &["id", "v"],
        vec![vec![json!(1), json!("a")], vec![json!(2), json!("b")]],
    );
    let after = rows(
        &["id", "v"],
        vec![vec![json!(1), json!("A")], vec![json!(3), json!("c")]],
    );
    let d = diff("s", "t", &pk(), &before, &after);
    let kinds: Vec<_> = d.iter().map(|c| (c.kind, c.key.clone())).collect();
    assert_eq!(
        kinds,
        [
            (Kind::Update, vec![json!(1)]),
            (Kind::Delete, vec![json!(2)]),
            (Kind::Insert, vec![json!(3)])
        ]
    );
    assert_eq!(d[0].cols, ["v"]);
    // An unchanged row (and a number read back as text) is no change.
    let same_rows = rows(&["id", "v"], vec![vec![json!(1), json!(5)]]);
    let as_text = rows(&["id", "v"], vec![vec![json!("1"), json!("5")]]);
    assert!(diff("s", "t", &pk(), &same_rows, &as_text).is_empty());
}

// ---- the check (B1): every row of the §3 table ---------------------------------

fn state(e: &Entry, current: &Current) -> (State, Option<Why>) {
    let v = &check(e, current, false)[0];
    (v.state, v.why)
}

#[test]
fn update_verdicts() {
    let e = entry(shipped());
    let row = |status: &str, note: &str| {
        Some(rows(
            &["id", "status", "note"],
            vec![vec![json!(1), json!(status), json!(note)]],
        ))
    };
    assert_eq!(state(&e, &now(row("shipped", "a"))), (State::Ok, None));
    assert_eq!(
        state(&e, &now(row("paid", "a"))),
        (State::Noop, Some(Why::AlreadyEarlier))
    );
    assert_eq!(
        state(&e, &now(row("delivered", "a"))),
        (State::Conflict, Some(Why::ChangedAgain))
    );
    assert_eq!(
        state(&e, &now(Some(rows(&["id", "status", "note"], vec![])))),
        (State::Conflict, Some(Why::RowGone))
    );
    assert_eq!(
        state(&e, &now(None)),
        (State::Conflict, Some(Why::TableGone))
    );
}

#[test]
fn an_edit_to_an_untouched_column_does_not_block_undo() {
    let e = entry(shipped());
    let edited = Some(rows(
        &["id", "status", "note"],
        vec![vec![json!(1), json!("shipped"), json!("CHANGED")]],
    ));
    assert_eq!(state(&e, &now(edited)), (State::Ok, None));
}

#[test]
fn a_conflict_names_the_column_its_value_now_and_what_the_change_left() {
    let e = entry(shipped());
    let row = Some(rows(
        &["id", "status", "note"],
        vec![vec![json!(1), json!("delivered"), json!("a")]],
    ));
    let v = &check(&e, &now(row), false)[0];
    assert_eq!(
        v.now,
        [Drift {
            col: "status".into(),
            now: json!("delivered"),
            was: json!("shipped")
        }]
    );
}

#[test]
fn insert_and_delete_verdicts() {
    let added = diff(
        "public",
        "orders",
        &pk(),
        &Rows::default(),
        &rows(&["id", "v"], vec![vec![json!(7), json!("x")]]),
    );
    let e = entry(added);
    let t = |r: Vec<Vec<Value>>| now(Some(rows(&["id", "v"], r)));
    assert_eq!(
        state(&e, &t(vec![vec![json!(7), json!("x")]])),
        (State::Ok, None)
    );
    assert_eq!(state(&e, &t(vec![])), (State::Noop, Some(Why::AlreadyGone)));
    assert_eq!(
        state(&e, &t(vec![vec![json!(7), json!("y")]])),
        (State::Conflict, Some(Why::ChangedAfterAdded))
    );

    let gone = diff(
        "public",
        "orders",
        &pk(),
        &rows(&["id", "v"], vec![vec![json!(7), json!("x")]]),
        &Rows::default(),
    );
    let e = entry(gone);
    assert_eq!(state(&e, &t(vec![])), (State::Ok, None));
    assert_eq!(
        state(&e, &t(vec![vec![json!(7), json!("z")]])),
        (State::Conflict, Some(Why::KeyExistsAgain))
    );
}

#[test]
fn redo_checks_the_flipped_change_on_undone_rows_only() {
    let mut e = entry(shipped());
    // Not undone yet: nothing to redo.
    let paid = Some(rows(
        &["id", "status", "note"],
        vec![vec![json!(1), json!("paid"), json!("a")]],
    ));
    assert_eq!(check(&e, &now(paid.clone()), true)[0].state, State::Done);
    // Undone (the row is back to "paid"): redo can set it to "shipped" again.
    e.undone = vec![0];
    assert_eq!(check(&e, &now(paid), true)[0].state, State::Ok);
    // …unless it changed after the undo.
    let moved = Some(rows(
        &["id", "status", "note"],
        vec![vec![json!(1), json!("void"), json!("a")]],
    ));
    assert_eq!(check(&e, &now(moved), true)[0].state, State::Conflict);
}

#[test]
fn settle_records_ok_and_noop_rows_and_one_activity_line() {
    let mut e = entry(shipped());
    let v = vec![Verdict {
        i: 0,
        state: State::Ok,
        why: None,
        now: vec![],
    }];
    settle(&mut e, &v, false, 5);
    assert_eq!(e.undone, [0]);
    assert_eq!(e.history[0].what, "undo");
    settle(&mut e, &v, true, 6);
    assert!(e.undone.is_empty());
    assert_eq!(e.history.len(), 2);
}

// ---- reversing SQL (C1–C2) ---------------------------------------------------

fn types(identity: bool) -> ColTypes {
    let mut t = ColTypes::new();
    t.insert(
        "id".into(),
        ColType {
            identity,
            ..Default::default()
        },
    );
    t.insert(
        "blob".into(),
        ColType {
            binary: true,
            ..Default::default()
        },
    );
    t
}

#[test]
fn reversing_statements_per_kind_and_engine() {
    let c = &shipped()[0];
    assert_eq!(
        reverse(Dialect::Postgres, c, &types(false)),
        [r#"UPDATE "public"."orders" SET "status" = 'paid' WHERE "id" = 1;"#]
    );
    assert_eq!(
        reverse(Dialect::Mysql, c, &types(false)),
        ["UPDATE `public`.`orders` SET `status` = 'paid' WHERE `id` = 1;"]
    );
    let added = &diff(
        "main",
        "t",
        &pk(),
        &Rows::default(),
        &rows(&["id"], vec![vec![json!(9)]]),
    )[0];
    assert_eq!(
        reverse(Dialect::Sqlite, added, &types(false)),
        [r#"DELETE FROM "t" WHERE "id" = 9;"#]
    );
}

#[test]
fn a_deleted_row_comes_back_with_its_original_key() {
    let before = rows(
        &["id", "name", "blob", "ok"],
        vec![vec![
            json!(4),
            json!("O'Brien"),
            json!("0xCAFE"),
            json!(true),
        ]],
    );
    let gone = &diff("dbo", "t", &pk(), &before, &Rows::default())[0];
    assert_eq!(
        reverse(Dialect::Postgres, gone, &types(true)),
        [
            r#"INSERT INTO "dbo"."t" ("id", "name", "blob", "ok") OVERRIDING SYSTEM VALUE VALUES (4, 'O''Brien', '\xCAFE'::bytea, TRUE);"#
        ]
    );
    assert_eq!(
        reverse(Dialect::Mssql, gone, &types(true)),
        [
            "SET IDENTITY_INSERT [dbo].[t] ON;",
            "INSERT INTO [dbo].[t] ([id], [name], [blob], [ok]) VALUES (4, N'O''Brien', 0xCAFE, 1);",
            "SET IDENTITY_INSERT [dbo].[t] OFF;"
        ]
    );
    assert_eq!(
        reverse(Dialect::Mysql, gone, &types(true)),
        ["INSERT INTO `dbo`.`t` (`id`, `name`, `blob`, `ok`) VALUES (4, 'O''Brien', X'CAFE', TRUE);"]
    );
}

#[test]
fn mysql_escapes_backslashes_and_keys_are_read_in_one_locked_query() {
    let c = Change {
        kind: Kind::Update,
        cols: vec!["path".into()],
        before: Some(vec![json!(1), json!("C:\\tmp")]),
        after: Some(vec![json!(1), json!("D:")]),
        columns: vec!["id".into(), "path".into()],
        ..shipped()[0].clone()
    };
    assert!(reverse(Dialect::Mysql, &c, &ColTypes::new())[0].contains(r"'C:\\tmp'"));
    let keys = vec![vec![json!(1)], vec![json!(2)]];
    assert_eq!(
        select_by_keys(
            Dialect::Postgres,
            "public",
            "orders",
            &pk(),
            &keys,
            &ColTypes::new(),
            true
        ),
        r#"SELECT * FROM "public"."orders" WHERE "id" IN (1, 2) FOR UPDATE"#
    );
    assert_eq!(
        select_by_keys(
            Dialect::Mssql,
            "dbo",
            "o",
            &pk(),
            &keys,
            &ColTypes::new(),
            true
        ),
        "SELECT * FROM [dbo].[o] WITH (UPDLOCK, ROWLOCK) WHERE [id] IN (1, 2)"
    );
}

// ---- capture (A2–A4) -----------------------------------------------------------

#[test]
fn statements_are_read_into_what_to_record() {
    let pg = |s: &str| analyze(s, Engine::Postgres);
    assert_eq!(pg("SELECT 1"), Plan::Plain);
    assert_eq!(pg("SET search_path TO x"), Plan::Plain);
    assert_eq!(pg("BEGIN"), Plan::Begin);
    assert_eq!(pg("COMMIT"), Plan::Commit);
    assert_eq!(pg("ROLLBACK"), Plan::Rollback);
    assert_eq!(pg("ROLLBACK TO SAVEPOINT a"), Plan::Plain);
    assert!(matches!(
        pg("ALTER TABLE t ADD c int"),
        Plan::Cant {
            reason: Cant::Structure,
            ..
        }
    ));
    assert!(matches!(
        pg("CALL refresh()"),
        Plan::Cant {
            reason: Cant::Unsupported,
            ..
        }
    ));
    assert!(matches!(
        pg("UPDATE orders o SET status = p.status FROM payments p WHERE p.order_id = o.id"),
        Plan::Cant {
            reason: Cant::Multitable,
            ..
        }
    ));
    assert!(matches!(
        pg("INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 2"),
        Plan::Cant {
            reason: Cant::Unsupported,
            ..
        }
    ));
    match pg("UPDATE public.orders SET status = 'x' WHERE id = 3") {
        Plan::Rows {
            kind,
            schema,
            table,
            target_sql,
            ..
        } => {
            assert_eq!(kind, Kind::Update);
            assert_eq!(schema.as_deref(), Some("public"));
            assert_eq!(table, "orders");
            assert_eq!(
                target_sql,
                "SELECT orders.*\nFROM public.orders\nWHERE id = 3"
            );
        }
        other => panic!("{other:?}"),
    }
    match pg("TRUNCATE TABLE logs") {
        Plan::Rows {
            kind: Kind::Delete,
            target_sql,
            ..
        } => assert_eq!(target_sql, "SELECT * FROM logs"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn inserts_read_their_new_rows_back_per_engine() {
    let sql = "INSERT INTO t (a) VALUES (1)";
    let Plan::Insert { how, .. } = analyze(sql, Engine::Postgres) else {
        panic!()
    };
    assert_eq!(
        with_returning(sql, &how),
        "INSERT INTO t (a) VALUES (1) RETURNING *"
    );
    let Plan::Insert { how, .. } = analyze(sql, Engine::Mssql) else {
        panic!()
    };
    assert_eq!(
        with_returning(sql, &how),
        "INSERT INTO t (a) OUTPUT inserted.* VALUES (1)"
    );
    assert!(matches!(
        analyze("INSERT INTO t (id, a) VALUES (5, 'x')", Engine::Mysql),
        Plan::Insert {
            how: InsertHow::MysqlSingle { .. },
            ..
        }
    ));
    // Several rows on MySQL: no way to say which rows were added.
    assert!(matches!(
        analyze("INSERT INTO t (a) VALUES (1), (2)", Engine::Mysql),
        Plan::Cant {
            reason: Cant::Unsupported,
            ..
        }
    ));
}
