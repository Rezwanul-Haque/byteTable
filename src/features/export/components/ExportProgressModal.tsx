// Export progress modal (M15) — ported from the prototype's
// `export-progress.jsx` `ExportProgressModal`. One modal owns the whole export:
//
//   choose (SQL only) → building (live bar) → done (auto-close)
//
// SQL exports open on the `choose` step (the "middleware" scope picker:
// structure + data / structure only / data only); CSV exports are always data,
// so they skip straight to `building`. After the scope is chosen (or
// immediately, for CSV) the native save dialog asks for a path, then the
// backend generates the text while streaming row/table progress over its
// Channel — rendered here as a live bar. On success the text is written, a
// toast fires, and the modal auto-closes; on cancel the in-flight result is
// discarded (no file written).

import { useEffect, useMemo, useRef, useState } from "react";

import { exportSave, type ExportScope } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import type { StringKey } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import {
  exportStamp,
  exportTarget,
  generate,
  saveDialog,
  scopeSuffix,
  type ExportKind,
} from "../exportFlow";
import "./ExportProgressModal.css";

/** The three scope options, mirroring the prototype's `EXPORT_CONTENTS`.
 *  Labels are i18n keys, resolved at render time. */
const SCOPES: { id: ExportScope; label: StringKey; icon: string; desc: StringKey }[] = [
  {
    id: "both",
    label: "io.scopeBoth",
    icon: "database",
    desc: "io.scopeBothDesc",
  },
  {
    id: "schema",
    label: "io.scopeSchema",
    icon: "account_tree",
    desc: "io.scopeSchemaDesc",
  },
  { id: "data", label: "io.scopeData", icon: "table_rows", desc: "io.scopeDataDesc" },
];

type Stage = "choose" | "building" | "done";

export function ExportProgressModal({
  kind,
  handleId,
  schema,
  /** Required for table exports; ignored for `schemaSql`. */
  table,
  /** Connection's deployment env — goes into the filename (`exportStamp`). */
  env,
  onClose,
}: {
  kind: ExportKind;
  handleId: string;
  schema: string;
  table?: string;
  env?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const isSql = kind === "tableSql" || kind === "schemaSql";
  // SQL exports start on the scope-choice step; CSV goes straight to building.
  const [stage, setStage] = useState<Stage>(isSql ? "choose" : "building");
  const [scope, setScope] = useState<ExportScope>("both");
  const [pct, setPct] = useState(0);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  // Set when the user hits Cancel: guards against writing the file or updating
  // the bar after the in-flight generate resolves. (Reset at the start of each
  // `run` so a fresh export is never born cancelled.)
  const cancelled = useRef(false);
  // One-shot latch for the CSV auto-start so React StrictMode's dev
  // mount→unmount→remount fires the export (and its save dialog) exactly once.
  const autoStarted = useRef(false);

  // The progress unit differs by kind: table exports page rows, a schema dump
  // advances per table (rendered via io.unitRows / io.unitTables below).
  const baseName = kind === "schemaSql" ? schema : (table ?? "");
  // One stamp for the modal's lifetime so the preview below and the name handed
  // to the save dialog agree (a fresh `exportStamp()` per render would drift).
  const stamp = useMemo(() => exportStamp(env), [env]);
  // Filename preview reflects the chosen scope's suffix (the actual saved name
  // can differ if the user edits it in the dialog — this is just the default).
  const previewName =
    baseName + scopeSuffix(scope) + stamp + (kind === "tableCsv" ? ".csv" : ".sql");

  const run = (chosenScope: ExportScope) => {
    // This run owns the cancel flag — start it clean so a fresh export is never
    // born cancelled (the flag is only raised by the Cancel button).
    cancelled.current = false;
    setScope(chosenScope);
    setStage("building");
    void (async () => {
      try {
        const { name, ext, label } = exportTarget(kind, schema, table, chosenScope, stamp);
        let path: string | null;
        try {
          path = await saveDialog(name, ext, t(label as StringKey));
        } catch {
          // Dialog plugin unavailable (browser dev) → not a real failure.
          if (!cancelled.current) toast(t("io.exportNeedsApp"), "info");
          onClose();
          return;
        }
        if (!path) {
          // User cancelled the save dialog.
          onClose();
          return;
        }

        const text = await generate(
          kind,
          { handleId, schema, table, scope: chosenScope },
          (d, t) => {
            if (cancelled.current) return;
            setDone(d);
            setTotal(t);
            setPct(t ? Math.round((d / t) * 100) : 0);
          },
        );
        if (cancelled.current) return; // user cancelled during generation

        await exportSave(path, text);
        setPct(100);
        setStage("done");
        const file = path.split(/[\\/]/).pop() ?? name;
        toast(t("io.exportedFile", { name: file }), "ok");
        setTimeout(() => {
          if (!cancelled.current) onClose();
        }, 700);
      } catch (err) {
        if (!cancelled.current) toast(appErrorMessage(err, t("io.exportFail")), "err");
        onClose();
      }
    })();
  };

  // CSV: no scope choice — start as soon as the modal mounts. The `autoStarted`
  // latch keeps it to a single run (and a single save dialog) even under
  // StrictMode's dev double-mount.
  useEffect(() => {
    if (isSql || autoStarted.current) return;
    autoStarted.current = true;
    run("both");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    cancelled.current = true;
    onClose();
  };

  const titleText =
    stage === "done"
      ? t("io.exportComplete")
      : stage === "choose"
        ? t("io.exportTitle", { name: baseName })
        : t("io.exporting");

  return (
    <Modal
      onClose={stage === "building" ? () => {} : onClose}
      label={t("io.exportTitle", { name: baseName })}
      width={460}
      className="export-progress-modal"
    >
      <ModalTitle>
        <Icon
          name={stage === "done" ? "download_done" : "download"}
          size={18}
          style={{ color: "var(--accent)" }}
        />{" "}
        {titleText}
      </ModalTitle>

      {stage === "choose" ? (
        <>
          <div className="export-choose">
            {SCOPES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={"export-opt" + (scope === c.id ? " on" : "")}
                onClick={() => setScope(c.id)}
                aria-pressed={scope === c.id}
              >
                <span className="export-opt-radio">
                  <Icon
                    name={scope === c.id ? "radio_button_checked" : "radio_button_unchecked"}
                    size={16}
                  />
                </span>
                <Icon
                  name={c.icon}
                  size={16}
                  style={{ color: scope === c.id ? "var(--accent)" : "var(--text-dim)" }}
                />
                <span className="export-opt-text">
                  <b>{t(c.label)}</b>
                  <span>{t(c.desc)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="export-file">
            <Icon name="code" size={15} style={{ color: "var(--text-dim)" }} />
            <span className="export-file-name">{previewName}</span>
          </div>
          <ModalActions>
            <Btn variant="text" onClick={onClose}>
              {t("common.cancel")}
            </Btn>
            <Btn variant="filled" icon="download" onClick={() => run(scope)}>
              {t("io.exportBtn")}
            </Btn>
          </ModalActions>
        </>
      ) : (
        <>
          <div className="export-file">
            <Icon
              name={kind === "tableCsv" ? "table_view" : "code"}
              size={15}
              style={{ color: "var(--text-dim)" }}
            />
            <span className="export-file-name">{previewName}</span>
          </div>
          <div className="export-bar">
            <span className="export-bar-fill" style={{ width: pct + "%" }} />
          </div>
          <div className="export-meta">
            <span>{stage === "done" ? t("io.done") : pct + "%"}</span>
            <span>
              {scope === "schema" && kind !== "schemaSql"
                ? t("io.structureOnly")
                : total
                  ? done.toLocaleString() +
                    " / " +
                    total.toLocaleString() +
                    " " +
                    t(kind === "schemaSql" ? "io.unitTables" : "io.unitRows")
                  : ""}
            </span>
          </div>
          {stage !== "done" ? (
            <ModalActions>
              <Btn variant="text" onClick={cancel}>
                {t("common.cancel")}
              </Btn>
            </ModalActions>
          ) : null}
        </>
      )}
    </Modal>
  );
}
