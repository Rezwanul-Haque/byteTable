// Bottom-region object accordion for SQL engines (design Prompts 1, 2, 4):
// the non-table classes (Views / Materialized Views / Functions / Procedures /
// Triggers) in engine display order, as an accordion where only ONE section is
// open at a time. Each class' list is eager-loaded for its count so zero-count
// classes are hidden. Each header has a "+" that opens a SQL editor pre-filled
// with a CREATE template; rows open the viewer; a hover Drop confirms + runs.

import { useEffect, useState } from "react";

import { Icon } from "../../../shared/ui/Icon";
import type { Engine, Env } from "../../../shared/types";
import { useToast } from "../../../shared/ui/toastContext";
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import { appErrorMessage } from "../../../shared/api/error";
import { objectsKey, useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { dropObject, type DbObjectInfo, type DbObjectKind } from "../api";
import { newObjectTemplate, objectClassesFor, OBJ_SECTIONS } from "../kinds";
import { ObjectDropModal } from "./ObjectDropModal";

/** Object kind → its translated section-group / singular-kind keys. */
const GROUP_KEY: Record<DbObjectKind, StringKey> = {
  view: "obj.group.views",
  materialized_view: "obj.group.materializedViews",
  function: "obj.group.functions",
  procedure: "obj.group.procedures",
  trigger: "obj.group.triggers",
};
const KIND_KEY: Record<DbObjectKind, StringKey> = {
  view: "obj.kind.view",
  materialized_view: "obj.kind.materializedView",
  function: "obj.kind.function",
  procedure: "obj.kind.procedure",
  trigger: "obj.kind.trigger",
};

export function SidebarObjectGroups({
  handleId,
  schema,
  engine,
  env,
  envColor,
  filter = "",
}: {
  handleId: string;
  schema: string;
  engine: Engine;
  env: Env;
  envColor: string;
  // Already normalized by the caller (trimmed + lowercased). When non-empty,
  // every class list is filtered by name and matching sections auto-open so
  // results are visible without expanding the accordion.
  filter?: string;
}) {
  const classes = objectClassesFor(engine);
  const loadObjects = useIntrospectionStore((s) => s.loadObjects);
  const invalidateObjects = useIntrospectionStore((s) => s.invalidateObjects);
  const objectsMap = useIntrospectionStore((s) => s.objects);
  const openObjectTab = useWorkspacesStore((s) => s.openObjectTab);
  const openSqlTabWith = useWorkspacesStore((s) => s.openSqlTabWith);
  const openObjExplorer = useWorkspacesStore((s) => s.openObjExplorer);
  const toast = useToast();
  const t = useT();

  // Cap each class' inline list; the overflow escalates into the Object Explorer.
  const CAP = 12;

  // Accordion: only one section open at a time.
  const [openSec, setOpenSec] = useState<DbObjectKind | null>(null);
  const [dropTarget, setDropTarget] = useState<DbObjectInfo | null>(null);
  const [dropping, setDropping] = useState(false);

  // Eager-load every class' list so we know counts (to hide zero-count classes)
  // and the open section renders instantly.
  useEffect(() => {
    for (const kind of classes) {
      if (!objectsMap[objectsKey(handleId, schema, kind)]) {
        void loadObjects(handleId, schema, kind);
      }
    }
  }, [classes, objectsMap, handleId, schema, loadObjects]);

  if (classes.length === 0) return null;

  const listOf = (kind: DbObjectKind) => {
    const all = objectsMap[objectsKey(handleId, schema, kind)]?.objects ?? null;
    if (all === null || filter === "") return all;
    return all.filter((o) => o.name.toLowerCase().includes(filter));
  };

  // Always show every supported class for the engine (even with zero objects)
  // so the section + its "+ New" affordance are always reachable.
  const visible = classes;

  const confirmDrop = async () => {
    if (!dropTarget) return;
    setDropping(true);
    try {
      await dropObject(handleId, schema, dropTarget.kind, dropTarget.name, dropTarget.detail);
      invalidateObjects(handleId, schema, dropTarget.kind);
      toast(t("obj.droppedName", { name: dropTarget.name }), "ok");
      setDropTarget(null);
    } catch (e) {
      toast(appErrorMessage(e, t("obj.err.drop")), "err");
    } finally {
      setDropping(false);
    }
  };

  return (
    <div className="sidebar-other">
      <div className="obj-other-head">
        <Icon name="category" size={13} style={{ color: "var(--text-faint)" }} />
        <span className="obj-other-head-label">{t("obj.objects")}</span>
        <button
          type="button"
          className="obj-explore-all"
          title={t("obj.openExplorer")}
          onClick={() => openObjExplorer(schema, "all")}
        >
          <Icon name="open_in_full" size={12} /> {t("obj.exploreAll")}
        </button>
      </div>
      {visible.map((kind) => {
        const sec = OBJ_SECTIONS[kind];
        const list = listOf(kind);
        // While filtering, ignore the accordion and open every section that has
        // a match (collapse the rest); otherwise honor the one-open state.
        const isOpen = filter !== "" ? (list?.length ?? 0) > 0 : openSec === kind;
        return (
          <div key={kind} className={"obj-section obj-section-acc" + (isOpen ? " open" : "")}>
            <div
              className="obj-sec-head"
              onClick={() => setOpenSec((o) => (o === kind ? null : kind))}
            >
              <Icon
                name="chevron_right"
                size={14}
                className="obj-sec-chev"
                style={{ transform: isOpen ? "rotate(90deg)" : "none", color: "var(--text-faint)" }}
              />
              <Icon name={sec.icon} size={14} style={{ color: sec.accent }} />
              <span className="obj-sec-label">{t(GROUP_KEY[kind])}</span>
              {engine === "postgres" && kind === "trigger" ? (
                <span
                  className="obj-sec-info"
                  title={t("obj.explorerTriggerTip")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon name="info" size={13} />
                </span>
              ) : null}
              <span className="obj-sec-count">{list?.length ?? ""}</span>
              <button
                type="button"
                className="sec-new-btn"
                title={t("obj.newObject", { label: t(KIND_KEY[kind]) })}
                onClick={(e) => {
                  e.stopPropagation();
                  openSqlTabWith(newObjectTemplate(engine, kind));
                }}
              >
                <Icon name="add" size={14} />
              </button>
            </div>
            {isOpen ? (
              <div className="obj-sec-body obj-sec-body-scroll">
                {list === null ? (
                  <div className="sb-obj-loading">{t("obj.loading")}</div>
                ) : list.length === 0 ? (
                  <div className="sb-obj-loading">
                    {t("obj.emptyNo", { group: t(GROUP_KEY[kind]).toLowerCase() })}
                  </div>
                ) : (
                  <>
                    {(filter !== "" ? list : list.slice(0, CAP)).map((obj) => (
                      <div
                        key={obj.name}
                        className="obj-item"
                        role="button"
                        tabIndex={0}
                        title={obj.name}
                        onClick={() => openObjectTab(schema, obj)}
                      >
                        <Icon
                          name={sec.icon}
                          size={15}
                          style={{ color: "var(--text-faint)", flex: "none" }}
                        />
                        <span className="obj-item-name">{obj.name}</span>
                        <button
                          type="button"
                          className="obj-item-drop"
                          title={t("obj.item.drop", { name: obj.name })}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDropTarget(obj);
                          }}
                        >
                          <Icon name="delete" size={13} />
                        </button>
                      </div>
                    ))}
                    {filter === "" && list.length > CAP ? (
                      <button
                        type="button"
                        className="obj-showall"
                        onClick={() => openObjExplorer(schema, kind)}
                      >
                        <Icon name="expand_more" size={13} />{" "}
                        {t("obj.showAll", { count: list.length })}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        );
      })}

      {dropTarget ? (
        <ObjectDropModal
          engine={engine}
          env={env}
          envColor={envColor}
          schema={schema}
          kind={dropTarget.kind}
          name={dropTarget.name}
          detail={dropTarget.detail}
          busy={dropping}
          onConfirm={() => void confirmDrop()}
          onClose={() => setDropTarget(null)}
        />
      ) : null}
    </div>
  );
}
