// The tool rail's contents (M37 Task 3) and the keyboard map derived from it.
//
// RAIL BUDGET: the rail is a fixed 44px column and must stay fully visible at a
// 540px-tall window — a hidden scrollbar once made "Draft table", the last
// button, unreachable. That is why the four flow kinds share ONE flyout button
// (showing the last-used kind) instead of taking four slots: twelve buttons plus
// three separators come to ~412px (and compact to 27px tall below a 640px
// window); the fifteen it would otherwise take do not fit.
//
// Each group carries the layer its tools belong to, which drives two things: the
// separator above it takes the layer's colour, and picking one of its tools
// focuses that layer when a layer is currently isolated.

import type { StringKey } from "../../shared/i18n";
import { FLOW_KINDS, type FlowKindId, type LayerId } from "./model";

/** Every tool the rail can be in. The four flow kinds double as tool ids — the
 *  tool IS "place a source node", so no separate kind state is needed. */
export type ToolId =
  | "select"
  | "hand"
  | "connector"
  | "eraser"
  | "pen"
  | "sticky"
  | "text"
  | "frame"
  | "sketch"
  | "snippet"
  | FlowKindId
  | "table";

export interface ToolSpec {
  id: ToolId;
  icon: string;
  /** Translation key — resolved at render, not at import (see LAYERS). Typed as
   *  `StringKey`, so a key that is not in the English table fails to compile. */
  labelKey: StringKey;
  /** Single-key shortcut, when the tool has one. */
  key?: string;
}

export interface ToolGroup {
  group: string;
  /** The layer this group's tools create on; absent for the general tools. */
  layer?: LayerId;
  /** Rendered as one flyout button rather than one button per item. */
  flyout?: boolean;
  items: ToolSpec[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    group: "General",
    items: [
      { id: "select", icon: "arrow_selector_tool", labelKey: "board.tool.select", key: "V" },
      {
        id: "hand",
        icon: "pan_tool",
        labelKey: "board.tool.hand",
        key: "H",
      },
      { id: "connector", icon: "trending_flat", labelKey: "board.tool.connect", key: "C" },
      // General, not Domain: it erases on every layer, and it erases edges and
      // whole groups as well as objects.
      {
        id: "eraser",
        icon: "ink_eraser",
        labelKey: "board.tool.eraser",
        key: "X",
      },
    ],
  },
  {
    group: "Domain",
    layer: "domain",
    items: [
      { id: "pen", icon: "ink_pen", labelKey: "board.tool.pen", key: "P" },
      { id: "sticky", icon: "sticky_note_2", labelKey: "board.tool.sticky", key: "N" },
      { id: "text", icon: "title", labelKey: "board.tool.text", key: "T" },
      { id: "frame", icon: "frame_source", labelKey: "board.tool.frame", key: "F" },
      { id: "sketch", icon: "crop_square", labelKey: "board.tool.sketch", key: "E" },
      { id: "snippet", icon: "data_object", labelKey: "board.tool.snippet", key: "J" },
    ],
  },
  {
    group: "Flow",
    layer: "flow",
    flyout: true,
    items: [
      {
        id: "source",
        icon: FLOW_KINDS.source.icon,
        labelKey: FLOW_KINDS.source.labelKey,
        key: "G",
      },
      { id: "process", icon: FLOW_KINDS.process.icon, labelKey: FLOW_KINDS.process.labelKey },
      { id: "store", icon: FLOW_KINDS.store.icon, labelKey: FLOW_KINDS.store.labelKey },
      { id: "sink", icon: FLOW_KINDS.sink.icon, labelKey: FLOW_KINDS.sink.labelKey },
    ],
  },
  {
    group: "Schema",
    layer: "schema",
    items: [{ id: "table", icon: "table_view", labelKey: "board.tool.table", key: "D" }],
  },
];

/** Tool → the layer it creates on (null for Select / Hand / Connect). */
export const TOOL_LAYER: Partial<Record<ToolId, LayerId>> = {};
for (const group of TOOL_GROUPS) {
  for (const tool of group.items) {
    if (group.layer) TOOL_LAYER[tool.id] = group.layer;
  }
}

/** Lower-cased key → tool. `g` resolves to the flyout's remembered kind, which
 *  is why the handler special-cases it rather than reading this blindly. */
export const TOOL_KEYS: Record<string, ToolId> = {};
for (const group of TOOL_GROUPS) {
  for (const tool of group.items) {
    if (tool.key) TOOL_KEYS[tool.key.toLowerCase()] = tool.id;
  }
}
