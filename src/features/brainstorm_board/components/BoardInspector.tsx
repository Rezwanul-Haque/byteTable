// The board inspector (M37 Task 6): a 272px right panel whose content is
// decided entirely by what is selected.
//
// The variants are checked in SPECIFICITY order, and the order matters: an edge
// wins over objects (the two selections are mutually exclusive), an exact group
// wins over a multi-select (showing "Ungroup" for a selection that merely
// overlaps a group would lie about what the button acts on), and the
// nothing-selected board panel is the fallback.
//
// Every field edits the document through `apply`, so every change is undoable.
// The one exception is live typing in a group's name, which commits on blur —
// otherwise each keystroke would be its own undo step.

import type { ReactNode } from "react";

import { Icon } from "../../../shared/ui/Icon";
import type { StringKey } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { Kbd } from "../../../shared/ui/Kbd";
import type { BoardDiffInfo } from "../diff";
import { exactGroup, groupsTouching, patchObject, removeObjects } from "../doc";
import { promoteSketch } from "../infer";
import {
  boardTables,
  cloneColumns,
  FLOW_KINDS,
  FLOW_KIND_IDS,
  GROUP_COLORS,
  INK_COLORS,
  LAYERS,
  objectLabel,
  STICKY_COLORS,
  STICKY_TAGS,
  STICKY_TAG_KEYS,
  TYPES,
  type BoardColumn,
  type BoardDoc,
  type BoardGroup,
  type BoardObject,
  type BoardSelection,
  type LiveSchema,
  type LiveSourceId,
} from "../model";
import { snake } from "../naming";
import type { ExportTarget, ImageFormat } from "../exportImage";

export interface BoardInspectorProps {
  doc: BoardDoc;
  selection: BoardSelection;
  apply: (fn: (doc: BoardDoc) => BoardDoc, withHistory?: boolean) => void;
  setSelection: (selection: BoardSelection) => void;
  live: LiveSchema;
  /** Human name of the comparison source, for the "Compare against" hint. */
  liveLabel: string;
  liveSource: LiveSourceId;
  setLiveSource: (source: LiveSourceId) => void;
  /** True while the workspace's live schema is still being introspected. */
  liveLoading: boolean;
  onAddLive: (table: string) => void;
  onPromote: (sketchId: string) => void;
  onJump: (id: string) => void;
  /** True when the board has no objects — swaps the example action for a clear. */
  isEmpty: boolean;
  /** Fill the board with the worked example. */
  onLoadSample: () => void;
  /** Empty the board. */
  onClear: () => void;
  diffInfo: BoardDiffInfo;
  onGroup: (ids: string[]) => void;
  onUngroup: (groupId: string) => void;
  patchGroup: (groupId: string, patch: Partial<BoardGroup>, withHistory?: boolean) => void;
  onExport: (target: ExportTarget, format: ImageFormat) => void;
  onFocusGroup: (groupId: string) => void;
}

/** Section heading with an optional right-aligned count. */
function Section({ children }: { children: ReactNode }) {
  return <div className="bb-sec">{children}</div>;
}

function Head({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <>
      <div className="bb-insp-h">
        <Icon name={icon} size={16} />
        {title}
      </div>
      {sub ? <div className="bb-insp-sub">{sub}</div> : null}
    </>
  );
}

export function BoardInspector(props: BoardInspectorProps) {
  const t = useT();
  const {
    doc,
    selection,
    apply,
    setSelection,
    live,
    liveLabel,
    liveSource,
    setLiveSource,
    liveLoading,
    onAddLive,
    onPromote,
    onJump,
    isEmpty,
    onLoadSample,
    onClear,
    diffInfo,
    onGroup,
    onUngroup,
    patchGroup,
    onExport,
    onFocusGroup,
  } = props;

  const ids = selection.ids;
  const soleId = ids.length === 1 ? ids[0] : undefined;
  const object = soleId ? (doc.objects[soleId] ?? null) : null;
  const edge = selection.edge ? doc.edges.find((e) => e.id === selection.edge) : undefined;
  const tables = boardTables(doc);

  const patch = (p: Partial<BoardObject>) => {
    if (object) apply((d) => patchObject(d, object.id, p));
  };
  const deleteSelection = () => {
    apply((d) => removeObjects(d, ids));
    setSelection({ ids: [], edge: null });
  };
  const deleteButton = (
    <button type="button" className="bb-btn danger" onClick={deleteSelection}>
      <Icon name="delete" size={14} />
      {t("common.delete")}
    </button>
  );

  // --- an edge --------------------------------------------------------
  if (edge) {
    const a = doc.objects[edge.from];
    const b = doc.objects[edge.to];
    const isFlow = a?.type === "flow" && b?.type === "flow";
    const endName = (o: BoardObject | undefined) => (o ? objectLabel(o) : "?");
    return (
      <div className="bb-insp">
        <Head
          icon="trending_flat"
          title={isFlow ? t("board.edge.flow") : t("board.edge.connector")}
        />
        <div className="bb-insp-sub">{endName(a) + " → " + endName(b)}</div>
        <label className="bb-field">
          <span>{isFlow ? t("board.edge.volume") : t("board.edge.label")}</span>
          <input
            value={edge.label}
            placeholder={isFlow ? t("board.edge.volumePh") : t("board.edge.labelPh")}
            // Live typing without history: one undo step per label, not per key.
            onChange={(e) => {
              const label = e.target.value;
              apply(
                (d) => ({
                  ...d,
                  edges: d.edges.map((x) => (x.id === edge.id ? { ...x, label } : x)),
                }),
                false,
              );
            }}
          />
        </label>
        {isFlow ? <div className="bb-hint">{t("board.edge.volumeHint")}</div> : null}
        <div className="bb-insp-acts">
          <button
            type="button"
            className="bb-btn"
            onClick={() =>
              apply((d) => ({
                ...d,
                edges: d.edges.map((x) =>
                  x.id === edge.id ? { ...x, from: x.to, to: x.from } : x,
                ),
              }))
            }
          >
            <Icon name="swap_horiz" size={14} />
            {t("board.edge.reverse")}
          </button>
          <button
            type="button"
            className="bb-btn danger"
            onClick={() => {
              apply((d) => ({ ...d, edges: d.edges.filter((x) => x.id !== edge.id) }));
              setSelection({ ids: [], edge: null });
            }}
          >
            <Icon name="delete" size={14} />
            {t("common.delete")}
          </button>
        </div>
      </div>
    );
  }

  // --- exactly one group ----------------------------------------------
  const group = exactGroup(doc, selection);
  if (group) {
    const byLayer: Record<string, number> = {};
    for (const id of group.ids) {
      const member = doc.objects[id];
      if (member) byLayer[member.layer] = (byLayer[member.layer] ?? 0) + 1;
    }
    return (
      <div className="bb-insp">
        <div className="bb-insp-h">
          <Icon name="workspaces" size={16} style={{ color: group.color }} />
          {t("board.group.title")}
        </div>
        <div className="bb-insp-sub">{t("board.group.sub", { count: group.ids.length })}</div>
        <label className="bb-field">
          <span>{t("board.field.name")}</span>
          <input
            value={group.name}
            onChange={(e) => patchGroup(group.id, { name: e.target.value }, false)}
            onBlur={(e) =>
              patchGroup(group.id, { name: e.target.value.trim() || t("board.group.title") })
            }
          />
        </label>
        <Section>{t("board.sec.colour")}</Section>
        <div className="bb-swatches">
          {GROUP_COLORS.map((color) => (
            <button
              type="button"
              key={color}
              aria-label={"Colour " + color}
              className={"bb-sw" + (group.color === color ? " on" : "")}
              style={{ background: color }}
              onClick={() => patchGroup(group.id, { color })}
            />
          ))}
        </div>
        <Section>{t("board.sec.contains")}</Section>
        <div className="bb-preview">
          {LAYERS.filter((l) => byLayer[l.id]).map((l) => (
            <div key={l.id}>
              <span>
                <i className="bb-dot" style={{ background: l.color }} />
                {t(l.labelKey)}
              </span>
              <em>{byLayer[l.id]}</em>
            </div>
          ))}
        </div>
        <Section>{t("board.sec.export")}</Section>
        <div className="bb-insp-acts" style={{ marginTop: 0 }}>
          <button
            type="button"
            className="bb-btn pri"
            onClick={() => onExport({ kind: "group", id: group.id }, "png")}
          >
            <Icon name="image" size={14} />
            PNG
          </button>
          <button
            type="button"
            className="bb-btn"
            onClick={() => onExport({ kind: "group", id: group.id }, "svg")}
          >
            <Icon name="shape_line" size={14} />
            SVG
          </button>
          <button type="button" className="bb-btn" onClick={() => onFocusGroup(group.id)}>
            <Icon name="center_focus_strong" size={14} />
            {t("board.group.focus")}
          </button>
        </div>
        <div className="bb-insp-acts">
          <button type="button" className="bb-btn" onClick={() => onUngroup(group.id)}>
            <Icon name="ungroup" size={14} />
            {t("board.group.ungroup")}
          </button>
          <button type="button" className="bb-btn danger" onClick={deleteSelection}>
            <Icon name="delete" size={14} />
            {t("board.group.deleteAll")}
          </button>
        </div>
      </div>
    );
  }

  // --- several objects ------------------------------------------------
  if (ids.length > 1) {
    const touched = groupsTouching(doc, ids);
    return (
      <div className="bb-insp">
        <Head icon="select_all" title={t("board.multi.title", { count: ids.length })} />
        <div className="bb-hint">{t("board.multi.hint")}</div>
        <button type="button" className="bb-btn pri" onClick={() => onGroup(ids)}>
          <Icon name="workspaces" size={14} />
          {t("board.multi.group", { count: ids.length })}
          <kbd className="bb-kbd">⌘G</kbd>
        </button>
        {touched.length > 0 ? (
          <div className="bb-hint">
            {t("board.multi.willLose", {
              groups: touched.map((g) => g.name).join(", "),
              count: touched.length,
            })}
          </div>
        ) : null}
        <div className="bb-insp-acts">
          <button
            type="button"
            className="bb-btn"
            onClick={() => onExport({ kind: "selection" }, "png")}
          >
            <Icon name="image" size={14} />
            {t("board.multi.exportSelection")}
          </button>
          <button type="button" className="bb-btn danger" onClick={deleteSelection}>
            <Icon name="delete" size={14} />
            {t("board.multi.delete", { count: ids.length })}
          </button>
        </div>
      </div>
    );
  }

  // --- nothing selected: the board itself ------------------------------
  if (!object) {
    const onBoard = new Set(tables.map((t) => t.name));
    const liveNames = Object.entries(live).sort(([a], [b]) => a.localeCompare(b));
    return (
      <div className="bb-insp">
        <Head icon="draw" title={doc.name} sub={t("board.insp.boardSub")} />
        <Section>{t("board.sec.compare")}</Section>
        <div className="bb-seg">
          {(
            [
              ["sample", t("board.source.sample")],
              ["workspace", t("board.source.workspace")],
              ["none", t("board.source.none")],
            ] as [LiveSourceId, string][]
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={"bb-seg-btn" + (liveSource === value ? " active" : "")}
              onClick={() => setLiveSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="bb-hint">
          {liveSource === "none"
            ? t("board.insp.standalone")
            : t("board.insp.comparedWith", { source: liveLabel })}
        </div>
        {liveSource !== "none" ? (
          <>
            <Section>
              {t("board.sec.liveTables")}
              <em>{liveLoading ? "…" : liveNames.length}</em>
            </Section>
            {liveLoading ? (
              <div className="bb-hint">{t("board.insp.readingSchema")}</div>
            ) : liveNames.length === 0 ? (
              <div className="bb-hint">{t("board.insp.noTables", { source: liveLabel })}</div>
            ) : (
              <div className="bb-live">
                {liveNames.map(([table, columns]) => (
                  <div key={table} className="bb-live-row">
                    <Icon name="table_rows" size={14} />
                    <span className="bb-live-n">{table}</span>
                    <em>{t("board.insp.cols", { count: columns.length })}</em>
                    {onBoard.has(table) ? (
                      <span className="bb-live-on">{t("board.insp.onBoard")}</span>
                    ) : (
                      <button
                        type="button"
                        className="bb-mini"
                        onClick={() => onAddLive(table)}
                        title={t("board.insp.addLive")}
                      >
                        <Icon name="add" size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
        <Section>
          {t("board.sec.groups")}
          <em>{doc.groups.length}</em>
        </Section>
        {doc.groups.length > 0 ? (
          <div className="bb-live">
            {doc.groups.map((g) => (
              <div
                key={g.id}
                className="bb-live-row bb-grp-row"
                onClick={() =>
                  setSelection({ ids: g.ids.filter((id) => doc.objects[id]), edge: null })
                }
                title={t("board.insp.selectGroup")}
              >
                <i className="bb-dot" style={{ background: g.color, marginRight: 0 }} />
                <span className="bb-live-n" style={{ fontFamily: "var(--ui)" }}>
                  {g.name}
                </span>
                <em>{g.ids.length}</em>
                <button
                  type="button"
                  className="bb-mini"
                  title={t("board.group.focus")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onFocusGroup(g.id);
                  }}
                >
                  <Icon name="center_focus_strong" size={13} />
                </button>
                <button
                  type="button"
                  className="bb-mini"
                  title={t("board.export.png")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onExport({ kind: "group", id: g.id }, "png");
                  }}
                >
                  <Icon name="download" size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="bb-hint">
            {t("board.insp.groupsEmptyBefore")} <Kbd>⌘G</Kbd> {t("board.insp.groupsEmptyAfter")}
          </div>
        )}
        <Section>{t("board.sec.shortcuts")}</Section>
        <div className="bb-keys">
          <span>
            <kbd>V</kbd>select
          </span>
          <span>
            <kbd>P</kbd>pen
          </span>
          <span>
            <kbd>N</kbd>sticky
          </span>
          <span>
            <kbd>E</kbd>sketch
          </span>
          <span>
            <kbd>C</kbd>connect
          </span>
          <span>
            <kbd>G</kbd>flow node
          </span>
          <span>
            <kbd>D</kbd>table
          </span>
          <span>
            <kbd>1</kbd>–<kbd>3</kbd>layer
          </span>
          <span>
            <kbd>0</kbd>all
          </span>
          <span>
            <kbd>Space</kbd>pan
          </span>
          <span>
            <kbd>⌘Z</kbd>undo
          </span>
          <span>
            <kbd>X</kbd>erase
          </span>
          <span>
            <kbd>⌘A</kbd>select all
          </span>
          <span>
            <kbd>⌘G</kbd>group
          </span>
          <span>
            <kbd>⌫</kbd>delete
          </span>
          <span>
            <kbd>⌘ wheel</kbd>zoom
          </span>
        </div>
        <div className="bb-insp-acts">
          {/* The example is an action, never a default: a new board is blank, and
              this is how you ask for the demonstration. Both directions are one
              ⌘Z away, so neither needs a confirm. */}
          {isEmpty ? (
            <button type="button" className="bb-btn" onClick={onLoadSample}>
              <Icon name="auto_awesome" size={14} />
              Load the example board
            </button>
          ) : (
            <button type="button" className="bb-btn danger" onClick={onClear}>
              <Icon name="restart_alt" size={14} />
              Clear the board
            </button>
          )}
        </div>
      </div>
    );
  }

  // --- one object -----------------------------------------------------
  if (object.type === "sticky") {
    return (
      <div className="bb-insp">
        <Head icon="sticky_note_2" title={t("board.obj.sticky")} sub={t("board.insp.domainEdit")} />
        <Section>{t("board.sec.colour")}</Section>
        <div className="bb-swatches">
          {Object.entries(STICKY_COLORS).map(([key, color]) => (
            <button
              type="button"
              key={key}
              aria-label={"Colour " + key}
              className={"bb-sw" + (object.color === key ? " on" : "")}
              style={{ background: color }}
              onClick={() => patch({ color: key as keyof typeof STICKY_COLORS })}
            />
          ))}
        </div>
        <Section>{t("board.sec.kind")}</Section>
        <div className="bb-chips">
          {STICKY_TAGS.map((tag) => (
            <button
              type="button"
              key={tag}
              className={"bb-chip" + (object.tag === tag ? " on" : "")}
              onClick={() => patch({ tag })}
            >
              {t(STICKY_TAG_KEYS[tag])}
            </button>
          ))}
        </div>
        <div className="bb-insp-acts">{deleteButton}</div>
      </div>
    );
  }

  if (object.type === "sketch") {
    const promoted = object.promotedTo ? doc.objects[object.promotedTo] : undefined;
    // The preview is the SAME function promotion runs, so what is shown here
    // and what gets created can never drift apart.
    const preview = promoteSketch(object, tables.map((t) => t.name).concat(Object.keys(live)));
    return (
      <div className="bb-insp">
        <Head icon="crop_square" title={t("board.obj.sketch")} sub={t("board.insp.sketchSub")} />
        {promoted && promoted.type === "table" ? (
          <>
            <Section>{t("board.sec.promoted")}</Section>
            <button type="button" className="bb-linkrow" onClick={() => onJump(promoted.id)}>
              <Icon name="table_view" size={15} />
              {promoted.name}
              <Icon name="arrow_forward" size={15} style={{ marginLeft: "auto" }} />
            </button>
            <div className="bb-hint">{t("board.insp.promotedHint")}</div>
          </>
        ) : (
          <>
            <Section>
              {t("board.insp.willBecome")} <code>{preview.name}</code>
            </Section>
            <div className="bb-preview">
              {preview.columns.map((c) => (
                <div key={c.name}>
                  <span>{c.name}</span>
                  <em>
                    {c.type}
                    {c.fk ? " → " + c.fk : ""}
                    {c.pk ? " · pk" : ""}
                  </em>
                </div>
              ))}
            </div>
            <button type="button" className="bb-btn pri" onClick={() => onPromote(object.id)}>
              <Icon name="upgrade" size={14} />
              {t("board.insp.promote")}
            </button>
          </>
        )}
        <div className="bb-insp-acts">{deleteButton}</div>
      </div>
    );
  }

  if (object.type === "flow") {
    const kind = FLOW_KINDS[object.kind];
    const incoming = doc.edges.filter((e) => e.to === object.id);
    const outgoing = doc.edges.filter((e) => e.from === object.id);
    return (
      <div className="bb-insp">
        <Head icon={kind.icon} title={t("board.obj.flow")} sub={t("board.insp.flowLayer")} />
        <div className="bb-seg">
          {FLOW_KIND_IDS.map((id) => (
            <button
              type="button"
              key={id}
              className={"bb-seg-btn" + (object.kind === id ? " active" : "")}
              onClick={() => patch({ kind: id })}
            >
              {t(FLOW_KINDS[id].labelKey)}
            </button>
          ))}
        </div>
        <label className="bb-field">
          <span>{t("board.field.name")}</span>
          <input value={object.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="bb-field">
          <span>{t("board.field.detail")}</span>
          <input
            value={object.detail}
            placeholder={t("board.field.detailPh")}
            onChange={(e) => patch({ detail: e.target.value })}
          />
        </label>
        <Section>
          {t("board.sec.edges")}
          <em>{t("board.insp.inOut", { in: incoming.length, out: outgoing.length })}</em>
        </Section>
        <div className="bb-preview">
          {[...incoming, ...outgoing].map((e) => {
            const other = doc.objects[e.from === object.id ? e.to : e.from];
            const name = other && "name" in other ? other.name : other?.type;
            return (
              <div key={e.id}>
                <span>
                  {e.from === object.id ? "→ " : "← "}
                  {name ?? "?"}
                </span>
                <em>{e.label || "—"}</em>
              </div>
            );
          })}
          {incoming.length === 0 && outgoing.length === 0 ? (
            <div>
              <span className="bb-ph">{t("board.insp.noEdges")}</span>
            </div>
          ) : null}
        </div>
        <div className="bb-insp-acts">{deleteButton}</div>
      </div>
    );
  }

  if (object.type === "table") {
    const status = diffInfo.status[object.id];
    const setColumns = (columns: BoardColumn[]) => patch({ columns });
    const mapColumn = (index: number, change: Partial<BoardColumn>) =>
      setColumns(object.columns.map((c, i) => (i === index ? { ...c, ...change } : c)));
    // FK targets: every other board card plus every live table.
    const others = [...tables.map((t) => t.name), ...Object.keys(live)]
      .filter((name, i, all) => all.indexOf(name) === i && name !== object.name)
      .sort();
    const added = diffInfo.added[object.id] ?? new Set<string>();
    const typed = diffInfo.typed[object.id] ?? new Set<string>();
    return (
      <div className="bb-insp">
        <Head
          icon={object.origin === "live" ? "table_rows" : "edit_square"}
          title={
            object.origin === "live" ? t("board.table.liveTitle") : t("board.table.draftTitle")
          }
          sub={
            status === "create"
              ? t("board.table.subCreate")
              : status === "changed"
                ? t("board.table.subAlter")
                : object.origin === "live"
                  ? t("board.table.subSame")
                  : t("board.table.subDraft")
          }
        />
        <label className="bb-field">
          <span>{t("board.field.name")}</span>
          <input
            className="mono"
            value={object.name}
            // Snake the typed name, but never to nothing — mid-edit a name can
            // legitimately be "menu " and snaking that to "" would wipe it.
            onChange={(e) => patch({ name: snake(e.target.value) || e.target.value })}
          />
        </label>
        <Section>
          Columns<em>{object.columns.length}</em>
        </Section>
        <div className="bb-cols">
          {object.columns.map((column, i) => (
            <div
              key={i}
              className={
                "bb-col" +
                (added.has(column.name) ? " add" : "") +
                (typed.has(column.name) ? " mod" : "")
              }
            >
              <input
                className="mono"
                aria-label={t("board.col.name")}
                value={column.name}
                onChange={(e) => mapColumn(i, { name: e.target.value })}
              />
              <select
                aria-label={t("board.col.type")}
                value={column.type}
                onChange={(e) => mapColumn(i, { type: e.target.value })}
              >
                {(TYPES.includes(column.type as (typeof TYPES)[number])
                  ? [...TYPES]
                  : [column.type, ...TYPES]
                ).map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={"bb-tg" + (column.pk ? " on" : "")}
                title={t("board.col.pk")}
                onClick={() => mapColumn(i, { pk: !column.pk })}
              >
                <Icon name="key" size={12} />
              </button>
              <button
                type="button"
                className={"bb-tg" + (column.nullable ? " on" : "")}
                title={t("board.col.nullable")}
                onClick={() => mapColumn(i, { nullable: !column.nullable })}
              >
                ∅
              </button>
              <button
                type="button"
                className="bb-tg"
                title={t("board.col.remove")}
                onClick={() => setColumns(object.columns.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={12} />
              </button>
              <select
                className="bb-fk"
                aria-label={t("board.col.references")}
                value={column.fk ?? ""}
                onChange={(e) => mapColumn(i, { fk: e.target.value || null })}
              >
                <option value="">{t("board.col.noReference")}</option>
                {others.map((name) => (
                  <option key={name} value={name}>
                    → {name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="bb-btn"
          onClick={() =>
            setColumns([
              ...object.columns,
              { name: "new_column", type: "text", pk: false, fk: null, nullable: true },
            ])
          }
        >
          <Icon name="add" size={14} />
          {t("board.col.add")}
        </button>
        <div className="bb-insp-acts">
          {object.origin === "live" && live[object.name] ? (
            <button
              type="button"
              className="bb-btn"
              onClick={() => patch({ columns: cloneColumns(live[object.name] ?? []) })}
            >
              <Icon name="restart_alt" size={14} />
              {t("board.table.revert")}
            </button>
          ) : null}
          {deleteButton}
        </div>
      </div>
    );
  }

  // text / frame / snippet / ink
  const META: Record<string, [string, StringKey]> = {
    text: ["title", "board.obj.text"],
    frame: ["frame_source", "board.obj.frame"],
    snippet: ["data_object", "board.obj.snippet"],
    ink: ["ink_pen", "board.obj.ink"],
  };
  const [icon, titleKey] = META[object.type] ?? ["category", ""];
  const title = titleKey ? t(titleKey) : object.type;
  return (
    <div className="bb-insp">
      <Head
        icon={icon}
        title={title}
        sub={object.type === "ink" ? t("board.insp.domainLayer") : t("board.insp.domainEdit")}
      />
      {object.type === "text" ? (
        <div className="bb-seg">
          {(
            [
              ["h1", t("board.text.heading")],
              ["body", t("board.text.body")],
            ] as ["h1" | "body", string][]
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={"bb-seg-btn" + (object.size === value ? " active" : "")}
              onClick={() => patch({ size: value })}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {object.type === "snippet" ? (
        <label className="bb-field">
          <span>{t("board.field.title")}</span>
          <input value={object.title} onChange={(e) => patch({ title: e.target.value })} />
        </label>
      ) : null}
      {object.type === "ink" ? (
        <div className="bb-swatches">
          {INK_COLORS.map((color) => (
            <button
              type="button"
              key={color}
              aria-label={"Colour " + color}
              className={"bb-sw" + (object.color === color ? " on" : "")}
              style={{ background: color }}
              onClick={() => patch({ color })}
            />
          ))}
        </div>
      ) : null}
      {object.type === "frame" ? <div className="bb-hint">{t("board.insp.frameHint")}</div> : null}
      <div className="bb-insp-acts">{deleteButton}</div>
    </div>
  );
}
