// Create-table modal — ported from the prototype's `create-table.jsx`
// `CreateTableModal`. Stages columns like the structure editor and builds a
// `CREATE TABLE` statement, run via `execute_script_text` (the in-memory DDL
// path). The name is slugified (`\W+`→`_`, lowercased) and duplicate-checked
// against the schema's existing tables; at least one named column is required.
// A live `CREATE TABLE` preview updates as fields change.

import { useMemo, useState } from "react";

import { highlightSql } from "../../browse/shared/highlightSql";
import { executeScriptText } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import type { Engine } from "../../../shared/types";
import "./CreateTableModal.css";

/**
 * The column types offered in the dropdown, per engine — so a created table uses
 * syntax the target database actually accepts (the prototype assumed Postgres
 * types like `JSONB` / `UUID`, which MySQL rejects). The first entry is the
 * default for a newly-added column.
 */
const TYPES_BY_ENGINE: Record<Engine, string[]> = {
  postgres: [
    "INTEGER",
    "BIGINT",
    "TEXT",
    "VARCHAR(255)",
    "NUMERIC(10,2)",
    "BOOLEAN",
    "TIMESTAMP",
    "DATE",
    "JSONB",
    "UUID",
    "BYTEA",
  ],
  mysql: [
    "INT",
    "BIGINT",
    "TEXT",
    "VARCHAR(255)",
    "DECIMAL(10,2)",
    "BOOLEAN",
    "DATETIME",
    "TIMESTAMP",
    "DATE",
    "JSON",
    "CHAR(36)",
    "BINARY(16)",
  ],
  sqlite: [
    "INTEGER",
    "TEXT",
    "REAL",
    "NUMERIC",
    "BLOB",
    "BOOLEAN",
    "VARCHAR(255)",
    "TIMESTAMP",
    "DATE",
  ],
  // SQL Server (M21): the common T-SQL types (a curated subset of the full
  // Structure type list); bracket-quoted identifiers are applied at emit time.
  mssql: [
    "INT",
    "BIGINT",
    "NVARCHAR(255)",
    "VARCHAR(255)",
    "NVARCHAR(MAX)",
    "DECIMAL(18,2)",
    "BIT",
    "DATETIME2",
    "DATE",
    "UNIQUEIDENTIFIER",
    "VARBINARY(MAX)",
  ],
  // Redis / DynamoDB / MongoDB / Cassandra have no relational create-table here
  // (Cassandra has its own CQL create flow, M19 §19.6); never reached, but the
  // record must be total.
  redis: ["TEXT"],
  dynamodb: ["S"],
  mongodb: ["string"],
  cassandra: ["text"],
};

/** The type a fresh column row defaults to per engine (the second-ish text type
 *  — the first entry tends to be the int pk type). */
function defaultColType(types: string[]): string {
  return types.find((t) => t.startsWith("TEXT") || t.startsWith("VARCHAR")) ?? types[0]!;
}

interface DraftCol {
  id: string;
  name: string;
  type: string;
  pk: boolean;
  nullable: boolean;
  dflt: string;
}

/** Slugify a name the way the prototype does (`\W+`→`_`, lowercased). */
function slug(name: string): string {
  return name.trim().replace(/\W+/g, "_").toLowerCase();
}

export function CreateTableModal({
  handleId,
  schemaName,
  engine,
  existing,
  onCreated,
  onClose,
}: {
  handleId: string;
  schemaName: string;
  /** The connection's engine — picks the column-type list. */
  engine: Engine;
  /** Existing table names in the schema (for the duplicate check). */
  existing: string[];
  /** Called with the created table's (cleaned) name after success. */
  onCreated: (name: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  // Engine-specific column types (fall back to Postgres' set defensively).
  const types = TYPES_BY_ENGINE[engine] ?? TYPES_BY_ENGINE.postgres;
  const [name, setName] = useState("");
  const [cols, setCols] = useState<DraftCol[]>([
    { id: "c1", name: "id", type: types[0]!, pk: true, nullable: false, dflt: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic id source for new column rows (avoids Date.now in render).
  const [seq, setSeq] = useState(1);

  const clean = slug(name);
  const dupe = clean !== "" && existing.includes(clean);
  const validCols = cols.filter((c) => c.name.trim() !== "");
  const ok = clean !== "" && !dupe && validCols.length > 0 && !busy;

  const addCol = () => {
    const id = "c" + (seq + 1);
    setSeq((s) => s + 1);
    setCols((cs) => [
      ...cs,
      { id, name: "", type: defaultColType(types), pk: false, nullable: true, dflt: "" },
    ]);
  };
  const patch = (id: string, p: Partial<DraftCol>) =>
    setCols((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const remove = (id: string) => setCols((cs) => cs.filter((c) => c.id !== id));
  const togglePk = (id: string) =>
    setCols((cs) => cs.map((c) => (c.id === id ? { ...c, pk: !c.pk } : c)));

  const ddl = useMemo(() => {
    const isInt = (t: string) => /INT/i.test(t);
    const pkCols = validCols.filter((c) => c.pk);
    // Auto-increment only makes sense for a single integer primary key (a
    // composite pk or a non-int pk can't auto-increment).
    const autoPk = pkCols.length === 1 && isInt(pkCols[0]!.type) ? pkCols[0]!.id : null;
    const lines = validCols.map((c) => {
      const isAuto = c.id === autoPk;
      let typeTok = c.type;
      let tail = "";
      if (isAuto) {
        // Engine-specific identity column syntax.
        if (engine === "postgres") {
          typeTok = /BIGINT/i.test(c.type) ? "BIGSERIAL" : "SERIAL";
          tail = " PRIMARY KEY";
        } else if (engine === "mysql") {
          tail = " AUTO_INCREMENT PRIMARY KEY";
        } else {
          // SQLite: AUTOINCREMENT requires the literal `INTEGER PRIMARY KEY`.
          typeTok = "INTEGER";
          tail = " PRIMARY KEY AUTOINCREMENT";
        }
      } else if (c.pk) {
        tail = " PRIMARY KEY";
      }
      let l = "  " + slug(c.name) + " " + typeTok + tail;
      if (!c.nullable && !c.pk) l += " NOT NULL";
      // An auto-increment column supplies its own value — skip a user default.
      if (c.dflt.trim() && !isAuto) l += " DEFAULT " + c.dflt.trim();
      return l;
    });
    return "CREATE TABLE " + (clean || "table_name") + " (\n" + lines.join(",\n") + "\n);";
  }, [validCols, clean, engine]);

  const create = () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await executeScriptText(handleId, schemaName, ddl);
      } catch (err) {
        setError(appErrorMessage(err, "Could not create the table."));
        setBusy(false);
        return;
      }
      toast("Table “" + clean + "” created", "ok");
      onCreated(clean);
      onClose();
    })();
  };

  const bad = dupe || error !== null;
  const status = error
    ? error
    : dupe
      ? "Table “" + clean + "” already exists"
      : ok
        ? validCols.length + " column" + (validCols.length === 1 ? "" : "s") + " · ready to create"
        : "Name the table and add at least one column";

  return (
    <Modal onClose={onClose} label="Create table" width={600} className="createtable-modal">
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="add" size={17} style={{ color: "var(--accent)" }} /> Create table
          <span className="ct-schema">in {schemaName}</span>
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </ModalTitle>

      <label className="binary-field">
        <span className="binary-label">Table name</span>
        <input
          className={"binary-input" + (bad ? " err" : "")}
          value={name}
          autoFocus
          spellCheck={false}
          placeholder="invoices"
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </label>

      <div className="ct-cols-head">
        <span className="form-section-label">Columns</span>
        <button type="button" className="rail-add" onClick={addCol} title="Add column">
          <Icon name="add" size={15} />
        </button>
      </div>
      <div className="ct-cols">
        <div className="ct-row ct-row-head">
          <span>Name</span>
          <span>Type</span>
          <span title="Primary key">PK</span>
          <span title="Nullable">Null</span>
          <span>Default</span>
          <span />
        </div>
        {cols.map((c) => (
          <div className="ct-row" key={c.id}>
            <input
              className="ct-in"
              value={c.name}
              placeholder="column"
              spellCheck={false}
              onChange={(e) => patch(c.id, { name: e.target.value })}
            />
            <Select
              className="ct-sel sel-block"
              aria-label="Column type"
              value={c.type}
              options={[...new Set([c.type, ...types])].map((t) => ({ value: t, label: t }))}
              onChange={(v) => patch(c.id, { type: v })}
            />
            <button
              type="button"
              className={"ct-flag" + (c.pk ? " on" : "")}
              onClick={() => togglePk(c.id)}
              title="Primary key"
            >
              <Icon
                name="key"
                size={13}
                style={{ transform: "rotate(45deg)", opacity: c.pk ? 1 : 0.3 }}
              />
            </button>
            <button
              type="button"
              className={"ct-flag" + (c.nullable && !c.pk ? " on" : "")}
              onClick={() => patch(c.id, { nullable: !c.nullable })}
              disabled={c.pk}
              title="Nullable"
            >
              {c.pk ? "—" : c.nullable ? "yes" : "no"}
            </button>
            <input
              className="ct-in"
              value={c.dflt}
              placeholder="—"
              spellCheck={false}
              onChange={(e) => patch(c.id, { dflt: e.target.value })}
            />
            <button
              type="button"
              className="ct-drop"
              onClick={() => remove(c.id)}
              disabled={cols.length === 1}
              title="Remove column"
            >
              <Icon name="delete" size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="ct-ddl-label">Preview</div>
      <pre className="ddl-block ct-ddl" dangerouslySetInnerHTML={{ __html: highlightSql(ddl) }} />

      <div className={"json-status" + (bad ? " err" : " ok")}>
        <Icon name={bad ? "error" : "check_circle"} size={14} />
        <span>{status}</span>
      </div>

      <ModalActions>
        <div style={{ flex: 1 }} />
        <Btn variant="text" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="filled" icon="add" disabled={!ok} onClick={create}>
          {busy ? "Creating…" : "Create table"}
        </Btn>
      </ModalActions>
    </Modal>
  );
}
