// Read-only is a property of ONE workspace, not of the connection behind it.
//
// Parent and schema sub-workspaces share a backend handle (that is the point of
// a sub-workspace — no second connection), so the obvious implementation makes
// the flag connection-wide and locks the parent the moment you lock a schema
// you only ever browse. These tests pin the behaviour that matters instead: a
// child starts from its parent's setting and is its own from then on.
//
// Pushing the mode onto the shared handle is `useHandleReadOnlySync`'s job (it
// keeps the handle on the ACTIVE workspace's mode) — the store itself never
// touches the backend, which is what makes it testable here.

import { beforeEach, describe, expect, it } from "vitest";

import { useWorkspacesStore } from "./state";
import type { Workspace } from "./types";

const PARENT = "ws-parent";
const CHILD = "ws-parent-public";
const SIBLING = "ws-parent-billing";
/** The one handle all three share, as a real parent/child set would. */
const HANDLE = "handle-1";

/** A parent plus two schema sub-workspaces, all read-only or all writable. */
function seed(readOnly: boolean) {
  const base = {
    handleId: HANDLE,
    readOnly,
    ui: {},
    color: "#2dd4a7",
    // `openSchemaWorkspace` reads the registry id to look up the child's
    // stored session; the lookup itself tolerates having no storage at all.
    saved: { id: "conn-1", name: "Prod", engine: "postgres" },
  };
  useWorkspacesStore.setState({
    activeWorkspaceId: PARENT,
    workspaces: [
      { ...base, id: PARENT } as unknown as Workspace,
      { ...base, id: CHILD, parentId: PARENT, schema: "public" } as unknown as Workspace,
      { ...base, id: SIBLING, parentId: PARENT, schema: "billing" } as unknown as Workspace,
    ],
  });
}

/** The read-only flag of each workspace, by id. */
function modes(): Record<string, boolean> {
  return Object.fromEntries(
    useWorkspacesStore.getState().workspaces.map((ws) => [ws.id, ws.readOnly]),
  );
}

describe("setWorkspaceReadOnly", () => {
  beforeEach(() => seed(false));

  it("locks only the sub-workspace it was called on", () => {
    useWorkspacesStore.getState().setWorkspaceReadOnly(CHILD, true);
    expect(modes()).toEqual({ [PARENT]: false, [CHILD]: true, [SIBLING]: false });
  });

  it("locks only the parent it was called on", () => {
    useWorkspacesStore.getState().setWorkspaceReadOnly(PARENT, true);
    expect(modes()).toEqual({ [PARENT]: true, [CHILD]: false, [SIBLING]: false });
  });

  it("unlocks one workspace without unlocking the others", () => {
    seed(true);
    useWorkspacesStore.getState().setWorkspaceReadOnly(CHILD, false);
    expect(modes()).toEqual({ [PARENT]: true, [CHILD]: false, [SIBLING]: true });
  });

  it("leaves the parent alone when a child is unlocked and re-locked", () => {
    useWorkspacesStore.getState().setWorkspaceReadOnly(CHILD, true);
    useWorkspacesStore.getState().setWorkspaceReadOnly(CHILD, false);
    expect(modes()).toEqual({ [PARENT]: false, [CHILD]: false, [SIBLING]: false });
  });

  it("ignores an id no workspace has", () => {
    useWorkspacesStore.getState().setWorkspaceReadOnly("ws-ghost", true);
    expect(modes()).toEqual({ [PARENT]: false, [CHILD]: false, [SIBLING]: false });
  });
});

describe("openSchemaWorkspace", () => {
  it("starts a new sub-workspace from its parent's read-only setting", () => {
    seed(true);
    // Only the parent exists for this one: the child is what we are creating.
    useWorkspacesStore.setState({
      workspaces: useWorkspacesStore.getState().workspaces.filter((ws) => ws.id === PARENT),
    });

    useWorkspacesStore.getState().openSchemaWorkspace(PARENT, "reporting");

    const child = useWorkspacesStore.getState().workspaces.find((ws) => ws.parentId === PARENT);
    expect(child?.readOnly).toBe(true);
    expect(child?.handleId).toBe(HANDLE);
  });

  it("starts writable when the parent is writable", () => {
    seed(false);
    useWorkspacesStore.setState({
      workspaces: useWorkspacesStore.getState().workspaces.filter((ws) => ws.id === PARENT),
    });

    useWorkspacesStore.getState().openSchemaWorkspace(PARENT, "reporting");

    expect(
      useWorkspacesStore.getState().workspaces.find((ws) => ws.parentId === PARENT)?.readOnly,
    ).toBe(false);
  });
});
