// Privileges tab (M39) — the connection's users, roles and logins on the left,
// and for the selected principal an effective-grants matrix, its role
// membership, and its engine-specific attributes on the right.
//
// Phase 2 adds the editor: matrix cells cycle through the states the ENGINE
// can write (see `capabilities`), staged changes collect in a bar, and nothing
// reaches the database until the Review SQL modal is confirmed.
//
// No prototype exists for this feature (every earlier milestone had a
// `bytetable/*.jsx` to match), so the shell is composed from the established
// patterns: the Processes tab's toolbar/footer chrome and the object explorer's
// left-list / right-detail split.

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Select } from "../../../shared/ui/Select";
import { useReadOnly } from "../../../shared/ui/readOnlyContext";
import { useToast } from "../../../shared/ui/toastContext";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { normalizeEnv } from "../../../shared/types";
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import type { Engine } from "../../../shared/types";
import { tablesKey, useIntrospectionStore } from "../../introspection/state";
import {
  PRIV_SOURCES,
  privilegeSnapshot,
  type GrantCapabilities,
  type Principal,
  type PrivilegeSnapshot,
  type PrivilegeState,
} from "../api";
import { fillCell, grantsByGrantee, matrixObjects, roleChainsFor } from "../matrix";
import { cellKey, stagedOps, type StagedCell } from "../edit";
import { STATE_GLYPH } from "../glyphs";
import { CellMenu, type CellMenuTarget } from "./CellMenu";
import { PrincipalModal, type PrincipalModalMode } from "./PrincipalModal";
import { GrantReviewModal } from "./GrantReviewModal";
import "./Privileges.css";

/** Cell-state labels, as a table rather than a built key, so a renamed string
 *  is a type error instead of a missing translation at runtime. */
const STATE_KEY: Record<PrivilegeState, StringKey> = {
  none: "priv.state.none",
  granted: "priv.state.granted",
  grantable: "priv.state.grantable",
  denied: "priv.state.denied",
};

type Pane = "grants" | "membership" | "attributes";

const PANE_KEY: Record<Pane, StringKey> = {
  grants: "priv.pane.grants",
  membership: "priv.pane.membership",
  attributes: "priv.pane.attributes",
};

export function PrivilegesTab({
  handleId,
  engine,
  env,
  schemaName,
  schemas = [],
}: {
  handleId: string;
  engine: Engine;
  /** Connection deployment env — drives the editor's production arming gate. */
  env: string;
  /** The workspace's current schema — the tab's starting scope. */
  schemaName: string;
  /** Every schema on the connection, for the tab's own scope switcher. */
  schemas?: string[];
}) {
  const tr = useT();
  const toast = useToast();
  const readOnly = useReadOnly();
  const envColor = ENV_COLOR[normalizeEnv(env)] ?? ENV_COLOR.dev;
  const cfg = PRIV_SOURCES[engine];

  // The matrix's own scope. It follows the workspace's schema until the tab's
  // switcher is used, after which the tab holds its own — so you can audit
  // `analytics` grants while browsing `public` tables.
  const [scope, setScope] = useState(schemaName);
  // Follow the workspace when it moves, unless this tab has been pointed
  // somewhere else deliberately.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinned) setScope(schemaName);
  }, [schemaName, pinned]);

  // Matrix rows come from the schema's already-introspected table list. It may
  // legitimately be empty (the sidebar has not expanded this schema yet), in
  // which case `matrixObjects` still yields every object a grant names.
  const tablesMap = useIntrospectionStore((state) => state.tables);
  const tables = useMemo(
    () => (tablesMap[tablesKey(handleId, scope)]?.tables ?? []).map((t) => t.name),
    [tablesMap, handleId, scope],
  );

  const [snapshot, setSnapshot] = useState<PrivilegeSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [effective, setEffective] = useState(true);
  const [pane, setPane] = useState<Pane>("grants");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Staged cell edits, keyed by object + privilege. Nothing here has touched
  // the database — `stagedOps` turns them into ops only for preview/apply.
  const [staged, setStaged] = useState<Map<string, StagedCell>>(() => new Map());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [principalModal, setPrincipalModal] = useState<PrincipalModalMode | null>(null);

  // A ref so the refresh button always calls the latest closure.
  const refresh = useRef<() => void>(() => {});
  refresh.current = () => {
    void (async () => {
      try {
        const next = await privilegeSnapshot(handleId, scope, effective);
        setSnapshot(next);
        setError(null);
      } catch (err) {
        setSnapshot(null);
        setError(appErrorMessage(err, tr("priv.err.read")));
      } finally {
        setLoaded(true);
      }
    })();
  };

  // Reload on connection, schema or mode change. No auto-refresh: privileges
  // do not churn the way sessions do, and a poll would fight the selection.
  useEffect(() => {
    if (!cfg) return;
    setLoaded(false);
    // Staged edits are keyed to the rows they were made against; dropping them
    // on a reload is safer than replaying them onto data that may have moved.
    setStaged(new Map());
    refresh.current();
  }, [handleId, scope, effective, cfg]);

  // Memoised rather than derived inline: these feed the hooks below, and a
  // fresh array identity each render would re-run every one of them.
  const principals = useMemo(() => snapshot?.principals ?? [], [snapshot]);
  const byGrantee = useMemo(() => grantsByGrantee(snapshot?.grants ?? []), [snapshot]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return principals;
    return principals.filter((p) => p.name.toLowerCase().includes(q));
  }, [principals, query]);

  // Keep a valid selection across refreshes; default to the first account that
  // can actually log in, which is nearly always what someone came to check.
  useEffect(() => {
    if (!principals.length) return;
    if (selected && principals.some((p) => p.name === selected)) return;
    const first = principals.find((p) => p.canLogin) ?? principals[0];
    if (first) setSelected(first.name);
  }, [principals, selected]);

  const current = principals.find((p) => p.name === selected) ?? null;
  const currentGrants = useMemo(
    () => (current ? (byGrantee.get(current.name) ?? []) : []),
    [current, byGrantee],
  );
  const objects = useMemo(
    () => matrixObjects(tables, currentGrants, scope),
    [tables, currentGrants, scope],
  );
  const roles = useMemo(
    () => (current ? roleChainsFor(snapshot?.memberships ?? [], current.name) : []),
    [snapshot, current],
  );

  // Until the snapshot lands, assume the most RESTRICTIVE engine: no deny, and
  // no narrowing of a wildcard grant. A permissive default would briefly offer
  // edits the engine cannot perform.
  const capabilities: GrantCapabilities = snapshot?.capabilities ?? {
    canDeny: false,
    atomic: true,
    canNarrowWildcard: false,
  };
  // Editing works in BOTH views. Gating it to `effective` was backwards: the
  // direct view is the SAFER surface to edit, because every cell there is a
  // grant written against this principal. In the effective view an inherited
  // cell belongs to a role, and the cell menu refuses to narrow it (see
  // `blockedReason`) rather than emitting a revoke that would do nothing.
  const editable = !readOnly && !!current && !current.isSuperuser;
  const pendingOps = useMemo(
    () => (current ? stagedOps(staged, current.name, scope) : []),
    [staged, current, scope],
  );

  // The open cell menu. Explicit state selection, not a click-through cycle:
  // cycling made `granted → grantable` (i.e. WITH GRANT OPTION) a single stray
  // click away, so a misclick ESCALATED privilege.
  const [menu, setMenu] = useState<CellMenuTarget | null>(null);

  const openCellMenu = (
    e: ReactMouseEvent,
    object: string,
    privilege: string,
    from: PrivilegeState,
    wildcard: boolean,
    coveredByWider: boolean,
    via: string[],
  ) => {
    if (!editable) return;
    const key = cellKey(object, privilege);
    const staging = staged.get(key);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      object,
      privilege,
      // The ORIGINAL state, so re-picking it clears the staged change rather
      // than staging a move from the pending value.
      from: staging?.from ?? from,
      current: staging?.to ?? from,
      wildcard,
      coveredByWider,
      via,
    });
  };

  const chooseState = (target: CellMenuTarget, to: PrivilegeState) => {
    setStaged((prev) => {
      const next = new Map(prev);
      const key = cellKey(target.object, target.privilege);
      if (to === target.from) next.delete(key);
      else
        next.set(key, {
          object: target.object,
          privilege: target.privilege,
          from: target.from,
          to,
        });
      return next;
    });
    setMenu(null);
  };

  const onApplied = (statements: string[]) => {
    setStaged(new Map());
    toast(tr("priv.applied", { count: statements.length }), "ok");
    refresh.current();
  };

  // Engines whose privileges ByteTable does not read — a different model, not
  // a missing one. See PRIV_SOURCES.
  if (!cfg) {
    return (
      <div className="priv-tab">
        <div className="empty-state">
          <Icon name="admin_panel_settings" size={40} style={{ color: "var(--text-faint)" }} />
          <p>{tr("priv.noCatalog")}</p>
          <span>{tr("priv.noCatalogBody", { engine: engineLabel(engine) })}</span>
        </div>
      </div>
    );
  }

  const groups: { key: string; label: string; items: Principal[] }[] = [
    {
      key: "users",
      label: tr("priv.group.users"),
      items: filtered.filter((p) => p.kind === "user"),
    },
    {
      key: "roles",
      label: tr("priv.group.roles"),
      items: filtered.filter((p) => p.kind === "role"),
    },
    {
      key: "logins",
      label: tr("priv.group.logins"),
      items: filtered.filter((p) => p.kind === "login"),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="priv-tab" data-screen-label="Privileges">
      <div className="priv-toolbar">
        <Icon name="admin_panel_settings" size={16} style={{ color: "var(--accent)" }} />
        <span className="priv-title">{tr("priv.title")}</span>
        <span className="priv-src" title={tr("priv.source")}>
          {cfg.src}
        </span>
        <div className="priv-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            placeholder={tr("priv.filterPlaceholder")}
            spellCheck="false"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button className="priv-search-x" onClick={() => setQuery("")}>
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>
        <div style={{ flex: 1 }}></div>
        <span className="priv-stat">
          <b>{principals.length}</b> {tr("priv.principals")}
        </span>
        {/* Direct = what the catalog literally records. Effective = that plus
            role inheritance, with each grant's chain recorded. */}
        <div className="priv-seg" role="group" aria-label={tr("priv.mode")}>
          <button
            className={effective ? "" : "on"}
            onClick={() => setEffective(false)}
            title={tr("priv.directTitle")}
          >
            {tr("priv.direct")}
          </button>
          <button
            className={effective ? "on" : ""}
            onClick={() => setEffective(true)}
            title={tr("priv.effectiveTitle")}
          >
            {tr("priv.effective")}
          </button>
        </div>
        {readOnly ? null : (
          <IconBtn
            icon="person_add"
            title={tr("priv.new.title")}
            onClick={() => setPrincipalModal({ kind: "create" })}
          />
        )}
        <IconBtn icon="refresh" title={tr("priv.refreshNow")} onClick={() => refresh.current()} />
      </div>

      {snapshot?.truncated ? (
        <div className="priv-warn">
          <Icon name="warning" size={14} /> {tr("priv.truncated")}
        </div>
      ) : null}

      {pendingOps.length ? (
        <div className="priv-staged">
          <Icon name="edit" size={14} />
          <span>{tr("priv.staged", { count: staged.size, ops: pendingOps.length })}</span>
          <button className="priv-clear" onClick={() => setStaged(new Map())}>
            {tr("priv.discard")}
          </button>
          <div style={{ flex: 1 }}></div>
          <button className="btn btn-filled priv-review-btn" onClick={() => setReviewOpen(true)}>
            <Icon name="code" size={15} /> <span>{tr("priv.reviewSql")}</span>
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="priv-body">
          <div className="dg-empty-body">
            <span className="dg-error">
              <Icon name="error" size={22} /> {error}
            </span>
          </div>
        </div>
      ) : !loaded ? (
        <div className="priv-body">
          <div className="dg-empty-body">
            <Icon name="autorenew" size={22} /> {tr("priv.loading")}
          </div>
        </div>
      ) : (
        <div className="priv-body">
          <div className="priv-list">
            {groups.length === 0 ? (
              <div className="priv-list-empty">
                <Icon name="search_off" size={18} />
                <span>{tr("priv.noMatch", { query })}</span>
              </div>
            ) : (
              groups.map((group) => (
                <div className="priv-group" key={group.key}>
                  <div className="priv-group-h">{group.label}</div>
                  {group.items.map((p) => (
                    <button
                      key={p.scope + "/" + p.name}
                      className={"priv-row" + (p.name === selected ? " sel" : "")}
                      onClick={() => setSelected(p.name)}
                    >
                      <Icon
                        name={p.kind === "role" ? "group" : p.kind === "login" ? "key" : "person"}
                        size={14}
                      />
                      <span className="priv-row-name">{p.name}</span>
                      {p.isSuperuser ? (
                        <span className="priv-badge su" title={tr("priv.superuserTitle")}>
                          {tr("priv.superuser")}
                        </span>
                      ) : null}
                      {!p.canLogin && p.kind !== "role" ? (
                        <span className="priv-badge">{tr("priv.noLogin")}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="priv-detail">
            {!current ? (
              <div className="dg-empty-body">
                <Icon name="admin_panel_settings" size={22} /> {tr("priv.noPrincipals")}
              </div>
            ) : (
              <>
                <div className="priv-panes">
                  {(["grants", "membership", "attributes"] as Pane[]).map((key) => (
                    <button
                      key={key}
                      className={"priv-pane-btn" + (pane === key ? " on" : "")}
                      onClick={() => setPane(key)}
                    >
                      {tr(PANE_KEY[key])}
                      {key === "membership" && roles.length ? (
                        <span className="priv-pane-n">{roles.length}</span>
                      ) : null}
                    </button>
                  ))}
                  <div style={{ flex: 1 }}></div>
                  {/* The scope switcher. A static chip here was a trap: the
                      tab froze the schema it was opened on, so the matrix
                      could silently describe a different schema than the one
                      the sidebar showed. */}
                  {schemas.length > 1 ? (
                    <Select
                      value={scope}
                      options={schemas.map((name) => ({ value: name, label: name }))}
                      onChange={(name) => {
                        setScope(name);
                        // Picking explicitly detaches the tab from the
                        // workspace's schema; "same as the workspace" re-attaches.
                        setPinned(name !== schemaName);
                        setStaged(new Map());
                      }}
                      className="priv-scope-select"
                      title={tr("priv.scopeTitle")}
                      aria-label={tr("priv.scopeTitle")}
                    />
                  ) : (
                    <span className="priv-scope" title={tr("priv.scopeTitle")}>
                      {scope}
                    </span>
                  )}
                  {readOnly ? null : (
                    <IconBtn
                      icon="person_remove"
                      title={tr("priv.drop.title", { name: current.name })}
                      onClick={() => setPrincipalModal({ kind: "drop", principal: current })}
                    />
                  )}
                </div>

                {pane === "grants" ? (
                  current.isSuperuser ? (
                    // Expanding a matrix for a superuser would look
                    // authoritative while omitting nearly everything: the
                    // catalog does not record implicit superuser rights at all.
                    <div className="empty-state">
                      <Icon name="shield_person" size={36} style={{ color: "var(--accent)" }} />
                      <p>{tr("priv.superuserHead", { name: current.name })}</p>
                      <span>{tr("priv.superuserBody")}</span>
                    </div>
                  ) : objects.length === 0 ? (
                    <div className="dg-empty-body">
                      <Icon name="table" size={22} /> {tr("priv.noObjects", { schema: scope })}
                    </div>
                  ) : (
                    <GrantMatrix
                      privileges={cfg.privileges}
                      objects={objects}
                      schema={scope}
                      grants={currentGrants}
                      staged={staged}
                      editable={editable}
                      onOpenMenu={openCellMenu}
                    />
                  )
                ) : pane === "membership" ? (
                  <div className="priv-pane-body">
                    {roles.length === 0 ? (
                      <div className="dg-empty-body">
                        <Icon name="group_off" size={22} /> {tr("priv.noRoles")}
                      </div>
                    ) : (
                      <ul className="priv-roles">
                        {roles.map((r) => (
                          <li key={r.role} style={{ paddingLeft: (r.depth - 1) * 18 }}>
                            <Icon name="subdirectory_arrow_right" size={13} />
                            <span className="priv-role-name">{r.role}</span>
                            <span className="priv-role-depth">
                              {r.depth === 1 ? tr("priv.direct") : tr("priv.hops", { n: r.depth })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <div className="priv-pane-body">
                    {current.attributes.length === 0 ? (
                      <div className="dg-empty-body">
                        <Icon name="info" size={22} /> {tr("priv.noAttributes")}
                      </div>
                    ) : (
                      <dl className="priv-attrs">
                        {current.attributes.map((a) => (
                          <div key={a.key}>
                            <dt>{a.key}</dt>
                            <dd>{a.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {menu ? (
        <CellMenu
          target={menu}
          capabilities={capabilities}
          onChoose={chooseState}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {principalModal ? (
        <PrincipalModal
          handleId={handleId}
          engine={engine}
          mode={principalModal}
          env={env}
          envColor={envColor}
          onDone={(statements) => {
            // A dropped principal may be the selected one; clearing the
            // selection lets the refresh pick a valid default.
            if (principalModal.kind === "drop") setSelected(null);
            toast(tr("priv.applied", { count: statements.length }), "ok");
            refresh.current();
          }}
          onClose={() => setPrincipalModal(null)}
        />
      ) : null}

      {reviewOpen && current ? (
        <GrantReviewModal
          handleId={handleId}
          ops={pendingOps}
          capabilities={capabilities}
          env={env}
          envColor={envColor}
          onApplied={onApplied}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}

      <div className="priv-foot">
        <span>{tr("priv.foot", { schema: scope })}</span>
        {/* The glyph language is not guessable — eight symbols across four
            states and two derivations — so it is spelled out rather than left
            to tooltips. */}
        <span className="priv-legend">
          <b className="granted">●</b> {tr("priv.state.granted")}
          <b className="grantable">◎</b> {tr("priv.legend.grantable")}
          {capabilities.canDeny ? (
            <>
              <b className="denied">✕</b> {tr("priv.state.denied")}
            </>
          ) : null}
          <b className="granted wild">●</b> {tr("priv.legend.wildcard")}
        </span>
        <div style={{ flex: 1 }}></div>
        <span className="dim">{effective ? tr("priv.footEffective") : tr("priv.footDirect")}</span>
      </div>
    </div>
  );
}

/** How a cell asks for its state menu. */
type CellMenuOpener = (
  e: ReactMouseEvent,
  object: string,
  privilege: string,
  from: PrivilegeState,
  wildcard: boolean,
  coveredByWider: boolean,
  via: string[],
) => void;

/** The object × privilege grid for one principal. */
function GrantMatrix({
  privileges,
  objects,
  schema,
  grants,
  staged,
  editable,
  onOpenMenu,
}: {
  privileges: string[];
  objects: string[];
  schema: string;
  grants: Parameters<typeof fillCell>[0];
  staged: Map<string, StagedCell>;
  editable: boolean;
  onOpenMenu: CellMenuOpener;
}) {
  const tr = useT();
  const template = "minmax(160px, 1.4fr) " + privileges.map(() => "minmax(64px, 1fr)").join(" ");

  return (
    <div className="priv-matrix-wrap">
      <div className="priv-matrix" style={{ gridTemplateColumns: template }}>
        <div className="priv-mh priv-mh-obj">{tr("priv.col.object")}</div>
        {privileges.map((p) => (
          <div className="priv-mh" key={p} title={p}>
            {p}
          </div>
        ))}
        {objects.map((object) => (
          <Row
            key={object}
            object={object}
            privileges={privileges}
            schema={schema}
            grants={grants}
            staged={staged}
            editable={editable}
            onOpenMenu={onOpenMenu}
          />
        ))}
      </div>
    </div>
  );
}

function Row({
  object,
  privileges,
  schema,
  grants,
  staged,
  editable,
  onOpenMenu,
}: {
  object: string;
  privileges: string[];
  schema: string;
  grants: Parameters<typeof fillCell>[0];
  staged: Map<string, StagedCell>;
  editable: boolean;
  onOpenMenu: CellMenuOpener;
}) {
  const tr = useT();
  return (
    <>
      <div className="priv-mc priv-mc-obj" title={schema + "." + object}>
        {object}
      </div>
      {privileges.map((privilege) => {
        const cell = fillCell(grants, schema, object, privilege);
        const actual: PrivilegeState = cell?.state ?? "none";
        const pending = staged.get(cellKey(object, privilege));
        // A staged cell shows what it WILL be, not what it is — with the
        // original kept in the tooltip so the change stays legible.
        const shown = pending ? pending.to : actual;

        const parts = [privilege + " · " + tr(STATE_KEY[shown])];
        if (pending) parts.push(tr("priv.wasState", { state: tr(STATE_KEY[pending.from]) }));
        if (!pending && cell?.via.length) {
          parts.push(tr("priv.viaChain", { chain: cell.via.join(" → ") }));
        }
        if (!pending && cell?.wildcard) parts.push(tr("priv.viaWildcard"));
        if (editable) parts.push(tr("priv.clickToChange"));

        // Derivation never changes the glyph — fill means held, full stop. A
        // staged cell is not derived at all: once you ask for it, the grant
        // will name this object.
        const wildcard = !pending && !!cell?.wildcard;

        const className = [
          "priv-mc",
          shown,
          pending ? "staged" : "",
          wildcard ? "wild" : "",
          !pending && cell?.via.length ? "inh" : "",
          editable ? "editable" : "",
        ]
          .filter(Boolean)
          .join(" ");

        // A non-editable matrix stays a plain div: a disabled button would
        // still take focus and imply an affordance that is not there.
        if (!editable) {
          return (
            <div className={className} key={privilege} title={parts.join("\n")}>
              {STATE_GLYPH[shown]}
            </div>
          );
        }
        return (
          <button
            type="button"
            className={className}
            key={privilege}
            title={parts.join("\n")}
            onClick={(e) =>
              onOpenMenu(
                e,
                object,
                privilege,
                actual,
                wildcard,
                !!cell?.coveredByWider,
                cell?.via ?? [],
              )
            }
          >
            {STATE_GLYPH[shown]}
          </button>
        );
      })}
    </>
  );
}

/** Display name for the engines with no privilege catalog. */
function engineLabel(engine: Engine): string {
  const names: Partial<Record<Engine, string>> = {
    sqlite: "SQLite",
    redis: "Redis",
    mongodb: "MongoDB",
    cassandra: "Cassandra",
    dynamodb: "DynamoDB",
    typesense: "Typesense",
  };
  return names[engine] ?? engine;
}
