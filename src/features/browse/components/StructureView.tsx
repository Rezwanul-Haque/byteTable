// Read-only table structure view (spec §3.6) — the Structure mode of a table
// tab, ported from the prototype's `StructureView` (structure.jsx) MINUS the
// v4 editing affordances (inline rename/type/nullable/default, add/drop, the
// pending-changes bar): those are M8. Here every column row is static and the
// rail/DDL are display-only.
//
// Layout: a non-scrolling header (tree icon + schema.table + comment + count
// chips), then a two-pane body — the left columns pane (own vertical scroll,
// sticky pane-head with a live filter) and the right 348px rail (own scroll,
// tinted bg: Indexes / Foreign keys / Referenced by / DDL). The 64-column
// acceptance rides on each pane owning its overflow (`.columns-scroll` and
// `.structure-rail`) inside the fixed `1fr 348px` grid, so columns scroll
// while the rail stays put and keeps its width.
//
// Data: the full TableMeta comes from the introspection cache via
// `loadTableMeta` (one round-trip, cached per handle+schema+table). The rows
// count chip reuses this tab's `tabMeta.totalRows` when the data grid has
// already fetched it (warmed when the user has visited Data mode); it is
// omitted otherwise rather than firing a COUNT just for the chip.
//
// M8 SEAMS: where the editing build will hook in is marked `M8:` below —
// the column rows (currently static cells) gain inline editors, an
// "+ Add column" button joins the pane head, a trash action joins each row,
// and a pending-changes bar mounts under the body. None of that is built here.

import { useEffect, useMemo, useState } from "react";

import { highlightSql } from "../highlightSql";
import { useIntrospectionStore, tableMetaKey } from "../../introspection/state";
import { useTabMetaStore } from "../../workspaces/tabMeta";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import "./StructureView.css";

interface StructureViewProps {
  handleId: string;
  /** This tab's id — used to read the warmed row count from tabMeta. */
  tabId: string;
  schema: string;
  table: string;
  /** Connection's first schema; the prefix is dropped for it (tab-title rule). */
  defaultSchema: string;
}

export function StructureView({
  handleId,
  tabId,
  schema,
  table,
  defaultSchema,
}: StructureViewProps) {
  const toast = useToast();
  const [colQuery, setColQuery] = useState("");
  const [ddlOpen, setDdlOpen] = useState(false);

  const loadTableMeta = useIntrospectionStore((state) => state.loadTableMeta);
  const key = tableMetaKey(handleId, schema, table);
  const entry = useIntrospectionStore((state) => state.tableMetas[key]);
  const loading = useIntrospectionStore((state) => state.loading[key] ?? false);
  const error = useIntrospectionStore((state) => state.errors[key]);

  // Rows count chip: reuse this tab's warmed total when the grid has fetched
  // it (Data mode visited); omit otherwise — no COUNT fired just for the chip.
  const totalRows = useTabMetaStore((state) => state.meta[tabId]?.totalRows);

  useEffect(() => {
    void loadTableMeta(handleId, schema, table);
  }, [loadTableMeta, handleId, schema, table]);

  const meta = entry?.meta ?? null;

  const qualified = schema === defaultSchema ? table : schema + "." + table;

  // inbound references (from the backend's referencedBy — same-schema FKs).
  const inbound = meta?.referencedBy ?? [];

  const q = colQuery.trim().toLowerCase();
  const allColumns = meta?.columns;
  const filteredCols = useMemo(() => {
    const cols = allColumns ?? [];
    return q
      ? cols.filter(
          (c) => c.name.toLowerCase().includes(q) || c.dataType.toLowerCase().includes(q),
        )
      : cols;
  }, [allColumns, q]);

  const ddl = meta?.ddl ?? "";
  const ddlLines = ddl ? ddl.split("\n").length : 0;
  const copyDdl = () => {
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(ddl);
    toast("DDL copied to clipboard", "ok");
  };

  // --- error / loading states (§5 inline red; no modal) ------------------
  if (error && !meta) {
    return (
      <div className="structure-view">
        <div className="dg-state">
          <Icon name="error" size={28} style={{ color: "#e06c75" }} />
          <div className="dg-error">
            Could not load table structure.
            <code>{error}</code>
          </div>
          <button
            type="button"
            className="dg-retry"
            onClick={() => void loadTableMeta(handleId, schema, table)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (loading && !meta) {
    return (
      <div className="structure-view">
        <div className="dg-state">
          <Icon name="account_tree" size={28} style={{ opacity: 0.5 }} />
          <span>Loading structure of {qualified}…</span>
        </div>
      </div>
    );
  }

  if (!meta) {
    // Not yet started (effect runs after first paint) — render nothing
    // structural to avoid a flash of empty panes.
    return <div className="structure-view" />;
  }

  return (
    <div className="structure-view">
      <div className="structure-head">
        <Icon name="account_tree" size={20} style={{ color: "var(--accent)" }} />
        <h2>{qualified}</h2>
        {meta.comment ? <span className="structure-sub">{meta.comment}</span> : null}
        <div style={{ flex: 1 }} />
        <div className="structure-chips">
          <span className="structure-chip">
            <b>{meta.columns.length}</b> columns
          </span>
          <span className="structure-chip">
            <b>{meta.indexes.length}</b> indexes
          </span>
          <span className="structure-chip">
            <b>{meta.foreignKeys.length}</b> FKs
          </span>
          <span className="structure-chip">
            <b>{inbound.length}</b> referenced by
          </span>
          {typeof totalRows === "number" ? (
            <span className="structure-chip">
              <b>{totalRows.toLocaleString()}</b> rows
            </span>
          ) : null}
        </div>
      </div>

      <div className="structure-body">
        <section className="columns-pane">
          <div className="columns-pane-head">
            <h3>
              <Icon name="view_column" size={15} /> Columns
            </h3>
            <div className="columns-search">
              <Icon name="search" size={14} style={{ color: "var(--text-faint)" }} />
              <input
                aria-label={"Filter " + meta.columns.length + " columns"}
                placeholder={"Filter " + meta.columns.length + " columns…"}
                value={colQuery}
                onChange={(e) => setColQuery(e.target.value)}
                spellCheck={false}
              />
              {colQuery ? (
                <IconBtn icon="close" size={12} title="Clear" onClick={() => setColQuery("")} />
              ) : null}
            </div>
            <span className="columns-count">
              {q ? filteredCols.length + " of " + meta.columns.length : meta.columns.length}
            </span>
            {/* M8: an "+ Add column" button joins here (.add-col-btn). */}
          </div>
          <div className="columns-scroll">
            {/* Default column omitted: ColumnInfo carries no default value yet
                (a backend/M8 gap). M8: this table gains inline editors + a
                trailing trash action per row; rows are static here. */}
            <table className="structure-table">
              <thead>
                <tr>
                  <th />
                  <th>Name</th>
                  <th>Type</th>
                  <th>Nullable</th>
                </tr>
              </thead>
              <tbody>
                {filteredCols.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="grid-empty-cell">
                      No columns match “{colQuery}”
                    </td>
                  </tr>
                ) : (
                  filteredCols.map((c) => (
                    <tr key={c.name}>
                      <td className="st-icon">
                        {c.pk ? (
                          <Icon
                            name="key"
                            size={14}
                            style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
                          />
                        ) : c.fk ? (
                          <Icon name="link" size={14} style={{ color: "var(--text-faint)" }} />
                        ) : null}
                      </td>
                      <td className="st-name">
                        {c.name}
                        {c.fk ? (
                          <span className="st-fk-ref">
                            → {c.fk.table}
                            {c.fk.column ? "." + c.fk.column : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="st-type">{c.dataType.toLowerCase() || "—"}</td>
                      <td className="st-null">
                        {c.nullable ? (
                          <span className="cell-dim">NULL</span>
                        ) : (
                          <span className="cell-true">NOT NULL</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="structure-rail">
          <div className="structure-section">
            <h3>
              <Icon name="speed" size={15} /> Indexes{" "}
              <span className="rail-count">{meta.indexes.length}</span>
            </h3>
            {meta.indexes.length === 0 ? (
              <div className="structure-none">No indexes</div>
            ) : (
              meta.indexes.map((ix) => (
                <div key={ix.name} className="structure-card">
                  <div className="structure-card-name">
                    {ix.name}
                    {ix.primary ? (
                      <span className="tag tag-accent">PRIMARY</span>
                    ) : ix.unique ? (
                      <span className="tag">UNIQUE</span>
                    ) : null}
                  </div>
                  <div className="structure-card-detail">({ix.columns.join(", ")})</div>
                </div>
              ))
            )}
          </div>

          <div className="structure-section">
            <h3>
              <Icon name="link" size={15} /> Foreign keys{" "}
              <span className="rail-count">{meta.foreignKeys.length}</span>
            </h3>
            {meta.foreignKeys.length === 0 ? (
              <div className="structure-none">No foreign keys</div>
            ) : (
              meta.foreignKeys.map((fk, i) => (
                <div key={fk.name ?? "fk-" + i} className="structure-card">
                  <div className="structure-card-name">{fk.name ?? "fk"}</div>
                  <div className="structure-card-detail">
                    ({fk.columns.join(", ")}) → {fk.refTable}({fk.refColumns.join(", ")})
                    {fk.onDelete ? (
                      <span className="tag" style={{ marginLeft: 8 }}>
                        ON DELETE {fk.onDelete}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="structure-section">
            <h3>
              <Icon name="call_received" size={15} /> Referenced by{" "}
              <span className="rail-count">{inbound.length}</span>
            </h3>
            {inbound.length === 0 ? (
              <div className="structure-none">No tables reference {table}</div>
            ) : (
              inbound.map((fk, i) => (
                <div key={fk.table + "-" + i} className="structure-card">
                  <div className="structure-card-name">{fk.table}</div>
                  <div className="structure-card-detail">
                    {fk.table}({fk.columns.join(", ")}) → {table}({fk.refColumns.join(", ")})
                    {fk.onDelete ? (
                      <span className="tag" style={{ marginLeft: 8 }}>
                        ON DELETE {fk.onDelete}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="structure-section">
            <h3>
              <Icon name="code" size={15} /> DDL
              <span style={{ flex: 1 }} />
              {ddl ? (
                <>
                  <button className="ddl-copy" onClick={copyDdl} title="Copy DDL">
                    <Icon name="content_copy" size={13} /> copy
                  </button>
                  <button
                    className="ddl-copy"
                    onClick={() => setDdlOpen(true)}
                    title="View full DDL"
                  >
                    <Icon name="open_in_full" size={13} /> expand
                  </button>
                </>
              ) : null}
            </h3>
            {ddl ? (
              <div
                className="ddl-preview"
                onClick={() => setDdlOpen(true)}
                title="Click to view full DDL"
              >
                <pre
                  className="ddl-block ddl-preview-block"
                  dangerouslySetInnerHTML={{ __html: highlightSql(ddl) }}
                />
                <div className="ddl-fade">
                  <span className="ddl-fade-hint">
                    <Icon name="open_in_full" size={12} /> view all {ddlLines} lines
                  </span>
                </div>
              </div>
            ) : (
              <div className="structure-none">No DDL available</div>
            )}
          </div>
        </aside>
      </div>

      {ddlOpen ? (
        <Modal
          onClose={() => setDdlOpen(false)}
          className="ddl-modal"
          label={"DDL for " + qualified}
        >
          <ModalTitle>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Icon name="code" size={17} style={{ color: "var(--accent)" }} /> DDL · {qualified}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn icon="content_copy" variant="tonal" small onClick={copyDdl}>
                Copy
              </Btn>
              <IconBtn icon="close" onClick={() => setDdlOpen(false)} title="Close" />
            </div>
          </ModalTitle>
          <pre
            className="ddl-block ddl-modal-block"
            dangerouslySetInnerHTML={{ __html: highlightSql(ddl) }}
          />
        </Modal>
      ) : null}
    </div>
  );
}
