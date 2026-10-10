// KeyboardShortcutsModal — a static reference sheet for the app's keyboard
// shortcuts, opened from the title-bar Help menu. Keys mirror the hints shown
// on the app menu items (buildMenus) so the two never drift.

import type { StringKey } from "../i18n";
import { useT } from "../i18n/useT";
import { Modal } from "./Modal";
import "./KeyboardShortcutsModal.css";

interface Group {
  title: StringKey;
  rows: { keys: string; label: StringKey }[];
}

const GROUPS: Group[] = [
  {
    title: "uix.sc.group.general",
    rows: [
      { keys: "⌘K", label: "uix.sc.general.palette" },
      { keys: "⌘,", label: "uix.sc.general.settings" },
      { keys: "Ctrl+`", label: "uix.sc.general.terminal" },
    ],
  },
  {
    title: "uix.sc.group.query",
    rows: [
      { keys: "⌘T", label: "uix.sc.query.newTab" },
      { keys: "⌘↩", label: "uix.sc.query.run" },
      { keys: "⇧⌥F", label: "uix.sc.query.format" },
      { keys: "⌘S", label: "uix.sc.query.save" },
    ],
  },
  {
    // Multi-cursor gets its own group: two of the four are mouse gestures, and
    // the feature is invisible until you know the modifier.
    title: "uix.sc.group.multiCursor",
    rows: [
      { keys: "⌥ + click", label: "uix.sc.multi.addCursor" },
      { keys: "⌥ + drag", label: "uix.sc.multi.rectSelect" },
      { keys: "⌘⌥↑ / ⌘⌥↓", label: "uix.sc.multi.addAboveBelow" },
      { keys: "Esc", label: "uix.sc.multi.singleCursor" },
    ],
  },
  {
    title: "uix.sc.group.grid",
    rows: [
      { keys: "⌘E", label: "uix.sc.grid.rowInspector" },
      { keys: "⌘I", label: "uix.sc.grid.addRow" },
      { keys: "Esc", label: "uix.sc.grid.cancelStaged" },
      { keys: "⌘F", label: "uix.sc.grid.filterRows" },
      { keys: "⌘S", label: "uix.sc.grid.saveStaged" },
    ],
  },
  {
    title: "uix.sc.group.structure",
    rows: [
      { keys: "⌘I", label: "uix.sc.structure.addColumn" },
      { keys: "⌘S", label: "uix.sc.structure.applyPending" },
    ],
  },
  {
    title: "uix.sc.group.view",
    rows: [
      { keys: "⌘+", label: "uix.sc.view.zoomIn" },
      { keys: "⌘-", label: "uix.sc.view.zoomOut" },
    ],
  },
];

export function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal label={t("uix.sc.title")} width={420} className="shortcuts-modal" onClose={onClose}>
      <h2 className="shortcuts-title">{t("uix.sc.title")}</h2>
      <div className="shortcuts-groups">
        {GROUPS.map((group) => (
          <section key={group.title} className="shortcuts-group">
            <h3 className="shortcuts-group-title">{t(group.title)}</h3>
            <ul className="shortcuts-rows">
              {group.rows.map((row) => (
                <li key={row.label} className="shortcuts-row">
                  <span className="shortcuts-label">{t(row.label)}</span>
                  <kbd className="shortcuts-keys">{row.keys}</kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="shortcuts-note">{t("uix.sc.note")}</p>
    </Modal>
  );
}
