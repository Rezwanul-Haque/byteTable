//! Postgres schema-object introspection + DDL builders (views, materialized
//! views, functions, procedures, triggers). Catalog queries bind the schema /
//! name as parameters; `relkind`/`prokind` discriminators are fixed internal
//! constants interpolated safely. Definitions come from the `pg_get_*def`
//! builtins (authoritative, runnable DDL). `drop_sql` is pure (unit-tested).

use sqlx::{PgPool, Row};

use crate::shared::engine::{DbObjectDefinition, DbObjectInfo, DbObjectKind, RoutineArg};
use crate::shared::error::AppError;

use super::map_query_error;
use super::sql::quote_ident;

/// Kinds Postgres exposes (all five).
pub(super) const KINDS: &[DbObjectKind] = &[
    DbObjectKind::View,
    DbObjectKind::MaterializedView,
    DbObjectKind::Function,
    DbObjectKind::Procedure,
    DbObjectKind::Trigger,
];

/// Ensure a DDL string ends with exactly one `;`.
fn ensure_semi(s: &str) -> String {
    let t = s.trim_end();
    if t.ends_with(';') {
        t.to_string()
    } else {
        format!("{t};")
    }
}

/// Map a `pg_proc.provolatile` char to its label. `None` for anything else.
fn volatility_label(provolatile: char) -> Option<String> {
    match provolatile {
        'i' => Some("IMMUTABLE".into()),
        's' => Some("STABLE".into()),
        'v' => Some("VOLATILE".into()),
        _ => None,
    }
}

/// Decode a `pg_trigger.tgtype` bitmask into (timing, events). Bit 2 = BEFORE,
/// bit 64 = INSTEAD OF (else AFTER); bits 4/8/16/32 = INSERT/DELETE/UPDATE/
/// TRUNCATE. (Bit 1 = ROW vs STATEMENT — level, decoded separately.)
fn trigger_bits(tgtype: i32) -> (String, Vec<String>) {
    let timing = if tgtype & 64 != 0 {
        "INSTEAD OF"
    } else if tgtype & 2 != 0 {
        "BEFORE"
    } else {
        "AFTER"
    }
    .to_string();
    let mut events = Vec::new();
    if tgtype & 4 != 0 {
        events.push("INSERT".to_string());
    }
    if tgtype & 8 != 0 {
        events.push("DELETE".to_string());
    }
    if tgtype & 16 != 0 {
        events.push("UPDATE".to_string());
    }
    if tgtype & 32 != 0 {
        events.push("TRUNCATE".to_string());
    }
    (timing, events)
}

pub(super) async fn list(
    pool: &PgPool,
    schema: &str,
    kind: DbObjectKind,
) -> Result<Vec<DbObjectInfo>, AppError> {
    match kind {
        DbObjectKind::View | DbObjectKind::MaterializedView => {
            let is_mat = matches!(kind, DbObjectKind::MaterializedView);
            let relkind = if is_mat { 'm' } else { 'v' };
            // Matviews carry approx rows + on-disk size; plain views don't.
            let extra = if is_mat {
                ", c.reltuples::bigint AS rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS size"
            } else {
                ", NULL::bigint AS rows, NULL::text AS size"
            };
            let rows = sqlx::query(&format!(
                "SELECT c.relname AS name, r.rolname AS owner{extra} \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_roles r ON r.oid = c.relowner \
                 WHERE n.nspname = $1 AND c.relkind = '{relkind}' ORDER BY 1"
            ))
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(map_query_error)?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let mut info = DbObjectInfo::bare(r.get("name"), kind, None);
                    info.owner = r.try_get::<Option<String>, _>("owner").ok().flatten();
                    let n: i64 = r.try_get("rows").unwrap_or(-1);
                    info.approx_rows = if n < 0 { None } else { Some(n) };
                    info.size = r.try_get::<Option<String>, _>("size").ok().flatten();
                    info
                })
                .collect())
        }
        DbObjectKind::Function | DbObjectKind::Procedure => {
            let prokind = if matches!(kind, DbObjectKind::Function) {
                'f'
            } else {
                'p'
            };
            let rows = sqlx::query(&format!(
                "SELECT p.proname AS name, \
                        pg_get_function_identity_arguments(p.oid) AS args, \
                        pg_get_function_result(p.oid) AS ret, \
                        l.lanname AS lang, \
                        p.provolatile::text AS vol, \
                        p.pronargs::bigint AS nargs, \
                        r.rolname AS owner \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 JOIN pg_language l ON l.oid = p.prolang \
                 LEFT JOIN pg_roles r ON r.oid = p.proowner \
                 WHERE n.nspname = $1 AND p.prokind = '{prokind}' ORDER BY 1, 2"
            ))
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(map_query_error)?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let args: String = r.get("args");
                    let mut info = DbObjectInfo::bare(r.get("name"), kind, Some(args));
                    info.returns = r.try_get::<Option<String>, _>("ret").ok().flatten();
                    info.language = r.try_get::<Option<String>, _>("lang").ok().flatten();
                    if matches!(kind, DbObjectKind::Function) {
                        info.volatility = r
                            .try_get::<Option<String>, _>("vol")
                            .ok()
                            .flatten()
                            .and_then(|s| s.chars().next())
                            .and_then(volatility_label);
                    }
                    info.arg_count = r.try_get::<i64, _>("nargs").ok();
                    info.owner = r.try_get::<Option<String>, _>("owner").ok().flatten();
                    info
                })
                .collect())
        }
        DbObjectKind::Trigger => {
            let rows = sqlx::query(
                "SELECT t.tgname AS name, c.relname AS tbl, t.tgtype::int AS tgtype, \
                        t.tgenabled::text AS enabled \
                 FROM pg_trigger t \
                 JOIN pg_class c ON c.oid = t.tgrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1",
            )
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(map_query_error)?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let tbl: String = r.get("tbl");
                    let mut info = DbObjectInfo::bare(r.get("name"), kind, Some(tbl.clone()));
                    info.table = Some(tbl);
                    let (timing, events) = trigger_bits(r.try_get("tgtype").unwrap_or(0));
                    info.timing = Some(timing);
                    info.events = events;
                    if let Ok(en) = r.try_get::<String, _>("enabled") {
                        info.enabled = Some(en != "D");
                    }
                    info
                })
                .collect())
        }
    }
}

pub(super) async fn definition(
    pool: &PgPool,
    schema: &str,
    kind: DbObjectKind,
    name: &str,
    detail: Option<&str>,
) -> Result<DbObjectDefinition, AppError> {
    let ddl = match kind {
        DbObjectKind::View | DbObjectKind::MaterializedView => {
            // Resolve the OID via the SAME pg_class join the list uses (NOT
            // `::regclass`, whose name resolution depends on search_path /
            // visibility and can disagree with the listed object → spurious
            // "relation does not exist").
            let relkind = if matches!(kind, DbObjectKind::View) {
                'v'
            } else {
                'm'
            };
            let body: Option<String> = sqlx::query_scalar(&format!(
                "SELECT pg_get_viewdef(c.oid, true) FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = '{relkind}'"
            ))
            .bind(schema)
            .bind(name)
            .fetch_optional(pool)
            .await
            .map_err(map_query_error)?;
            let body = body.ok_or_else(|| {
                AppError::NotFound(format!("\"{schema}\".\"{name}\" was not found."))
            })?;
            let head = if matches!(kind, DbObjectKind::View) {
                "CREATE OR REPLACE VIEW"
            } else {
                "CREATE MATERIALIZED VIEW"
            };
            ensure_semi(&format!(
                "{head} {}.{} AS\n{}",
                quote_ident(schema),
                quote_ident(name),
                body.trim_end().trim_end_matches(';')
            ))
        }
        DbObjectKind::Function | DbObjectKind::Procedure => {
            // Resolve the routine's OID by name + prokind, preferring the row
            // whose identity arguments match `detail` (disambiguates overloads)
            // but falling back to the first by name — so a slightly-stale or
            // absent `detail` still loads the definition instead of erroring.
            let prokind = if matches!(kind, DbObjectKind::Function) {
                'f'
            } else {
                'p'
            };
            let oid: Option<i64> = sqlx::query_scalar(&format!(
                "SELECT p.oid::bigint FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = '{prokind}' \
                 ORDER BY (pg_get_function_identity_arguments(p.oid) = $3) DESC, p.oid LIMIT 1"
            ))
            .bind(schema)
            .bind(name)
            .bind(detail.unwrap_or(""))
            .fetch_optional(pool)
            .await
            .map_err(map_query_error)?;
            let oid = oid.ok_or_else(|| {
                AppError::NotFound(format!("\"{schema}\".\"{name}\" was not found."))
            })?;
            let ddl: String = sqlx::query_scalar("SELECT pg_get_functiondef($1::oid)")
                .bind(oid)
                .fetch_one(pool)
                .await
                .map_err(map_query_error)?;
            ensure_semi(&ddl)
        }
        DbObjectKind::Trigger => {
            let table = detail.ok_or_else(|| {
                AppError::Invalid("A trigger needs its owning table to resolve.".into())
            })?;
            let ddl: String = sqlx::query_scalar(
                "SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t \
                 JOIN pg_class c ON c.oid = t.tgrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND t.tgname = $2 AND c.relname = $3 \
                   AND NOT t.tgisinternal",
            )
            .bind(schema)
            .bind(name)
            .bind(table)
            .fetch_one(pool)
            .await
            .map_err(map_query_error)?;
            ensure_semi(&ddl)
        }
    };
    let mut def = DbObjectDefinition::ddl_only(name.to_string(), kind, ddl);
    // Best-effort chip/args metadata — failures leave the field empty (the
    // viewer renders each chip only when present).
    match kind {
        DbObjectKind::Function | DbObjectKind::Procedure => {
            enrich_routine(pool, &mut def, schema, name, detail.unwrap_or("")).await;
        }
        DbObjectKind::Trigger => {
            def.table = detail.map(str::to_string);
            if let Some(tbl) = detail {
                enrich_trigger(pool, &mut def, schema, name, tbl).await;
            }
        }
        DbObjectKind::MaterializedView => enrich_matview(pool, &mut def, schema, name).await,
        DbObjectKind::View => {}
    }
    Ok(def)
}

/// Routine metadata: returns / language / volatility (functions only) / args.
async fn enrich_routine(
    pool: &PgPool,
    def: &mut DbObjectDefinition,
    schema: &str,
    name: &str,
    identity_args: &str,
) {
    let row = sqlx::query(
        "SELECT p.oid::bigint AS oid, \
                pg_get_function_result(p.oid) AS ret, \
                l.lanname AS lang, \
                CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' \
                  ELSE 'VOLATILE' END AS vol, \
                obj_description(p.oid, 'pg_proc') AS comment \
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
         JOIN pg_language l ON l.oid = p.prolang \
         WHERE n.nspname = $1 AND p.proname = $2 \
           AND pg_get_function_identity_arguments(p.oid) = $3",
    )
    .bind(schema)
    .bind(name)
    .bind(identity_args)
    .fetch_one(pool)
    .await;
    let Ok(row) = row else { return };
    let oid: i64 = row.try_get("oid").unwrap_or(0);
    def.returns = row.try_get::<Option<String>, _>("ret").ok().flatten();
    def.language = row.try_get::<Option<String>, _>("lang").ok().flatten();
    if matches!(def.kind, DbObjectKind::Function) {
        def.volatility = row.try_get::<Option<String>, _>("vol").ok().flatten();
    }
    def.comment = row.try_get::<Option<String>, _>("comment").ok().flatten();

    // Pair the type / mode / name arrays by ORDINAL via multi-arg `unnest`
    // (not by subscript): `proargtypes::oid[]` from an oidvector is 0-based
    // while `proargnames` is 1-based, so subscript indexing misaligns names.
    // Columns (by index): 0 = name, 1 = mode char, 2 = type text.
    if let Ok(arows) = sqlx::query(
        "SELECT coalesce(a.nm, '') AS nm, a.md::text AS md, format_type(a.tp, NULL) AS tp \
         FROM pg_proc p \
         LEFT JOIN LATERAL unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]), \
                                  p.proargmodes, p.proargnames) \
                   WITH ORDINALITY AS a(tp, md, nm, ord) ON true \
         WHERE p.oid = $1::oid AND a.tp IS NOT NULL \
         ORDER BY a.ord",
    )
    .bind(oid)
    .fetch_all(pool)
    .await
    {
        def.args = arows
            .into_iter()
            .map(|r| {
                let md = r.try_get::<Option<String>, _>(1).ok().flatten();
                let mode = match md.as_deref() {
                    Some("o") => "OUT",
                    Some("b") => "INOUT",
                    Some("v") => "VARIADIC",
                    Some("t") => "TABLE",
                    _ => "IN",
                };
                RoutineArg {
                    mode: Some(mode.into()),
                    name: r.try_get::<String, _>(0).unwrap_or_default(),
                    data_type: r.try_get::<String, _>(2).unwrap_or_default(),
                }
            })
            .collect();
    }
}

/// Trigger metadata from the `tgtype` bitmask + `tgenabled`.
async fn enrich_trigger(
    pool: &PgPool,
    def: &mut DbObjectDefinition,
    schema: &str,
    name: &str,
    table: &str,
) {
    let row = sqlx::query(
        "SELECT t.tgtype::int AS tgtype, t.tgenabled::text AS enabled, \
                obj_description(t.oid, 'pg_trigger') AS comment \
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND t.tgname = $2 AND c.relname = $3 AND NOT t.tgisinternal",
    )
    .bind(schema)
    .bind(name)
    .bind(table)
    .fetch_one(pool)
    .await;
    let Ok(row) = row else { return };
    let tgtype: i32 = row.try_get("tgtype").unwrap_or(0);
    def.level = Some(if tgtype & 1 != 0 { "ROW" } else { "STATEMENT" }.into());
    let (timing, events) = trigger_bits(tgtype);
    def.timing = Some(timing);
    def.events = events;
    if let Ok(en) = row.try_get::<String, _>("enabled") {
        def.enabled = Some(en != "D");
    }
    def.comment = row.try_get::<Option<String>, _>("comment").ok().flatten();
}

/// Materialized-view metadata: populated / approx rows / on-disk size.
async fn enrich_matview(pool: &PgPool, def: &mut DbObjectDefinition, schema: &str, name: &str) {
    let row = sqlx::query(
        "SELECT m.ispopulated AS populated, c.reltuples::bigint AS rows, \
                pg_size_pretty(pg_total_relation_size(c.oid)) AS size, \
                obj_description(c.oid, 'pg_class') AS comment \
         FROM pg_matviews m \
         JOIN pg_namespace n ON n.nspname = m.schemaname \
         JOIN pg_class c ON c.relname = m.matviewname AND c.relnamespace = n.oid \
         WHERE m.schemaname = $1 AND m.matviewname = $2",
    )
    .bind(schema)
    .bind(name)
    .fetch_one(pool)
    .await;
    let Ok(row) = row else { return };
    def.populated = row.try_get::<Option<bool>, _>("populated").ok().flatten();
    let rows: i64 = row.try_get("rows").unwrap_or(-1);
    def.approx_rows = if rows < 0 { None } else { Some(rows) };
    def.size = row.try_get::<Option<String>, _>("size").ok().flatten();
    def.comment = row.try_get::<Option<String>, _>("comment").ok().flatten();
}

pub(super) fn drop_sql(
    schema: &str,
    kind: DbObjectKind,
    name: &str,
    detail: Option<&str>,
) -> Result<String, AppError> {
    let q = quote_ident;
    Ok(match kind {
        DbObjectKind::View => format!("DROP VIEW IF EXISTS {}.{};", q(schema), q(name)),
        DbObjectKind::MaterializedView => {
            format!(
                "DROP MATERIALIZED VIEW IF EXISTS {}.{};",
                q(schema),
                q(name)
            )
        }
        DbObjectKind::Function => format!(
            "DROP FUNCTION IF EXISTS {}.{}({});",
            q(schema),
            q(name),
            detail.unwrap_or("")
        ),
        DbObjectKind::Procedure => format!(
            "DROP PROCEDURE IF EXISTS {}.{}({});",
            q(schema),
            q(name),
            detail.unwrap_or("")
        ),
        DbObjectKind::Trigger => {
            let table = detail.ok_or_else(|| {
                AppError::Invalid("A trigger needs its owning table to drop.".into())
            })?;
            format!(
                "DROP TRIGGER IF EXISTS {} ON {}.{};",
                q(name),
                q(schema),
                q(table)
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_drop_sql_builds_precise_drops() {
        assert_eq!(
            drop_sql("public", DbObjectKind::View, "v", None).unwrap(),
            "DROP VIEW IF EXISTS \"public\".\"v\";"
        );
        assert_eq!(
            drop_sql("public", DbObjectKind::MaterializedView, "mv", None).unwrap(),
            "DROP MATERIALIZED VIEW IF EXISTS \"public\".\"mv\";"
        );
        assert_eq!(
            drop_sql("public", DbObjectKind::Function, "f", Some("integer, text")).unwrap(),
            "DROP FUNCTION IF EXISTS \"public\".\"f\"(integer, text);"
        );
        assert_eq!(
            drop_sql("public", DbObjectKind::Procedure, "p", Some("")).unwrap(),
            "DROP PROCEDURE IF EXISTS \"public\".\"p\"();"
        );
        assert_eq!(
            drop_sql("public", DbObjectKind::Trigger, "trg", Some("orders")).unwrap(),
            "DROP TRIGGER IF EXISTS \"trg\" ON \"public\".\"orders\";"
        );
        assert!(drop_sql("public", DbObjectKind::Trigger, "trg", None).is_err());
    }

    #[test]
    fn pg_decodes_volatility_and_trigger_bits() {
        assert_eq!(volatility_label('i'), Some("IMMUTABLE".to_string()));
        assert_eq!(volatility_label('s'), Some("STABLE".to_string()));
        assert_eq!(volatility_label('v'), Some("VOLATILE".to_string()));
        assert_eq!(volatility_label('x'), None);
        // tgtype: bit 2 = BEFORE, bits 4/16 = INSERT/UPDATE.
        let (timing, events) = trigger_bits(2 | 4 | 16);
        assert_eq!(timing, "BEFORE");
        assert_eq!(events, vec!["INSERT".to_string(), "UPDATE".to_string()]);
        // bit 64 = INSTEAD OF; bit 8 = DELETE.
        let (timing, events) = trigger_bits(64 | 8);
        assert_eq!(timing, "INSTEAD OF");
        assert_eq!(events, vec!["DELETE".to_string()]);
    }

    #[test]
    fn ensure_semi_normalises_trailing_semicolons() {
        assert_eq!(ensure_semi("SELECT 1"), "SELECT 1;");
        assert_eq!(ensure_semi("SELECT 1;"), "SELECT 1;");
        assert_eq!(ensure_semi("SELECT 1; \n"), "SELECT 1;");
    }
}
