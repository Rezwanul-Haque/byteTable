// Item editor drawer (M17 §17.3): a right-side panel — NOT a modal — sharing the
// SQL row inspector's shell (`.ri-drawer`), so an item reads the way a row does.
// PK/SK shown locked (immutable — changing identity = delete+recreate, out of
// scope), every other attribute editable with a type selector (S/N/BOOL/NULL/L/M),
// add/remove attribute, and a live preview in either plain JSON or DynamoDB's
// type-tagged JSON.
//
// Nothing here writes: the primary action STAGES the composed item into the
// grid's buffer, and the save bar commits the batch (⌘S). Ported from the
// prototype's `DynamoItemModal` in `dynamo.jsx`, which was a modal that wrote
// directly.
//
// Adding an attribute is a composer, not a name box: "+ Add attribute" opens a
// panel with type, name and value together, and the attribute only joins the
// list once it is complete. The earlier version took a name, appended a row
// typed `S` with an empty value, and left you to fix the type and the value in
// the dense list — three edits in two places for one attribute, with a
// half-formed row sitting in the item's JSON meanwhile.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import type { DynamoItem, TableDescriptor } from "../api";
import {
  ddbCoerce,
  ddbRawOf,
  ddbType,
  formatIsoTs,
  isIsoTimestamp,
  isSetType,
  isoShapeOf,
  itemKeyOf,
  orderAttributes,
  parseIsoTs,
  marshalItem,
  DDB_TYPES,
} from "../helpers";
import { RiDateTime } from "../../shared/DateTimeField";
import { JsonField } from "../../shared/JsonField";
import { highlightJSON } from "../../shared/jsonCell";
import "../../shared/CellEditors.css";
import "../../shared/InspectorShell.css";

interface AttrRow {
  name: string;
  type: string;
  raw: string;
}

/** The two shapes the preview can render the item in. */
type JsonFormat = "plain" | "ddb";

/** Clipboard shapes offered by the header's copy menu. */
type ItemCopyFormat = "json" | "ddb" | "csv" | "cli" | "key";

/**
 * DynamoDB's useful clipboard shapes. The SQL inspector offers CSV / JSON / SQL
 * INSERT / values — the two middle ones carry over, `SQL INSERT` has no meaning
 * here, and the two that replace it are the ones this engine actually needs: the
 * type-tagged wire form, and a runnable CLI call. "Just the key" is worth its own
 * row because every targeted DynamoDB operation — GetItem, DeleteItem, a Query —
 * takes the key and nothing else.
 */
const ITEM_COPY_ITEMS: { format: ItemCopyFormat; label: string; icon: string }[] = [
  { format: "json", label: "Copy as JSON", icon: "data_object" },
  { format: "ddb", label: "Copy as DynamoDB JSON", icon: "code_blocks" },
  { format: "csv", label: "Copy as CSV", icon: "table_view" },
  { format: "cli", label: "Copy as AWS CLI put-item", icon: "terminal" },
  { format: "key", label: "Copy the primary key", icon: "vpn_key" },
];

/** One CSV field: objects serialise to JSON, and anything risky gets quoted. */
function csvField(v: unknown): string {
  const text =
    v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

const JSON_FORMATS: { id: JsonFormat; label: string; hint: string }[] = [
  { id: "plain", label: "JSON", hint: "The item as plain JSON" },
  {
    id: "ddb",
    label: "DynamoDB JSON",
    hint: "Type-tagged AttributeValues — the wire form the AWS CLI and BatchWriteItem take",
  },
];

/**
 * The raw string a value should carry after its type changes — a boolean needs
 * `true`/`false`, NULL carries nothing, and M/L want a JSON skeleton to type
 * into. Shared by the in-place type selector and the new-attribute composer so
 * the two cannot drift.
 */
function rawForType(type: string, raw: string): string {
  switch (type) {
    case "BOOL":
      return raw === "true" ? "true" : "false";
    case "NULL":
      return "";
    case "M":
      return "{\n  \n}";
    // A set edits as a bare array of its members — same shape as a list, and
    // the type selector is what says it is a set.
    case "L":
    case "SS":
    case "NS":
    case "BS":
      return "[\n  \n]";
    default:
      return raw;
  }
}

/**
 * The value editor for one attribute, dispatched on its DynamoDB type. Used by
 * both the attribute list and the composer, so a value is edited the same way
 * wherever it appears.
 */
/**
 * The shape a timestamp is written in when the field has no shape to copy —
 * after the value was cleared, or when the calendar's "now" button fills an
 * empty field. Plain UTC ISO-8601, the form AWS's own docs use.
 */
const DEFAULT_ISO_SHAPE = { sep: "T", frac: "", zone: "Z", hasSeconds: true };

function AttrValueField({
  type,
  raw,
  onChange,
  placeholder,
  asTimestamp,
}: {
  type: string;
  raw: string;
  onChange: (raw: string) => void;
  placeholder?: string;
  /**
   * Render the calendar editor even when `raw` does not currently parse as a
   * timestamp. The caller owns this decision and keeps it STICKY per attribute:
   * detecting from the value alone is a one-way door, because clearing the field
   * (or the calendar's own "null" button) makes the value stop looking like a
   * date and the calendar would vanish with no way back short of retyping a full
   * ISO string by hand.
   */
  asTimestamp?: boolean;
}) {
  if (type === "NULL") return <input className="ri-input" value="null" readOnly disabled />;
  // An `S` holding an ISO-8601 timestamp gets the calendar + clock editor the
  // SQL inspector gives a temporal column. DynamoDB declares no such type, so
  // the value itself is the only signal — and the editor keeps its raw-text
  // escape hatch, so a string that merely looks like a date is never a trap.
  if (type === "S" && (asTimestamp || isIsoTimestamp(raw))) {
    // Keep the stored spelling when there is one; fall back to plain UTC ISO for
    // an empty field, so "now" and the steppers still have something to write.
    const shape = isoShapeOf(raw) ?? DEFAULT_ISO_SHAPE;
    return (
      <RiDateTime
        type="timestamp"
        // An empty attribute is passed as NULL, not as "". The editor reads
        // `cur != null && !date` as "there is a value here and it does not
        // parse" and forces raw-text mode with the clock disabled — which is
        // what an empty string looked like, stranding the field the moment its
        // own `null` button was used. As null it shows the NULL chip and offers
        // `now`, exactly as it does for a SQL column.
        cur={raw === "" ? null : raw}
        onDraft={(v) => onChange(v === null || v === undefined ? "" : String(v))}
        parse={(v) => parseIsoTs(v)}
        emitValue={(d) => formatIsoTs(d, shape)}
      />
    );
  }
  if (type === "BOOL")
    return (
      <Select
        className="ddb-val-select"
        aria-label="Boolean value"
        mono={false}
        value={raw === "true" ? "true" : "false"}
        options={[
          { value: "true", label: "true" },
          { value: "false", label: "false" },
        ]}
        onChange={onChange}
      />
    );
  // Maps, lists and the three set types all edit as JSON, so they all get the
  // highlighted editor with its live validity check and format / minify — the
  // same field the SQL inspector gives a JSON column. A nested map is the case
  // that needs it most: plain text at this size is where a missing brace hides.
  if (type === "M" || type === "L" || isSetType(type))
    return <JsonField text={raw} onChange={onChange} minRows={2} maxRows={12} />;
  return (
    <input
      className="ri-input"
      value={raw}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      inputMode={type === "N" ? "decimal" : "text"}
      aria-label="Attribute value"
    />
  );
}

interface DynamoItemDrawerProps {
  item: DynamoItem;
  table: TableDescriptor;
  /** Create a brand-new item (PK/SK editable) vs. edit an existing one (locked). */
  create?: boolean;
  /**
   * The attribute to land on — the grid column that was clicked. That field is
   * highlighted, scrolled into view and given focus, so clicking `status` opens
   * this drawer on `status` rather than at the top of the item.
   */
  focusAttr?: string | null;
  /**
   * Delete this item from the table. Omitted in create mode — there is nothing
   * to delete yet. Unlike the edits, this does NOT go through the save bar: it
   * routes to the same confirm the grid's "delete selected" uses, so a
   * destructive action still asks before it happens rather than sitting in a
   * buffer that looks like a pending edit.
   */
  onDelete?: () => void;
  onClose: () => void;
  /**
   * Hand the composed item to the grid's staged-write buffer. Nothing is written
   * here — the save bar commits the batch, the same two-stage contract the SQL
   * and Cassandra row inspectors follow.
   */
  onStage: (item: DynamoItem) => void;
}

export function DynamoItemDrawer({
  item,
  table,
  create = false,
  focusAttr,
  onDelete,
  onClose,
  onStage,
}: DynamoItemDrawerProps) {
  const keyAttrs = [table.keySchema.pk, table.keySchema.sk].filter(Boolean) as string[];
  const isKey = (k: string) => keyAttrs.includes(k);

  // The drawer's starting point, and what Discard restores.
  const initialRows = (): AttrRow[] =>
    create
      ? // New item: seed the key attributes (empty values) using their declared
        // DynamoDB types, so identity is always present and typed correctly.
        keyAttrs.map((k) => ({ name: k, type: table.attrTypes[k] ?? "S", raw: "" }))
      : // Same order as the grid's columns, so a row and its drawer read alike.
        orderAttributes(Object.keys(item), table.keySchema).map((k) => ({
          name: k,
          type: ddbType(item[k]),
          raw: ddbRawOf(item[k]),
        }));

  /** Attribute names currently edited with the calendar, seeded from the item. */
  const tsAttrsOf = (rs: AttrRow[]) =>
    new Set(rs.filter((r) => r.type === "S" && isIsoTimestamp(r.raw)).map((r) => r.name));

  const [rows, setRows] = useState<AttrRow[]>(initialRows);
  // Which fields show the calendar. Sticky, not derived from the value on every
  // render: emptying a field — including with the calendar's own "null" button —
  // makes it stop looking like a date, and a derived flag would take the
  // calendar away at exactly the moment the user wanted to pick a new one.
  const [tsAttrs, setTsAttrs] = useState<Set<string>>(() => tsAttrsOf(initialRows()));
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [dirty, setDirty] = useState(false);
  // The new-attribute composer: closed, or open holding a complete draft.
  const [draftAttr, setDraftAttr] = useState<AttrRow | null>(null);
  // Re-target when the drawer is pointed at a DIFFERENT item. `rows` is seeded
  // from `item` by useState, which runs only on mount — and this drawer stays
  // mounted while the grid is clicked, so without this a click on another row
  // left the previous item's fields on screen under the new item's header.
  //
  // Adjusted during render (React's "derive state from props" pattern, as in the
  // SQL RowInspector's `lastRowId`) rather than in an effect, so the new item
  // paints in the same commit instead of flashing the old one first.
  const identity = create ? "new" : itemKeyOf(item, table.keySchema);
  const [lastIdentity, setLastIdentity] = useState(identity);
  if (lastIdentity !== identity) {
    const fresh = initialRows();
    setLastIdentity(identity);
    setRows(fresh);
    setTsAttrs(tsAttrsOf(fresh));
    setDirty(false);
    setDraftAttr(null);
  }
  const newNameRef = useRef<HTMLInputElement | null>(null);
  // ⌘S reaches `stage` through a ref so the key listener is bound once rather
  // than re-bound on every keystroke in a field.
  const stageRef = useRef<() => void>(() => {});
  const toast = useToast();

  // Which shape the preview renders. Plain JSON is what the item IS; DynamoDB
  // JSON is what the wire carries — the form you paste into the AWS CLI, a
  // CloudFormation seed or `BatchWriteItem`, and the form an exported file uses.
  const [jsonFormat, setJsonFormat] = useState<JsonFormat>("plain");

  const composerOpen = draftAttr !== null;

  // Put the clicked attribute under the user's hands: scroll its field into view
  // inside the drawer's scroller and focus its editor. Runs on open and whenever
  // the target moves (another cell, or another row), never on an unrelated
  // re-render.
  //
  // Queried by class rather than through a ref map because a field renders one
  // of several bodies (text/number input, the BOOL select, an M/L textarea, a
  // locked key chip) — and the field HEAD also holds the type selector and the
  // remove button, which a generic "first focusable" query would grab instead.
  useEffect(() => {
    if (!focusAttr) return;
    const field = bodyRef.current?.querySelector<HTMLElement>(
      '[data-ddb-field="' + CSS.escape(focusAttr) + '"]',
    );
    if (!field) return;
    field.scrollIntoView({ block: "nearest" });
    // `.ri-input` covers the text/number/textarea editors and the disabled NULL
    // box; `.ddb-val-select` is the BOOL dropdown's wrapper, whose trigger is the
    // focusable part. A locked key row has neither, so nothing takes focus and
    // the scroll alone does the work.
    field.querySelector<HTMLElement>(".ri-input, .ddb-val-select .sel-trigger")?.focus();
  }, [focusAttr, identity]);

  // Mount closed, then open on the next frame so the drawer slides in rather
  // than appearing already docked — the row inspector gets this for free by
  // staying mounted and toggling `open`, but this editor mounts on demand.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Escape closes; ⌘/Ctrl+S stages. Staging — NOT the grid's batch commit: while
  // this drawer holds un-staged edits, save has to mean "stage these first",
  // exactly as the SQL row inspector treats the same key. The grid's own ⌘S
  // listener skips its commit while the drawer is open, so one keystroke never
  // fires both.
  //
  // preventDefault matters on both: an Escape we act on must not travel on to
  // the window, or macOS reads it as "leave full screen".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // The grid has its own ⌘S listener on `window` for committing the
        // staged batch. `preventDefault` does NOT stop a sibling listener, and
        // whichever was registered first wins — so one keystroke could stage
        // here and immediately commit there, skipping the review the save bar
        // exists for. Stop the event dead: while this drawer is up, ⌘S means
        // stage and nothing else.
        e.stopImmediatePropagation();
        stageRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus the name as the composer opens — Modal's initial focus only runs at
  // mount, and the name is the field with something to type into first.
  useEffect(() => {
    if (composerOpen) newNameRef.current?.focus();
  }, [composerOpen]);

  const setRow = (i: number, patch: Partial<AttrRow>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    // Typing a full ISO string into a plain field promotes it to the calendar —
    // and, being sticky, it stays there afterwards.
    const row = rows[i];
    if (row && patch.raw !== undefined && !tsAttrs.has(row.name) && isIsoTimestamp(patch.raw)) {
      setTsAttrs((prev) => new Set(prev).add(row.name));
    }
    setDirty(true);
  };
  const removeRow = (i: number) => {
    setRows((rs) => rs.filter((_, j) => j !== i));
    setDirty(true);
  };
  const changeType = (i: number, type: string) => {
    const cur = rows[i];
    if (!cur) return;
    // Leaving `S` is an explicit "this is not a date", and the way out of the
    // calendar for good. (Its own text mode is the way to edit the raw string
    // without leaving.)
    if (type !== "S" && tsAttrs.has(cur.name)) {
      setTsAttrs((prev) => {
        const next = new Set(prev);
        next.delete(cur.name);
        return next;
      });
    }
    setRow(i, { type, raw: rawForType(type, cur.raw) });
  };

  const patchDraft = (patch: Partial<AttrRow>) => setDraftAttr((d) => (d ? { ...d, ...patch } : d));

  // What is wrong with the draft, or null when it is ready to add. Shown in the
  // composer rather than toasted: the fix belongs next to the field.
  const draftError = (() => {
    if (!draftAttr) return null;
    const nm = draftAttr.name.trim();
    if (nm === "") return null; // nothing typed yet — not an error, just not ready
    if (rows.some((r) => r.name === nm)) return "This item already has a “" + nm + "” attribute.";
    if (draftAttr.type === "M" || draftAttr.type === "L" || isSetType(draftAttr.type)) {
      try {
        // `ddbCoerce` carries the set rules too (non-empty, homogeneous, no
        // duplicates), reported as the SyntaxError message rather than a
        // generic "invalid JSON" — DynamoDB would otherwise reject the write
        // and the reason would arrive far from the field that caused it.
        ddbCoerce(draftAttr.type, draftAttr.raw);
      } catch (err) {
        if (isSetType(draftAttr.type)) {
          return err instanceof Error ? err.message : "That is not a valid set.";
        }
        return "The value is not valid JSON for a " + (draftAttr.type === "M" ? "map" : "list");
      }
    }
    return null;
  })();
  const draftReady = draftAttr !== null && draftAttr.name.trim() !== "" && draftError === null;

  const addAttr = () => {
    if (!draftAttr || !draftReady) return;
    setRows((rs) => [...rs, { ...draftAttr, name: draftAttr.name.trim() }]);
    setDraftAttr(null);
    setDirty(true);
  };

  // Validate + build the draft item (invalid = the first attr whose JSON fails).
  const { draft, invalid, json } = useMemo(() => {
    let invalidName: string | null = null;
    const d: DynamoItem = {};
    for (const r of rows) {
      try {
        d[r.name] = ddbCoerce(r.type, r.raw);
      } catch {
        invalidName = r.name;
        d[r.name] = r.raw;
      }
    }
    return { draft: d, invalid: invalidName, json: JSON.stringify(d, null, 2) };
  }, [rows]);

  // Marshalling can only fail on an attribute whose own JSON is already broken,
  // and `invalid` has that covered — so this falls back to the plain shape
  // rather than blanking the preview while the user is mid-edit.
  const typedJson = useMemo(() => {
    try {
      return JSON.stringify(marshalItem(draft), null, 2);
    } catch {
      return json;
    }
  }, [draft, json]);
  const shownJson = jsonFormat === "plain" ? json : typedJson;

  // Create mode requires every key attribute to have a value (identity).
  const keysFilled =
    !create || keyAttrs.every((k) => (rows.find((r) => r.name === k)?.raw.trim() ?? "") !== "");

  const discard = () => {
    const fresh = initialRows();
    setRows(fresh);
    setTsAttrs(tsAttrsOf(fresh));
    setDraftAttr(null);
    setDirty(false);
  };

  // Hand the composed item to the grid's buffer and close. No write happens
  // here: the save bar commits the batch, so an item can be composed, reviewed
  // beside the others, and abandoned without ever reaching the table.
  const stage = () => {
    if (invalid) {
      toast("Invalid JSON in attribute “" + invalid + "”", "err");
      return;
    }
    if (create && !keysFilled) {
      toast(
        table.keySchema.sk ? "Fill in the partition key and sort key" : "Fill in the partition key",
        "err",
      );
      return;
    }
    setDirty(false);
    onStage(draft);
    onClose();
  };

  useEffect(() => {
    stageRef.current = stage;
  });

  // How many attributes differ from the item this drawer was opened on —
  // added, removed, retyped or edited. Drives the footer's count, the same
  // readout the SQL inspector shows while dirty.
  const changedCount = useMemo(() => {
    if (create) return 0;
    let n = 0;
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.name);
      const before = item[r.name];
      if (before === undefined) n++;
      else if (ddbRawOf(before) !== r.raw || ddbType(before) !== r.type) n++;
    }
    for (const k of Object.keys(item)) if (!seen.has(k)) n++;
    return n;
  }, [rows, item, create]);

  // Copy menu, anchored under its button in the header.
  const [copyOpen, setCopyOpen] = useState(false);
  const copyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!copyOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (copyRef.current && !copyRef.current.contains(e.target as Node)) setCopyOpen(false);
    };
    window.addEventListener("click", onClickOutside);
    return () => window.removeEventListener("click", onClickOutside);
  }, [copyOpen]);

  /**
   * The item in one of the offered shapes. Built from `draft` — what the drawer
   * is SHOWING, edits folded in — so a copy matches the fields on screen rather
   * than the stored item, matching the SQL inspector's contract.
   */
  const copyAs = (format: ItemCopyFormat): string => {
    const names = Object.keys(draft);
    switch (format) {
      case "ddb":
        return JSON.stringify(marshalItem(draft), null, 2);
      case "csv":
        return (
          names.map(csvField).join(",") + "\n" + names.map((n) => csvField(draft[n])).join(",")
        );
      case "cli":
        // Single-quoted for a POSIX shell; the JSON itself cannot contain a
        // single quote without breaking that, so those are escaped the only way
        // a shell allows — close, escape, reopen.
        return (
          "aws dynamodb put-item --table-name " +
          table.name +
          " --item '" +
          JSON.stringify(marshalItem(draft)).replace(/'/g, "'\\''") +
          "'"
        );
      case "key": {
        const key: DynamoItem = { [table.keySchema.pk]: draft[table.keySchema.pk] };
        if (table.keySchema.sk) key[table.keySchema.sk] = draft[table.keySchema.sk];
        return JSON.stringify(key, null, 2);
      }
      default:
        return JSON.stringify(draft, null, 2);
    }
  };

  /** One field's value, as it reads in the editor. */
  const copyValue = (raw: string) => {
    void navigator.clipboard.writeText(raw).then(
      () => toast("Copied", "ok"),
      () => toast("Couldn't copy to clipboard", "err"),
    );
  };

  const copyItem = (format: ItemCopyFormat, label: string) => {
    void navigator.clipboard.writeText(copyAs(format)).then(
      () => toast(label.replace(/^Copy /, "Copied "), "ok"),
      () => toast("Couldn't copy to clipboard", "err"),
    );
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(shownJson);
      toast("Copied " + (jsonFormat === "plain" ? "JSON" : "DynamoDB JSON"), "ok");
    } catch {
      toast("Couldn't copy to clipboard", "err");
    }
  };

  const verb = create ? "New item" : "Edit item";
  // The key values, as the header subline — the drawer's answer to the row
  // inspector's `pkLabel`. Empty on a new item until the user types them.
  const keyLabel = keyAttrs
    .map((k) => k + " = " + (rows.find((r) => r.name === k)?.raw || "…"))
    .join(" · ");

  return createPortal(
    <aside className={"ri-drawer ddb-item-drawer" + (shown ? " open" : "")}>
      <div className="ri-head">
        <Icon name="data_object" size={16} style={{ color: "var(--accent)" }} />
        <div className="ri-title">
          <span className="ri-title-main">{verb}</span>
          <span className="ri-title-sub">
            {table.name}
            {keyLabel ? " · " + keyLabel : ""}
          </span>
        </div>
        {dirty ? <span className="ri-dot" title="Unsaved changes" /> : null}
        {/* Copy this item to the clipboard in one of the DynamoDB-shaped forms. */}
        <div className="ri-copyrow" ref={copyRef}>
          <button
            type="button"
            className={"ri-close" + (copyOpen ? " on" : "")}
            title="Copy this item to the clipboard"
            aria-label="Copy item"
            onClick={() => setCopyOpen(!copyOpen)}
          >
            <Icon name="content_copy" size={16} />
          </button>
          {copyOpen ? (
            <div className="ri-copyrow-menu">
              {ITEM_COPY_ITEMS.map((it) => (
                <div
                  key={it.format}
                  className="ri-copyrow-item"
                  onClick={() => {
                    setCopyOpen(false);
                    copyItem(it.format, it.label);
                  }}
                >
                  <Icon name={it.icon} size={13} />
                  {it.label}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {onDelete ? (
          <button
            type="button"
            className="ri-close ddb-ri-delete"
            title={"Delete this item from " + table.name}
            aria-label="Delete item"
            onClick={onDelete}
          >
            <Icon name="delete" size={16} />
          </button>
        ) : null}
        <button type="button" className="ri-close" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="ri-body" ref={bodyRef}>
        {rows.map((r, i) => {
          const keyRow = isKey(r.name);
          // Edit mode: keys fully locked. Create mode: the key VALUE is editable
          // (the user is choosing the new item's identity) but its name and type
          // stay fixed — they come from the table's own schema.
          const locked = keyRow && !create;
          const badge =
            r.name === table.keySchema.pk ? "pk" : r.name === table.keySchema.sk ? "sk" : null;
          const rowInvalid = invalid === r.name;
          return (
            <div
              className={
                "ri-field" + (rowInvalid ? " dirty" : "") + (r.name === focusAttr ? " focused" : "")
              }
              data-ddb-field={r.name}
              key={r.name}
            >
              <div className="ri-field-head">
                {badge ? (
                  <span className={"ddb-key-badge " + badge}>{badge.toUpperCase()}</span>
                ) : null}
                <span className="ri-field-name">{r.name}</span>
                {/* A key's type is fixed by the table; everything else is the
                    user's choice, so only non-key rows get the selector. */}
                {keyRow ? (
                  <span className="ri-field-type">{r.type}</span>
                ) : (
                  <Select
                    className="ddb-type-sel"
                    title="Attribute type"
                    aria-label="Attribute type"
                    value={r.type}
                    options={DDB_TYPES.map((ty) => ({ value: ty, label: ty }))}
                    onChange={(v) => changeType(i, v)}
                  />
                )}
                <div style={{ flex: 1 }} />
                {/* Per-field copy, always visible — the same affordance every
                    field gets in the SQL row inspector. Copies the value as it
                    reads in the editor, so a map, a list or a set copies as the
                    JSON on screen and a NULL copies an empty string. */}
                <button
                  type="button"
                  className="ri-mini-btn ri-copy"
                  title="Copy value"
                  aria-label={"Copy " + r.name + " value"}
                  onClick={() => copyValue(r.raw)}
                >
                  <Icon name="content_copy" size={12} />
                </button>
                {keyRow ? null : (
                  <button
                    type="button"
                    className="ri-mini-btn"
                    onClick={() => removeRow(i)}
                    title="Remove attribute"
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
              {locked ? (
                <div className="ri-pk-lock">
                  <span className="ddb-pk-lock-val">{r.raw}</span>
                  {/* DynamoDB's own words: the PRIMARY KEY is the whole thing
                      — partition key alone, or partition key + sort key. The
                      individual attributes are the partition key and the sort
                      key, so naming each one "primary key" (the SQL wording
                      this shell came with) would be wrong twice over. */}
                  <span className="ri-pk-note">
                    <Icon name="lock" size={11} /> {badge === "sk" ? "sort key" : "partition key"}
                  </span>
                </div>
              ) : (
                <AttrValueField
                  type={r.type}
                  raw={r.raw}
                  onChange={(raw) => setRow(i, { raw })}
                  asTimestamp={tsAttrs.has(r.name)}
                  placeholder={
                    keyRow ? (badge ? badge.toUpperCase() + " value" : "key value") : undefined
                  }
                />
              )}
            </div>
          );
        })}

        {draftAttr ? (
          <div className="ddb-attr-new">
            <div className="ddb-attr-new-head">
              <Icon name="add" size={14} style={{ color: "var(--accent)" }} />
              <span>New attribute</span>
              <div style={{ flex: 1 }} />
              <IconBtn
                icon="close"
                size={16}
                title="Discard this attribute"
                onClick={() => setDraftAttr(null)}
              />
            </div>
            <div className="ddb-attr-new-grid">
              <label>
                Type
                <Select
                  className="sel-block"
                  aria-label="Attribute type"
                  value={draftAttr.type}
                  options={DDB_TYPES.map((ty) => ({ value: ty, label: ty }))}
                  // Retype before the attribute exists, so switching to BOOL or
                  // M/L seeds the value the same way it would in the list.
                  onChange={(v) => patchDraft({ type: v, raw: rawForType(v, draftAttr.raw) })}
                />
              </label>
              <label>
                Name
                <input
                  ref={newNameRef}
                  className="ri-input"
                  placeholder="attribute name"
                  value={draftAttr.name}
                  onChange={(e) => patchDraft({ name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addAttr();
                  }}
                  spellCheck={false}
                  aria-label="Attribute name"
                />
              </label>
              <label className="ddb-attr-new-val">
                Value
                <AttrValueField
                  type={draftAttr.type}
                  raw={draftAttr.raw}
                  onChange={(raw) => patchDraft({ raw })}
                  placeholder={draftAttr.type === "N" ? "0" : "value"}
                />
              </label>
            </div>
            {draftError ? (
              <div className="ddb-attr-new-err">
                <Icon name="error" size={14} /> {draftError}
              </div>
            ) : null}
            <div className="ddb-attr-new-foot">
              <Btn variant="text" small onClick={() => setDraftAttr(null)}>
                Cancel
              </Btn>
              <Btn icon="add" variant="filled" small disabled={!draftReady} onClick={addAttr}>
                Add attribute
              </Btn>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="ddb-add-attr-btn"
            onClick={() => setDraftAttr({ name: "", type: "S", raw: "" })}
          >
            <Icon name="add" size={15} /> Add attribute
          </button>
        )}

        <div className="ddb-json-head">
          <div className="ddb-json-tabs" role="tablist" aria-label="Preview format">
            {JSON_FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={jsonFormat === f.id}
                title={f.hint}
                className={"ddb-json-tab" + (jsonFormat === f.id ? " on" : "")}
                onClick={() => setJsonFormat(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {invalid ? (
            <span className="ddb-json-err">invalid JSON in “{invalid}”</span>
          ) : (
            <button
              type="button"
              className="ri-mini-btn"
              title={"Copy the " + (jsonFormat === "plain" ? "JSON" : "DynamoDB JSON")}
              onClick={() => void copyJson()}
            >
              <Icon name="content_copy" size={12} /> copy
            </button>
          )}
        </div>
        <pre
          className={"ddb-ddl-block ddb-json-pre" + (invalid ? " invalid" : "")}
          // The highlighter escapes &, < and > before wrapping tokens in spans,
          // so the only markup here is its own.
          dangerouslySetInnerHTML={{ __html: highlightJSON(shownJson) }}
        />
      </div>

      {/* One row, like the SQL inspector's: a count and the actions while there
          is something to stage, and ONLY the hint when there is not. Showing
          both at once is what wrapped the footer onto three lines — the hint
          took the flex space the buttons needed. */}
      <div className={"ri-foot" + (dirty || create ? " dirty" : "")}>
        {dirty || create ? (
          <>
            <Icon name="edit_note" size={15} style={{ color: "var(--accent)" }} />
            <span className="ri-foot-n">
              {create
                ? "New item"
                : changedCount + " field" + (changedCount === 1 ? "" : "s") + " changed"}
            </span>
            <div style={{ flex: 1 }} />
            {/* Discard resets the fields and leaves the drawer open — the same
                thing it does in the SQL inspector. Escape is what closes. */}
            <button type="button" className="ri-btn ghost" onClick={discard}>
              Discard
            </button>
            <button
              type="button"
              className="ri-btn primary"
              disabled={(!create && !dirty) || !!invalid || !keysFilled}
              title="Stage into the save bar — commit with ⌘S"
              onClick={stage}
            >
              <Icon name="playlist_add_check" size={14} />
              {create ? "Stage new item" : "Stage changes"}
            </button>
          </>
        ) : (
          <span className="ri-foot-hint">
            <Icon name="info" size={13} /> Edits are staged first — nothing is written until you
            save (⌘S)
          </span>
        )}
      </div>
    </aside>,
    document.body,
  );
}
