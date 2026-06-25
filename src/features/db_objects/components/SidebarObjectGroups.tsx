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
import { appErrorMessage } from "../../../shared/api/error";
import { objectsKey, useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { dropObject, type DbObjectInfo, type DbObjectKind } from "../api";
import { newObjectTemplate, objectClassesFor, OBJ_SECTIONS } from "../kinds";
import { ObjectDropModal } from "./ObjectDropModal";

export function SidebarObjectGroups({
  handleId,
  schema,
  engine,
  env,
  envColor,
}: {
  handleId: string;
  schema: string;
  engine: Engine;
  env: Env;
  envColor: string;
}) {
  const classes = objectClassesFor(engine);
  const loadObjects = useIntrospectionStore((s) => s.loadObjects);
  const invalidateObjects = useIntrospectionStore((s) => s.invalidateObjects);
  const objectsMap = useIntrospectionStore((s) => s.objects);
  const openObjectTab = useWorkspacesStore((s) => s.openObjectTab);
  const openSqlTabWith = useWorkspacesStore((s) => s.openSqlTabWith);
  const toast = useToast();

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

  const listOf = (kind: DbObjectKind) =>
    objectsMap[objectsKey(handleId, schema, kind)]?.objects ?? null;

  // Always show every supported class for the engine (even with zero objects)
  // so the section + its "+ New" affordance are always reachable.
  const visible = classes;

  const confirmDrop = async () => {
    if (!dropTarget) return;
    setDropping(true);
    try {
      await dropObject(handleId, schema, dropTarget.kind, dropTarget.name, dropTarget.detail);
      invalidateObjects(handleId, schema, dropTarget.kind);
      toast(`Dropped ${dropTarget.name}`, "ok");
      setDropTarget(null);
    } catch (e) {
      toast(appErrorMessage(e, "Could not drop the object."), "err");
    } finally {
      setDropping(false);
    }
  };

  return (
    <div className="sidebar-other">
      {visible.map((kind) => {
        const sec = OBJ_SECTIONS[kind];
        const list = listOf(kind);
        const isOpen = openSec === kind;
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
              <span className="obj-sec-label">{sec.group}</span>
              {engine === "postgres" && kind === "trigger" ? (
                <span
                  className="obj-sec-info"
                  title="A Postgres trigger runs a trigger function — create the function (RETURNS trigger) first, then the CREATE TRIGGER that EXECUTEs it."
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon name="info" size={13} />
                </span>
              ) : null}
              <span className="obj-sec-count">{list?.length ?? ""}</span>
              <button
                type="button"
                className="sec-new-btn"
                title={`New ${sec.label.toLowerCase()}… (opens SQL editor)`}
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
                  <div className="sb-obj-loading">Loading…</div>
                ) : list.length === 0 ? (
                  <div className="sb-obj-loading">No {sec.group.toLowerCase()}</div>
                ) : (
                  list.map((obj) => (
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
                        title={"Drop " + obj.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDropTarget(obj);
                        }}
                      >
                        <Icon name="delete" size={13} />
                      </button>
                    </div>
                  ))
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
