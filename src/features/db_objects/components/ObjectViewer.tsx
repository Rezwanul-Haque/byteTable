// ObjectViewer tab (design Prompt 3): header with a coloured class icon, name,
// type badge (+ DISABLED for disabled triggers), a metadata chip row, an
// arguments table for routines, and a syntax-highlighted DDL block with a
// dialect label. Actions: Browse data (views/matviews → opens a data tab),
// Refresh (matview), Edit definition (→ SQL editor with re-runnable DDL),
// Copy DDL, and Drop (portal confirm modal, production-gated).
//
// Chip/argument metadata comes from `DbObjectDefinition` — fields the backend
// fills best-effort per engine; each chip renders only when its value exists
// (so partial metadata degrades cleanly, exactly like the prototype).

import { useEffect, useState } from "react";

import { highlightSql } from "../../browse/shared/highlightSql";
import { formatSql } from "../../workspaces/formatSql";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { useReadOnly } from "../../../shared/ui/readOnlyContext";
import { Icon } from "../../../shared/ui/Icon";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { useToast } from "../../../shared/ui/toastContext";
import { useT } from "../../../shared/i18n/useT";
import { objectDefKey, useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Workspace } from "../../workspaces/types";
import type { DbObjectKind } from "../api";
import { runObjectDdl } from "../api";
import { editableObjectDDL, refreshMatviewSql } from "../ddl";
import { ENGINE_DIALECT, isBrowsable, OBJ_SECTIONS, typeBadge } from "../kinds";
import { ObjectDropModal } from "./ObjectDropModal";
import "./ObjectsView.css";

function Chip({
  icon,
  label,
  value,
  tone,
}: {
  icon: string;
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div
      className="obj-chip"
      style={tone ? { borderColor: `color-mix(in oklab, ${tone} 40%, var(--border))` } : undefined}
    >
      <Icon name={icon} size={12} style={{ color: tone ?? "var(--text-faint)" }} />
      <span className="obj-chip-k">{label}</span>
      <span className="obj-chip-v">{value}</span>
    </div>
  );
}

export function ObjectViewer({
  workspace,
  tabId,
  schema,
  objectKind,
  name,
  detail,
}: {
  workspace: Workspace;
  tabId: string;
  schema: string;
  objectKind: DbObjectKind;
  name: string;
  detail: string | null;
}) {
  const { handleId } = workspace;
  const engine = workspace.saved.engine;
  const env = workspace.saved.env;
  const envColor = workspace.saved.color ?? ENV_COLOR[env];
  const toast = useToast();
  const t = useT();
  const sec = OBJ_SECTIONS[objectKind];

  const loadDef = useIntrospectionStore((s) => s.loadObjectDefinition);
  const invalidateObjects = useIntrospectionStore((s) => s.invalidateObjects);
  const openTableTab = useWorkspacesStore((s) => s.openTableTab);
  const openSqlTabWith = useWorkspacesStore((s) => s.openSqlTabWith);
  const closeTab = useWorkspacesStore((s) => s.closeTab);

  const key = objectDefKey(handleId, schema, objectKind, name);
  const entry = useIntrospectionStore((s) => s.objectDefs[key]);
  const loading = useIntrospectionStore((s) => s.loading[key] ?? false);
  const error = useIntrospectionStore((s) => s.errors[key]);

  useEffect(() => {
    if (!entry && !loading && !error) void loadDef(handleId, schema, objectKind, name, detail);
  }, [entry, loading, error, loadDef, handleId, schema, objectKind, name, detail]);

  const def = entry?.def ?? null;
  const ddl = def?.ddl ?? null;
  const browsable = isBrowsable(objectKind);

  // Pretty-print the DDL UNLESS it has a compound body — a dollar-quoted block
  // (Postgres uses TAGGED quotes: `$$`, `$function$`, `$procedure$`, `$body$`…)
  // or a `BEGIN…END` block (MySQL routines/triggers). Those hold inner `;` that
  // the regex beautifier splits on and mangles; engines already return them
  // multi-line. Everything else (views, single-statement procedures/triggers/
  // functions) is often minified on one line, so format it.
  const compound = ddl !== null && (/\$[A-Za-z0-9_]*\$/.test(ddl) || /\bBEGIN\b/i.test(ddl));
  const shownDdl = ddl !== null && !compound ? formatSql(ddl) : ddl;

  const [dropOpen, setDropOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Read-only workspace: the viewer is pure reading anyway — it keeps Browse
  // data and Copy DDL, and drops Edit / Refresh / Drop.
  const readOnly = useReadOnly();

  const refresh = async () => {
    setRefreshing(true);
    try {
      await runObjectDdl(handleId, [refreshMatviewSql(engine, schema, name)]);
      toast(t("obj.refreshed", { name }), "ok");
    } catch (e) {
      toast(appErrorMessage(e, t("obj.err.refresh")), "err");
    } finally {
      setRefreshing(false);
    }
  };

  const confirmDrop = async () => {
    setDropping(true);
    try {
      const { dropObject } = await import("../api");
      await dropObject(handleId, schema, objectKind, name, detail);
      invalidateObjects(handleId, schema, objectKind);
      toast(t("obj.droppedObject", { type: typeBadge(objectKind), name }), "ok");
      setDropOpen(false);
      closeTab(tabId);
    } catch (e) {
      toast(appErrorMessage(e, t("obj.err.drop")), "err");
      setDropping(false);
    }
  };

  const onEdit = () => {
    if (ddl === null) return;
    openSqlTabWith(editableObjectDDL(engine, objectKind, schema, name, detail, ddl));
  };

  const copyDdl = () => {
    if (ddl === null) return;
    void navigator.clipboard.writeText(ddl).then(
      () => toast(t("obj.copiedClipboard"), "ok"),
      () => toast(t("uix.copy.fail"), "err"),
    );
  };

  // Chips from whatever metadata the definition carries.
  const m = def;
  const chips: { icon: string; label: string; value: string | number; tone?: string }[] = [];
  if (m) {
    if (m.returns)
      chips.push({
        icon: "output",
        label: t("obj.chip.returns"),
        value: m.returns,
        tone: sec.accent,
      });
    if (m.language) chips.push({ icon: "code", label: t("obj.chip.language"), value: m.language });
    if (m.volatility)
      chips.push({ icon: "bolt", label: t("obj.chip.volatility"), value: m.volatility });
    if (objectKind === "function" || objectKind === "procedure")
      chips.push({ icon: "data_array", label: t("obj.chip.args"), value: m.args?.length ?? 0 });
    if (m.table)
      chips.push({ icon: "table", label: t("obj.chip.table"), value: m.table, tone: sec.accent });
    if (m.timing) chips.push({ icon: "schedule", label: t("obj.chip.timing"), value: m.timing });
    if (m.events && m.events.length)
      chips.push({ icon: "flash_on", label: t("obj.chip.events"), value: m.events.join(", ") });
    if (m.level)
      chips.push({
        icon: "layers",
        label: t("obj.chip.level"),
        value: t("obj.chip.levelValue", { level: m.level }),
      });
    if (m.populated !== null && m.populated !== undefined)
      chips.push({
        icon: "check_circle",
        label: t("obj.chip.populated"),
        value: m.populated ? t("obj.chip.yes") : t("obj.chip.no"),
        tone: sec.accent,
      });
    if (m.approxRows !== null && m.approxRows !== undefined)
      chips.push({ icon: "tag", label: t("obj.chip.rows"), value: m.approxRows });
    if (m.size) chips.push({ icon: "hard_drive", label: t("obj.chip.size"), value: m.size });
    if (m.dependsOn && m.dependsOn.length)
      chips.push({
        icon: "account_tree",
        label: t("obj.chip.reads"),
        value: m.dependsOn.join(", "),
      });
  }
  const args = m?.args ?? [];
  const disabledTrigger = objectKind === "trigger" && m?.enabled === false;
  const ddlLabel =
    objectKind === "view" || objectKind === "materialized_view"
      ? t("obj.ddl.definition")
      : objectKind === "trigger"
        ? t("obj.ddl.trigger")
        : t("obj.ddl.source");

  return (
    <div className="obj-view">
      <div className="obj-head">
        <div
          className="obj-head-icon"
          style={{
            background: `color-mix(in oklab, ${sec.accent} 16%, transparent)`,
            color: sec.accent,
          }}
        >
          <Icon name={sec.icon} size={20} />
        </div>
        <div className="obj-head-main">
          <div className="obj-head-title">
            <span className="obj-head-name">{name}</span>
            <span
              className="obj-type-badge"
              style={{
                color: sec.accent,
                borderColor: `color-mix(in oklab, ${sec.accent} 45%, var(--border))`,
              }}
            >
              {typeBadge(objectKind)}
            </span>
            {disabledTrigger ? (
              <span className="obj-type-badge obj-disabled">{t("obj.badge.disabled")}</span>
            ) : null}
          </div>
          {m?.comment ? <div className="obj-head-comment">{m.comment}</div> : null}
        </div>
        <div className="obj-head-actions">
          {browsable ? (
            <Btn icon="table_rows" variant="tonal" small onClick={() => openTableTab(schema, name)}>
              {t("obj.browseData")}
            </Btn>
          ) : null}
          {/* REFRESH MATERIALIZED VIEW rewrites the view's stored rows, so it
              is a write like any other. */}
          {objectKind === "materialized_view" && !readOnly ? (
            <Btn
              icon={refreshing ? "hourglass_top" : "refresh"}
              variant="tonal"
              small
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? t("obj.refreshing") : t("obj.refresh")}
            </Btn>
          ) : null}
          {/* "Edit definition" exists only to open a CREATE OR REPLACE in the
              editor; reading the DDL is what "Copy DDL" is for, and it stays. */}
          {readOnly ? null : (
            <Btn icon="edit" variant="tonal" small disabled={ddl === null} onClick={onEdit}>
              {t("obj.editDef")}
            </Btn>
          )}
          <Btn icon="content_copy" variant="tonal" small disabled={ddl === null} onClick={copyDdl}>
            {t("obj.copyDdl")}
          </Btn>
          {readOnly ? null : (
            <Btn
              icon="delete"
              variant="tonal"
              small
              className="obj-drop-btn"
              onClick={() => setDropOpen(true)}
            >
              {t("obj.drop")}
            </Btn>
          )}
        </div>
      </div>

      {chips.length ? (
        <div className="obj-chiprow">
          {chips.map((c) => (
            <Chip key={c.label} icon={c.icon} label={c.label} value={c.value} tone={c.tone} />
          ))}
        </div>
      ) : null}

      {(objectKind === "function" || objectKind === "procedure") && args.length ? (
        <div className="obj-args">
          <div className="obj-args-title">{t("obj.args")}</div>
          <table className="obj-args-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("obj.args.mode")}</th>
                <th>{t("obj.args.name")}</th>
                <th>{t("obj.args.type")}</th>
              </tr>
            </thead>
            <tbody>
              {args.map((a, i) => (
                <tr key={i}>
                  <td className="obj-args-i">{i + 1}</td>
                  <td>{a.mode ?? "IN"}</td>
                  <td className="obj-args-name">{a.name}</td>
                  <td className="obj-args-type">{a.dataType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {loading ? (
        <div className="dg-state">
          <Icon name="hourglass_top" size={24} style={{ opacity: 0.5 }} />
          <span>{t("obj.loadingDef")}</span>
        </div>
      ) : error ? (
        <div className="dg-state">
          <Icon name="error" size={24} style={{ color: "#e06c75" }} />
          <div className="dg-error">
            {t("obj.err.loadDef")}
            <code>{error}</code>
          </div>
        </div>
      ) : ddl !== null ? (
        <div className="obj-ddl-wrap">
          <div className="obj-ddl-label">
            <Icon name="code" size={13} />
            <span>{ddlLabel}</span>
            <span className="obj-ddl-dialect">{ENGINE_DIALECT[engine]}</span>
          </div>
          <pre
            className="ddl-block obj-ddl-block"
            dangerouslySetInnerHTML={{ __html: highlightSql(shownDdl ?? ddl) }}
          />
        </div>
      ) : null}

      {dropOpen ? (
        <ObjectDropModal
          engine={engine}
          env={env}
          envColor={envColor}
          schema={schema}
          kind={objectKind}
          name={name}
          detail={detail}
          busy={dropping}
          onConfirm={() => void confirmDrop()}
          onClose={() => setDropOpen(false)}
        />
      ) : null}
    </div>
  );
}
