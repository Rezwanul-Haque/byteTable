//! SQL Server schema-object introspection + DDL builders. SQL Server exposes the
//! **full** object set (like Postgres): views, indexed views (surfaced under the
//! `matview` label), functions, procedures, triggers. Listing reads the `sys.*`
//! catalog (schema bound as a parameter); definitions come from
//! `OBJECT_DEFINITION(OBJECT_ID(...))` — the verbatim `CREATE …` text. `drop_sql`
//! and `generate_table_ddl` are pure (unit-tested).

use tiberius::Query;

use crate::shared::engine::{
    ColumnInfo, DbObjectDefinition, DbObjectInfo, DbObjectKind, ForeignKeyInfo, IndexInfo,
};
use crate::shared::error::AppError;

use super::sql::quote_ident;
use super::{get_str, map_query_error, TdsClient};

/// Kinds SQL Server exposes — the full set. `matview` reuses the label for
/// **indexed views** (schemabound views carrying a unique clustered index).
pub(super) const KINDS: &[DbObjectKind] = &[
    DbObjectKind::View,
    DbObjectKind::MaterializedView,
    DbObjectKind::Function,
    DbObjectKind::Procedure,
    DbObjectKind::Trigger,
];

pub(super) async fn list(
    client: &mut TdsClient,
    schema: &str,
    kind: DbObjectKind,
) -> Result<Vec<DbObjectInfo>, AppError> {
    // A view is "indexed" (our matview) when it carries any index (index_id > 0
    // — a unique clustered index is what materializes it).
    let indexed_pred =
        "EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = v.object_id AND i.index_id > 0)";
    let sql = match kind {
        DbObjectKind::View => format!(
            "SELECT v.name AS name FROM sys.views v \
             JOIN sys.schemas s ON s.schema_id = v.schema_id \
             WHERE s.name = @P1 AND v.is_ms_shipped = 0 AND NOT {indexed_pred} ORDER BY v.name"
        ),
        DbObjectKind::MaterializedView => format!(
            "SELECT v.name AS name FROM sys.views v \
             JOIN sys.schemas s ON s.schema_id = v.schema_id \
             WHERE s.name = @P1 AND v.is_ms_shipped = 0 AND {indexed_pred} ORDER BY v.name"
        ),
        DbObjectKind::Function =>
            "SELECT o.name AS name FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.is_ms_shipped = 0 AND o.type IN ('FN','IF','TF','FS','FT') ORDER BY o.name"
                .to_string(),
        DbObjectKind::Procedure =>
            "SELECT o.name AS name FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.is_ms_shipped = 0 AND o.type IN ('P','PC') ORDER BY o.name"
                .to_string(),
        DbObjectKind::Trigger =>
            "SELECT tr.name AS name, t.name AS parent FROM sys.triggers tr \
             JOIN sys.tables t ON t.object_id = tr.parent_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             WHERE s.name = @P1 AND tr.is_ms_shipped = 0 ORDER BY tr.name"
                .to_string(),
    };

    let mut q = Query::new(&sql);
    q.bind(schema.to_string());
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    Ok(rows
        .iter()
        .map(|row| {
            let name = get_str(row, "name");
            let detail = if matches!(kind, DbObjectKind::Trigger) {
                let parent = get_str(row, "parent");
                (!parent.is_empty()).then_some(parent)
            } else {
                None
            };
            DbObjectInfo { name, kind, detail }
        })
        .collect())
}

pub(super) async fn definition(
    client: &mut TdsClient,
    schema: &str,
    kind: DbObjectKind,
    name: &str,
    detail: Option<&str>,
) -> Result<DbObjectDefinition, AppError> {
    let object_ref = format!("{}.{}", quote_ident(schema), quote_ident(name));
    let mut q = Query::new("SELECT OBJECT_DEFINITION(OBJECT_ID(@P1)) AS ddl");
    q.bind(object_ref);
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let ddl = rows
        .first()
        .and_then(|r| r.try_get::<&str, _>("ddl").ok().flatten())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::NotFound(format!("Object '{name}' was not found.")))?;

    let mut def = DbObjectDefinition::ddl_only(name.to_string(), kind, ddl);
    if matches!(kind, DbObjectKind::Trigger) {
        def.table = detail.map(str::to_string);
    }
    Ok(def)
}

pub(super) fn drop_sql(
    schema: &str,
    kind: DbObjectKind,
    name: &str,
    _detail: Option<&str>,
) -> Result<String, AppError> {
    let q = quote_ident;
    Ok(match kind {
        // An indexed view drops as a view; its unique clustered index goes with
        // it, so the same statement covers both View and MaterializedView.
        DbObjectKind::View | DbObjectKind::MaterializedView => {
            format!("DROP VIEW IF EXISTS {}.{};", q(schema), q(name))
        }
        DbObjectKind::Function => format!("DROP FUNCTION IF EXISTS {}.{};", q(schema), q(name)),
        DbObjectKind::Procedure => format!("DROP PROCEDURE IF EXISTS {}.{};", q(schema), q(name)),
        // T-SQL DML triggers are dropped by their (schema-qualified) name; no
        // `ON <table>` clause.
        DbObjectKind::Trigger => format!("DROP TRIGGER IF EXISTS {}.{};", q(schema), q(name)),
    })
}

/// Build a `CREATE TABLE` statement in T-SQL from the introspected column set,
/// primary key, and foreign keys — bracket-quoted identifiers, `IDENTITY`, and
/// inline `CONSTRAINT`s. This is a faithful reconstruction (SQL Server has no
/// `SHOW CREATE TABLE`), rendered syntax-highlighted in the §3.6 DDL modal.
pub(super) fn generate_table_ddl(
    schema: &str,
    table: &str,
    columns: &[ColumnInfo],
    foreign_keys: &[ForeignKeyInfo],
    _indexes: &[IndexInfo],
) -> String {
    let mut lines: Vec<String> = Vec::new();

    for col in columns {
        let mut line = format!("    {} {}", quote_ident(&col.name), col.data_type);
        // IDENTITY (surfaced in default_value as the sentinel "IDENTITY").
        let is_identity = col.default_value.as_deref() == Some("IDENTITY");
        if is_identity {
            line.push_str(" IDENTITY(1,1)");
        }
        line.push_str(if col.nullable { " NULL" } else { " NOT NULL" });
        if let Some(default) = &col.default_value {
            if !is_identity {
                line.push_str(&format!(" DEFAULT {default}"));
            }
        }
        lines.push(line);
    }

    // Primary key (composite → ordered by column list as introspected).
    let pk_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| quote_ident(&c.name))
        .collect();
    if !pk_cols.is_empty() {
        lines.push(format!(
            "    CONSTRAINT {} PRIMARY KEY ({})",
            quote_ident(&format!("PK_{table}")),
            pk_cols.join(", ")
        ));
    }

    // Foreign keys.
    for fk in foreign_keys {
        let name = fk
            .name
            .clone()
            .unwrap_or_else(|| format!("FK_{table}_{}", fk.ref_table));
        let cols = fk
            .columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let ref_cols = fk
            .ref_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let mut line = format!(
            "    CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            quote_ident(&name),
            cols,
            quote_ident(&fk.ref_table),
            ref_cols
        );
        if let Some(on_delete) = &fk.on_delete {
            if on_delete != "NO ACTION" {
                line.push_str(&format!(" ON DELETE {on_delete}"));
            }
        }
        lines.push(line);
    }

    format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        quote_ident(schema),
        quote_ident(table),
        lines.join(",\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, nullable: bool, pk: bool, default: Option<&str>) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: ty.to_string(),
            nullable,
            pk,
            default_value: default.map(str::to_string),
            fk: None,
        }
    }

    #[test]
    fn drop_sql_uses_brackets_and_no_on_table_for_triggers() {
        assert_eq!(
            drop_sql("dbo", DbObjectKind::View, "v", None).unwrap(),
            "DROP VIEW IF EXISTS [dbo].[v];"
        );
        assert_eq!(
            drop_sql("dbo", DbObjectKind::MaterializedView, "mv", None).unwrap(),
            "DROP VIEW IF EXISTS [dbo].[mv];"
        );
        assert_eq!(
            drop_sql("dbo", DbObjectKind::Procedure, "p", None).unwrap(),
            "DROP PROCEDURE IF EXISTS [dbo].[p];"
        );
        assert_eq!(
            drop_sql("dbo", DbObjectKind::Trigger, "trg", Some("orders")).unwrap(),
            "DROP TRIGGER IF EXISTS [dbo].[trg];"
        );
    }

    #[test]
    fn generate_table_ddl_brackets_identity_pk_and_fk() {
        let columns = vec![
            col("id", "INT", false, true, Some("IDENTITY")),
            col("name", "NVARCHAR(100)", false, false, None),
            col("status", "VARCHAR(20)", true, false, Some("'pending'")),
            col("user_id", "INT", true, false, None),
        ];
        let fks = vec![ForeignKeyInfo {
            name: Some("FK_orders_users".into()),
            columns: vec!["user_id".into()],
            ref_table: "users".into(),
            ref_columns: vec!["id".into()],
            on_delete: Some("CASCADE".into()),
            on_update: Some("NO ACTION".into()),
        }];
        let ddl = generate_table_ddl("dbo", "orders", &columns, &fks, &[]);
        assert!(ddl.starts_with("CREATE TABLE [dbo].[orders] ("));
        assert!(ddl.contains("[id] INT IDENTITY(1,1) NOT NULL"));
        assert!(ddl.contains("[name] NVARCHAR(100) NOT NULL"));
        assert!(ddl.contains("[status] VARCHAR(20) NULL DEFAULT 'pending'"));
        assert!(ddl.contains("CONSTRAINT [PK_orders] PRIMARY KEY ([id])"));
        assert!(ddl.contains(
            "CONSTRAINT [FK_orders_users] FOREIGN KEY ([user_id]) REFERENCES [users] ([id]) ON DELETE CASCADE"
        ));
        assert!(ddl.trim_end().ends_with(");"));
    }
}
