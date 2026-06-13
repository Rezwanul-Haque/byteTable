// Redis CLI console (REDIS_SPEC §7) — a real command surface replacing the SQL
// editor. Ported from the prototype `RedisCli` in `redis-tabs.jsx`: a preset
// chip toolbar, a scrolling log, and a sticky `{conn}:db{N}>` input line with
// ↑/↓ history and Ctrl+L clear. Each Enter tokenizes the line (the engine
// tokenizer, honoring quotes), runs it via `kvCommand`, and appends the
// prompt-echoed command + the typed reply formatted exactly like redis-cli
// (helpers.formatReply, driven off the typed `RespReply` — never re-parsed).
//
// Live mutation (REDIS_SPEC §7): a write command (SET/DEL/EXPIRE/FLUSHDB/…)
// bumps the workspace version after it returns, so the sidebar + open key tabs
// re-fetch. `SELECT n` switches the workspace db. Destructive `FLUSHDB` and
// multi-key `DEL` confirm first on a production connection (the M11 confirm
// Modal). The per-tab log + history persist in the redis_browse store (keyed by
// cli tab id) so they survive tab/workspace switches.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Btn } from "../../../shared/ui/Btn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { kvCommand } from "../api";
import {
  formatReply,
  isDestructiveCommand,
  isMutatingCommand,
  tokenizeCommand,
} from "../helpers";
import type { CliLine, CliTabState } from "../state";
import "./CliTab.css";

/** Preset command chips (REDIS_SPEC §7). Clicking one fills + runs the input. */
const CLI_PRESETS = [
  "KEYS *",
  "DBSIZE",
  "INFO",
  "SCAN 0 MATCH session:* COUNT 20",
  "ZREVRANGE leaderboard:sales 0 4 WITHSCORES",
  "HGETALL feature_flags",
];

const MAX_HISTORY = 50;

interface CliTabProps {
  /** The connection handle commands run against. */
  handleId: string;
  /** The conn name shown in the prompt (`{conn}:db{N}>`). */
  connName: string;
  /** Server version, for the connected banner. */
  serverVersion: string;
  /** The selected db commands run against (and the prompt shows). */
  dbIndex: number;
  /** True when the connection's env is `production` (gate destructive cmds). */
  isProduction: boolean;
  /** Persisted log + history for this cli tab (from the store). */
  state: CliTabState | undefined;
  /** Persist this tab's log + history (after each run / clear). */
  onPersist: (state: CliTabState) => void;
  /** Bump the workspace version after a mutating command. */
  onMutated: () => void;
  /** Switch the workspace db (a `SELECT n` command). */
  onSelectDb: (db: number) => void;
}

export function CliTab({
  handleId,
  connName,
  serverVersion,
  dbIndex,
  isProduction,
  state,
  onPersist,
  onMutated,
  onSelectDb,
}: CliTabProps) {
  const banner = useMemo<CliLine>(
    () => ({
      cls: "cli-info",
      text:
        "Connected to " +
        connName +
        " · " +
        serverVersion +
        ". Type a command, ↑/↓ for history.",
    }),
    [connName, serverVersion],
  );

  const [lines, setLines] = useState<CliLine[]>(state?.lines ?? [banner]);
  const [history, setHistory] = useState<string[]>(state?.history ?? []);
  const [input, setInput] = useState("");
  // History cursor: -1 = the live (unsubmitted) input, 0 = most recent command.
  const [histIdx, setHistIdx] = useState(-1);
  const [pending, setPending] = useState(false);
  // A destructive command awaiting production confirm: its raw line + tokens.
  const [confirm, setConfirm] = useState<{ line: string; tokens: string[] } | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Keep the latest onPersist in a ref so the persist effect only runs when the
  // log / history actually change (not on every parent render).
  const onPersistRef = useRef(onPersist);
  onPersistRef.current = onPersist;

  // Persist log + history whenever they change (survives tab switches).
  useEffect(() => {
    onPersistRef.current({ lines, history });
  }, [lines, history]);

  // Keep the log pinned to the newest line.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines]);

  const clearConsole = useCallback(() => setLines([]), []);

  // Run a tokenized command (already past the production confirm gate).
  const exec = useCallback(
    async (line: string, tokens: string[]) => {
      const cmd = (tokens[0] ?? "").toUpperCase();
      const promptLine: CliLine = {
        cls: "cli-prompt",
        text: connName + ":db" + dbIndex + "> " + line,
      };
      setLines((l) => [...l, promptLine]);
      setPending(true);
      try {
        const reply = await kvCommand(handleId, dbIndex, tokens);
        const replyLines = formatReply(reply);
        setLines((l) => [...l, ...replyLines]);
        // A server-side error reply (WRONGTYPE / ERR) is not a mutation.
        if (reply.kind !== "error") {
          if (cmd === "SELECT") {
            const n = parseInt(tokens[1] ?? "", 10);
            if (!Number.isNaN(n) && n >= 0 && n <= 15) onSelectDb(n);
          }
          if (isMutatingCommand(cmd)) onMutated();
        }
      } catch (err) {
        setLines((l) => [
          ...l,
          { cls: "cli-error", text: "(error) " + appErrorMessage(err, "command failed") },
        ]);
      } finally {
        setPending(false);
        inputRef.current?.focus();
      }
    },
    [connName, dbIndex, handleId, onMutated, onSelectDb],
  );

  // Submit the typed line: record history, then either confirm (production
  // destructive) or run.
  const submit = useCallback(
    (raw: string) => {
      const line = raw.trim();
      if (!line || pending) return;
      const tokens = tokenizeCommand(line);
      if (tokens.length === 0) return;
      setHistory((h) => [line, ...h].slice(0, MAX_HISTORY));
      setHistIdx(-1);
      setInput("");
      if (isProduction && isDestructiveCommand(tokens)) {
        setConfirm({ line, tokens });
        return;
      }
      void exec(line, tokens);
    },
    [exec, isProduction, pending],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.min(histIdx + 1, history.length - 1);
      if (n >= 0 && history[n] != null) {
        setHistIdx(n);
        setInput(history[n] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = histIdx - 1;
      if (n < 0) {
        setHistIdx(-1);
        setInput("");
      } else {
        setHistIdx(n);
        setInput(history[n] ?? "");
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      clearConsole();
    }
  };

  const runPreset = (preset: string) => {
    setInput(preset);
    inputRef.current?.focus();
    submit(preset);
  };

  const confirmRun = () => {
    const c = confirm;
    setConfirm(null);
    if (c) void exec(c.line, c.tokens);
  };

  return (
    <div className="rcli" data-screen-label="Redis CLI console">
      <div className="rcli-toolbar">
        <Icon name="terminal" size={15} style={{ color: "var(--accent)" }} />
        <span className="rcli-title">redis-cli</span>
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
        <div className="rcli-toolbar-spacer" />
        <IconBtn
          icon="delete_sweep"
          title="Clear console (Ctrl+L)"
          onClick={clearConsole}
        />
      </div>

      <div
        className="rcli-body"
        ref={bodyRef}
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((l, i) => (
          <div key={i} className={"rcli-line " + l.cls}>
            {l.text}
          </div>
        ))}
        <div className="rcli-inputline">
          <span className="rcli-prompt">
            {connName}:db{dbIndex}&gt;
          </span>
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
            autoFocus
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>

      {confirm ? (
        <Modal onClose={() => setConfirm(null)} label="Confirm destructive command" width={480}>
          <ModalTitle>
            <Icon name="warning" size={18} style={{ color: "#e06c75" }} /> Run a destructive
            command on production?
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
