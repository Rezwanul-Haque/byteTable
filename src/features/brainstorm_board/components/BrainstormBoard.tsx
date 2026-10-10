// The brainstorm board tab (M37): the tool rail, the canvas, the layer switch,
// the zoom bar, the live-schema diff bar and the inspector.
//
// This component owns the interaction state the canvas reads (tool, focused
// layer, selection, view) and every action that spans more than one of them —
// creating objects, connecting two things, promoting a sketch, grouping,
// exporting, fitting. The document and its undo stack live in `useBoardDoc`; the
// pointer handling lives in `BoardCanvas`.
//
// Keyboard shortcuts are registered only while this tab is the ACTIVE one
// (`isActive`), and never fire while a field has focus or a modal is open — the
// single-letter tool keys would otherwise eat typing anywhere else in the app.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { boardDdl, diffBoard, diffInfoOf, EMPTY_DIFF, EMPTY_DIFF_INFO } from "../diff";
import {
  addObject,
  groupObjects,
  groupsTouching,
  layerCounts,
  patchGroupIn,
  patchObject,
  removeEdge,
  removeObjects,
  ungroup,
} from "../doc";
import { exportBoardImage, type ExportTarget, type ImageFormat } from "../exportImage";
import { boxOf, clampZoom, unionBox } from "../geometry";
import { freeTableName, promoteSketch } from "../infer";
import {
  boardTables,
  cloneColumns,
  isEditable,
  objectLabel,
  uid,
  FLOW_KINDS,
  INK_COLORS,
  LAYERS,
  LAYER_BY_ID,
  ZOOM_MAX,
  ZOOM_MIN,
  type BoardObject,
  type BoardSelection,
  type BoardSizes,
  type BoardView,
  type LayerFocus,
  type LiveSchema,
  type LiveSourceId,
} from "../model";
import { singular } from "../naming";
import { loadBoard } from "../persist";
import { emptyBoard, SAMPLE_LIVE, seedBoard } from "../seed";
import { TOOL_GROUPS, TOOL_KEYS, TOOL_LAYER, type ToolId } from "../tools";
import { defaultBoardViewState, readBoardViewState, writeBoardViewState } from "../viewState";
import { useBoardDoc } from "../hooks/useBoardDoc";
import { useBoardLive } from "../hooks/useBoardLive";
import { BoardCanvas, type EraseTarget } from "./BoardCanvas";
import { BoardDdlSheet } from "./BoardDdlSheet";
import { BoardInspector } from "./BoardInspector";
import "./Board.css";

/** Breathing room left around the content when fitting. */
const FIT_PAD = 60;
/** Fit never zooms IN past this — a two-object board filling the screen at 300%
 *  is disorienting. */
const FIT_ZOOM_MAX = 1.4;

export interface BrainstormBoardProps {
  /** The tab this board is mounted in — the key its view state is remembered
   *  under, so a tab switch does not reset where the user was looking. */
  tabId: string;
  /** The schema this board belongs to — half of its storage identity. */
  schemaName: string;
  /** The durable connection id (`workspace.saved.id`) — the other half. */
  connectionId: string;
  /** Display name of the connection, for the diff bar's label. */
  connectionName: string;
  /** Live backend handle, for introspecting the "This workspace" source. */
  handleId: string;
  /** True while this tab is the visible one — gates every shortcut. */
  isActive: boolean;
  /** Report the board's name so the tab strip can show it. */
  onNameChange?: (name: string) => void;
  /** Hand generated DDL to a new SQL tab. */
  onOpenInSql: (sql: string) => void;
}

export function BrainstormBoard(props: BrainstormBoardProps) {
  const {
    tabId,
    schemaName,
    connectionId,
    connectionName,
    handleId,
    isActive,
    onNameChange,
    onOpenInSql,
  } = props;
  const toast = useToast();

  // Seeded from what this tab was last left at (the workspace unmounts an
  // inactive tab), else the board's defaults.
  const [initial] = useState(() => readBoardViewState(tabId) ?? defaultBoardViewState());
  const [view, setView] = useState<BoardView>(initial.view);
  const [tool, setToolRaw] = useState<ToolId>(initial.tool);
  const [activeLayer, setActiveLayer] = useState<LayerFocus>(initial.activeLayer);
  const [selection, setSelection] = useState<BoardSelection>(initial.selection);
  // Which object is being edited in place, and whether that edit opened on a
  // freshly created object — whose stand-in text ("Zone", "Thing", "Source") the
  // first keystroke should replace. Re-opening something already written puts
  // the caret after it instead.
  const [editingId, setEditingIdRaw] = useState<string | null>(null);
  const [editingSelectAll, setEditingSelectAll] = useState(false);
  const setEditingId = useCallback((id: string | null, selectAll = false) => {
    setEditingIdRaw(id);
    setEditingSelectAll(selectAll);
  }, []);
  // Re-measured on mount, so not worth remembering.
  const [sizes, setSizes] = useState<BoardSizes>({});
  const [ddlOpen, setDdlOpen] = useState(false);
  const [inkColor, setInkColor] = useState<string>(INK_COLORS[0]);
  const [flowKind, setFlowKind] = useState<ToolId>("source");
  const [flowFlyout, setFlowFlyout] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [exporting, setExporting] = useState<Set<string> | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(initial.inspectorOpen);
  const spaceRef = useRef(false);

  // Write through on change rather than on unmount: an unmount cleanup would
  // have to chase the latest value through refs for no gain, and nothing
  // subscribes to this store.
  useEffect(() => {
    writeBoardViewState(tabId, { view, selection, activeLayer, tool, inspectorOpen });
  }, [tabId, view, selection, activeLayer, tool, inspectorOpen]);

  // Read once, so the comparison source can be seeded from the stored board in
  // the same render the document is — adopting it in an effect afterwards would
  // diff against the wrong schema for a frame.
  const [storedDoc] = useState(() => loadBoard(connectionId, schemaName));
  // `liveSource` is the one piece of board state that is NOT in the document's
  // history — flipping the comparison is a view choice, not an edit. It is still
  // persisted with the document (see useBoardDoc).
  const [liveSource, setLiveSource] = useState<LiveSourceId>(storedDoc.liveSource ?? "workspace");
  const { doc, docRef, apply, snapshot, undo, redo, canUndo, canRedo, replace } = useBoardDoc(
    storedDoc,
    connectionId,
    schemaName,
    liveSource,
  );

  const workspaceLive = useBoardLive(handleId, schemaName, liveSource === "workspace");
  const live = useMemo<LiveSchema>(
    () =>
      liveSource === "sample" ? SAMPLE_LIVE : liveSource === "workspace" ? workspaceLive.live : {},
    [liveSource, workspaceLive.live],
  );
  const liveLabel =
    liveSource === "sample"
      ? "food_platform · public (sample)"
      : liveSource === "workspace"
        ? connectionName + " · " + schemaName
        : "nothing";

  // Report the board's name for the tab strip, keyed on the NAME only: the
  // callback comes in as an inline closure, so depending on its identity would
  // fire this on every render of the workspace.
  const onNameChangeRef = useRef(onNameChange);
  useEffect(() => {
    onNameChangeRef.current = onNameChange;
  });
  useEffect(() => {
    onNameChangeRef.current?.(doc.name);
  }, [doc.name]);

  // --- diff ------------------------------------------------------------
  const diff = useMemo(
    () => (liveSource === "none" ? EMPTY_DIFF : diffBoard(doc, live)),
    [doc, live, liveSource],
  );
  const diffInfo = useMemo(
    () => (liveSource === "none" ? EMPTY_DIFF_INFO : diffInfoOf(diff)),
    [diff, liveSource],
  );
  // Memoised: panning re-renders this component on every frame (the view is
  // state), and rebuilding the whole script each time would be wasted string
  // work 60 times a second.
  const sql = useMemo(() => (liveSource === "none" ? "" : boardDdl(diff)), [diff, liveSource]);

  // --- tools -----------------------------------------------------------
  // Picking a layer-bound tool while a layer is isolated switches to that
  // tool's layer: creating a flow node you then cannot see is never intended.
  const setTool = useCallback((next: ToolId) => {
    setToolRaw(next);
    const layer = TOOL_LAYER[next];
    if (layer) setActiveLayer((current) => (current === "all" ? current : layer));
  }, []);

  const addAndSelect = useCallback(
    (object: BoardObject) => {
      apply((d) => addObject(d, object));
      setSelection({ ids: [object.id], edge: null });
    },
    [apply],
  );

  const onCreate = useCallback(
    (which: ToolId, point: { x: number; y: number }) => {
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      let object: BoardObject | null = null;
      if (which === "sticky") {
        // Placed centred on the click, like every other note-taking canvas.
        object = {
          id: uid("st"),
          type: "sticky",
          layer: "domain",
          x: x - 75,
          y: y - 40,
          color: "y",
          tag: "note",
          text: "",
        };
      } else if (which === "text") {
        object = {
          id: uid("tx"),
          type: "text",
          layer: "domain",
          x,
          y: y - 12,
          text: "",
          size: "h1",
        };
      } else if (which === "frame") {
        object = {
          id: uid("fr"),
          type: "frame",
          layer: "domain",
          x,
          y,
          w: 360,
          h: 240,
          label: "Zone",
        };
      } else if (which === "sketch") {
        object = {
          id: uid("sk"),
          type: "sketch",
          layer: "domain",
          x,
          y,
          w: 190,
          title: "Thing",
          lines: [],
        };
      } else if (which === "snippet") {
        object = {
          id: uid("sn"),
          type: "snippet",
          layer: "domain",
          x,
          y,
          title: "sample data",
          body: '{ "id": 1 }',
        };
      } else if (which === "table") {
        object = {
          id: uid("tb"),
          type: "table",
          layer: "schema",
          origin: "draft",
          x,
          y,
          name: "new_table",
          columns: [{ name: "id", type: "bigint", pk: true, fk: null, nullable: false }],
        };
      } else if (which in FLOW_KINDS) {
        const kind = which as keyof typeof FLOW_KINDS;
        object = {
          id: uid("fl"),
          type: "flow",
          layer: "flow",
          kind,
          x: x - 75,
          y: y - 30,
          name: FLOW_KINDS[kind].label,
          detail: "",
        };
      }
      if (!object) return;
      addAndSelect(object);
      // Back to Select: placing one object is the common case, and a sticky
      // tool that keeps placing is how canvases get littered.
      setToolRaw("select");
      if (activeLayer !== "all" && activeLayer !== object.layer) setActiveLayer(object.layer);
      if (isEditable(object)) setEditingId(object.id, true);
    },
    [activeLayer, addAndSelect, setEditingId],
  );

  /**
   * Connecting two TABLES adds a real FK column rather than a loose line —
   * "menus references restaurants" is a schema fact, and drawing it as an
   * annotation would leave the generated DDL wrong. Everything else gets a
   * labelled edge, selected so the label can be typed straight away.
   */
  const onLink = useCallback(
    (from: string, to: string) => {
      const current = docRef.current;
      const a = current.objects[from];
      const b = current.objects[to];
      if (!a || !b) return;
      if (a.type === "table" && b.type === "table") {
        const column = singular(b.name) + "_id";
        if (a.columns.some((c) => c.name === column)) {
          toast(a.name + " already references " + b.name, "info");
          return;
        }
        apply((d) =>
          patchObject(d, a.id, {
            columns: [
              ...a.columns,
              { name: column, type: "bigint", pk: false, fk: b.name, nullable: false },
            ],
          }),
        );
        toast("Added " + a.name + "." + column + " → " + b.name, "ok");
        return;
      }
      if (current.edges.some((e) => e.from === from && e.to === to)) return;
      const id = uid("e");
      apply((d) => ({ ...d, edges: [...d.edges, { id, from, to, label: "" }] }));
      setSelection({ ids: [], edge: id });
      setToolRaw("select");
    },
    [apply, docRef, toast],
  );

  const onPromote = useCallback(
    (sketchId: string) => {
      const current = docRef.current;
      const sketch = current.objects[sketchId];
      if (!sketch || sketch.type !== "sketch") return;
      const boardNames = boardTables(current).map((t) => t.name);
      const preview = promoteSketch(sketch, [...boardNames, ...Object.keys(live)]);
      const name = freeTableName(preview.name, boardNames, live);
      const width = sizes[sketchId]?.w ?? sketch.w;
      const id = uid("tb");
      // Linked BOTH ways: the sketch gets a chip to jump to its table, the table
      // remembers where it came from. The sketch stays as the record of the
      // thinking — editing it later does not re-promote.
      apply((d) => ({
        ...d,
        objects: {
          ...d.objects,
          [id]: {
            id,
            type: "table",
            layer: "schema",
            origin: "draft",
            from: sketchId,
            x: sketch.x + width + 60,
            y: sketch.y,
            name,
            columns: preview.columns,
          },
          [sketchId]: { ...sketch, promotedTo: id },
        },
        order: [...d.order, id],
      }));
      if (activeLayer !== "all") setActiveLayer("schema");
      setSelection({ ids: [id], edge: null });
      toast(
        `Promoted “${sketch.title}” to draft table ${name} (${preview.columns.length} columns). ` +
          "Check the types in the inspector",
        "ok",
      );
    },
    [activeLayer, apply, docRef, live, sizes, toast],
  );

  /**
   * The eraser's one action. Deliberately immediate and un-confirmed: it is a
   * tool you pick up on purpose, every removal is one ⌘Z away, and a dialog per
   * click would make erasing three things unbearable. The toast names what went
   * and how to get it back.
   */
  const onErase = useCallback(
    (target: EraseTarget) => {
      const current = docRef.current;
      if (target.kind === "edge") {
        if (!current.edges.some((e) => e.id === target.id)) return;
        apply((d) => removeEdge(d, target.id));
        setSelection((s) => (s.edge === target.id ? { ids: s.ids, edge: null } : s));
        toast("Edge removed · ⌘Z to undo", "ok");
        return;
      }
      const ids =
        target.kind === "group"
          ? (current.groups.find((g) => g.id === target.id)?.ids ?? []).filter(
              (id) => current.objects[id],
            )
          : current.objects[target.id]
            ? [target.id]
            : [];
      if (ids.length === 0) return;
      const removed = new Set(ids);
      apply((d) => removeObjects(d, ids));
      setSelection((s) => ({
        ids: s.ids.filter((id) => !removed.has(id)),
        edge: s.edge,
      }));
      // Raw setter: closing an editor whose object is gone says nothing about
      // how the NEXT edit should open.
      setEditingIdRaw((id) => (id && removed.has(id) ? null : id));
      if (target.kind === "group") {
        const name = current.groups.find((g) => g.id === target.id)?.name ?? "Group";
        toast(`Removed “${name}” and its ${ids.length} objects · ⌘Z to undo`, "ok");
      } else {
        toast(`${objectLabel(current.objects[ids[0]!]!)} removed · ⌘Z to undo`, "ok");
      }
    },
    [apply, docRef, toast],
  );

  const onJump = useCallback(
    (id: string) => {
      const object = docRef.current.objects[id];
      if (!object) return;
      if (activeLayer !== "all") setActiveLayer(object.layer);
      setSelection({ ids: [id], edge: null });
    },
    [activeLayer, docRef],
  );

  /** Add a live table as a reference card at the centre of the current view. */
  const onAddLive = useCallback(
    (name: string) => {
      const viewport = document.querySelector(".bb-viewport");
      const rect = viewport?.getBoundingClientRect() ?? { width: 800, height: 500 };
      const centre = {
        x: (rect.width / 2 - view.x) / view.k,
        y: (rect.height / 2 - view.y) / view.k,
      };
      addAndSelect({
        id: uid("tb"),
        type: "table",
        layer: "schema",
        origin: "live",
        x: Math.round(centre.x - 100),
        y: Math.round(centre.y - 80),
        name,
        columns: cloneColumns(live[name] ?? []),
      });
      if (activeLayer !== "all") setActiveLayer("schema");
    },
    [activeLayer, addAndSelect, live, view],
  );

  // --- view ------------------------------------------------------------
  /** Fit `onlyIds` (or the focused layer) into the viewport. */
  const fit = useCallback(
    (onlyIds?: string[]) => {
      const viewport = document.querySelector(".bb-viewport");
      if (!viewport) return;
      const current = docRef.current;
      const boxes = Object.values(current.objects)
        .filter((o) =>
          onlyIds ? onlyIds.includes(o.id) : activeLayer === "all" || o.layer === activeLayer,
        )
        .map((o) => boxOf(o, sizes))
        .filter((b) => b !== null);
      const box = unionBox(boxes);
      if (!box) return;
      const rect = viewport.getBoundingClientRect();
      const w = box.x2 - box.x1;
      const h = box.y2 - box.y1;
      const k = Math.max(
        ZOOM_MIN,
        Math.min(
          FIT_ZOOM_MAX,
          Math.min((rect.width - FIT_PAD * 2) / w, (rect.height - FIT_PAD * 2) / h),
        ),
      );
      setView({
        k,
        x: (rect.width - w * k) / 2 - box.x1 * k,
        y: (rect.height - h * k) / 2 - box.y1 * k,
      });
    },
    [activeLayer, docRef, sizes],
  );

  const zoomBy = useCallback((factor: number) => {
    const viewport = document.querySelector(".bb-viewport");
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    setView((v) => {
      const k = clampZoom(v.k * factor, ZOOM_MIN, ZOOM_MAX);
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  }, []);

  // Fit once, after the first measurement pass — before it, every content-sized
  // object still reports its fallback box and the fit would be wrong.
  const fitted = useRef(initial.fitted);
  const isEmpty = doc.order.length === 0;
  useEffect(() => {
    if (fitted.current) return;
    // An empty board has nothing to fit, and counts as fitted: otherwise the
    // very first object the user places would trigger the one-time fit and yank
    // the view to centre a single sticky note.
    if (isEmpty) {
      fitted.current = true;
      writeBoardViewState(tabId, { fitted: true });
      return;
    }
    if (Object.keys(sizes).length === 0) return;
    fitted.current = true;
    writeBoardViewState(tabId, { fitted: true });
    fit();
  }, [sizes, fit, tabId, isEmpty]);
  // Opening or closing the inspector changes the viewport width, so re-fit —
  // but only on an actual TOGGLE. Firing on mount too would throw away the view
  // a returning tab just restored.
  const lastInspectorOpen = useRef(inspectorOpen);
  useEffect(() => {
    if (lastInspectorOpen.current === inspectorOpen) return;
    lastInspectorOpen.current = inspectorOpen;
    if (!fitted.current) return;
    const timer = setTimeout(() => fit(), 30);
    return () => clearTimeout(timer);
    // `fit` changes identity with every measurement; depending on it here would
    // re-fit on content changes, which is not what toggling the panel means.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectorOpen]);

  // --- groups ----------------------------------------------------------
  const groupSelection = useCallback(
    (ids?: string[]) => {
      const target = (ids ?? selection.ids).filter((id) => docRef.current.objects[id]);
      if (target.length < 2) {
        toast("Select two or more objects to group them", "info");
        return;
      }
      apply((d) => groupObjects(d, target));
      setSelection({ ids: target, edge: null });
      toast("Grouped " + target.length + " objects. Rename it in the inspector", "ok");
    },
    [apply, docRef, selection.ids, toast],
  );

  const ungroupSelection = useCallback(() => {
    const touched = groupsTouching(docRef.current, selection.ids);
    if (touched.length === 0) return;
    apply((d) => touched.reduce((acc, g) => ungroup(acc, g.id), d));
    toast("Ungrouped " + touched.map((g) => g.name).join(", "), "ok");
  }, [apply, docRef, selection.ids, toast]);

  const focusGroup = useCallback(
    (groupId: string) => {
      const group = docRef.current.groups.find((g) => g.id === groupId);
      if (!group) return;
      // Focus means "show me this whole thing", so the layer isolation is
      // dropped — a group may span layers.
      if (activeLayer !== "all") setActiveLayer("all");
      fit(group.ids);
    },
    [activeLayer, docRef, fit],
  );

  /**
   * ⌘A / Ctrl+A — select every object the user can actually act on.
   *
   * Scoped to the FOCUSED LAYER when one is isolated, for the same reason a
   * dimmed object cannot be clicked or dragged: "all" has to mean all of what is
   * in front of you, or the selection would silently include notes on a layer
   * you deliberately faded out. With no layer isolated it is the whole board.
   *
   * The handler must preventDefault: left to the browser, ⌘A runs the native
   * select-all and highlights the whole app chrome (rail, sidebar, inspector)
   * instead of selecting anything on the board.
   */
  const selectAll = useCallback(() => {
    const ids = Object.values(docRef.current.objects)
      .filter((o) => activeLayer === "all" || o.layer === activeLayer)
      .map((o) => o.id);
    if (ids.length === 0) return;
    setSelection({ ids, edge: null });
  }, [activeLayer, docRef]);

  // --- export ----------------------------------------------------------
  const exportImage = useCallback(
    async (target: ExportTarget, format: ImageFormat) => {
      setExportMenu(false);
      let ids: string[];
      let name: string;
      if (target.kind === "group") {
        const group = doc.groups.find((g) => g.id === target.id);
        if (!group) return;
        ids = group.ids;
        name = group.name;
      } else if (target.kind === "layer") {
        ids = Object.values(doc.objects)
          .filter((o) => o.layer === activeLayer)
          .map((o) => o.id);
        name = doc.name + " " + activeLayer;
      } else if (target.kind === "selection") {
        ids = selection.ids;
        name = doc.name + " selection";
      } else {
        ids = Object.keys(doc.objects);
        name = doc.name;
      }
      ids = ids.filter((id) => doc.objects[id]);
      if (ids.length === 0) {
        toast("Nothing to export", "info");
        return;
      }
      // Re-render the canvas scoped to the export BEFORE capturing, then give
      // the browser two frames: one for React to commit, one to lay out + paint.
      setExporting(new Set(ids));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        const world = document.querySelector<HTMLElement>(".bb-world");
        const viewport = document.querySelector(".bb-viewport");
        const bounds = unionBox(
          ids.map((id) => boxOf(doc.objects[id], sizes)).filter((b) => b !== null),
        );
        if (!world || !bounds) {
          toast("Nothing to export", "info");
          return;
        }
        const background = viewport ? getComputedStyle(viewport).backgroundColor : "var(--bg0)";
        const result = await exportBoardImage({
          world,
          background,
          bounds,
          format,
          name,
          count: ids.length,
        });
        if (result.status === "ok") {
          toast(
            `Exported “${name}” · ${result.count} objects · ${format.toUpperCase()} → ${result.file}`,
            "ok",
          );
        } else if (result.status === "failed") {
          toast("Export failed: " + result.message, "err");
        } else if (result.status === "no-dialog") {
          toast("Image export needs the desktop app", "info");
        }
      } finally {
        // Always restore the live view, whatever happened.
        setExporting(null);
      }
    },
    [activeLayer, doc, selection.ids, sizes, toast],
  );

  // --- keyboard --------------------------------------------------------
  useEffect(() => {
    if (!isActive) return;
    const typing = (target: EventTarget | null) =>
      target instanceof Element && target.closest("input,textarea,select,[contenteditable]");

    const onKeyDown = (e: KeyboardEvent) => {
      // Never while typing, and never under a modal (the DDL sheet owns Esc).
      if (typing(e.target) || document.querySelector(".modal-scrim")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === "Space") {
        spaceRef.current = true;
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        // preventDefault, or the native select-all highlights the whole app.
        e.preventDefault();
        selectAll();
        return;
      }
      // Everything below is unmodified — leave ⌘T, ⌘K and friends to the shell.
      if (mod) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selection.ids.length > 0) {
          e.preventDefault();
          const ids = selection.ids;
          apply((d) => removeObjects(d, ids));
          setSelection({ ids: [], edge: null });
        } else if (selection.edge) {
          e.preventDefault();
          const edgeId = selection.edge;
          apply((d) => removeEdge(d, edgeId));
          setSelection({ ids: [], edge: null });
        }
        return;
      }
      if (e.key === "Escape") {
        setSelection({ ids: [], edge: null });
        setToolRaw("select");
        return;
      }
      if (e.key === "Enter" && selection.ids.length === 1) {
        const soleId = selection.ids[0];
        const object = soleId ? doc.objects[soleId] : undefined;
        if (object && isEditable(object)) {
          e.preventDefault();
          setEditingId(object.id);
        }
        return;
      }
      const layer = LAYERS[Number(e.key) - 1];
      if (layer && (e.key === "1" || e.key === "2" || e.key === "3")) {
        setActiveLayer(layer.id);
        return;
      }
      if (e.key === "0") {
        setActiveLayer("all");
        return;
      }
      const next = TOOL_KEYS[e.key.toLowerCase()];
      // `G` means "the flow node I last used", not always Source.
      if (next === "source") setTool(flowKind);
      else if (next) setTool(next);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    isActive,
    selection,
    doc,
    flowKind,
    apply,
    undo,
    redo,
    groupSelection,
    ungroupSelection,
    selectAll,
    setTool,
    setEditingId,
  ]);

  // Close the flyout / export menu on any outside press.
  useEffect(() => {
    if (!flowFlyout) return;
    const close = () => setFlowFlyout(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [flowFlyout]);
  useEffect(() => {
    if (!exportMenu) return;
    const close = () => setExportMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [exportMenu]);

  const counts = layerCounts(doc);

  /** Fill the board with the worked example — explicit, never automatic. Goes
   *  through `replace`, so one ⌘Z puts the board back the way it was. */
  const onLoadSample = () => {
    replace(seedBoard());
    setSelection({ ids: [], edge: null });
    // The example is written against the sample schema — diffing its menu tables
    // against the user's real one would report five inventions they never made.
    setLiveSource("sample");
    // Re-measure and re-fit: the example arrives off-screen otherwise.
    fitted.current = false;
    writeBoardViewState(tabId, { fitted: false });
    setSizes({});
    toast("Loaded the menu-service example · ⌘Z to undo", "ok");
  };

  /** Back to a blank canvas. Also undoable. */
  const onClear = () => {
    replace(emptyBoard(schemaName));
    setSelection({ ids: [], edge: null });
    setLiveSource("workspace");
    toast("Board cleared · ⌘Z to undo", "ok");
  };

  const patchGroup = (
    groupId: string,
    patch: Parameters<typeof patchGroupIn>[2],
    withHistory = true,
  ) => apply((d) => patchGroupIn(d, groupId, patch), withHistory);

  return (
    <div
      className={"bb-root" + (tool === "hand" ? " hand" : "") + (tool === "eraser" ? " erase" : "")}
      data-screen-label="Brainstorm board"
    >
      <div className="bb-tools">
        {TOOL_GROUPS.map((group, index) => (
          <Fragment key={group.group}>
            {index > 0 ? (
              <div
                className="bb-tool-sep"
                style={group.layer ? { background: LAYER_BY_ID[group.layer].color } : undefined}
              />
            ) : null}
            {group.flyout ? (
              <FlowFlyout
                items={group.items}
                flowKind={flowKind}
                setFlowKind={setFlowKind}
                tool={tool}
                setTool={setTool}
                open={flowFlyout}
                setOpen={setFlowFlyout}
              />
            ) : (
              group.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={"bb-tool" + (tool === item.id ? " on" : "")}
                  title={item.label + (item.key ? " (" + item.key + ")" : "")}
                  aria-label={item.label}
                  aria-pressed={tool === item.id}
                  onClick={() => setTool(item.id)}
                >
                  <Icon name={item.icon} size={17} />
                </button>
              ))
            )}
          </Fragment>
        ))}
        {tool === "pen" ? (
          <div className="bb-inkpick">
            {INK_COLORS.map((color) => (
              <button
                type="button"
                key={color}
                className={inkColor === color ? "on" : undefined}
                style={{ background: color }}
                onClick={() => setInkColor(color)}
                title="Ink colour"
                aria-label={"Ink colour " + color}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="bb-stage">
        <BoardCanvas
          doc={doc}
          view={view}
          setView={setView}
          tool={tool}
          activeLayer={activeLayer}
          // An export draws no selection outlines.
          selection={exporting ? { ids: [], edge: null } : selection}
          setSelection={setSelection}
          exportIds={exporting}
          editingId={editingId}
          setEditingId={setEditingId}
          editingSelectAll={editingSelectAll}
          apply={apply}
          snapshot={snapshot}
          onCreate={onCreate}
          onLink={onLink}
          onErase={onErase}
          onPromote={onPromote}
          onJump={onJump}
          sizes={sizes}
          setSizes={setSizes}
          spaceRef={spaceRef}
          diffInfo={diffInfo}
          inkColor={inkColor}
        />

        {/* A blank infinite canvas says nothing about what it is for, so the
            empty board carries its own instructions — and the one place the
            worked example is offered without the user having to go looking.
            Click-through except for the button: clicking the card with a tool
            selected should place the object, not swallow the gesture. */}
        {isEmpty && !exporting ? (
          <div className="bb-blank">
            <div className="bb-blank-card">
              <Icon name="draw" size={24} />
              <h2>Nothing on the board yet</h2>
              <p>
                Pick a tool on the left and click the canvas — notes and sketches on <b>Domain</b>,
                data movement on <b>Flow</b>, draft tables on <b>Schema</b>. A sketch becomes a real
                table, and the board diffs against {schemaName}.
              </p>
              <button type="button" className="bb-btn pri" onClick={onLoadSample}>
                <Icon name="auto_awesome" size={14} />
                Load the example board
              </button>
              <span>A worked menu service across all three layers. ⌘Z undoes it.</span>
            </div>
          </div>
        ) : null}

        <div className="bb-layers">
          {LAYERS.map((layer, index) => (
            <button
              type="button"
              key={layer.id}
              className={"bb-layer" + (activeLayer === layer.id ? " on" : "")}
              onClick={() => setActiveLayer(layer.id)}
              title={`Focus the ${layer.label} layer (${index + 1})`}
            >
              <i style={{ background: layer.color }} />
              {layer.label}
              <em>{counts[layer.id] ?? 0}</em>
            </button>
          ))}
          <button
            type="button"
            className={"bb-layer" + (activeLayer === "all" ? " on" : "")}
            onClick={() => setActiveLayer("all")}
            title="Show every layer (0)"
          >
            <Icon name="layers" size={14} />
            All
          </button>
        </div>

        <div className="bb-zoom">
          <button type="button" onClick={undo} title="Undo (⌘Z)" disabled={!canUndo}>
            <Icon name="undo" size={16} />
          </button>
          <button type="button" onClick={redo} title="Redo (⇧⌘Z)" disabled={!canRedo}>
            <Icon name="redo" size={16} />
          </button>
          <span className="bb-zsep" />
          <button type="button" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
            <Icon name="remove" size={16} />
          </button>
          <span className="bb-zpct">{Math.round(view.k * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.2)} title="Zoom in">
            <Icon name="add" size={16} />
          </button>
          <button type="button" onClick={() => fit()} title="Fit to screen">
            <Icon name="fit_screen" size={16} />
          </button>
          <span className="bb-zsep" />
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setExportMenu((open) => !open)}
            title="Export image"
            className={exportMenu ? "on" : undefined}
            disabled={!!exporting}
          >
            <Icon name={exporting ? "hourglass_top" : "download"} size={16} />
          </button>
          <button
            type="button"
            onClick={() => setInspectorOpen((open) => !open)}
            title={inspectorOpen ? "Hide inspector" : "Show inspector"}
            className={inspectorOpen ? "on" : undefined}
          >
            <Icon name={inspectorOpen ? "right_panel_close" : "right_panel_open"} size={16} />
          </button>
        </div>

        {exportMenu ? (
          <div className="bb-export" onPointerDown={(e) => e.stopPropagation()}>
            <div className="bb-export-h">Export image</div>
            {[
              {
                target: { kind: "board" } as ExportTarget,
                label: "Whole board",
                icon: "dashboard",
                n: Object.keys(doc.objects).length,
              },
              ...(activeLayer !== "all"
                ? [
                    {
                      target: { kind: "layer" } as ExportTarget,
                      label: LAYER_BY_ID[activeLayer].label + " layer",
                      icon: "layers",
                      n: counts[activeLayer] ?? 0,
                    },
                  ]
                : []),
              ...(selection.ids.length > 0
                ? [
                    {
                      target: { kind: "selection" } as ExportTarget,
                      label: "Selection",
                      icon: "select_all",
                      n: selection.ids.length,
                    },
                  ]
                : []),
            ].map((row) => (
              <div className="bb-export-row" key={row.label}>
                <Icon name={row.icon} size={15} />
                <span className="bb-export-n">{row.label}</span>
                <em>{row.n}</em>
                <button type="button" onClick={() => void exportImage(row.target, "png")}>
                  PNG
                </button>
                <button type="button" onClick={() => void exportImage(row.target, "svg")}>
                  SVG
                </button>
              </div>
            ))}
            {doc.groups.length > 0 ? (
              <div className="bb-export-h" style={{ marginTop: 4 }}>
                Groups
              </div>
            ) : null}
            {doc.groups.map((group) => (
              <div className="bb-export-row" key={group.id}>
                <i className="bb-dot" style={{ background: group.color, margin: "0 3px" }} />
                <span className="bb-export-n">{group.name}</span>
                <em>{group.ids.length}</em>
                <button
                  type="button"
                  onClick={() => void exportImage({ kind: "group", id: group.id }, "png")}
                >
                  PNG
                </button>
                <button
                  type="button"
                  onClick={() => void exportImage({ kind: "group", id: group.id }, "svg")}
                >
                  SVG
                </button>
              </div>
            ))}
            <div className="bb-export-foot">
              PNG at 2× · every layer drawn at full strength · selection outlines left out
            </div>
          </div>
        ) : null}

        {liveSource !== "none" ? (
          <div className="bb-diffbar">
            <Icon name="difference" size={15} style={{ color: "var(--accent)" }} />
            <span className="bb-diff-l">
              vs <b>{liveLabel}</b>
            </span>
            <span>
              <i className="bb-dot" style={{ background: "var(--accent)" }} />
              <b>+{diff.creates.length}</b> new
            </span>
            <span>
              <i className="bb-dot" style={{ background: "var(--warn)" }} />
              <b>~{diff.alters.length}</b> changed
            </span>
            <button
              type="button"
              className="bb-btn pri"
              disabled={diff.count === 0}
              onClick={() => setDdlOpen(true)}
            >
              <Icon name="code" size={14} />
              Generate DDL
            </button>
          </div>
        ) : null}
      </div>

      {inspectorOpen ? (
        <BoardInspector
          doc={doc}
          selection={selection}
          apply={apply}
          setSelection={setSelection}
          live={live}
          liveLabel={liveLabel}
          liveSource={liveSource}
          setLiveSource={setLiveSource}
          liveLoading={liveSource === "workspace" && workspaceLive.loading}
          onAddLive={onAddLive}
          onPromote={onPromote}
          onJump={onJump}
          isEmpty={isEmpty}
          onLoadSample={onLoadSample}
          onClear={onClear}
          diffInfo={diffInfo}
          onGroup={groupSelection}
          onUngroup={(groupId) => {
            apply((d) => ungroup(d, groupId));
            toast("Ungrouped", "ok");
          }}
          patchGroup={patchGroup}
          onExport={(target, format) => void exportImage(target, format)}
          onFocusGroup={focusGroup}
        />
      ) : null}

      {ddlOpen ? (
        <BoardDdlSheet
          sql={sql}
          diff={diff}
          toast={toast}
          onOpenInSql={onOpenInSql}
          onClose={() => setDdlOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The four flow kinds behind one rail button, showing the last-used kind.
 *
 * Four separate buttons overflowed the 44px rail on a short window and a hidden
 * scrollbar made the last tool (Draft table) unreachable — this keeps the rail
 * inside its budget. Clicking selects the remembered kind; clicking again (while
 * a flow tool is already active) opens the picker.
 */
function FlowFlyout({
  items,
  flowKind,
  setFlowKind,
  tool,
  setTool,
  open,
  setOpen,
}: {
  items: { id: ToolId; icon: string; label: string }[];
  flowKind: ToolId;
  setFlowKind: (id: ToolId) => void;
  tool: ToolId;
  setTool: (id: ToolId) => void;
  open: boolean;
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
}) {
  const current = items.find((i) => i.id === flowKind) ?? items[0];
  if (!current) return null;
  const active = tool in FLOW_KINDS;
  const kindColor = (id: ToolId) => FLOW_KINDS[id as keyof typeof FLOW_KINDS].color;
  return (
    <div className="bb-flywrap" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={"bb-tool" + (active ? " on" : "")}
        title={"Flow node: " + current.label + " (G) · click again for other kinds"}
        aria-label={"Flow node: " + current.label}
        aria-expanded={open}
        style={{ color: active ? undefined : kindColor(current.id) }}
        onClick={() => {
          if (active) setOpen((v) => !v);
          else setTool(flowKind);
        }}
      >
        <Icon name={current.icon} size={17} />
        <i className="bb-fly-caret" />
      </button>
      {open ? (
        <div className="bb-fly">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              className={"bb-fly-item" + (flowKind === item.id ? " on" : "")}
              onClick={() => {
                setFlowKind(item.id);
                setTool(item.id);
                setOpen(false);
              }}
            >
              <Icon name={item.icon} size={15} style={{ color: kindColor(item.id) }} />
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
