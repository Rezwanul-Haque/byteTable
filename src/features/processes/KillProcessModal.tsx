// Kill-process confirm modal (M26 Task 4) — ported from the prototype's
// processes.jsx `KillProcessModal`, on the shared Modal (focus trap + Esc +
// scrim). Engine-aware noun (process / operation / client), a red-tinted
// preview of the exact kill statement(s), and the production type-to-arm gate
// (identical pattern to TruncateModal). It executes the kills against the
// backend, then hands the killed set back to the tab via `onConfirm`.

import { useState } from "react";

import { appErrorMessage } from "../../shared/api/error";
import { Btn } from "../../shared/ui/Btn";
import { Icon } from "../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../shared/ui/Modal";
import type { Engine } from "../../shared/types";
import { useSettingsStore } from "../settings/state";
import { PROC_SOURCES, procNoun, processKill, type ProcessInfo } from "./api";

export function KillProcessModal({
  handleId,
  procs,
  engine,
  env,
  envColor,
  onConfirm,
  onClose,
}: {
  handleId: string;
  procs: ProcessInfo[];
  engine: Engine;
  env: string;
  envColor: string;
  /** Called after the kills succeed, with the processes that were killed. */
  onConfirm: (killed: ProcessInfo[]) => void;
  onClose: () => void;
}) {
  const cfg = PROC_SOURCES[engine];
  const stmts = cfg ? procs.map((p) => cfg.kill(p)) : [];
  const noun = procNoun(engine);

  const confirmProd = useSettingsStore((s) => s.settings.confirmProd);
  const isProd = env === "production" && confirmProd;
  const [armText, setArmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = !isProd || armText.trim() === "kill " + procs.length;

  const title =
    procs.length > 1
      ? "Kill " + procs.length + " " + noun + "s"
      : "Kill " + noun + " " + (procs[0]?.pid ?? "");

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        for (const p of procs) {
          await processKill(handleId, { pid: p.pid, serial: p.serial, qid: p.qid });
        }
        onConfirm(procs);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not kill the " + noun + "."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal onClose={onClose} label={title} width={460}>
      <ModalTitle>
        <Icon name="dangerous" size={20} style={{ color: "var(--danger)" }} />
        <span className="modal-title-text">{title}</span>
        <span
          className="env-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          {env}
        </span>
      </ModalTitle>
      <p className="modal-desc">
        The {noun}
        {procs.length > 1 ? "s" : ""} will be terminated immediately
        {engine === "redis"
          ? " — the client connection is closed"
          : " — any running statement is rolled back"}
        . This cannot be undone.
      </p>
      <pre className="proc-kill-preview">
        {stmts.slice(0, 6).join("\n")}
        {stmts.length > 6 ? "\n-- +" + (stmts.length - 6) + " more" : ""}
      </pre>
      {isProd ? (
        <label className="proc-arm">
          <span>
            This is <b style={{ color: envColor }}>production</b>. Type{" "}
            <code>kill {procs.length}</code> to confirm.
          </span>
          <input
            value={armText}
            autoFocus
            spellCheck="false"
            placeholder={"kill " + procs.length}
            onChange={(e) => setArmText(e.target.value)}
          />
        </label>
      ) : null}
      {error ? <div className="proc-kill-error">{error}</div> : null}
      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="dangerous" size={16} />
          <span>
            {busy
              ? "Killing…"
              : procs.length > 1
                ? "Kill " + procs.length + " " + noun + "s"
                : "Kill " + noun}
          </span>
        </button>
      </ModalActions>
    </Modal>
  );
}
