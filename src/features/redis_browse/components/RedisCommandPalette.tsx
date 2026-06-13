// Redis command palette (REDIS_SPEC §5) — ⌘K. Lists key-jump entries (icon
// `vpn_key`, hint = type) plus the always-known commands: New CLI console,
// Keyspace dashboard, switch-to-db entries (the non-empty other dbs), and close
// workspace. The key entries are a bounded SCAN sample of the current db (the
// `keyType` rides on every scan entry) — a quick-jump surface that complements
// the sidebar's full MATCH browse; selecting one opens its key tab. Same
// listbox a11y as the SQL palette.

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../../../shared/ui/Icon";
import { Kbd } from "../../../shared/ui/Kbd";
import type { KvDbInfo } from "../../connections/api";
import { shellLabel, usePanelStore } from "../../console/state";
import { kvScan, type KeyEntry, type KeyType } from "../api";
import { useRedisBrowseStore } from "../state";
import "./RedisCommandPalette.css";

/** How many keys to sample from the current db for the key-jump list. */
const KEY_SAMPLE_MAX = 200;

interface PaletteCommand {
  id: string;
  icon: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface RedisCommandPaletteProps {
  workspaceId: string;
  workspaceName: string;
  initialDb: number;
  dbIndex: number;
  databases: KvDbInfo[];
  /** Connection handle — for the key-jump SCAN sample. */
  handleId: string;
  /** Open (or focus) a key tab — used by the key-jump entries. */
  onOpenKey: (db: number, key: string, keyType: KeyType) => void;
  onCloseWorkspace: () => void;
  onClose: () => void;
}

export function RedisCommandPalette(props: RedisCommandPaletteProps) {
  const {
    workspaceId,
    workspaceName,
    initialDb,
    dbIndex,
    databases,
    handleId,
    onOpenKey,
    onCloseWorkspace,
    onClose,
  } = props;
  const openDashboardTab = useRedisBrowseStore((state) => state.openDashboardTab);
  const setDbIndex = useRedisBrowseStore((state) => state.setDbIndex);
  // M14: the docked console panel replaces the M13 cli tab; the "New CLI
  // console" entry opens it.
  const openPanel = usePanelStore((state) => state.openPanel);

  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [sampleKeys, setSampleKeys] = useState<KeyEntry[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Sample a bounded page of the current db for the key-jump entries. Cheap
  // (one SCAN page) and scoped to the open palette; refreshed when the db
  // changes. Errors are swallowed — the palette still lists its commands.
  useEffect(() => {
    let live = true;
    void kvScan(handleId, dbIndex, { pattern: "*", cursor: "0", count: KEY_SAMPLE_MAX })
      .then((page) => {
        if (live) setSampleKeys(page.keys.slice(0, KEY_SAMPLE_MAX));
      })
      .catch(() => {
        if (live) setSampleKeys([]);
      });
    return () => {
      live = false;
    };
  }, [handleId, dbIndex]);

  const commands = useMemo<PaletteCommand[]>(() => {
    // Key-jump entries (REDIS_SPEC §5: vpn_key icon + type hint) from the
    // current-db sample. Listed first so a typed query matches key names early.
    const keyCmds: PaletteCommand[] = sampleKeys.map((k) => ({
      id: "key-" + k.name,
      icon: "vpn_key",
      label: k.name,
      hint: k.keyType,
      run: () => onOpenKey(dbIndex, k.name, k.keyType),
    }));
    const cli: PaletteCommand = {
      id: "new-cli",
      icon: "terminal",
      label: "New CLI console",
      hint: "⌘T",
      run: () => openPanel(workspaceId, shellLabel("redis")),
    };
    const dash: PaletteCommand = {
      id: "dashboard",
      icon: "monitoring",
      label: "Keyspace dashboard",
      run: () => openDashboardTab(workspaceId, initialDb),
    };
    const dbCmds: PaletteCommand[] = databases
      .filter((d) => d.index !== dbIndex && d.keyCount > 0)
      .map((d) => ({
        id: "db-" + d.index,
        icon: "storage",
        label: "Switch to db" + d.index,
        hint: d.keyCount + " keys",
        run: () => setDbIndex(workspaceId, initialDb, d.index),
      }));
    const close: PaletteCommand = {
      id: "close-ws",
      icon: "power_settings_new",
      label: "Close workspace",
      hint: workspaceName,
      run: onCloseWorkspace,
    };
    return [...keyCmds, cli, dash, ...dbCmds, close];
  }, [
    sampleKeys,
    databases,
    dbIndex,
    workspaceId,
    workspaceName,
    initialDb,
    onOpenKey,
    openPanel,
    openDashboardTab,
    setDbIndex,
    onCloseWorkspace,
  ]);

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      commands.filter(
        (c) =>
          trimmed === "" ||
          c.label.toLowerCase().includes(trimmed) ||
          (c.hint ?? "").toLowerCase().includes(trimmed),
      ),
    [commands, trimmed],
  );
  const sel = Math.min(idx, Math.max(0, filtered.length - 1));

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[data-idx='" + sel + "']")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      const cmd = filtered[sel];
      if (cmd) {
        event.preventDefault();
        cmd.run();
        onClose();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="modal-scrim palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette" aria-modal="true">
        <div className="palette-input-row">
          <Icon name="search" size={18} style={{ color: "var(--text-faint)" }} />
          <input
            ref={inputRef}
            placeholder="Run a command…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIdx(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="redis-palette-list"
            aria-activedescendant={filtered[sel] ? "redis-palette-item-" + sel : undefined}
            aria-label="Search commands"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" id="redis-palette-list" role="listbox" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            filtered.map((c, i) => (
              <div
                key={c.id}
                id={"redis-palette-item-" + i}
                data-idx={i}
                className={"palette-item" + (i === sel ? " active" : "")}
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setIdx(i)}
                onClick={() => {
                  c.run();
                  onClose();
                }}
              >
                <Icon
                  name={c.icon}
                  size={16}
                  style={{ color: i === sel ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="palette-label">{c.label}</span>
                {c.hint ? <span className="palette-hint">{c.hint}</span> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
