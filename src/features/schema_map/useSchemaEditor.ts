// useSchemaEditor — the stateful half of schema-map edit mode
// (Schema_Visual_Edit.md "Staging model").
//
// Owns the editable schema model, the pending-migration list, the discard
// snapshot, and every edit operation. Each op does two things: it updates the
// editable model (so the diagram redraws) and pushes one SQL string onto
// `pending`. Lives in the host (SchemaMap) so the toolbar (Add table / pending
// count / toggle guard) and the edit canvas share one editor.
//
// Updates are IMMUTABLE: an op validates against the current model, then
// `setSchema(prev => clone+mutate)` so React (and its lint rules) see a fresh
// object. Columns/tables/FKs are addressed BY NAME (stable across clones), not
// object identity. Before the first edit of a session a deep-clone snapshot is
// captured for discard.
//
// COMMIT wires to the real database: the staged statements join into one script
// and run through `executeScriptText` (a single transaction — the same in-app
// DDL path CreateTableModal uses). On success the introspection cache is
// invalidated and the host re-introspects so the map reflects committed truth.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { executeScriptText } from "../../shared/api/engine";
import type { TableMeta } from "../../shared/api/engine";
import { appErrorMessage } from "../../shared/api/error";
import type { ToastKind } from "../../shared/ui/toastContext";
import { useIntrospectionStore } from "../introspection/state";
import type { Workspace } from "../workspaces/types";
import {
  buildEditSchema,
  cloneEditSchema,
  ddl,
  editTypesFor,
  sanitizeName,
  type EditMeta,
  type EditSchema,
} from "./editModel";

/** Card position in world coords (matches the host's `Positions` entries). */
export interface XY {
  x: number;
  y: number;
}

interface UseSchemaEditorArgs {
  workspace: Workspace;
  schemaName: string;
  /** Introspected metas (the seed). Re-seeds the editable model on identity
   *  change — i.e. after a commit re-introspects. */
  metas: Record<string, TableMeta> | null;
  /** Mutate card positions for table add/rename/drop (lives in the host). */
  setPositions: (fn: (p: Record<string, XY> | null) => Record<string, XY> | null) => void;
  /** World-space top-left to drop a newly added table at (host derives it from
   *  the current scroll so the card lands in view). */
  newTablePos: () => XY;
  /** Called after a successful commit so the host can re-introspect. */
  onCommitted: () => void;
  toast: (message: string, kind?: ToastKind) => void;
}

export interface SchemaEditor {
  schema: EditSchema;
  pending: string[];
  editTypes: string[];
  busy: boolean;
  /** The id of the destructive control currently armed for its confirm click,
   *  or null. Format `"col:<table>.<name>"` | `"tbl:<name>"`. */
  armedDrop: string | null;
  arm: (id: string) => void;
  disarm: () => void;
  // column ops (addressed by column name)
  addColumn: (table: string) => void;
  renameColumn: (table: string, colName: string, raw: string) => void;
  changeType: (table: string, colName: string, type: string) => void;
  toggleNullable: (table: string, colName: string) => void;
  togglePk: (table: string, colName: string) => void;
  dropColumn: (table: string, colName: string) => void;
  // relationship ops
  addForeignKey: (fromT: string, fromCol: string, toT: string, toCol: string) => void;
  dropForeignKey: (table: string, fkName: string) => void;
  // table ops
  addTable: () => void;
  renameTable: (oldName: string, raw: string) => void;
  dropTable: (table: string) => void;
  // migration
  commit: () => Promise<void>;
  discard: () => void;
}

export function useSchemaEditor({
  workspace,
  schemaName,
  metas,
  setPositions,
  newTablePos,
  onCommitted,
  toast,
}: UseSchemaEditorArgs): SchemaEditor {
  const { handleId } = workspace;
  const engine = workspace.saved.engine;
  const invalidate = useIntrospectionStore((s) => s.invalidate);

  // The editable model. Re-seeded whenever metas identity changes (a fresh
  // introspection after commit), which also clears any stale pending. This uses
  // React's "adjust state during render" pattern (deriving from a changed prop)
  // rather than an effect, so the reseed is synchronous with no extra paint.
  const [schema, setSchema] = useState<EditSchema>(() =>
    metas ? buildEditSchema(metas) : { meta: {}, order: [] },
  );
  const [seededFrom, setSeededFrom] = useState(metas);
  const [pending, setPending] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [armedDrop, setArmedDrop] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotRef = useRef<EditSchema | null>(null);

  if (metas !== seededFrom) {
    // metas changed (post-commit re-introspection) → reseed. Pending is already
    // empty after a commit; the snapshot was cleared there too.
    setSeededFrom(metas);
    setSchema(metas ? buildEditSchema(metas) : { meta: {}, order: [] });
    setPending([]);
  }

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  const editTypes = useMemo(() => editTypesFor(engine), [engine]);

  const stage = useCallback((sql: string) => setPending((p) => [...p, sql]), []);
  // Capture the pre-edit snapshot once per session, from the current model.
  const ensureSnapshot = useCallback(() => {
    if (!snapshotRef.current) snapshotRef.current = cloneEditSchema(schema);
  }, [schema]);
  /** Apply an immutable mutation: clone, run `fn` on the clone, return it. */
  const edit = useCallback((fn: (next: EditSchema) => void) => {
    setSchema((prev) => {
      const next = cloneEditSchema(prev);
      fn(next);
      return next;
    });
  }, []);

  const arm = useCallback((id: string) => {
    setArmedDrop(id);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmedDrop(null), 2600);
  }, []);
  const disarm = useCallback(() => {
    setArmedDrop(null);
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);

  // --- column ops ------------------------------------------------------
  const addColumn = useCallback(
    (table: string) => {
      const meta = schema.meta[table];
      if (!meta) return;
      let name = "new_column";
      let i = 2;
      while (meta.columns.find((c) => c.name === name)) name = "new_column_" + i++;
      ensureSnapshot();
      edit((next) => {
        next.meta[table]?.columns.push({
          name,
          type: "TEXT",
          pk: false,
          nullable: true,
          default: null,
          fk: null,
        });
      });
      stage(ddl.addColumn(table, name));
    },
    [schema, ensureSnapshot, edit, stage],
  );

  const renameColumn = useCallback(
    (table: string, colName: string, raw: string) => {
      const newName = sanitizeName(raw);
      if (!newName || newName === colName) return;
      const meta = schema.meta[table];
      if (!meta) return;
      if (meta.columns.find((c) => c.name === newName)) {
        toast(`Column “${newName}” already exists`, "err");
        return;
      }
      ensureSnapshot();
      edit((next) => {
        const m = next.meta[table];
        if (!m) return;
        const col = m.columns.find((c) => c.name === colName);
        if (col) col.name = newName;
        m.indexes.forEach((ix) => {
          ix.columns = ix.columns.map((c) => (c === colName ? newName : c));
        });
        m.foreignKeys.forEach((fk) => {
          fk.columns = fk.columns.map((c) => (c === colName ? newName : c));
        });
      });
      stage(ddl.renameColumn(table, colName, newName));
    },
    [schema, ensureSnapshot, edit, stage, toast],
  );

  const changeType = useCallback(
    (table: string, colName: string, type: string) => {
      const col = schema.meta[table]?.columns.find((c) => c.name === colName);
      // `type` is "" when the user re-picks the placeholder (current type shown
      // when it isn't one of the offered types) — ignore that no-op.
      if (!col || !type || type === col.type) return;
      ensureSnapshot();
      edit((next) => {
        const c = next.meta[table]?.columns.find((x) => x.name === colName);
        if (c) c.type = type;
      });
      stage(ddl.changeType(table, colName, type));
    },
    [schema, ensureSnapshot, edit, stage],
  );

  const toggleNullable = useCallback(
    (table: string, colName: string) => {
      const col = schema.meta[table]?.columns.find((c) => c.name === colName);
      if (!col || col.pk) return;
      const nullable = !col.nullable;
      ensureSnapshot();
      edit((next) => {
        const c = next.meta[table]?.columns.find((x) => x.name === colName);
        if (c) c.nullable = nullable;
      });
      stage(ddl.setNullable(table, colName, nullable));
    },
    [schema, ensureSnapshot, edit, stage],
  );

  const togglePk = useCallback(
    (table: string, colName: string) => {
      const col = schema.meta[table]?.columns.find((c) => c.name === colName);
      if (!col) return;
      const wasPk = col.pk;
      ensureSnapshot();
      edit((next) => {
        const m = next.meta[table];
        if (!m) return;
        if (wasPk) {
          const c = m.columns.find((x) => x.name === colName);
          if (c) c.pk = false;
        } else {
          m.columns.forEach((c) => {
            c.pk = false;
          });
          const c = m.columns.find((x) => x.name === colName);
          if (c) {
            c.pk = true;
            c.nullable = false;
          }
        }
      });
      stage(wasPk ? ddl.dropPrimaryKey(table) : ddl.addPrimaryKey(table, colName));
    },
    [schema, ensureSnapshot, edit, stage],
  );

  const dropColumn = useCallback(
    (table: string, colName: string) => {
      if (!schema.meta[table]) return;
      ensureSnapshot();
      edit((next) => {
        const m = next.meta[table];
        if (!m) return;
        m.columns = m.columns.filter((c) => c.name !== colName);
        m.indexes = m.indexes.filter((ix) => !ix.columns.includes(colName));
        m.foreignKeys = m.foreignKeys.filter((fk) => !fk.columns.includes(colName));
      });
      stage(ddl.dropColumn(table, colName));
    },
    [schema, ensureSnapshot, edit, stage],
  );

  // --- relationship ops ------------------------------------------------
  const addForeignKey = useCallback(
    (fromT: string, fromCol: string, toT: string, toCol: string) => {
      const meta = schema.meta[fromT];
      if (!meta) return;
      if (meta.foreignKeys.find((fk) => fk.columns[0] === fromCol && fk.refTable === toT)) {
        toast("That foreign key already exists", "err");
        return;
      }
      const name = `fk_${fromT}_${fromCol}`;
      ensureSnapshot();
      edit((next) => {
        const m = next.meta[fromT];
        if (!m) return;
        m.foreignKeys.push({
          name,
          columns: [fromCol],
          refTable: toT,
          refColumns: [toCol],
          onDelete: "RESTRICT",
        });
        const col = m.columns.find((c) => c.name === fromCol);
        if (col) col.fk = `${toT}.${toCol}`;
      });
      stage(ddl.addForeignKey(fromT, name, fromCol, toT, toCol));
      toast("Foreign key added", "ok");
    },
    [schema, ensureSnapshot, edit, stage, toast],
  );

  const dropForeignKey = useCallback(
    (table: string, fkName: string) => {
      if (!schema.meta[table]) return;
      ensureSnapshot();
      edit((next) => {
        const m = next.meta[table];
        if (!m) return;
        const fk = m.foreignKeys.find((x) => x.name === fkName);
        if (!fk) return;
        m.foreignKeys = m.foreignKeys.filter((x) => x.name !== fkName);
        fk.columns.forEach((cn) => {
          const c = m.columns.find((x) => x.name === cn);
          if (c) c.fk = null;
        });
      });
      stage(ddl.dropForeignKey(table, fkName));
    },
    [schema, ensureSnapshot, edit, stage],
  );

  // --- table ops -------------------------------------------------------
  const addTable = useCallback(() => {
    let name = "new_table";
    let i = 2;
    while (schema.meta[name]) name = "new_table_" + i++;
    const meta: EditMeta = {
      columns: [
        { name: "id", type: "INTEGER", pk: true, nullable: false, default: null, fk: null },
      ],
      indexes: [{ name: name + "_pkey", columns: ["id"], unique: true, primary: true }],
      foreignKeys: [],
    };
    ensureSnapshot();
    edit((next) => {
      next.meta[name] = meta;
      next.order = [...next.order, name];
    });
    const pos = newTablePos();
    setPositions((p) => ({ ...(p ?? {}), [name]: pos }));
    stage(ddl.createTable(name));
  }, [schema, ensureSnapshot, edit, stage, newTablePos, setPositions]);

  const renameTable = useCallback(
    (oldName: string, raw: string) => {
      const newName = sanitizeName(raw);
      if (!newName || newName === oldName) return;
      if (!schema.meta[oldName]) return;
      if (schema.meta[newName]) {
        toast(`Table “${newName}” already exists`, "err");
        return;
      }
      ensureSnapshot();
      edit((next) => {
        const moved = next.meta[oldName];
        if (!moved) return;
        next.meta[newName] = moved;
        delete next.meta[oldName];
        next.order = next.order.map((t) => (t === oldName ? newName : t));
        // Repoint inbound FK references + `col.fk` strings.
        for (const m of Object.values(next.meta)) {
          m.foreignKeys.forEach((fk) => {
            if (fk.refTable === oldName) fk.refTable = newName;
          });
          m.columns.forEach((c) => {
            if (c.fk && c.fk.split(".")[0] === oldName) c.fk = newName + "." + c.fk.split(".")[1];
          });
        }
      });
      setPositions((p) => {
        if (!p) return p;
        const np = { ...p };
        const xy = np[oldName];
        if (xy) np[newName] = xy;
        delete np[oldName];
        return np;
      });
      stage(ddl.renameTable(oldName, newName));
    },
    [schema, ensureSnapshot, edit, stage, toast, setPositions],
  );

  const dropTable = useCallback(
    (table: string) => {
      if (!schema.meta[table]) return;
      ensureSnapshot();
      edit((next) => {
        delete next.meta[table];
        next.order = next.order.filter((t) => t !== table);
        for (const m of Object.values(next.meta)) {
          m.foreignKeys = m.foreignKeys.filter((fk) => fk.refTable !== table);
          m.columns.forEach((c) => {
            if (c.fk && c.fk.split(".")[0] === table) c.fk = null;
          });
        }
      });
      setPositions((p) => {
        if (!p) return p;
        const np = { ...p };
        delete np[table];
        return np;
      });
      stage(ddl.dropTable(table));
    },
    [schema, ensureSnapshot, edit, stage, setPositions],
  );

  // --- migration -------------------------------------------------------
  const commit = useCallback(async () => {
    if (pending.length === 0) return;
    setBusy(true);
    try {
      await executeScriptText(handleId, schemaName, pending.join("\n"));
    } catch (err) {
      toast(appErrorMessage(err, "Could not apply the schema changes."), "err");
      setBusy(false);
      return;
    }
    const n = pending.length;
    snapshotRef.current = null;
    setPending([]);
    setBusy(false);
    invalidate(handleId, schemaName);
    toast(`${n} schema change${n === 1 ? "" : "s"} committed`, "ok");
    onCommitted();
  }, [pending, handleId, schemaName, invalidate, onCommitted, toast]);

  const discard = useCallback(() => {
    const snap = snapshotRef.current;
    if (snap) {
      setSchema(cloneEditSchema(snap));
      snapshotRef.current = null;
    }
    setPending([]);
    disarm();
    toast("Pending changes discarded");
  }, [disarm, toast]);

  return {
    schema,
    pending,
    editTypes,
    busy,
    armedDrop,
    arm,
    disarm,
    addColumn,
    renameColumn,
    changeType,
    toggleNullable,
    togglePk,
    dropColumn,
    addForeignKey,
    dropForeignKey,
    addTable,
    renameTable,
    dropTable,
    commit,
    discard,
  };
}
