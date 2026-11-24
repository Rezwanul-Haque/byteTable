// A note cell (M47 E2–E3): reads as rendered Markdown; click, or Enter / Space
// when focused, swaps in a text area with the source. It grows with its
// content (a hidden twin sizes it, so the page never jumps), and Esc or a
// click outside returns to reading.
//
// Jupyter's keys finish a note the way they run a query: ⌘↩ / Ctrl+↩ stays,
// ⇧↩ moves to the next cell, ⌥↩ / Alt+↩ inserts a query below. A plain Enter
// is still a new line.

import { useEffect, useRef, useState } from "react";

import { useT } from "../../../shared/i18n/useT";
import { NbMarkdown } from "./NbMarkdown";

export function NbNote({
  text,
  onChange,
  autoEdit,
  readOnly,
  onNext,
  onInsertBelow,
}: {
  text: string;
  onChange: (text: string) => void;
  autoEdit: boolean;
  readOnly: boolean;
  /** ⇧↩: go to the next cell (adding one at the end). */
  onNext: () => void;
  /** ⌥↩: insert a query cell below this note. */
  onInsertBelow: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(autoEdit && !readOnly);
  const ta = useRef<HTMLTextAreaElement>(null);
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!editing || !el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  if (editing) {
    return (
      <div className="nb-note-edit">
        <div className="nb-grow" data-value={text + "\n"}>
          <textarea
            ref={ta}
            value={text}
            rows={1}
            spellCheck
            aria-label={t("notebook.note.editAria")}
            placeholder={t("notebook.note.placeholder")}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey;
              const done =
                e.key === "Escape" || (e.key === "Enter" && (mod || e.shiftKey || e.altKey));
              if (!done) return;
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
              if (e.key === "Enter" && e.shiftKey) onNext();
              else if (e.key === "Enter" && e.altKey) onInsertBelow();
              // Keep keyboard users on the note they just left.
              else requestAnimationFrame(() => view.current?.focus());
            }}
          />
        </div>
        <div className="nb-note-hint">
          {t("notebook.note.hint")} <span className="kbd">Esc</span> {t("notebook.note.hintPost")}
        </div>
      </div>
    );
  }
  const empty = !text.trim();
  return (
    <div
      ref={view}
      className={"nb-note-view" + (empty ? " empty" : "") + (readOnly ? " ro" : "")}
      role="button"
      tabIndex={0}
      aria-label={empty ? t("notebook.note.emptyAria") : t("notebook.note.aria")}
      aria-disabled={readOnly || undefined}
      onClick={() => !readOnly && setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          onNext();
          return;
        }
        if (e.key === "Enter" && e.altKey && !readOnly) {
          e.preventDefault();
          onInsertBelow();
          return;
        }
        if (!readOnly && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setEditing(true);
        }
      }}
    >
      {empty ? <span>{t("notebook.note.empty")}</span> : <NbMarkdown text={text} />}
    </div>
  );
}
