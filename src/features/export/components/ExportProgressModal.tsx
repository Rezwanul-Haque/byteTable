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

import { useEffect, useRef, useState } from "react";

import { exportSave, type ExportScope } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { exportTarget, generate, saveDialog, scopeSuffix, type ExportKind } from "../exportFlow";
import "./ExportProgressModal.css";

/** The three scope options, mirroring the prototype's `EXPORT_CONTENTS`. */
const SCOPES: { id: ExportScope; label: string; icon: string; desc: string }[] = [
  {
    id: "both",
    label: "Structure + data",
    icon: "database",
    desc: "CREATE statements and all rows",
  },
  {
    id: "schema",
    label: "Structure only",
    icon: "account_tree",
    desc: "CREATE statements — no rows",
  },
  { id: "data", label: "Data only", icon: "table_rows", desc: "INSERT statements — no DDL" },
];

type Stage = "choose" | "building" | "done";

export function ExportProgressModal({
  kind,
  handleId,
  schema,
  /** Required for table exports; ignored for `schemaSql`. */
  table,
  onClose,
}: {
  kind: ExportKind;
  handleId: string;
  schema: string;
  table?: string;
  onClose: () => void;
}) {
  const toast = useToast();
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
  // advances per table.
  const unit = kind === "schemaSql" ? "tables" : "rows";
  const baseName = kind === "schemaSql" ? schema : (table ?? "");
  // Filename preview reflects the chosen scope's suffix (the actual saved name
  // can differ if the user edits it in the dialog — this is just the default).
  const previewName = baseName + scopeSuffix(scope) + (kind === "tableCsv" ? ".csv" : ".sql");

  const run = (chosenScope: ExportScope) => {
    // This run owns the cancel flag — start it clean so a fresh export is never
    // born cancelled (the flag is only raised by the Cancel button).
    cancelled.current = false;
    setScope(chosenScope);
    setStage("building");
    void (async () => {
      try {
        const { name, ext, label } = exportTarget(kind, schema, table, chosenScope);
        let path: string | null;
        try {
          path = await saveDialog(name, ext, label);
        } catch {
          // Dialog plugin unavailable (browser dev) → not a real failure.
          if (!cancelled.current) toast("Export requires the desktop app", "info");
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
        toast("Exported " + file, "ok");
        setTimeout(() => {
          if (!cancelled.current) onClose();
        }, 700);
      } catch (err) {
        if (!cancelled.current) toast(appErrorMessage(err, "Could not export."), "err");
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
    stage === "done" ? "Export complete" : stage === "choose" ? "Export " + baseName : "Exporting…";

  return (
    <Modal
      onClose={stage === "building" ? () => {} : onClose}
      label={"Export " + baseName}
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
                  <b>{c.label}</b>
                  <span>{c.desc}</span>
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
              Cancel
            </Btn>
            <Btn variant="filled" icon="download" onClick={() => run(scope)}>
              Export
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
            <span>{stage === "done" ? "Done" : pct + "%"}</span>
            <span>
              {scope === "schema" && kind !== "schemaSql"
                ? "structure only"
                : total
                  ? done.toLocaleString() + " / " + total.toLocaleString() + " " + unit
                  : ""}
            </span>
          </div>
          {stage !== "done" ? (
            <ModalActions>
              <Btn variant="text" onClick={cancel}>
                Cancel
              </Btn>
            </ModalActions>
          ) : null}
        </>
      )}
    </Modal>
  );
}
