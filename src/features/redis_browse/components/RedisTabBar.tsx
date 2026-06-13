// Redis tab bar (REDIS_SPEC §5) — ported from `redis.jsx` RedisTabBar. Same
// 37px `.tabbar`/`.tab` chrome as the SQL workspace, but the leading glyph is
// a type badge for key tabs (not a generic icon), and the `+` / ⌘T opens a new
// CLI console rather than a SQL tab. The dashboard tab is non-closable.

import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { Icon } from "../../../shared/ui/Icon";
import type { RedisTab } from "../state";
import { RedisTypeBadge } from "./RedisTypeBadge";
import "./RedisTabBar.css";

/** Non-key tab kinds → Material Symbol (REDIS_SPEC §5). */
const TAB_ICON: Record<"dashboard" | "cli", string> = {
  dashboard: "monitoring",
  cli: "terminal",
};

/** The visible label: the key name, the CLI's "CLI N", or "Dashboard". */
function tabTitle(tab: RedisTab): string {
  switch (tab.kind) {
    case "dashboard":
      return "Dashboard";
    case "key":
      return tab.key;
    case "cli":
      return tab.title;
  }
}

interface RedisTabBarProps {
  tabs: RedisTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewCli: () => void;
}

export function RedisTabBar({ tabs, activeTabId, onSelect, onClose, onNewCli }: RedisTabBarProps) {
  return (
    <div className="tabbar" role="tablist" aria-label="Redis tabs">
      <div className="tabbar-tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const title = tabTitle(tab);
          const closable = tab.kind !== "dashboard";
          const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(tab.id);
            } else if (closable && (event.key === "Delete" || event.key === "Backspace")) {
              event.preventDefault();
              onClose(tab.id);
            }
          };
          const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
            if (event.button === 1 && closable) {
              event.preventDefault();
              onClose(tab.id);
            }
          };
          return (
            <div
              key={tab.id}
              className={"tab" + (active ? " active" : "")}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onKeyDown={onKeyDown}
              onMouseDown={onMouseDown}
              title={title}
            >
              {tab.kind === "key" ? (
                <RedisTypeBadge type={tab.keyType} size={13} />
              ) : (
                <Icon
                  name={TAB_ICON[tab.kind]}
                  size={14}
                  style={{ color: active ? "var(--accent)" : "var(--text-faint)" }}
                />
              )}
              <span className="tab-title">{title}</span>
              {closable ? (
                <button
                  type="button"
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                  title="Close tab"
                  aria-label={"Close " + title}
                >
                  <Icon name="close" size={12} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-new" onClick={onNewCli} title="New CLI console (⌘T)">
        <Icon name="add" size={16} />
      </button>
    </div>
  );
}
