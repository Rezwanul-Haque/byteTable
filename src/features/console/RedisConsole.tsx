// Redis console body (M14, spec §"Redis console") — the engine-specific body
// the ConsolePanel host mounts for Redis (`kind === "kv"`) workspaces. It is the
// port of the M13 `CliTab` into the docked panel: this REPLACES the M13 `cli`
// tab kind, so Redis command work now happens only in this one per-workspace
// console (not multiple cli tabs).
//
// REUSE: tokenizer + `formatReply` + the mutating/destructive predicates come
// verbatim from `redis_browse/helpers.ts`; the reply colors come from the M13
// `.cli-*` line classes (moved into RedisConsole.css). The host wires the two
// slices (the SQL console never imports redis_browse, nor vice-versa —
// ARCHITECTURE §11); RedisConsole is that wire-point.
//
// STATE: the console log + history live in the per-workspace `useConsoleStore`
// (state.ts) so they survive workspace switches — the same store the SQL
// console uses, since the panel is one console per workspace. Redis replies are
// stored as formatted reply lines on the ConsoleEntry (`replyLines`). The
// selected db (the run target + prompt `db{N}`) is the redis_browse store's
// per-workspace `dbIndex`; `SELECT n` updates it and a mutating command bumps
// the redis_browse `version` (sidebar + open key tabs re-fetch).

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { appErrorMessage } from "../../shared/api/error";
import { Btn } from "../../shared/ui/Btn";
import { Icon } from "../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../shared/ui/Modal";
import { kvCommand } from "../redis_browse/api";
import {
  formatReply,
  isDestructiveCommand,
  isMutatingCommand,
  tokenizeCommand,
} from "../redis_browse/helpers";
import { useRedisBrowseStore } from "../redis_browse/state";
import type { Workspace } from "../workspaces/types";
import { selectConsole, useConsoleStore } from "./state";
import "./RedisConsole.css";

/** Preset command chips (REDIS_SPEC §7 / M13 cli) — clicking one fills + runs. */
const CLI_PRESETS = [
  "KEYS *",
  "DBSIZE",
  "INFO",
  "SCAN 0 MATCH session:* COUNT 20",
  "ZREVRANGE leaderboard:sales 0 4 WITHSCORES",
  "HGETALL feature_flags",
];

export function RedisConsole({ workspace }: { workspace: Workspace }) {
  const wsId = workspace.id;
  const cons = useConsoleStore((s) => selectConsole(s, wsId));
  const pushEntry = useConsoleStore((s) => s.pushEntry);
  const pushHistory = useConsoleStore((s) => s.pushHistory);
  const clearLog = useConsoleStore((s) => s.clearLog);

  // The selected db + invalidation come from the redis_browse slice (the same
  // dbIndex the sidebar/dashboard target). `initialDb` seeds the slice the
  // first time it's touched, mirroring RedisWorkspace.
  const params = workspace.saved.params;
  const initialDb = params.engine === "redis" ? params.dbIndex : 0;
  const ensure = useRedisBrowseStore((s) => s.ensure);
  const setDbIndex = useRedisBrowseStore((s) => s.setDbIndex);
  const bumpVersion = useRedisBrowseStore((s) => s.bumpVersion);
  const slice = useRedisBrowseStore((s) => s.byWorkspace[wsId]);
  const dbIndex = (slice ?? ensure(wsId, initialDb)).dbIndex;

  const isProduction = workspace.saved.env === "production";
  const connName = workspace.name;

  const [input, setInput] = useState("");
  // History cursor: -1 = the live (unsubmitted) input, 0 = most recent command.
  const [histIdx, setHistIdx] = useState(-1);
  const [pending, setPending] = useState(false);
  // A destructive command awaiting production confirm: its raw line + tokens.
  const [confirm, setConfirm] = useState<{ line: string; tokens: string[] } | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const log = cons.log;
  const prompt = connName + ":db" + dbIndex + ">";

  // Auto-scroll the log to the bottom on a new entry / while running.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [log.length, pending]);

  // Focus the input when the body first mounts (panel opened).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Run a tokenized command (already past the production confirm gate).
  const exec = (line: string, tokens: string[]) => {
    const cmd = (tokens[0] ?? "").toUpperCase();
    if (pending) return;
    setPending(true);
    kvCommand(workspace.handleId, dbIndex, tokens)
      .then((reply) => {
        pushEntry(wsId, {
          id: crypto.randomUUID(),
          command: line,
          status: reply.kind === "error" ? "error" : "ok",
          replyLines: formatReply(reply),
        });
        // A server-side error reply (WRONGTYPE / ERR) is not a mutation.
        if (reply.kind !== "error") {
          if (cmd === "SELECT") {
            const n = parseInt(tokens[1] ?? "", 10);
            if (!Number.isNaN(n) && n >= 0 && n <= 15) setDbIndex(wsId, initialDb, n);
          }
          if (isMutatingCommand(cmd)) bumpVersion(wsId, initialDb);
        }
      })
      .catch((err: unknown) => {
        pushEntry(wsId, {
          id: crypto.randomUUID(),
          command: line,
          status: "error",
          replyLines: [
            { cls: "cli-error", text: "(error) " + appErrorMessage(err, "command failed") },
          ],
        });
      })
      .finally(() => {
        setPending(false);
        inputRef.current?.focus();
      });
  };

  // Submit the typed line: record history, then either confirm (production
  // destructive) or run.
  const submit = (raw: string) => {
    const line = raw.trim();
    if (!line || pending) return;
    const tokens = tokenizeCommand(line);
    if (tokens.length === 0) return;
    pushHistory(wsId, line);
    setHistIdx(-1);
    setInput("");
    if (isProduction && isDestructiveCommand(tokens)) {
      setConfirm({ line, tokens });
      return;
    }
    exec(line, tokens);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(input);
    } else if (e.key === "l" && e.ctrlKey) {
      // Ctrl+L clears the log (spec §"Redis console").
      e.preventDefault();
      clearLog(wsId);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.min(histIdx + 1, cons.history.length - 1);
      if (n >= 0 && cons.history[n] != null) {
        setHistIdx(n);
        setInput(cons.history[n] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = histIdx - 1;
      if (n < 0) {
        setHistIdx(-1);
        setInput("");
      } else {
        setHistIdx(n);
        setInput(cons.history[n] ?? "");
      }
    }
    // ⌃` (toggle) is handled globally in RedisWorkspace; we let it bubble.
  };

  const runPreset = (preset: string) => {
    setInput(preset);
    inputRef.current?.focus();
    submit(preset);
  };

  const confirmRun = () => {
    const c = confirm;
    setConfirm(null);
    if (c) exec(c.line, c.tokens);
  };

  return (
    <div className="rcli">
      <div className="rcli-toolbar">
        <div className="sql-snippets" role="group" aria-label="Preset commands">
          {CLI_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className="snippet-chip"
              onClick={() => runPreset(c)}
              title={"Run " + c}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="rcli-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {log.length === 0 ? (
          <div className="rcli-line cli-info">
            Connected to {connName}. Type a command, ↑/↓ for history · Ctrl+L to clear.
          </div>
        ) : null}

        {log.map((entry) => (
          <div key={entry.id}>
            <div className="rcli-line cli-prompt">
              {prompt} {entry.command}
            </div>
            {(entry.replyLines ?? []).map((l, i) => (
              <div key={i} className={"rcli-line " + l.cls}>
                {l.text}
              </div>
            ))}
          </div>
        ))}

        <div className="rcli-inputline">
          <span className="rcli-prompt">{prompt}</span>
          <input
            ref={inputRef}
            className="rcli-input"
            value={input}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Redis command"
            disabled={pending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>

      {confirm ? (
        <Modal onClose={() => setConfirm(null)} label="Confirm destructive command" width={480}>
          <ModalTitle>
            <Icon name="warning" size={18} style={{ color: "#e06c75" }} /> Run a destructive command
            on production?
          </ModalTitle>
          <p className="dg-confirm-body">
            This connection points at <b>production</b>. The following command will run:
          </p>
          <code className="dg-confirm-sql">{confirm.line}</code>
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
