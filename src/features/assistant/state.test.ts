import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null), Channel: class {} }));

import { useAssistantStore } from "./state";

const st = () => useAssistantStore.getState();

describe("chat sessions", () => {
  it("are per workspace, started on demand, and stay in history", () => {
    expect(st().sessions["w1"]).toBeUndefined();
    const s1 = st().ensureSession("w1");
    expect(st().ensureSession("w1")).toBe(s1);

    // An empty chat is not stacked: New chat reuses it.
    st().newSession("w1");
    expect(st().sessions["w1"]!.ids).toEqual([s1]);

    st().patch(s1, {
      msgs: [{ id: "u", role: "user", kind: "ask", text: "find all user", prompt: {} as never }],
    });
    st().newSession("w1");
    const s2 = st().sessions["w1"]!.active!;
    expect(s2).not.toBe(s1);
    expect(st().sessions["w1"]!.ids).toEqual([s2, s1]);

    // Back to session 1 from history; another workspace is untouched.
    st().switchSession("w1", s1);
    expect(st().sessions["w1"]!.active).toBe(s1);
    expect(st().sessions["w2"]).toBeUndefined();
  });

  it("deleting the open chat falls back to the newest one left", () => {
    const a = st().ensureSession("w3");
    st().patch(a, {
      msgs: [{ id: "u", role: "user", kind: "ask", text: "x", prompt: {} as never }],
    });
    st().newSession("w3");
    const b = st().sessions["w3"]!.active!;
    st().switchSession("w3", a);
    st().deleteSession("w3", a);
    expect(st().sessions["w3"]).toEqual({ ids: [b], active: b });
    expect(st().threads[a]).toBeUndefined();
    st().deleteSession("w3", b);
    expect(st().sessions["w3"]).toEqual({ ids: [], active: null });
  });
});
