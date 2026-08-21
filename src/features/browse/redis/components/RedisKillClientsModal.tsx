// Kill-clients confirmation (M36 §A3) — ported from the prototype's
// `RedisKillClientsModal`, on the shared Modal.
//
// Two things the generic kill modal gets wrong for Redis and this one does not:
//
// 1. **Arming is about blast radius, not environment.** Production arms, and so
//    does *any* kill of more than three connections — a filter that matches
//    twenty leaked pool connections is the dangerous case whatever the
//    connection is tagged. (An earlier version armed on the cache env, which
//    means nothing.)
// 2. **The consequence is stated in Redis terms.** The connection closes with
//    no warning; a well-behaved library reconnects; a blocked `BLPOP` returns
//    an error; an open `MULTI` is discarded.
//
// The exact command is shown before it runs, and up to six affected clients are
// listed with id / name / address / age.

import { useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../../shared/ui/Modal";
import { useSettingsStore } from "../../../settings/state";
import { humanAge } from "../clients";
import type { KvClient } from "../api";
import "./RedisClientsTab.css";

/** More than this many connections in one go arms the confirm button. */
const BULK_THRESHOLD = 3;

/** One pending kill: who it hits, the command that runs, and how to run it. */
export interface KillTarget {
  /** The clients the kill is expected to close (drives the list + the count). */
  clients: KvClient[];
  /** The exact command(s), one per line, shown before anything runs. */
  cmd: string;
  title: string;
  /** Runs the kill; resolves to how many connections the server actually closed. */
  run: () => Promise<number>;
}

export function RedisKillClientsModal({
  target,
  env,
  envColor,
  onConfirm,
  onClose,
}: {
  target: KillTarget;
  env: string;
  envColor: string;
  /** Called after the kill succeeds, with the clients hit and the closed count. */
  onConfirm: (clients: KvClient[], closed: number, cmd: string) => void;
  onClose: () => void;
}) {
  const confirmProd = useSettingsStore((s) => s.settings.confirmProd);
  const n = target.clients.length;
  const prod = env === "production" && confirmProd;
  const bulk = n > BULK_THRESHOLD;
  const guard = prod || bulk;
  const word = "kill " + n;

  const [armText, setArmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = !guard || armText.trim() === word;

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const closed = await target.run();
        onConfirm(target.clients, closed, target.cmd);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not kill the connection."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal onClose={onClose} label={target.title} width={470}>
      <ModalTitle>
        <Icon name="dangerous" size={20} style={{ color: "var(--danger)" }} />
        <span className="modal-title-text">{target.title}</span>
        <span
          className="env-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          {env}
        </span>
      </ModalTitle>
      <p className="modal-desc">
        {n === 1
          ? "The connection is closed immediately."
          : n + " connections are closed immediately."}{" "}
        Redis does not warn the client — a well-behaved library reconnects, a blocked{" "}
        <code>BLPOP</code> returns an error, and any open <code>MULTI</code> is discarded.
      </p>
      <pre className="proc-kill-preview">{target.cmd}</pre>
      {n > 1 ? (
        <div className="rc-kill-list">
          {target.clients.slice(0, 6).map((c) => (
            <div className="rc-kill-row" key={c.id}>
              <span className="rc-kill-id">#{c.id}</span>
              <span className="rc-kill-name">{c.name || <em>unnamed</em>}</span>
              <span className="rc-kill-addr">{c.addr}</span>
              <span className="rc-kill-age">{humanAge(c.age)}</span>
            </div>
          ))}
          {n > 6 ? <div className="rc-kill-more">+{n - 6} more</div> : null}
        </div>
      ) : null}
      {guard ? (
        <label className="proc-arm">
          <span>
            {prod ? (
              <>
                Connection is tagged <b style={{ color: envColor }}>{env}</b>. Type{" "}
                <code>{word}</code> to confirm.
              </>
            ) : (
              <>
                This closes <b style={{ color: "var(--danger)" }}>{n} connections</b> at once. Type{" "}
                <code>{word}</code> to confirm.
              </>
            )}
          </span>
          <input
            value={armText}
            autoFocus
            spellCheck="false"
            placeholder={word}
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
          <span>{busy ? "Killing…" : n === 1 ? "Kill client" : "Kill " + n + " clients"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
