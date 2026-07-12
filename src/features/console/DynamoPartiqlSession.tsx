// DynamoDB PartiQL session body (M17) — the docked-terminal counterpart to
// SqlTerminalTab / RedisTerminalSession. Unlike a line REPL, PartiQL is an
// editor + results grid (per the prototype's `DynamoPartiql` in
// dynamo-shell.jsx), so this adapts the panel session to the dynamo_browse
// PartiQL editor: the session's `buffer` holds the editor SQL and `history` the
// statement history, persisted via `patchSession` so they survive panel
// hide/workspace switch. Mounted by TerminalPanel's engine branch.

import { useEffect, useState } from "react";

import { dynamoListTables, type TableDescriptor } from "../browse/dynamo/api";
import { DynamoPartiqlTab } from "../browse/dynamo/components/DynamoPartiqlTab";
import type { Workspace } from "../workspaces/types";
import { usePanelStore, type TermSession } from "./state";

export function DynamoPartiqlSession({
  workspace,
  session,
}: {
  workspace: Workspace;
  session: TermSession;
}) {
  const patchSession = usePanelStore((s) => s.patchSession);
  const [tables, setTables] = useState<TableDescriptor[]>([]);

  // Fetch the table list once (for the preset chips). Best-effort.
  useEffect(() => {
    let alive = true;
    void dynamoListTables(workspace.handleId)
      .then((t) => {
        if (alive) setTables(t);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspace.handleId]);

  return (
    <DynamoPartiqlTab
      handleId={workspace.handleId}
      tables={tables}
      sql={session.buffer}
      history={session.history}
      onChange={(patch) =>
        patchSession(workspace.id, session.id, {
          ...(patch.sql !== undefined ? { buffer: patch.sql } : {}),
          ...(patch.history !== undefined ? { history: patch.history } : {}),
        })
      }
    />
  );
}
