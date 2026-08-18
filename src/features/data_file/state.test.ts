// Staging rules for the data-file editor. The batch these actions build is
// what `serializeFile` writes, so "did this really change?" has to be decided
// here — a batch that claims an edit that is not one would rewrite a record for
// nothing, and the writer's fidelity guarantee leans on that not happening.

import { beforeEach, describe, expect, it } from "vitest";

import { isEmptyBatch } from "./csvWrite";
import { useDataFileStore } from "./state";

const WS = "ws-test";

function batch() {
  return useDataFileStore.getState().byWorkspace[WS]!.edits;
}

describe("staged cell edits", () => {
  beforeEach(() => useDataFileStore.getState().reset(WS));

  it("stages a changed cell", () => {
    useDataFileStore.getState().editCell(WS, 2, 1, "new", "old");
    expect(batch().cells).toEqual({ 2: { 1: "new" } });
    expect(isEmptyBatch(batch())).toBe(false);
  });

  it("clears the entry when a cell is typed back to its original", () => {
    const s = useDataFileStore.getState();
    s.editCell(WS, 2, 1, "new", "old");
    s.editCell(WS, 2, 1, "old", "old");
    // Not `{2: {}}` — an empty row entry would still read as a staged row.
    expect(batch().cells).toEqual({});
    expect(isEmptyBatch(batch())).toBe(true);
  });

  it("keeps other columns of the same row when one reverts", () => {
    const s = useDataFileStore.getState();
    s.editCell(WS, 2, 1, "a", "old");
    s.editCell(WS, 2, 3, "b", "old3");
    s.editCell(WS, 2, 1, "old", "old");
    expect(batch().cells).toEqual({ 2: { 3: "b" } });
  });

  it("stages an empty string as a real change", () => {
    // Clearing a cell is an edit; it must not be mistaken for "no edit".
    useDataFileStore.getState().editCell(WS, 0, 0, "", "value");
    expect(batch().cells).toEqual({ 0: { 0: "" } });
  });
});

describe("staged rows", () => {
  beforeEach(() => useDataFileStore.getState().reset(WS));

  it("adds rows with stable, non-repeating keys", () => {
    const s = useDataFileStore.getState();
    s.addRow(WS);
    s.addRow(WS);
    expect(batch().added.map((r) => r.key)).toEqual([1, 2]);
  });

  it("routes an edit on a staged row onto the row itself", () => {
    const s = useDataFileStore.getState();
    s.addRow(WS);
    s.editCell(WS, -1, 2, "typed", "");
    expect(batch().added).toEqual([{ key: 1, cells: { 2: "typed" } }]);
    // Nothing landed in the existing-row map.
    expect(batch().cells).toEqual({});
  });

  it("drops a staged row outright rather than marking it deleted", () => {
    const s = useDataFileStore.getState();
    s.addRow(WS);
    s.addRow(WS);
    s.toggleDeleted(WS, [-1]);
    expect(batch().added.map((r) => r.key)).toEqual([2]);
    expect(batch().deleted).toEqual([]);
  });
});

describe("staged deletions", () => {
  beforeEach(() => useDataFileStore.getState().reset(WS));

  it("toggles rows on and off", () => {
    const s = useDataFileStore.getState();
    s.toggleDeleted(WS, [3, 5]);
    expect(batch().deleted.sort()).toEqual([3, 5]);
    s.toggleDeleted(WS, [3]);
    expect(batch().deleted).toEqual([5]);
  });
});

describe("discard and commit", () => {
  beforeEach(() => useDataFileStore.getState().reset(WS));

  it("both clear the batch", () => {
    const s = useDataFileStore.getState();
    s.editCell(WS, 1, 1, "x", "y");
    s.addRow(WS);
    s.toggleDeleted(WS, [4]);
    expect(isEmptyBatch(batch())).toBe(false);

    s.discardEdits(WS);
    expect(isEmptyBatch(batch())).toBe(true);

    s.editCell(WS, 1, 1, "x", "y");
    s.commitEdits(WS);
    expect(isEmptyBatch(batch())).toBe(true);
  });

  it("keeps handing out fresh row keys after a discard", () => {
    const s = useDataFileStore.getState();
    s.addRow(WS);
    s.discardEdits(WS);
    s.addRow(WS);
    // Key 1 is gone; reusing it would collide with a React key still in flight.
    expect(batch().added.map((r) => r.key)).toEqual([2]);
  });
});
