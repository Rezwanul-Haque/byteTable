// Redis terminal session body (M14) — the redis-cli REPL the TerminalPanel
// mounts for Redis workspaces, ported from
// ByteTable_latest/bytetable/redis-tabs.jsx `RedisCli` (embedded mode) +
// `REDIS_CLI_PRESETS`. The Redis sibling of SqlTerminalTab: same panel chrome
// (toolbar + preset chips + Ctrl+L clear) and the same lifted session state
// (lines/history in the panel store), but the body runs raw RESP commands.
//
// Unlike the prototype's SYNCHRONOUS mock engine, here a command is wired to
// the REAL async backend (`kvCommand(handleId, db, args)` → typed `RespReply`)
// and the live redis_browse store: the echo is pushed immediately, the
// formatted reply when the awaited call resolves, and a concurrent submit is
// guarded while a call is in flight. After a non-error MUTATING command the
// workspace version is bumped (sidebar + open key tabs re-fetch); a `SELECT n`
// updates the shared dbIndex (so the prompt + the sidebar db switcher follow).
//
// dbIndex SOURCE. The `{conn}:db{N}>` prompt + the `kvCommand` db arg read the
// workspace's CURRENT db from the redis_browse store (the sidebar db switcher
// sets it) — NOT a local copy — so the terminal and the rest of the workspace
// always agree. `SELECT n` routes through the store's `setDbIndex`.
//
// PRODUCTION SAFETY. A destructive command (`FLUSHDB`/`FLUSHALL`/multi-key
// `DEL`/`UNLINK`) on a `production` connection is gated behind the M11 confirm
// Modal before it runs (the same pattern as the key tab's delete confirm).

import { useLayoutEffect, useRef, useState } from "react";

import { Btn } from "../../shared/ui/Btn";
import { Icon } from "../../shared/ui/Icon";
import { IconBtn } from "../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../shared/ui/Modal";
import { appErrorMessage } from "../../shared/api/error";
import { kvCommand } from "../browse/redis/api";
import {
  formatReply,
  isDestructiveCommand,
  isMutatingCommand,
  tokenizeCommand,
} from "../browse/redis/helpers";
import { useRedisBrowseStore } from "../browse/redis/state";
import type { Workspace } from "../workspaces/types";
import { usePanelStore, type TermLine, type TermSession } from "./state";
import "./SqlTerminalTab.css";

/** The redis-cli quick-command preset chips (ported verbatim from the
 *  prototype's `REDIS_CLI_PRESETS`). */
const REDIS_CLI_PRESETS = [
  "KEYS *",
  "DBSIZE",
  "INFO",
  "SCAN 0 MATCH session:* COUNT 20",
  "ZREVRANGE leaderboard:sales 0 4 WITHSCORES",
  "HGETALL feature_flags",
];

interface RedisTerminalSessionProps {
  workspace: Workspace;
  session: TermSession;
  /** True when hosted inside the panel (hides the title in the toolbar). */
  embedded?: boolean;
}

export function RedisTerminalSession({ workspace, session, embedded }: RedisTerminalSessionProps) {
  const wsId = workspace.id;
  const handleId = workspace.handleId;
  const connName = workspace.name;
  const isProduction = workspace.saved.env === "production";

  // Initial db = the connection's configured dbIndex (mirrors RedisWorkspace).
  const params = workspace.saved.params;
  const initialDb = params.engine === "redis" ? params.dbIndex : 0;

  // The CURRENT db comes from the shared redis_browse store (the sidebar
  // switcher sets it) — subscribe so the prompt + db arg follow a SELECT or a
  // sidebar switch. `ensure` seeds the default without writing for render.
  const ensure = useRedisBrowseStore((s) => s.ensure);
  const slice = useRedisBrowseStore((s) => s.byWorkspace[wsId]);
  const dbIndex = (slice ?? ensure(wsId, initialDb)).dbIndex;
  const setDbIndex = useRedisBrowseStore((s) => s.setDbIndex);
  const bumpVersion = useRedisBrowseStore((s) => s.bumpVersion);

  const banner = "Redis " + (workspace.info.serverVersion || "");

  const patchSession = usePanelStore((s) => s.patchSession);

  const [input, setInput] = useState("");
  // History cursor: -1 = the live (unsubmitted) input, 0 = most recent.
  const [hi, setHi] = useState(-1);
  const [running, setRunning] = useState(false);
  // A pending destructive command awaiting production confirmation.
  const [confirm, setConfirm] = useState<{ raw: string; tokens: string[] } | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Banner: seed on first mount when the session has no lines yet (mirrors the
  // prototype's initial connected-to line + the SQL tab's seeding).
  const seeded = useRef(false);
  useLayoutEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (session.lines.length === 0) {
      patchSession(wsId, session.id, {
        lines: [
          {
            cls: "cli-info",
            text:
              "Connected to " + connName + " · " + banner + ". Type a command, ↑/↓ for history.",
          },
        ],
      });
    }
    // Run once on mount; session identity is stable for this component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to the bottom on a new line / while running.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [session.lines.length, running]);

  // --- transcript helpers (read latest state via the store, never stale) ---
  const appendLines = (more: TermLine[]) => {
    if (more.length === 0) return;
    const cur = usePanelStore
      .getState()
      .byWorkspace[wsId]?.sessions.find((s) => s.id === session.id);
    patchSession(wsId, session.id, { lines: [...(cur?.lines ?? []), ...more] });
  };
  const setLines = (lines: TermLine[]) => patchSession(wsId, session.id, { lines });
  const pushHistory = (line: string) => {
    if (!line.trim()) return;
    const cur = usePanelStore
      .getState()
      .byWorkspace[wsId]?.sessions.find((s) => s.id === session.id);
    patchSession(wsId, session.id, {
      history: [line, ...(cur?.history ?? [])].slice(0, 80),
    });
  };

  // Run a tokenized command against the real backend; echo is already pushed by
  // the caller. Pushes the formatted reply when the awaited call resolves, bumps
  // the version after a non-error mutating command, and updates the shared
  // dbIndex on a successful SELECT.
  const exec = (tokens: string[], db: number) => {
    setRunning(true);
    kvCommand(handleId, db, tokens)
      .then((rep) => {
        appendLines(formatReply(rep));
        if (rep.kind !== "error") {
          const cmd = (tokens[0] ?? "").toUpperCase();
          // SELECT n → update the shared db (prompt + sidebar follow).
          if (cmd === "SELECT" && tokens[1] != null) {
            const n = Number(tokens[1]);
            if (Number.isInteger(n)) setDbIndex(wsId, initialDb, n);
          } else if (isMutatingCommand(cmd)) {
            // A write succeeded: invalidate the sidebar + open key tabs.
            bumpVersion(wsId, initialDb);
          }
        }
      })
      .catch((e: unknown) => {
        appendLines([
          { cls: "cli-error", text: "(error) " + appErrorMessage(e, "command failed") },
        ]);
      })
      .finally(() => {
        setRunning(false);
        inputRef.current?.focus();
      });
  };

  const run = (rawLine: string) => {
    if (running) return; // guard concurrent submit while a call is in flight.
    const cmd = rawLine.trim();
    if (!cmd) return;

    // Ctrl+L is handled in onKey; here we tokenize + dispatch.
    const tokens = tokenizeCommand(cmd);
    pushHistory(cmd);
    setHi(-1);
    setInput("");

    // Echo the command with the prompt immediately (the reply arrives async).
    appendLines([{ cls: "cli-prompt", text: connName + ":db" + dbIndex + "> " + cmd }]);

    if (tokens.length === 0) return;

    // Production safety: a destructive command waits for the confirm modal.
    if (isProduction && isDestructiveCommand(tokens)) {
      setConfirm({ raw: cmd, tokens });
      return;
    }

    exec(tokens, dbIndex);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.min(hi + 1, session.history.length - 1);
      if (n >= 0 && session.history[n] != null) {
        setHi(n);
        setInput(session.history[n] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = hi - 1;
      if (n < 0) {
        setHi(-1);
        setInput("");
      } else {
        setHi(n);
        setInput(session.history[n] ?? "");
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }
  };

  const confirmRun = () => {
    if (!confirm) return;
    const { tokens } = confirm;
    setConfirm(null);
    exec(tokens, dbIndex);
  };

  return (
    <div className="rcli term">
      <div className="rcli-toolbar">
        <Icon name="terminal" size={15} style={{ color: "var(--accent)" }} />
        {!embedded ? <span className="rcli-title">redis-cli</span> : null}
        <div className="sql-snippets">
          {REDIS_CLI_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className="snippet-chip"
              onClick={() => {
                setInput(c);
                inputRef.current?.focus();
              }}
            >
              {c}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <IconBtn
          icon="delete_sweep"
          size={15}
          title="Clear console (Ctrl+L)"
          onClick={() => setLines([])}
        />
      </div>
      <div className="rcli-body term-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {session.lines.map((l, i) =>
          "kind" in l ? null : (
            <div key={i} className={"rcli-line " + l.cls}>
              {l.text || " "}
            </div>
          ),
        )}
        <div className="rcli-inputline">
          <span className="rcli-prompt">
            {connName}:db{dbIndex}&gt;
          </span>
          <input
            ref={inputRef}
            className="rcli-input"
            value={input}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="redis-cli command"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
      </div>

      {confirm ? (
        <Modal onClose={() => setConfirm(null)} label="Confirm destructive command" width={460}>
          <ModalTitle>
            <Icon name="warning" size={18} style={{ color: "#e06c75" }} /> Run a destructive command
            on a production connection?
          </ModalTitle>
          <p className="dg-confirm-body">
            This connection points at <b>production</b>. The following command will run against{" "}
            <b>db{dbIndex}</b>:
          </p>
          <code className="dg-confirm-sql">{confirm.raw}</code>
          <ModalActions>
            <Btn variant="text" onClick={() => setConfirm(null)}>
              Cancel
            </Btn>
            <Btn variant="filled" className="rinfo-del-btn" onClick={confirmRun}>
              Run command
            </Btn>
          </ModalActions>
        </Modal>
      ) : null}
    </div>
  );
}
