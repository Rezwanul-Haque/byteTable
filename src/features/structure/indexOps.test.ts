// Index + foreign-key staging — the `replace` intent that realizes an "edit".
//
// These cover the invariant the whole feature rests on: no engine can redefine
// an index or a constraint in place, so an edit is a DROP + ADD. The editor
// holds it as ONE `replaceIndex` / `replaceForeignKey` op (so the rail can show
// one card, and so a RENAME does not look like an unrelated drop next to an
// unrelated create), and `toWireBatch` expands it drop-first. Break either half
// and the UI shows a phantom second index, or the apply fails on a name that
// still exists.

import { describe, expect, it } from "vitest";

import type { ForeignKeyInfo, IndexInfo } from "../../shared/api/engine";
import {
  applyOpsToForeignKeys,
  applyOpsToIndexes,
  stageForeignKeyDrop,
  stageForeignKeyEdit,
  stageForeignKeyRestore,
  stageIndexDrop,
  stageIndexEdit,
  stageIndexRestore,
  toWireBatch,
  type EditorOp,
  type WorkingForeignKey,
  type WorkingIndex,
} from "./ops";

const index = (name: string, columns: string[], unique = false, primary = false): IndexInfo => ({
  name,
  columns,
  unique,
  primary,
  origin: null,
});

/** The table every case starts from: one plain index, one unique, one pk. */
const INDEXES: IndexInfo[] = [
  index("idx_users_email", ["email"]),
  index("idx_users_name", ["name"], true),
  index("sqlite_autoindex_users_1", ["id"], true, true),
];

const working = (ops: EditorOp[]): WorkingIndex[] => applyOpsToIndexes(INDEXES, ops);
const byName = (ops: EditorOp[], name: string): WorkingIndex =>
  working(ops).find((w) => w.name === name)!;

/** `idx_users_email` as the editor currently sees it, after `ops`. */
const email = (ops: EditorOp[] = []): WorkingIndex =>
  working(ops).find((w) => w.was?.name === "idx_users_email" || w.name === "idx_users_email")!;

describe("stageIndexEdit", () => {
  it("stages ONE replace op rather than a loose drop + add", () => {
    const ops = stageIndexEdit([], email(), "idx_users_email", ["email", "created_at"], false);
    expect(ops).toEqual([
      {
        op: "replaceIndex",
        from: "idx_users_email",
        name: "idx_users_email",
        columns: ["email", "created_at"],
        unique: false,
      },
    ]);
  });

  it("shows it as ONE edited card carrying both definitions", () => {
    const ops = stageIndexEdit([], email(), "idx_users_email", ["email", "created_at"], true);
    const cards = working(ops);
    expect(cards).toHaveLength(3); // no phantom fourth index
    const edited = cards.find((c) => c.name === "idx_users_email")!;
    expect(edited.columns).toEqual(["email", "created_at"]);
    expect(edited.unique).toBe(true);
    expect(edited.isEdited).toBe(true);
    expect(edited.markedForDrop).toBe(false);
    expect(edited.isNew).toBe(false);
    expect(edited.was).toEqual({ name: "idx_users_email", columns: ["email"], unique: false });
  });

  it("renames in place, keeping the card and remembering the old name", () => {
    const ops = stageIndexEdit([], email(), "ix_email", ["email"], false);
    expect(ops).toEqual([
      {
        op: "replaceIndex",
        from: "idx_users_email",
        name: "ix_email",
        columns: ["email"],
        unique: false,
      },
    ]);
    const cards = working(ops);
    expect(cards).toHaveLength(3); // still one card, under the new name
    const card = cards.find((c) => c.name === "ix_email")!;
    expect(card.isEdited).toBe(true);
    expect(card.isNew).toBe(false);
    expect(card.was?.name).toBe("idx_users_email");
  });

  it("re-edits a RENAMED index without orphaning the first replace", () => {
    // The card's own name is now `ix_email`, but the server still calls it
    // `idx_users_email` — the ops stay filed under the server's name.
    let ops = stageIndexEdit([], email(), "ix_email", ["email"], false);
    ops = stageIndexEdit(ops, email(ops), "ix_email2", ["email", "id"], true);
    expect(ops).toEqual([
      {
        op: "replaceIndex",
        from: "idx_users_email",
        name: "ix_email2",
        columns: ["email", "id"],
        unique: true,
      },
    ]);
    expect(working(ops)).toHaveLength(3);
    expect(email(ops).was?.name).toBe("idx_users_email");
  });

  it("clears the ops when edited back to the server's definition, name included", () => {
    let ops = stageIndexEdit([], email(), "ix_renamed", ["email", "id"], true);
    ops = stageIndexEdit(ops, email(ops), "idx_users_email", ["email"], false);
    expect(ops).toEqual([]);
    expect(email().isEdited).toBe(false);
  });

  it("treats column ORDER as part of the definition", () => {
    const base = stageIndexEdit([], email(), "idx_users_email", ["a", "b"], false);
    const reordered = stageIndexEdit(base, email(base), "idx_users_email", ["b", "a"], false);
    expect(reordered).toHaveLength(1);
    expect(email(reordered).columns).toEqual(["b", "a"]);
  });

  it("rewrites a not-yet-applied index's own add op, with no drop", () => {
    const added: EditorOp[] = [
      { op: "addIndex", name: "idx_users_age", columns: ["age"], unique: false },
    ];
    const ops = stageIndexEdit(
      added,
      byName(added, "idx_users_age"),
      "ix_age",
      ["age", "city"],
      true,
    );
    expect(ops).toEqual([
      { op: "addIndex", name: "ix_age", columns: ["age", "city"], unique: true },
    ]);
    const card = byName(ops, "ix_age");
    expect(card.isNew).toBe(true);
    expect(card.isEdited).toBe(false);
    expect(card.was).toBeUndefined();
  });
});

describe("stageIndexDrop / stageIndexRestore", () => {
  it("drops an edited index under its SERVER name, discarding the edit", () => {
    const edited = stageIndexEdit([], email(), "ix_renamed", ["a"], false);
    const ops = stageIndexDrop(edited, email(edited));
    expect(ops).toEqual([{ op: "dropIndex", name: "idx_users_email" }]);
    const card = byName(ops, "idx_users_email");
    expect(card.markedForDrop).toBe(true);
    expect(card.isEdited).toBe(false);
    expect(card.columns).toEqual(["email"]); // back to the server's definition
  });

  it("forgets a not-yet-applied index rather than staging a drop for it", () => {
    const added: EditorOp[] = [
      { op: "addIndex", name: "idx_users_age", columns: ["age"], unique: false },
    ];
    expect(stageIndexDrop(added, byName(added, "idx_users_age"))).toEqual([]);
  });

  it("refuses to drop the primary-key index", () => {
    expect(stageIndexDrop([], byName([], "sqlite_autoindex_users_1"))).toEqual([]);
  });

  it("restores a dropped index and reverts an edited one", () => {
    const dropped = stageIndexDrop([], email());
    expect(stageIndexRestore(dropped, byName(dropped, "idx_users_email"))).toEqual([]);
    const edited = stageIndexEdit([], email(), "ix_renamed", ["a"], true);
    expect(stageIndexRestore(edited, email(edited))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Foreign keys
// ---------------------------------------------------------------------------

const FKS: ForeignKeyInfo[] = [
  {
    name: "users_org_id_fkey",
    columns: ["org_id"],
    refTable: "orgs",
    refColumns: ["id"],
    onDelete: "CASCADE",
    onUpdate: null,
  },
  // SQLite shape: no constraint name, so it is identified by its columns.
  {
    name: null,
    columns: ["team_id"],
    refTable: "teams",
    refColumns: ["id"],
    onDelete: null,
    onUpdate: null,
  },
];

const fks = (ops: EditorOp[]): WorkingForeignKey[] => applyOpsToForeignKeys(FKS, ops, "users");
const org = (ops: EditorOp[] = []): WorkingForeignKey =>
  fks(ops).find((f) => f.was?.name === "users_org_id_fkey" || f.name === "users_org_id_fkey")!;
/** The nameless SQLite FK, whatever synthetic name it is wearing. */
const team = (ops: EditorOp[] = []): WorkingForeignKey =>
  fks(ops).find((f) => (f.was ?? f).columns[0] === "team_id")!;

describe("stageForeignKeyEdit", () => {
  it("stages ONE replace op and shows ONE edited card", () => {
    const ops = stageForeignKeyEdit([], org(), {
      name: "users_org_fk",
      columns: ["org_id"],
      refTable: "orgs",
      refColumns: ["id"],
      onDelete: "SET NULL",
    });
    expect(ops).toEqual([
      {
        op: "replaceForeignKey",
        from: "users_org_id_fkey",
        fromColumns: ["org_id"],
        name: "users_org_fk",
        columns: ["org_id"],
        refTable: "orgs",
        refColumns: ["id"],
        onDelete: "SET NULL",
      },
    ]);
    expect(fks(ops)).toHaveLength(2); // no phantom third FK
    const card = org(ops);
    expect(card.name).toBe("users_org_fk");
    expect(card.onDelete).toBe("SET NULL");
    expect(card.isEdited).toBe(true);
    expect(card.was?.name).toBe("users_org_id_fkey");
    expect(card.was?.onDelete).toBe("CASCADE");
  });

  it("carries fromColumns, which is how SQLite identifies a nameless key", () => {
    const ops = stageForeignKeyEdit([], team(), {
      name: "users_team_fk",
      columns: ["team_id"],
      refTable: "teams",
      refColumns: ["uuid"],
      onDelete: null,
    });
    expect(ops[0]).toMatchObject({ op: "replaceForeignKey", fromColumns: ["team_id"] });
    expect(fks(ops)).toHaveLength(2);
    expect(team(ops).refColumns).toEqual(["uuid"]);
  });

  it("clears the ops when edited back to the server's definition", () => {
    let ops = stageForeignKeyEdit([], org(), {
      name: "renamed",
      columns: ["org_id"],
      refTable: "orgs",
      refColumns: ["id"],
      onDelete: "RESTRICT",
    });
    ops = stageForeignKeyEdit(ops, org(ops), {
      name: "users_org_id_fkey",
      columns: ["org_id"],
      refTable: "orgs",
      refColumns: ["id"],
      onDelete: "CASCADE",
    });
    expect(ops).toEqual([]);
  });

  it("drops an edited key under its server identity, discarding the edit", () => {
    const edited = stageForeignKeyEdit([], org(), {
      name: "renamed",
      columns: ["org_id"],
      refTable: "orgs",
      refColumns: ["id"],
      onDelete: null,
    });
    const ops = stageForeignKeyDrop(edited, org(edited));
    expect(ops).toEqual([{ op: "dropForeignKey", name: "users_org_id_fkey", columns: ["org_id"] }]);
    expect(org(ops).markedForDrop).toBe(true);
    expect(org(ops).isEdited).toBe(false);
  });

  it("restores an edited or dropped key", () => {
    const edited = stageForeignKeyEdit([], org(), {
      name: "renamed",
      columns: ["org_id"],
      refTable: "orgs",
      refColumns: ["id"],
      onDelete: null,
    });
    expect(stageForeignKeyRestore(edited, org(edited))).toEqual([]);
    const dropped = stageForeignKeyDrop([], org());
    expect(stageForeignKeyRestore(dropped, org(dropped))).toEqual([]);
  });
});

describe("toWireBatch", () => {
  it("expands a replaceIndex into drop-then-add, in separate phases", () => {
    const ops = stageIndexEdit([], email(), "ix_renamed", ["email", "id"], false);
    const wire = toWireBatch([...ops, { op: "dropColumn", name: "legacy" }]);
    expect(wire).toEqual([
      { op: "dropColumn", name: "legacy" },
      { op: "dropIndex", name: "idx_users_email" },
      { op: "addIndex", name: "ix_renamed", columns: ["email", "id"], unique: false },
    ]);
  });

  it("expands a replaceForeignKey the same way", () => {
    const ops = stageForeignKeyEdit([], org(), {
      name: "users_org_fk",
      columns: ["org_id"],
      refTable: "orgs",
      refColumns: ["id"],
      onDelete: null,
    });
    expect(toWireBatch(ops)).toEqual([
      { op: "dropForeignKey", name: "users_org_id_fkey", columns: ["org_id"] },
      {
        op: "addForeignKey",
        name: "users_org_fk",
        columns: ["org_id"],
        refTable: "orgs",
        refColumns: ["id"],
        onDelete: null,
      },
    ]);
  });

  it("never leaks an editor-only op to the wire", () => {
    const ops = [
      ...stageIndexEdit([], email(), "ix", ["email"], true),
      ...stageForeignKeyEdit([], org(), {
        name: "fk",
        columns: ["org_id"],
        refTable: "orgs",
        refColumns: ["id"],
        onDelete: null,
      }),
    ];
    const kinds = toWireBatch(ops).map((o) => o.op);
    expect(kinds).not.toContain("replaceIndex");
    expect(kinds).not.toContain("replaceForeignKey");
  });

  it("keeps index work after column renames, so it sees the final names", () => {
    const wire = toWireBatch([
      { op: "addIndex", name: "i", columns: ["b"], unique: false },
      { op: "renameColumn", from: "a", to: "b" },
    ]);
    expect(wire.map((o) => o.op)).toEqual(["renameColumn", "addIndex"]);
  });
});
