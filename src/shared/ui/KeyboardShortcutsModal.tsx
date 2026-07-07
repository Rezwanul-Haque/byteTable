// KeyboardShortcutsModal — a static reference sheet for the app's keyboard
// shortcuts, opened from the title-bar Help menu. Keys mirror the hints shown
// on the app menu items (buildMenus) so the two never drift.

import { Modal } from "./Modal";
import "./KeyboardShortcutsModal.css";

interface Group {
  title: string;
  rows: { keys: string; label: string }[];
}

const GROUPS: Group[] = [
  {
    title: "General",
    rows: [
      { keys: "⌘K", label: "Command palette" },
      { keys: "⌘,", label: "Settings" },
      { keys: "Ctrl+`", label: "Toggle terminal" },
    ],
  },
  {
    title: "Query",
    rows: [
      { keys: "⌘T", label: "New query tab" },
      { keys: "⌘↩", label: "Run query" },
      { keys: "⇧⌥F", label: "Format query" },
      { keys: "⌘S", label: "Save query" },
    ],
  },
  {
    title: "View",
    rows: [
      { keys: "⌘+", label: "Zoom in" },
      { keys: "⌘-", label: "Zoom out" },
    ],
  },
];

export function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Keyboard shortcuts" width={420} className="shortcuts-modal" onClose={onClose}>
      <h2 className="shortcuts-title">Keyboard shortcuts</h2>
      <div className="shortcuts-groups">
        {GROUPS.map((group) => (
          <section key={group.title} className="shortcuts-group">
            <h3 className="shortcuts-group-title">{group.title}</h3>
            <ul className="shortcuts-rows">
              {group.rows.map((row) => (
                <li key={row.label} className="shortcuts-row">
                  <span className="shortcuts-label">{row.label}</span>
                  <kbd className="shortcuts-keys">{row.keys}</kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="shortcuts-note">On Windows/Linux, ⌘ maps to Ctrl.</p>
    </Modal>
  );
}
