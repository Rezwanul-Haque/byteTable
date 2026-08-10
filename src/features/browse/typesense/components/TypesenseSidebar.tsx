// Typesense sidebar (M30 Task 5, ported from typesense.jsx TypesenseSidebar):
// connection header, cluster pill + search/refresh/dashboard icons, one filter
// input over both lists, Collections (name + document count) and Aliases
// (alias → collection), a 2×2 section nav that highlights the active tab, and an
// HTTP-console footer button. Reuses the shared sidebar chrome (.sidebar,
// .schema-row, .table-item, .ctx-menu).

import { useEffect, useState } from "react";

import type { Env } from "../../../../shared/types";
import { Btn } from "../../../../shared/ui/Btn";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { LanguageChip } from "../../../../shared/ui/LanguageChip";
import type { AliasInfo, CollectionDescriptor } from "../api";
import { tsCount } from "../format";

interface CtxMenu {
  x: number;
  y: number;
  coll: string;
}

/** The section-nav buttons — the four singleton tabs (Task 5). */
const SECTIONS = [
  { kind: "schema", label: "Schema", icon: "schema" },
  { kind: "docs", label: "Documents", icon: "data_object" },
  { kind: "curation", label: "Curation", icon: "tune" },
  { kind: "keys", label: "API keys", icon: "key" },
] as const;

export type TsSectionKind = (typeof SECTIONS)[number]["kind"];

interface TypesenseSidebarProps {
  workspaceName: string;
  workspaceColor: string;
  env: Env;
  envColor: string;
  detail: string;
  collections: CollectionDescriptor[];
  aliases: AliasInfo[];
  coll: string;
  /** The active tab's kind, so the section nav can highlight it. */
  activeKind: string | null;
  /** Cluster pill: node count, health and version. */
  nodeCount: number;
  healthy: boolean;
  version: string;
  /** False for a search-only key — the collection list is then the one
   *  configured collection, and that is worth saying out loud. */
  adminKey: boolean;
  onOpenSearch: (coll: string) => void;
  onOpenSection: (kind: TsSectionKind, coll?: string) => void;
  onOpenDashboard: () => void;
  onOpenConsole: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  onCloseWorkspace: () => void;
}

export function TypesenseSidebar({
  workspaceName,
  workspaceColor,
  env,
  envColor,
  detail,
  collections,
  aliases,
  coll,
  activeKind,
  nodeCount,
  healthy,
  version,
  adminKey,
  onOpenSearch,
  onOpenSection,
  onOpenDashboard,
  onOpenConsole,
  onRefresh,
  refreshing,
  onCloseWorkspace,
}: TypesenseSidebarProps) {
  const [q, setQ] = useState("");
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [ctxMenu]);

  const needle = q.trim().toLowerCase();
  const shownCollections = collections.filter(
    (c) => !needle || c.name.toLowerCase().includes(needle),
  );
  const shownAliases = aliases.filter(
    (a) =>
      !needle ||
      a.name.toLowerCase().includes(needle) ||
      a.collectionName.toLowerCase().includes(needle),
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-conn" title={detail}>
        <span className="ws-color-bar" style={{ background: workspaceColor }} />
        <EngineBadge engine="typesense" size={26} />
        <div className="sidebar-conn-info">
          <div className="sidebar-conn-name">{workspaceName}</div>
          <div className="sidebar-conn-detail">
            <span className="conn-env" style={{ color: envColor }}>
              {env}
            </span>
            <span className="conn-eng">Typesense</span>
          </div>
        </div>
        <LanguageChip />
        <IconBtn
          icon="power_settings_new"
          title="Close workspace"
          onClick={onCloseWorkspace}
          size={16}
          danger
        />
      </div>

      <div className="schema-row">
        <div className="ts-cluster-pill" title={nodeCount + (nodeCount === 1 ? " node" : " nodes")}>
          <span className={"ts-health" + (healthy ? "" : " bad")} />
          <span>{nodeCount}-node cluster</span>
          {version ? <span className="ts-cluster-ver">v{version}</span> : null}
        </div>
        <IconBtn
          icon="search"
          title="Search playground (⌘T)"
          onClick={() => onOpenSearch(coll)}
          disabled={!coll}
        />
        <IconBtn icon="monitoring" title="Cluster dashboard" onClick={onOpenDashboard} />
        {/* `sync` last, matching every other engine's sidebar (Cassandra, Mongo,
            Dynamo, Redis all end their header row with it). */}
        <IconBtn
          icon="sync"
          title="Refresh"
          onClick={onRefresh}
          className={refreshing ? "sidebar-sync-spinning" : undefined}
        />
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
        <input
          placeholder="Filter collections…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="sidebar-section-label">
        <span>Collections</span>
        <span className="sidebar-count">{collections.length}</span>
      </div>
      <div className="sidebar-tables">
        {shownCollections.map((c) => (
          <div
            key={c.name}
            className={"table-item" + (c.name === coll ? " active" : "")}
            onClick={() => onOpenSearch(c.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, coll: c.name });
            }}
          >
            <Icon
              name="database"
              size={13}
              style={{ color: c.name === coll ? "var(--accent)" : "var(--text-faint)" }}
            />
            <span className="table-item-name">{c.name}</span>
            <span className="ts-side-count">{tsCount(c.numDocuments)}</span>
          </div>
        ))}
        {shownCollections.length === 0 ? (
          <div className="sidebar-nomatch">
            {collections.length === 0
              ? adminKey
                ? "This cluster has no collections yet"
                : // A scoped key's allowed collections are baked into the key and
                  // Typesense exposes no way to read them back, so there is
                  // genuinely nothing to list. Say why rather than looking broken.
                  "A search-only key cannot list collections. Set a default collection on the connection to browse one."
              : "No collections match “" + q + "”"}
          </div>
        ) : null}
      </div>

      {aliases.length > 0 ? (
        <>
          <div className="sidebar-section-label">
            <span>Aliases</span>
            <span className="sidebar-count">{aliases.length}</span>
          </div>
          <div className="sidebar-tables ts-alias-list">
            {shownAliases.map((a) => (
              <div
                key={a.name}
                className="table-item"
                onClick={() => onOpenSearch(a.collectionName)}
                title={a.name + " → " + a.collectionName}
              >
                <Icon name="link" size={13} style={{ color: "var(--text-faint)" }} />
                <span className="table-item-name">{a.name}</span>
                <span className="ts-alias-target">{a.collectionName}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="ts-side-nav">
        {SECTIONS.map((s) => (
          <button
            key={s.kind}
            type="button"
            className={"ts-nav-btn" + (activeKind === s.kind ? " active" : "")}
            onClick={() => onOpenSection(s.kind)}
          >
            <Icon name={s.icon} size={14} /> {s.label}
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <Btn
          icon="terminal"
          variant="tonal"
          onClick={onOpenConsole}
          style={{ width: "100%", justifyContent: "center" }}
        >
          HTTP console
        </Btn>
      </div>

      {ctxMenu ? (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="ctx-item"
            onClick={() => {
              onOpenSearch(ctxMenu.coll);
              setCtxMenu(null);
            }}
          >
            <Icon name="search" size={15} /> Search playground
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              onOpenSection("schema", ctxMenu.coll);
              setCtxMenu(null);
            }}
          >
            <Icon name="schema" size={15} /> Schema
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              onOpenSection("docs", ctxMenu.coll);
              setCtxMenu(null);
            }}
          >
            <Icon name="data_object" size={15} /> Documents
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              onOpenSection("curation", ctxMenu.coll);
              setCtxMenu(null);
            }}
          >
            <Icon name="tune" size={15} /> Curation
          </div>
        </div>
      ) : null}
    </aside>
  );
}
