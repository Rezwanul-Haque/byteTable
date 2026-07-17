//! Oracle introspection: schemas (users), tables, columns, primary/foreign keys,
//! indexes, and inbound foreign keys, from the `ALL_*` catalog. Mirrors the
//! `ports::sql::meta` contract. Blocking (rust-oracle is synchronous); `super`
//! (`mod.rs`) hops these onto the blocking pool. Gated behind `engine-oracle`.

use oracle::Connection;

use crate::shared::engine::{
    ColumnInfo, FkRef, ForeignKeyInfo, InboundFkInfo, IndexInfo, SchemaInfo, TableInfo, TableMeta,
};
use crate::shared::error::AppError;

use super::error::{map_ora_query_err, OptionalRow};

/// User-schemas (Oracle "schemas are users"), excluding the Oracle-maintained
/// accounts (SYS/SYSTEM/…), with a cheap per-schema table count.
pub(super) fn list_schemas(c: &Connection) -> Result<Vec<SchemaInfo>, AppError> {
    let sql = "SELECT u.username, \
            (SELECT COUNT(*) FROM all_tables t WHERE t.owner = u.username) AS tcount \
         FROM all_users u \
         WHERE u.oracle_maintained = 'N' \
         ORDER BY u.username";
    let mut out = Vec::new();
    for row in c.query(sql, &[]).map_err(map_ora_query_err)? {
        let row = row.map_err(map_ora_query_err)?;
        let name: String = row.get(0).map_err(map_ora_query_err)?;
        let count: i64 = row
            .get::<usize, Option<i64>>(1)
            .map_err(map_ora_query_err)?
            .unwrap_or(0);
        out.push(SchemaInfo {
            name,
            table_count: Some(count.max(0) as u64),
        });
    }
    Ok(out)
}

/// User tables in the given schema, with the optimizer's row estimate (`num_rows`
/// — may be stale/NULL, the same "approximate" contract as the other server
/// adapters' catalog counts).
pub(super) fn list_tables(c: &Connection, schema: &str) -> Result<Vec<TableInfo>, AppError> {
    ensure_schema_exists(c, schema)?;
    let sql = "SELECT table_name, num_rows FROM all_tables \
         WHERE owner = :1 ORDER BY table_name";
    let mut out = Vec::new();
    for row in c.query(sql, &[&schema]).map_err(map_ora_query_err)? {
        let row = row.map_err(map_ora_query_err)?;
        let name: String = row.get(0).map_err(map_ora_query_err)?;
        let est: Option<i64> = row.get(1).map_err(map_ora_query_err)?;
        out.push(TableInfo {
            name,
            approx_row_count: est.map(|e| e.max(0) as u64),
        });
    }
    Ok(out)
}

/// Column-level (+ pk/fk/index/inbound) metadata for one table, from the `ALL_*`
/// catalog. Unknown table → §5 human error listing the schema's tables.
pub(crate) fn table_meta(c: &Connection, owner: &str, table: &str) -> Result<TableMeta, AppError> {
    ensure_schema_exists(c, owner)?;
    // Existence: a table or view owned by `owner`.
    let exists: Option<i64> = c
        .query_row_as::<i64>(
            "SELECT 1 FROM all_objects WHERE owner = :1 AND object_name = :2 \
             AND object_type IN ('TABLE', 'VIEW') AND ROWNUM = 1",
            &[&owner, &table],
        )
        .optional_or_none()?;
    if exists.is_none() {
        return Err(missing_table_error(c, owner, table));
    }

    let columns = read_columns(c, owner, table)?;
    let foreign_keys = read_foreign_keys(c, owner, table)?;
    let fk_by_column = fk_by_first_column(&foreign_keys);
    let columns: Vec<ColumnInfo> = columns
        .into_iter()
        .map(|mut col| {
            col.fk = fk_by_column.get(&col.name).cloned();
            col
        })
        .collect();
    let indexes = read_indexes(c, owner, table)?;
    let referenced_by = read_inbound_foreign_keys(c, owner, table)?;

    Ok(TableMeta {
        columns,
        comment: None,
        indexes,
        foreign_keys,
        referenced_by,
        ddl: None,
    })
}

/// Read columns from `all_tab_columns`, folding in pk membership from
/// `all_constraints`/`all_cons_columns` and identity from `all_tab_identity_cols`.
fn read_columns(c: &Connection, owner: &str, table: &str) -> Result<Vec<ColumnInfo>, AppError> {
    let sql = "SELECT tc.column_name, tc.data_type, tc.data_length, tc.data_precision, \
            tc.data_scale, tc.nullable, tc.data_default, \
            (SELECT COUNT(*) FROM all_cons_columns pcc \
                JOIN all_constraints pc ON pc.owner = pcc.owner \
                    AND pc.constraint_name = pcc.constraint_name \
                WHERE pc.constraint_type = 'P' AND pcc.owner = tc.owner \
                    AND pcc.table_name = tc.table_name \
                    AND pcc.column_name = tc.column_name) AS is_pk, \
            (SELECT COUNT(*) FROM all_tab_identity_cols ic \
                WHERE ic.owner = tc.owner AND ic.table_name = tc.table_name \
                    AND ic.column_name = tc.column_name) AS is_identity \
         FROM all_tab_columns tc \
         WHERE tc.owner = :1 AND tc.table_name = :2 \
         ORDER BY tc.column_id";
    let mut out = Vec::new();
    for row in c.query(sql, &[&owner, &table]).map_err(map_ora_query_err)? {
        let row = row.map_err(map_ora_query_err)?;
        let name: String = row.get(0).map_err(map_ora_query_err)?;
        let data_type: String = row
            .get::<usize, Option<String>>(1)
            .map_err(map_ora_query_err)?
            .unwrap_or_default();
        let data_length: Option<i64> = row.get(2).map_err(map_ora_query_err)?;
        let precision: Option<i64> = row.get(3).map_err(map_ora_query_err)?;
        let scale: Option<i64> = row.get(4).map_err(map_ora_query_err)?;
        let nullable: String = row
            .get::<usize, Option<String>>(5)
            .map_err(map_ora_query_err)?
            .unwrap_or_else(|| "Y".into());
        let default_raw: Option<String> = row.get(6).map_err(map_ora_query_err)?;
        let is_pk: i64 = row
            .get::<usize, Option<i64>>(7)
            .map_err(map_ora_query_err)?
            .unwrap_or(0);
        let is_identity: i64 = row
            .get::<usize, Option<i64>>(8)
            .map_err(map_ora_query_err)?
            .unwrap_or(0);

        let mut default_value = default_raw
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        if is_identity > 0 && default_value.is_none() {
            default_value = Some("IDENTITY".to_string());
        }

        out.push(ColumnInfo {
            name,
            data_type: build_display_type(&data_type, data_length, precision, scale),
            nullable: nullable != "N",
            pk: is_pk > 0,
            default_value,
            fk: None,
        });
    }
    Ok(out)
}

/// Build a display type from `all_tab_columns` metadata: character/RAW types show
/// a length (`VARCHAR2(255)`), `NUMBER` shows precision/scale when present, and
/// everything else is the bare Oracle type name.
fn build_display_type(
    data_type: &str,
    length: Option<i64>,
    precision: Option<i64>,
    scale: Option<i64>,
) -> String {
    let base = data_type.trim().to_ascii_uppercase();
    match base.as_str() {
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" | "RAW" => match length {
            Some(n) if n > 0 => format!("{base}({n})"),
            _ => base,
        },
        "NUMBER" => match (precision, scale) {
            (Some(p), Some(s)) if p > 0 && s > 0 => format!("NUMBER({p},{s})"),
            (Some(p), _) if p > 0 => format!("NUMBER({p})"),
            _ => base,
        },
        _ => base,
    }
}

/// Outbound foreign keys, grouped per constraint (ordered column lists +
/// on_delete). Oracle exposes only `CASCADE`/`SET NULL`/`NO ACTION` delete rules.
fn read_foreign_keys(
    c: &Connection,
    owner: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
    let sql = "SELECT ac.constraint_name, acc.column_name, \
            rac.table_name AS ref_table, racc.column_name AS ref_col, \
            ac.delete_rule \
         FROM all_constraints ac \
         JOIN all_cons_columns acc ON acc.owner = ac.owner \
            AND acc.constraint_name = ac.constraint_name \
         JOIN all_constraints rac ON rac.owner = ac.r_owner \
            AND rac.constraint_name = ac.r_constraint_name \
         JOIN all_cons_columns racc ON racc.owner = rac.owner \
            AND racc.constraint_name = rac.constraint_name \
            AND racc.position = acc.position \
         WHERE ac.constraint_type = 'R' AND ac.owner = :1 AND ac.table_name = :2 \
         ORDER BY ac.constraint_name, acc.position";
    let mut grouped: Vec<ForeignKeyInfo> = Vec::new();
    for row in c.query(sql, &[&owner, &table]).map_err(map_ora_query_err)? {
        let row = row.map_err(map_ora_query_err)?;
        let name: String = row.get(0).map_err(map_ora_query_err)?;
        let col: String = row.get(1).map_err(map_ora_query_err)?;
        let ref_table: String = row.get(2).map_err(map_ora_query_err)?;
        let ref_col: String = row.get(3).map_err(map_ora_query_err)?;
        let on_delete: Option<String> = row.get(4).map_err(map_ora_query_err)?;
        let on_delete = on_delete
            .unwrap_or_else(|| "NO ACTION".into())
            .trim()
            .to_ascii_uppercase();
        match grouped.last_mut() {
            Some(existing) if existing.name.as_deref() == Some(name.as_str()) => {
                existing.columns.push(col);
                existing.ref_columns.push(ref_col);
            }
            _ => grouped.push(ForeignKeyInfo {
                name: Some(name),
                columns: vec![col],
                ref_table,
                ref_columns: vec![ref_col],
                on_delete: Some(on_delete),
                on_update: None,
            }),
        }
    }
    Ok(grouped)
}

/// Foreign keys pointing *at* this table (§3.6 "referenced by").
fn read_inbound_foreign_keys(
    c: &Connection,
    owner: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let sql = "SELECT ac.constraint_name, ac.table_name AS child_table, \
            acc.column_name AS child_col, racc.column_name AS ref_col, \
            ac.delete_rule \
         FROM all_constraints ac \
         JOIN all_cons_columns acc ON acc.owner = ac.owner \
            AND acc.constraint_name = ac.constraint_name \
         JOIN all_constraints rac ON rac.owner = ac.r_owner \
            AND rac.constraint_name = ac.r_constraint_name \
         JOIN all_cons_columns racc ON racc.owner = rac.owner \
            AND racc.constraint_name = rac.constraint_name \
            AND racc.position = acc.position \
         WHERE ac.constraint_type = 'R' AND rac.owner = :1 AND rac.table_name = :2 \
         ORDER BY ac.constraint_name, acc.position";
    let mut grouped: Vec<InboundFkInfo> = Vec::new();
    for row in c.query(sql, &[&owner, &table]).map_err(map_ora_query_err)? {
        let row = row.map_err(map_ora_query_err)?;
        let _name: String = row.get(0).map_err(map_ora_query_err)?;
        let child_table: String = row.get(1).map_err(map_ora_query_err)?;
        let child_col: String = row.get(2).map_err(map_ora_query_err)?;
        let ref_col: String = row.get(3).map_err(map_ora_query_err)?;
        let on_delete: Option<String> = row.get(4).map_err(map_ora_query_err)?;
        let on_delete = on_delete
            .unwrap_or_else(|| "NO ACTION".into())
            .trim()
            .to_ascii_uppercase();
        match grouped.last_mut() {
            Some(existing) if existing.table == child_table => {
                existing.columns.push(child_col);
                existing.ref_columns.push(ref_col);
            }
            _ => grouped.push(InboundFkInfo {
                table: child_table,
                columns: vec![child_col],
                ref_columns: vec![ref_col],
                on_delete: Some(on_delete),
            }),
        }
    }
    Ok(grouped)
}

/// Indexes on the table, including the implicit primary-key index.
fn read_indexes(c: &Connection, owner: &str, table: &str) -> Result<Vec<IndexInfo>, AppError> {
    let sql = "SELECT ai.index_name, ai.uniqueness, aic.column_name, \
            (SELECT COUNT(*) FROM all_constraints pc \
                WHERE pc.owner = ai.owner AND pc.constraint_type = 'P' \
                    AND pc.index_name = ai.index_name) AS is_pk \
         FROM all_indexes ai \
         JOIN all_ind_columns aic ON aic.index_owner = ai.owner \
            AND aic.index_name = ai.index_name \
         WHERE ai.table_owner = :1 AND ai.table_name = :2 \
         ORDER BY ai.index_name, aic.column_position";
    let mut grouped: Vec<IndexInfo> = Vec::new();
    for row in c.query(sql, &[&owner, &table]).map_err(map_ora_query_err)? {
        let row = row.map_err(map_ora_query_err)?;
        let name: String = row.get(0).map_err(map_ora_query_err)?;
        let uniqueness: String = row
            .get::<usize, Option<String>>(1)
            .map_err(map_ora_query_err)?
            .unwrap_or_default();
        let col: String = row.get(2).map_err(map_ora_query_err)?;
        let is_pk: i64 = row
            .get::<usize, Option<i64>>(3)
            .map_err(map_ora_query_err)?
            .unwrap_or(0);
        let primary = is_pk > 0;
        match grouped.last_mut() {
            Some(existing) if existing.name == name => existing.columns.push(col),
            _ => grouped.push(IndexInfo {
                name,
                columns: vec![col],
                unique: uniqueness.eq_ignore_ascii_case("UNIQUE"),
                primary,
                origin: Some(if primary { "pk" } else { "c" }.to_string()),
            }),
        }
    }
    Ok(grouped)
}

/// First-column → FK target map for the sidebar's per-column FK icon.
fn fk_by_first_column(foreign_keys: &[ForeignKeyInfo]) -> std::collections::HashMap<String, FkRef> {
    let mut map = std::collections::HashMap::new();
    for fk in foreign_keys {
        if let (Some(col), Some(ref_col)) = (fk.columns.first(), fk.ref_columns.first()) {
            map.insert(
                col.clone(),
                FkRef {
                    table: fk.ref_table.clone(),
                    column: ref_col.clone(),
                },
            );
        }
    }
    map
}

/// §5 "Schema 'x' does not exist…" unless `owner` is a visible user schema.
pub(super) fn ensure_schema_exists(c: &Connection, owner: &str) -> Result<(), AppError> {
    let found: Option<i64> = c
        .query_row_as::<i64>(
            "SELECT 1 FROM all_users WHERE username = :1 AND ROWNUM = 1",
            &[&owner],
        )
        .optional_or_none()?;
    if found.is_some() {
        return Ok(());
    }
    let names = collect_strings(
        c,
        "SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username",
    );
    Err(AppError::Database(format!(
        "Schema '{owner}' does not exist. Available schemas: {}.",
        list_or_none(&names)
    )))
}

/// §5 "Table 'x' does not exist…" listing the available tables in the schema.
fn missing_table_error(c: &Connection, owner: &str, table: &str) -> AppError {
    let names = collect_strings_bound(
        c,
        "SELECT table_name FROM all_tables WHERE owner = :1 ORDER BY table_name",
        owner,
    );
    AppError::Database(format!(
        "Table '{table}' does not exist in schema '{owner}'. Available tables: {}.",
        list_or_none(&names)
    ))
}

/// Best-effort single-string-column collection (used only for the "available X"
/// suffix of §5 errors, so a failure just yields an empty list).
fn collect_strings(c: &Connection, sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(rows) = c.query(sql, &[]) {
        for row in rows.flatten() {
            if let Ok(Some(s)) = row.get::<usize, Option<String>>(0) {
                out.push(s);
            }
        }
    }
    out
}

fn collect_strings_bound(c: &Connection, sql: &str, bind: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(rows) = c.query(sql, &[&bind]) {
        for row in rows.flatten() {
            if let Ok(Some(s)) = row.get::<usize, Option<String>>(0) {
                out.push(s);
            }
        }
    }
    out
}

fn list_or_none(names: &[String]) -> String {
    if names.is_empty() {
        "(none)".to_string()
    } else {
        names.join(", ")
    }
}
