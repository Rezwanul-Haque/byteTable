// JSON / JSONB cell editor modal — ported from the prototype's json-editor.jsx
// onto the shared Modal primitive. Code ⇄ Tree view, syntax highlight + line
// gutter, live validation (Save is disabled until it parses), Format/Minify,
// bracket auto-close, ⌘↩ save. Empty input saves NULL; the saved value is the
// minified JSON text (the backend stores JSON columns as text).

import { useEffect, useRef, useState } from "react";

import type { CellValue } from "../../../../shared/api/engine";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Modal, ModalActions } from "../../../../shared/ui/Modal";
import { highlightJSON, validateJSON } from "../../shared/jsonCell";
import "../../shared/CellEditors.css";

/** Read-only collapsible tree view of a parsed JSON value. */
function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (value === null) return <span className="jx-null">null</span>;
  if (typeof value !== "object") {
    const cls =
      typeof value === "string" ? "jx-str" : typeof value === "boolean" ? "jx-bool" : "jx-num";
    return (
      <span className={cls}>{typeof value === "string" ? '"' + value + '"' : String(value)}</span>
    );
  }
  const isArr = Array.isArray(value);
  const entries: [string, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const brace = isArr ? (["[", "]"] as const) : (["{", "}"] as const);
  if (entries.length === 0)
    return (
      <span className="jx-punct">
        {brace[0]}
        {brace[1]}
      </span>
    );
  return (
    <div className="jtree-node">
      <button type="button" className="jtree-toggle" onClick={() => setOpen(!open)}>
        <Icon name={open ? "expand_more" : "chevron_right"} size={14} />
        <span className="jx-punct">{brace[0]}</span>
        {!open ? (
          <span className="jtree-collapsed">
            {entries.length} {isArr ? "items" : "keys"}
            {brace[1]}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="jtree-children">
          {entries.map(([k, v]) => (
            <div className="jtree-row" key={k}>
              <span className="jx-key">{isArr ? k : '"' + k + '"'}</span>
              <span className="jx-punct">:&nbsp;</span>
              <JsonTree value={v} depth={depth + 1} />
            </div>
          ))}
          <div className="jx-punct" style={{ paddingLeft: 2 }}>
            {brace[1]}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface JsonEditorModalProps {
  schemaName: string;
  table: string;
  column: string;
  type: string;
  value: CellValue;
  onSave: (next: string | null) => void;
  onClose: () => void;
}

export function JsonEditorModal({
  schemaName,
  table,
  column,
  type,
  value,
  onSave,
  onClose,
}: JsonEditorModalProps) {
  const initial = (() => {
    if (value == null) return "";
    try {
      return JSON.stringify(JSON.parse(String(value)), null, 2);
    } catch {
      return String(value);
    }
  })();
  const [text, setText] = useState(initial);
  const [view, setView] = useState<"code" | "tree">("code");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const hlRef = useRef<HTMLPreElement | null>(null);

  const res = validateJSON(text);
  const dirty = text !== initial;
  const lineCount = text.split("\n").length;

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const syncScroll = () => {
    if (taRef.current && hlRef.current) {
      hlRef.current.scrollTop = taRef.current.scrollTop;
      hlRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  const format = () => {
    if (res.ok && !res.empty) setText(JSON.stringify(res.value, null, 2));
  };
  const minify = () => {
    if (res.ok && !res.empty) setText(JSON.stringify(res.value));
  };

  const save = () => {
    if (!res.ok) return;
    onSave(res.empty ? null : JSON.stringify(res.value));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
      return;
    }
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      format();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      setText(text.slice(0, s) + "  " + text.slice(en));
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
      return;
    }
    const pairs: Record<string, string> = { "{": "}", "[": "]", '"': '"' };
    if (pairs[e.key] && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      setText(text.slice(0, s) + e.key + pairs[e.key] + text.slice(s));
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 1;
      });
    }
  };

  const statusText = res.ok
    ? res.empty
      ? "Empty → will save as NULL"
      : "Valid JSON" +
        (res.value && typeof res.value === "object"
          ? " · " +
            (Array.isArray(res.value)
              ? res.value.length + " items"
              : Object.keys(res.value).length + " keys")
          : "")
    : (res.line ? "Line " + res.line + (res.col ? ":" + res.col : "") + " — " : "") + res.message;

  return (
    <Modal className="json-modal" width={600} label="Edit JSON" onClose={onClose}>
      <div className="modal-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="data_object" size={17} style={{ color: "var(--accent)" }} />
          <span className="json-title-col">
            {schemaName}.{table}.<b>{column}</b>
          </span>
          <span className="json-type-tag">{type}</span>
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close (Esc)" />
      </div>

      <div className="json-toolbar">
        <div className="json-seg">
          <button
            type="button"
            className={"json-seg-btn" + (view === "code" ? " active" : "")}
            onClick={() => setView("code")}
          >
            <Icon name="code" size={14} /> Code
          </button>
          <button
            type="button"
            className={"json-seg-btn" + (view === "tree" ? " active" : "")}
            onClick={() => setView("tree")}
            disabled={!res.ok || res.empty}
          >
            <Icon name="account_tree" size={14} /> Tree
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="json-tool"
          onClick={format}
          disabled={!res.ok || res.empty}
          title="Format (Alt+Shift+F)"
        >
          <Icon name="format_align_left" size={14} /> Format
        </button>
        <button
          type="button"
          className="json-tool"
          onClick={minify}
          disabled={!res.ok || res.empty}
          title="Minify"
        >
          <Icon name="compress" size={14} /> Minify
        </button>
      </div>

      {view === "code" ? (
        <div className="json-editor-wrap">
          <div className="json-gutter" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i} className={"json-ln" + (!res.ok && res.line === i + 1 ? " err" : "")}>
                {i + 1}
              </div>
            ))}
          </div>
          <div className="json-code">
            <pre
              className="json-highlight"
              ref={hlRef}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightJSON(text) + "\n" }}
            />
            <textarea
              ref={taRef}
              className="json-input"
              value={text}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label={"Edit JSON for " + column}
              onChange={(e) => setText(e.target.value)}
              onScroll={syncScroll}
              onKeyDown={onKeyDown}
              placeholder="null  ·  empty saves NULL"
            />
          </div>
        </div>
      ) : (
        <div className="json-tree-wrap">
          {res.ok && !res.empty ? (
            <JsonTree value={res.value} />
          ) : (
            <div className="dg-pop-empty">Nothing to show</div>
          )}
        </div>
      )}

      <div className={"json-status" + (res.ok ? " ok" : " err")}>
        <Icon name={res.ok ? "check_circle" : "error"} size={14} />
        <span>{statusText}</span>
      </div>

      <ModalActions>
        <div className="json-hint">⌘↩ save · Alt+Shift+F format · brackets auto-close</div>
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="filled" icon="check" onClick={save} disabled={!res.ok || !dirty}>
          Save
        </Btn>
      </ModalActions>
    </Modal>
  );
}
