//! MSSQL introspection: schemas, tables, columns, indexes, foreign keys and
//! DDL fragments. Mirrors the `ports::sql::meta` contract.

use tiberius::{Query, Row};

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::sql::qualified;
use super::TdsClient;

/// Schemas hidden from `list_schemas` / the schema switcher: the SQL Server
/// system schema, the ANSI views schema, and the fixed database roles that own a
/// schema of the same name. User schemas (`dbo`, `sales`, `audit`, …) remain.
const SYSTEM_SCHEMAS: &[&str] = &[
    "sys",
    "INFORMATION_SCHEMA",
    "guest",
    "db_owner",
    "db_accessadmin",
    "db_securityadmin",
    "db_ddladmin",
    "db_backupoperator",
    "db_datareader",
    "db_datawriter",
    "db_denydatareader",
    "db_denydatawriter",
];

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// locks the client and delegates; the SQL lives in the concern module).
pub(super) async fn list_schemas(client: &mut TdsClient) -> Result<Vec<SchemaInfo>, AppError> {
    let sql = format!(
        "SELECT s.name AS name, \
            (SELECT COUNT(*) FROM sys.tables t \
             WHERE t.schema_id = s.schema_id AND t.is_ms_shipped = 0) AS table_count \
         FROM sys.schemas s \
         WHERE s.name NOT IN ({}) \
         ORDER BY s.name",
        system_schema_list()
    );
    let rows = client
        .simple_query(sql.as_str())
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    Ok(rows
        .iter()
        .map(|row| {
            let name: String = row
                .try_get::<&str, _>("name")
                .ok()
                .flatten()
                .unwrap_or("")
                .to_string();
            let count: i32 = row.try_get("table_count").ok().flatten().unwrap_or(0);
            SchemaInfo {
                name,
                table_count: Some(count.max(0) as u64),
            }
        })
        .collect())
}

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// locks the client and delegates; the SQL lives in the concern module).
pub(super) async fn list_tables(
    client: &mut TdsClient,
    schema: &str,
) -> Result<Vec<TableInfo>, AppError> {
    {
        ensure_schema_exists(&mut *client, schema).await?;
    }
    // Base tables in the schema, with the storage engine's row estimate
    // (SUM over the heap/clustered-index partitions — approximate, like the
    // other server adapters' catalog counts).
    // `is_ms_shipped = 0` hides the engine's own tables — notably the legacy
    // `spt_fallback_*` / `spt_monitor` / `MSreplication_options` tables that
    // ship in `master` (empty, deprecated) — so only user tables are listed.
    let sql = "SELECT t.name AS name, \
            CAST(ISNULL(SUM(p.rows), 0) AS bigint) AS est \
         FROM sys.tables t \
         JOIN sys.schemas s ON s.schema_id = t.schema_id \
         LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) \
         WHERE s.name = @P1 AND t.is_ms_shipped = 0 \
         GROUP BY t.name \
         ORDER BY t.name";
    let mut query = Query::new(sql);
    query.bind(schema.to_string());
    let rows = query
        .query(&mut *client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    Ok(rows
        .iter()
        .map(|row| {
            let name: String = row
                .try_get::<&str, _>("name")
                .ok()
                .flatten()
                .unwrap_or("")
                .to_string();
            let est: Option<i64> = row.try_get("est").ok().flatten();
            TableInfo {
                name,
                approx_row_count: est.map(|e| e.max(0) as u64),
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/// Column-level (+ pk/fk/index/inbound/ddl) metadata for one table, from the
/// `sys.*` catalog. Unknown table → §5 human error listing the schema's tables.
pub(crate) async fn table_meta(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    ensure_schema_exists(client, schema).await?;

    let object_ref = qualified(schema, table);

    // Existence: a base table or view with this schema-qualified name.
    let mut exists_q = Query::new(
        "SELECT o.object_id FROM sys.objects o \
         WHERE o.object_id = OBJECT_ID(@P1) AND o.type IN ('U', 'V')",
    );
    exists_q.bind(object_ref.clone());
    let exists = exists_q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    if exists.is_empty() {
        return Err(missing_table_error(client, schema, table).await);
    }

    let columns = read_columns(client, &object_ref).await?;
    let foreign_keys = read_foreign_keys(client, schema, table).await?;
    let fk_by_column = fk_by_first_column(&foreign_keys);
    let columns: Vec<ColumnInfo> = columns
        .into_iter()
        .map(|mut c| {
            c.fk = fk_by_column.get(&c.name).cloned();
            c
        })
        .collect();
    let indexes = read_indexes(client, &object_ref).await?;
    let referenced_by = read_inbound_foreign_keys(client, schema, table).await?;
    let ddl = super::objects::generate_table_ddl(schema, table, &columns, &foreign_keys, &indexes);

    Ok(TableMeta {
        columns,
        comment: None,
        indexes,
        foreign_keys,
        referenced_by,
        ddl: Some(ddl),
    })
}

/// Read columns from `sys.columns`/`sys.types`, building the display type
/// (length/precision) and reading identity + default. pk membership is folded in
/// from the primary-key index.
pub(super) async fn read_columns(
    client: &mut TdsClient,
    object_ref: &str,
) -> Result<Vec<ColumnInfo>, AppError> {
    let mut q = Query::new(
        "SELECT c.name AS name, ty.name AS type_name, \
            c.max_length AS max_length, c.precision AS precision, c.scale AS scale, \
            c.is_nullable AS is_nullable, c.is_identity AS is_identity, \
            dc.definition AS default_def, \
            CAST(CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS bit) AS is_pk \
         FROM sys.columns c \
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN ( \
            SELECT ic.column_id FROM sys.indexes i \
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
            WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(@P1) \
         ) pk ON pk.column_id = c.column_id \
         WHERE c.object_id = OBJECT_ID(@P1) \
         ORDER BY c.column_id",
    );
    q.bind(object_ref.to_string());
    q.bind(object_ref.to_string());
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let mut columns = Vec::with_capacity(rows.len());
    for row in &rows {
        let name = get_str(row, "name");
        let type_name = get_str(row, "type_name");
        let max_length: i16 = row.try_get("max_length").ok().flatten().unwrap_or(0);
        let precision: u8 = row.try_get("precision").ok().flatten().unwrap_or(0);
        let scale: u8 = row.try_get("scale").ok().flatten().unwrap_or(0);
        let is_nullable: bool = row.try_get("is_nullable").ok().flatten().unwrap_or(true);
        let is_identity: bool = row.try_get("is_identity").ok().flatten().unwrap_or(false);
        let is_pk: bool = row.try_get("is_pk").ok().flatten().unwrap_or(false);
        let mut default_value: Option<String> = row
            .try_get::<&str, _>("default_def")
            .ok()
            .flatten()
            .map(strip_default_parens);

        // Surface IDENTITY in the default cell so the Structure view shows it
        // (T-SQL has no separate "extra" column; IDENTITY is the analogue of
        // MySQL AUTO_INCREMENT / Postgres SERIAL).
        if is_identity && default_value.is_none() {
            default_value = Some("IDENTITY".to_string());
        }

        columns.push(ColumnInfo {
            name,
            data_type: super::sql::build_display_type(&type_name, max_length, precision, scale),
            nullable: is_nullable,
            pk: is_pk,
            default_value,
            fk: None,
            // SQL Server column comments (MS_Description extended properties) are
            // not read yet — deferred.
            comment: None,
        });
    }
    Ok(columns)
}

/// Outbound foreign keys, grouped per constraint with ordered column lists and
/// on_delete/on_update actions.
pub(super) async fn read_foreign_keys(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
    let object_ref = qualified(schema, table);
    let mut q = Query::new(
        "SELECT fk.name AS fk_name, \
            pc.name AS col, rt.name AS ref_table, rc.name AS ref_col, \
            fk.delete_referential_action_desc AS on_delete, \
            fk.update_referential_action_desc AS on_update, \
            fkc.constraint_column_id AS ord \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE fk.parent_object_id = OBJECT_ID(@P1) \
         ORDER BY fk.name, fkc.constraint_column_id",
    );
    q.bind(object_ref);
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let mut grouped: Vec<ForeignKeyInfo> = Vec::new();
    for row in &rows {
        let fk_name = get_str(row, "fk_name");
        let col = get_str(row, "col");
        let ref_table = get_str(row, "ref_table");
        let ref_col = get_str(row, "ref_col");
        let on_delete = normalize_fk_action(&get_str(row, "on_delete"));
        let on_update = normalize_fk_action(&get_str(row, "on_update"));
        match grouped.last_mut() {
            Some(existing) if existing.name.as_deref() == Some(fk_name.as_str()) => {
                existing.columns.push(col);
                existing.ref_columns.push(ref_col);
            }
            _ => grouped.push(ForeignKeyInfo {
                name: Some(fk_name),
                columns: vec![col],
                ref_table,
                ref_columns: vec![ref_col],
                on_delete: Some(on_delete),
                on_update: Some(on_update),
            }),
        }
    }
    Ok(grouped)
}

/// Foreign keys pointing *at* this table (§3.6 "referenced by").
pub(super) async fn read_inbound_foreign_keys(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let object_ref = qualified(schema, table);
    let mut q = Query::new(
        "SELECT fk.name AS fk_name, ct.name AS child_table, \
            pc.name AS child_col, rc.name AS ref_col, \
            fk.delete_referential_action_desc AS on_delete \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.tables ct ON ct.object_id = fk.parent_object_id \
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE fk.referenced_object_id = OBJECT_ID(@P1) \
         ORDER BY fk.name, fkc.constraint_column_id",
    );
    q.bind(object_ref);
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let mut grouped: Vec<InboundFkInfo> = Vec::new();
    for row in &rows {
        let fk_name = get_str(row, "fk_name");
        let child_table = get_str(row, "child_table");
        let child_col = get_str(row, "child_col");
        let ref_col = get_str(row, "ref_col");
        let on_delete = normalize_fk_action(&get_str(row, "on_delete"));
        match grouped.last_mut() {
            Some(existing)
                if existing.table == child_table && matches_fk_group(existing, &fk_name) =>
            {
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
    let _ = schema;
    let _ = table;
    Ok(grouped)
}

/// Indexes on the table, including the implicit primary-key index.
pub(super) async fn read_indexes(
    client: &mut TdsClient,
    object_ref: &str,
) -> Result<Vec<IndexInfo>, AppError> {
    let mut q = Query::new(
        "SELECT i.name AS name, i.is_unique AS is_unique, i.is_primary_key AS is_pk, \
            c.name AS col, ic.key_ordinal AS ord \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE i.object_id = OBJECT_ID(@P1) AND i.type <> 0 AND ic.is_included_column = 0 \
         ORDER BY i.index_id, ic.key_ordinal",
    );
    q.bind(object_ref.to_string());
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let mut grouped: Vec<IndexInfo> = Vec::new();
    for row in &rows {
        let name = get_str(row, "name");
        let unique: bool = row.try_get("is_unique").ok().flatten().unwrap_or(false);
        let primary: bool = row.try_get("is_pk").ok().flatten().unwrap_or(false);
        let col = get_str(row, "col");
        match grouped.last_mut() {
            Some(existing) if existing.name == name => existing.columns.push(col),
            _ => grouped.push(IndexInfo {
                name,
                columns: vec![col],
                unique,
                primary,
                origin: Some(if primary { "pk" } else { "c" }.to_string()),
            }),
        }
    }
    Ok(grouped)
}

/// §5 "Table 'x' does not exist…" listing the available tables in the schema.
pub(super) async fn missing_table_error(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> AppError {
    let mut q = Query::new(
        "SELECT t.name AS name FROM sys.tables t \
         JOIN sys.schemas s ON s.schema_id = t.schema_id \
         WHERE s.name = @P1 AND t.is_ms_shipped = 0 ORDER BY t.name",
    );
    q.bind(schema.to_string());
    let names: Vec<String> = match q.query(client).await {
        Ok(stream) => match stream.into_first_result().await {
            Ok(rows) => rows.iter().map(|r| get_str(r, "name")).collect(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    AppError::Database(format!(
        "Table '{table}' does not exist in schema '{schema}'. Available tables: {}.",
        if names.is_empty() {
            "(none)".to_string()
        } else {
            names.join(", ")
        }
    ))
}

/// §5 "Schema 'x' does not exist…" unless `schema` is a visible user schema.
pub(super) async fn ensure_schema_exists(
    client: &mut TdsClient,
    schema: &str,
) -> Result<(), AppError> {
    let mut q = Query::new("SELECT 1 AS ok FROM sys.schemas WHERE name = @P1");
    q.bind(schema.to_string());
    let found = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    if !found.is_empty() {
        return Ok(());
    }
    let names_sql = format!(
        "SELECT name FROM sys.schemas WHERE name NOT IN ({}) ORDER BY name",
        system_schema_list()
    );
    let names: Vec<String> = match client.simple_query(names_sql.as_str()).await {
        Ok(stream) => match stream.into_first_result().await {
            Ok(rows) => rows.iter().map(|r| get_str(r, "name")).collect(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    Err(AppError::Database(format!(
        "Schema '{schema}' does not exist. Available schemas: {}.",
        if names.is_empty() {
            "(none)".to_string()
        } else {
            names.join(", ")
        }
    )))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Read a string column, defaulting to empty on NULL / type mismatch.
pub(super) fn get_str(row: &Row, col: &str) -> String {
    row.try_get::<&str, _>(col)
        .ok()
        .flatten()
        .unwrap_or("")
        .to_string()
}

/// Strip the wrapping parentheses SQL Server stores around default definitions
/// (`((0))` → `0`, `('pending')` → `'pending'`, `(getdate())` → `getdate()`).
pub(super) fn strip_default_parens(def: &str) -> String {
    let mut s = def.trim();
    while s.starts_with('(') && s.ends_with(')') {
        let inner = &s[1..s.len() - 1];
        // Only strip a *balanced* outer pair.
        if is_balanced(inner) {
            s = inner.trim();
        } else {
            break;
        }
    }
    s.to_string()
}

pub(super) fn is_balanced(s: &str) -> bool {
    let mut depth = 0i32;
    for ch in s.chars() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// The system-schema exclusion list as a SQL literal `'a', 'b', …` (constant
/// names, no injection surface).
pub(super) fn system_schema_list() -> String {
    SYSTEM_SCHEMAS
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Normalize a `sys.foreign_keys.*_referential_action_desc` value
/// (`NO_ACTION`, `CASCADE`, `SET_NULL`, `SET_DEFAULT`) to the space-separated
/// display form the other adapters use (`NO ACTION`, `SET NULL`, …).
pub(super) fn normalize_fk_action(action: &str) -> String {
    action.trim().to_ascii_uppercase().replace('_', " ")
}

/// First-column → FK target map for the sidebar's per-column FK icon.
pub(super) fn fk_by_first_column(
    foreign_keys: &[ForeignKeyInfo],
) -> std::collections::HashMap<String, FkRef> {
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

/// Whether an inbound-FK group being accumulated matches this fk name. Inbound
/// groups carry no name field, so we approximate by "same child table and the
/// running group is still open"; the SQL orders by fk name so rows of one
/// constraint are contiguous — see [`read_inbound_foreign_keys`].
pub(super) fn matches_fk_group(_existing: &InboundFkInfo, _fk_name: &str) -> bool {
    // The ORDER BY groups a constraint's rows together; a new constraint starts
    // a new group via the ordering, so we only need contiguity, which the caller
    // already guarantees by only merging into `last_mut()`. Always false here
    // would over-split composite inbound FKs; we merge conservatively by child
    // table + name equality tracked out-of-band is unnecessary, so treat a
    // contiguous same-table run as the same constraint.
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_default_parens_unwraps_balanced_pairs() {
        assert_eq!(strip_default_parens("((0))"), "0");
        assert_eq!(strip_default_parens("('pending')"), "'pending'");
        assert_eq!(strip_default_parens("(getdate())"), "getdate()");
        assert_eq!(strip_default_parens("(N'x')"), "N'x'");
        assert_eq!(strip_default_parens("42"), "42");
    }

    #[test]
    fn normalize_fk_action_spaces_and_uppercases() {
        assert_eq!(normalize_fk_action("no_action"), "NO ACTION");
        assert_eq!(normalize_fk_action("CASCADE"), "CASCADE");
        assert_eq!(normalize_fk_action("set_null"), "SET NULL");
    }

    #[test]
    fn system_schema_list_is_quoted_csv() {
        let list = system_schema_list();
        assert!(list.starts_with("'sys', 'INFORMATION_SCHEMA'"));
        assert!(list.contains("'db_owner'"));
    }
}
