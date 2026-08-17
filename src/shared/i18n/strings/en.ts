// English — the source of truth for every key. Other locales are partial by
// design: a missing key falls back to English and lowers that locale's coverage
// number (shown in the picker), it is never a blank.
//
// Keys are dotted namespaces (`common.*`, `menu.*`, `connect.*`, `set.*`).
// Never build a sentence by concatenating keys — parameterize instead
// (`{name}` / `{count, plural, …}`), so word order can differ per locale.

export const en = {
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.apply": "Apply",
  "common.delete": "Delete",
  "common.reset": "Reset all",
  "common.search": "Search",
  "common.refresh": "Refresh",
  "common.rows": "rows",
  "common.of": "of",
  "common.page": "Page",

  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.query": "Query",
  "menu.help": "Help",

  // Menu items. `{app}` is the product name — never translate the brand, and
  // never concatenate it, since it does not sit in the same place in every
  // language. Keyboard hints (⌘T) are key names, not copy, and stay as they are.
  "menu.file.newConnection": "New Connection",
  "menu.file.newQuery": "New Query Tab",
  "menu.file.openSqlFile": "Open .sql File",
  "menu.file.closeWorkspace": "Close Workspace",
  "menu.file.settings": "Settings",
  "menu.file.quit": "Close {app}",
  "menu.edit.undo": "Undo",
  "menu.edit.redo": "Redo",
  "menu.edit.cut": "Cut",
  "menu.edit.copy": "Copy",
  "menu.edit.paste": "Paste",
  "menu.view.palette": "Command Palette",
  "menu.view.terminal": "Toggle Terminal",
  "menu.view.schemaMap": "Schema Map",
  "menu.view.processes": "Running Processes",
  "menu.view.zoomIn": "Zoom In",
  "menu.view.zoomOut": "Zoom Out",
  "menu.view.actualSize": "Actual Size",
  "menu.query.run": "Run",
  "menu.query.format": "Format Query",
  "menu.query.explain": "Explain Plan",
  "menu.query.save": "Save Query",
  "menu.query.history": "Query History",
  "menu.help.shortcuts": "Keyboard Shortcuts",
  "menu.help.checkUpdates": "Check for Updates",
  "menu.help.about": "About {app}",

  // Tray menu. Built in Rust, so these are pushed to the backend on every
  // tray sync (see features/workspaces/trayMenu.ts) rather than read there.
  "tray.show": "Show {app}",
  "tray.workspaces": "Workspaces",
  "tray.noConnections": "No saved connections",
  "tray.quit": "Quit {app}",

  "connect.tagline": "Local-first database client · free forever",
  "connect.openWorkspace": "Open a workspace",
  "connect.filter": "Filter connections…",
  "connect.new": "New connection",
  "connect.edit": "Edit connection",
  "connect.compare": "Compare schemas",
  "connect.openFile": "Open SQLite file",
  "connect.allProjects": "All projects",

  "set.title": "Settings",
  "set.tab.appearance": "Appearance",
  "set.tab.fonts": "Fonts & text",
  "set.tab.grid": "Data grid",
  "set.tab.behavior": "Behavior",
  "set.tab.language": "Language & region",

  "set.sec.theme": "Theme",
  "set.sec.accent": "Accent color",
  "set.sec.layout": "Layout",
  "set.sec.clientFont": "Database client font",
  "set.sec.uiFont": "Interface font",
  "set.sec.textSize": "Text size",
  "set.sec.rowLayout": "Row layout",
  "set.sec.queryDefaults": "Query defaults",
  "set.sec.liveData": "Live data",
  "set.sec.objects": "Database objects",
  "set.sec.safety": "Safety",
  "set.sec.connecting": "Connecting",
  "set.sec.session": "Session",
  "set.sec.language": "Interface language",
  "set.sec.formats": "Formats",

  "set.lang.pick": "Language",
  "set.lang.hint": "Applies immediately — no restart needed",
  // Both staged, not live: the coverage bar and this note are commented out in
  // SettingsModal.tsx until enough of the app is keyed for the number to be
  // truthful. Kept (and translated) so switching them back on is one edit.
  "set.lang.coverage": "{pct}% translated",
  "set.lang.machine": "Community translation — untranslated text falls back to English",
  "set.lang.rtl": "Right-to-left layout",
  "set.lang.rtlHint": "Arabic and Hebrew mirror the whole interface",
  "set.lang.region": "Region format",
  "set.lang.regionHint": "Dates, numbers and the first day of the week",
  "set.lang.clock": "Clock",
  "set.lang.clock12": "12-hour",
  "set.lang.clock24": "24-hour",
  "set.lang.firstDay": "First day of week",
  "set.lang.preview": "Preview",
  "set.lang.previewDate": "Date",
  "set.lang.previewNumber": "Number",
  "set.lang.previewRel": "Relative",
  "set.lang.previewRows": "Row count",
  "set.lang.dataNote":
    "Only the interface is translated. Your schema, data and SQL are never rewritten.",
  // The note is a link (it opens docs/TRANSLATING.md on GitHub), so the copy has
  // to describe what a contributor actually finds there: one file per language,
  // not one file for everything.
  "set.lang.contribute": "Missing your language? Each one is a single file — read the guide",

  "set.rowsFound": "{count, plural, one {# row} other {# rows}}",
} as const;

/** Every key the app may ask for. Other locales type-check against this. */
export type StringKey = keyof typeof en;

/** A partial locale table: any subset of the English keys. */
export type StringTable = Partial<Record<StringKey, string>>;
