// Typesense HTTP console session body (M30 Task 8) — the docked-terminal
// counterpart to SqlTerminalTab / RedisTerminalSession / MongoShellSession /
// CassandraShellSession. Mounted by TerminalPanel's engine branch.
//
// Typesense has no REPL: its "shell" is the HTTP API itself. So this session is
// a request runner with a deliberately forgiving parser (see `httpConsole.ts`) —
// bare paths, full URLs, pasted `curl`, a trailing JSON body — printing the
// `HTTP <status>` line (danger on ≥400) above the syntax-highlighted body.
//
// The API key is never typed here and never displayed: the backend attaches the
// connection's key to every proxied request, and any `-H` in a pasted curl is
// dropped. That is exactly what lets a curl copied from the playground's request
// panel (which carries a `${TYPESENSE_API_KEY}` placeholder) run unchanged.

import { useEffect, useRef, useState } from "react";

import { isAppErrorPayload } from "../../shared/api/error";
import { typesenseRawHttp } from "../browse/typesense/api";
import { TsJson } from "../browse/typesense/components/TsJson";
import { helpText, parseConsoleCommand } from "../browse/typesense/httpConsole";
import { useTsTabsStore } from "../browse/typesense/workspaceTabs";
import type { Workspace } from "../workspaces/types";
import type { TermSession } from "./state";

interface TextLine {
  kind: "text";
  cls: string;
  text: string;
}
interface JsonLine {
  kind: "json";
  value: unknown;
}
type Line = TextLine | JsonLine;

export function TypesenseHttpSession({
  workspace,
}: {
  workspace: Workspace;
  session: TermSession;
}) {
  const handleId = workspace.handleId;
  // The collection the workspace is on, so the presets and the parse-failure
  // examples name something real rather than a hard-coded `products`.
  const collection = useTsTabsStore((s) => s.byWorkspace[workspace.id]?.coll ?? "");
  const params = workspace.saved.params;
  const base =
    params.engine === "typesense"
      ? params.protocol + "://" + params.host + ":" + params.port
      : workspace.name;

  const [lines, setLines] = useState<Line[]>([
    { kind: "text", cls: "term-info", text: "Typesense HTTP console — " + base },
    {
      kind: "text",
      cls: "term-meta",
      text: "X-TYPESENSE-API-KEY is taken from the connection. Type HELP for examples.",
    },
  ]);
  const [input, setInput] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines]);

  const out = (arr: Line[]) => setLines((ls) => [...ls, ...arr]);

  const runCmd = async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    out([{ kind: "text", cls: "cli-prompt", text: "$ " + cmd }]);
    setHist((h) => [cmd, ...h]);
    setHi(-1);

    const low = cmd.toLowerCase();
    if (low === "help" || low === "?") {
      out([{ kind: "text", cls: "term-meta", text: helpText(collection) }]);
      return;
    }
    if (low === "clear" || low === "cls") {
      setLines([]);
      return;
    }

    const parsed = parseConsoleCommand(cmd, collection);
    if (!parsed.ok) {
      out([{ kind: "text", cls: "term-err", text: parsed.message }]);
      return;
    }

    setBusy(true);
    try {
      const response = await typesenseRawHttp(handleId, parsed.request);
      out([
        {
          kind: "text",
          cls: response.status >= 400 ? "term-err" : "term-meta",
          text:
            "HTTP " + response.status + "  " + parsed.request.method + " " + parsed.request.path,
        },
        { kind: "json", value: response.body },
      ]);
    } catch (e) {
      // A transport failure never reached the server, so there is no status to
      // print — say that rather than inventing one.
      out([
        {
          kind: "text",
          cls: "term-err",
          text: isAppErrorPayload(e) ? e.message : "The request could not be sent.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const name = collection || "products";
  const presets = [
    "GET /collections",
    "/collections/" + name,
    "/collections/" + name + "/documents/search?q=*&query_by=",
    "GET /health",
  ];

  return (
    <div className="rcli term mg-shell">
      <div className="rcli-body term-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {lines.map((l, i) =>
          l.kind === "json" ? (
            <TsJson key={i} value={l.value} />
          ) : (
            <div key={i} className={"rcli-line " + l.cls}>
              {l.text}
            </div>
          ),
        )}
        <div className="rcli-inputline">
          <span className="rcli-prompt term-prompt-str">$</span>
          <input
            ref={inputRef}
            className="rcli-input"
            value={input}
            spellCheck={false}
            autoFocus
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void runCmd(input);
                setInput("");
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                const n = Math.min(hist.length - 1, hi + 1);
                if (n >= 0) {
                  setHi(n);
                  setInput(hist[n] ?? "");
                }
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const n = hi - 1;
                if (n < 0) {
                  setHi(-1);
                  setInput("");
                } else {
                  setHi(n);
                  setInput(hist[n] ?? "");
                }
              }
            }}
          />
        </div>
      </div>
      <div className="term-foot">
        <span className="term-schema">
          {workspace.name}
          {collection ? " · " + collection : ""}
        </span>
        <div className="sql-snippets">
          {presets.map((p) => (
            <button
              key={p}
              className="snippet-chip"
              onClick={() => {
                setInput(p);
                inputRef.current?.focus();
              }}
            >
              {p.length > 38 ? p.slice(0, 36) + "…" : p}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
