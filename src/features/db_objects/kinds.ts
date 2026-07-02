// Per-object-class display metadata + engine ordering, mirroring the design's
// OBJ_SECTIONS / ENGINE_OBJECTS (dbobjects.jsx). Drives the sidebar sections,
// tab bar, and viewer. `table` is included for the sidebar's grouped browser;
// the object commands only ever deal with the non-table kinds (DbObjectKind).

import type { Engine } from "../../shared/types";
import type { DbObjectKind } from "./api";

/** A sidebar/viewer object class — the non-table kinds plus `table`. */
export type ObjectClass = "table" | DbObjectKind;

interface SectionMeta {
  label: string;
  group: string;
  icon: string;
  accent: string;
}

/** Per-class display metadata (OBJ_SECTIONS). */
export const OBJ_SECTIONS: Record<ObjectClass, SectionMeta> = {
  table: { label: "Table", group: "Tables", icon: "table", accent: "var(--text-faint)" },
  view: { label: "View", group: "Views", icon: "visibility", accent: "#5aa7f5" },
  materialized_view: {
    label: "Materialized View",
    group: "Materialized Views",
    icon: "dataset",
    accent: "#b08cff",
  },
  function: { label: "Function", group: "Functions", icon: "function", accent: "#2dd4a7" },
  procedure: { label: "Procedure", group: "Procedures", icon: "code_blocks", accent: "#f5b54a" },
  trigger: { label: "Trigger", group: "Triggers", icon: "bolt", accent: "#ef7fb1" },
};

/** Object classes each engine exposes, in sidebar display order (ENGINE_OBJECTS).
 *  `table` first; the rest become the bottom accordion. */
export const ENGINE_OBJECTS: Record<Engine, ObjectClass[]> = {
  sqlite: ["table", "view", "trigger"],
  mysql: ["table", "view", "procedure", "function", "trigger"],
  postgres: ["table", "view", "materialized_view", "function", "procedure", "trigger"],
  // SQL Server (M21) exposes the full object set (like Postgres); `matview`
  // stands in for indexed views.
  mssql: ["table", "view", "materialized_view", "function", "procedure", "trigger"],
  redis: [],
  dynamodb: [],
  mongodb: [],
  cassandra: [],
};

/** The non-table object classes for an engine, in display order (the bottom
 *  accordion's sections). */
export function objectClassesFor(engine: Engine): DbObjectKind[] {
  return ENGINE_OBJECTS[engine].filter((c): c is DbObjectKind => c !== "table");
}

/** Whether an object's data can be SELECTed (browse-as-rows). */
export function isBrowsable(kind: DbObjectKind): boolean {
  return kind === "view" || kind === "materialized_view";
}

/** A short uppercase type badge (`MATERIALIZED VIEW`, `FUNCTION`, …). */
export function typeBadge(kind: DbObjectKind): string {
  return kind === "materialized_view" ? "MATERIALIZED VIEW" : kind.toUpperCase();
}

/** Dialect label for the DDL block header. */
export const ENGINE_DIALECT: Record<Engine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  mssql: "T-SQL",
  redis: "Redis",
  dynamodb: "DynamoDB",
  mongodb: "MongoDB",
  cassandra: "Cassandra",
};

/** Engine-aware `CREATE …` template for a new object (design Prompt 4). Opens
 *  in the SQL editor for the user to fill in and run. */
export function newObjectTemplate(engine: Engine, kind: DbObjectKind): string {
  const mysql = engine === "mysql";
  // SQL Server (M21) uses T-SQL create templates: bracket/`dbo.`-qualified,
  // `CREATE OR ALTER` for routines/triggers, and an indexed view (schemabound
  // view + unique clustered index) in place of a materialized view.
  if (engine === "mssql") {
    switch (kind) {
      case "view":
        return "CREATE VIEW dbo.new_view AS\nSELECT *\nFROM dbo.table_name;";
      case "materialized_view":
        return (
          "CREATE VIEW dbo.new_indexed_view\nWITH SCHEMABINDING AS\n" +
          "SELECT col1, COUNT_BIG(*) AS cnt\nFROM dbo.table_name\nGROUP BY col1;\nGO\n" +
          "CREATE UNIQUE CLUSTERED INDEX IX_new_indexed_view\nON dbo.new_indexed_view (col1);"
        );
      case "function":
        return (
          "CREATE OR ALTER FUNCTION dbo.new_function(@arg1 INT)\nRETURNS INT\nAS\n" +
          "BEGIN\n  RETURN @arg1;\nEND;"
        );
      case "procedure":
        return (
          "CREATE OR ALTER PROCEDURE dbo.new_procedure\n  @arg1 INT\nAS\n" +
          "BEGIN\n  -- statements\nEND;"
        );
      case "trigger":
        return (
          "CREATE OR ALTER TRIGGER dbo.new_trigger\nON dbo.table_name\nAFTER INSERT\nAS\n" +
          "BEGIN\n  -- statements\nEND;"
        );
    }
  }
  switch (kind) {
    case "view":
      return "CREATE VIEW new_view AS\nSELECT *\nFROM table_name;";
    case "materialized_view":
      return "CREATE MATERIALIZED VIEW new_mview AS\nSELECT *\nFROM table_name\nWITH DATA;";
    case "function":
      return mysql
        ? "CREATE FUNCTION new_function(arg1 INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN arg1;\nEND;"
        : "CREATE OR REPLACE FUNCTION new_function(arg1 integer)\nRETURNS integer\nLANGUAGE plpgsql AS $$\nBEGIN\n  RETURN arg1;\nEND;\n$$;";
    case "procedure":
      return mysql
        ? "CREATE PROCEDURE new_procedure(IN arg1 INT)\nBEGIN\n  -- statements\nEND;"
        : "CREATE OR REPLACE PROCEDURE new_procedure(arg1 integer)\nLANGUAGE plpgsql AS $$\nBEGIN\n  -- statements\nEND;\n$$;";
    case "trigger":
      return mysql
        ? "CREATE TRIGGER new_trigger\nBEFORE INSERT ON table_name\nFOR EACH ROW\nBEGIN\n  -- statements\nEND;"
        : "CREATE TRIGGER new_trigger\nBEFORE INSERT ON table_name\nFOR EACH ROW\nEXECUTE FUNCTION trigger_function();";
  }
}
