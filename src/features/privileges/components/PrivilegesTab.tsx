// Privileges tab (M39) — the connection's users, roles and logins on the left,
// and for the selected principal an effective-grants matrix, its role
// membership, and its engine-specific attributes on the right.
//
// READ-ONLY. Nothing here can grant or revoke; the backend exposes no command
// that mutates. The editor is a later milestone.
//
// No prototype exists for this feature (every earlier milestone had a
// `bytetable/*.jsx` to match), so the shell is composed from the established
// patterns: the Processes tab's toolbar/footer chrome and the object explorer's
// left-list / right-detail split.

import { useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import type { Engine } from "../../../shared/types";
import { tablesKey, useIntrospectionStore } from "../../introspection/state";
import {
  PRIV_SOURCES,
  privilegeSnapshot,
  type Principal,
  type PrivilegeSnapshot,
  type PrivilegeState,
} from "../api";
import { fillCell, grantsByGrantee, matrixObjects, roleChainsFor } from "../matrix";
import "./Privileges.css";

/** The glyph each cell state renders as. */
const STATE_GLYPH: Record<PrivilegeState, string> = {
  none: "—",
  granted: "●",
  grantable: "◎",
  denied: "✕",
};

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
  schemaName,
}: {
  handleId: string;
  engine: Engine;
  /** The schema the matrix is scoped to — database-wide and wildcard grants
   *  still come back, but object rows are this schema's. */
  schemaName: string;
}) {
  const tr = useT();
  const cfg = PRIV_SOURCES[engine];

  // Matrix rows come from the schema's already-introspected table list. It may
  // legitimately be empty (the sidebar has not expanded this schema yet), in
  // which case `matrixObjects` still yields every object a grant names.
  const tablesMap = useIntrospectionStore((state) => state.tables);
  const tables = useMemo(
    () => (tablesMap[tablesKey(handleId, schemaName)]?.tables ?? []).map((t) => t.name),
    [tablesMap, handleId, schemaName],
  );

  const [snapshot, setSnapshot] = useState<PrivilegeSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [effective, setEffective] = useState(true);
  const [pane, setPane] = useState<Pane>("grants");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // A ref so the refresh button always calls the latest closure.
  const refresh = useRef<() => void>(() => {});
  refresh.current = () => {
    void (async () => {
      try {
        const next = await privilegeSnapshot(handleId, schemaName, effective);
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
    refresh.current();
  }, [handleId, schemaName, effective, cfg]);

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
    () => matrixObjects(tables, currentGrants, schemaName),
    [tables, currentGrants, schemaName],
  );
  const roles = useMemo(
    () => (current ? roleChainsFor(snapshot?.memberships ?? [], current.name) : []),
    [snapshot, current],
  );

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
        <IconBtn icon="refresh" title={tr("priv.refreshNow")} onClick={() => refresh.current()} />
      </div>

      {snapshot?.truncated ? (
        <div className="priv-warn">
          <Icon name="warning" size={14} /> {tr("priv.truncated")}
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
                  <span className="priv-scope" title={tr("priv.scopeTitle")}>
                    {schemaName}
                  </span>
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
                      <Icon name="table" size={22} /> {tr("priv.noObjects", { schema: schemaName })}
                    </div>
                  ) : (
                    <GrantMatrix
                      privileges={cfg.privileges}
                      objects={objects}
                      schema={schemaName}
                      grants={currentGrants}
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

      <div className="priv-foot">
        <span>{tr("priv.foot", { schema: schemaName })}</span>
        <div style={{ flex: 1 }}></div>
        <span className="dim">{effective ? tr("priv.footEffective") : tr("priv.footDirect")}</span>
      </div>
    </div>
  );
}

/** The object × privilege grid for one principal. */
function GrantMatrix({
  privileges,
  objects,
  schema,
  grants,
}: {
  privileges: string[];
  objects: string[];
  schema: string;
  grants: Parameters<typeof fillCell>[0];
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
}: {
  object: string;
  privileges: string[];
  schema: string;
  grants: Parameters<typeof fillCell>[0];
}) {
  const tr = useT();
  return (
    <>
      <div className="priv-mc priv-mc-obj" title={schema + "." + object}>
        {object}
      </div>
      {privileges.map((privilege) => {
        const cell = fillCell(grants, schema, object, privilege);
        if (!cell) {
          return (
            <div className="priv-mc none" key={privilege}>
              {STATE_GLYPH.none}
            </div>
          );
        }
        // The tooltip is the whole point of the effective view: a cell that
        // cannot say where its grant came from is no better than the direct
        // list it replaced.
        const parts = [privilege + " · " + tr(STATE_KEY[cell.state])];
        if (cell.via.length) parts.push(tr("priv.viaChain", { chain: cell.via.join(" → ") }));
        if (cell.wildcard) parts.push(tr("priv.viaWildcard"));
        return (
          <div
            className={
              "priv-mc " +
              cell.state +
              (cell.wildcard ? " wild" : "") +
              (cell.via.length ? " inh" : "")
            }
            key={privilege}
            title={parts.join("\n")}
          >
            {STATE_GLYPH[cell.state]}
          </div>
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
