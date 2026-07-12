// MongoDB mongosh session body (M18) — the docked-terminal counterpart to
// SqlTerminalTab / RedisTerminalSession / DynamoPartiqlSession. Adapts the
// mongo_browse MongoShellTab REPL to a TerminalPanel session so mongosh docks at
// the bottom of the workspace (toggled with ⌘`/Ctrl+`) like every other engine's
// shell, rather than opening as a tab. Scrollback/history persist in
// `useMongoShellStore`, keyed by the session id. Mounted by TerminalPanel's
// engine branch.

import { useEffect, useState } from "react";

import { mongoListDatabases } from "../browse/mongo/api";
import { MongoShellTab } from "../browse/mongo/components/MongoShellTab";
import { useMongoActiveDbStore } from "../browse/mongo/shellState";
import type { Workspace } from "../workspaces/types";
import type { TermSession } from "./state";

export function MongoShellSession({
  workspace,
  session,
}: {
  workspace: Workspace;
  session: TermSession;
}) {
  const params = workspace.saved.params;
  const serverHost =
    params.engine === "mongodb" ? (params.uri ?? params.host + ":" + params.port) : "";
  // Seed from the sidebar's selected database (the db the user actually picked);
  // fall back to the connection default.
  const selectedDb = useMongoActiveDbStore((s) => s.byWorkspace[workspace.id]);
  const initialDb = selectedDb ?? (params.engine === "mongodb" ? (params.database ?? "") : "");
  const [db, setDb] = useState(initialDb);

  // If neither the sidebar selection nor a connection default is known yet, land
  // on the first listed database. Render the REPL only once a db is known so its
  // persisted scrollback seeds with the right starting database.
  useEffect(() => {
    if (db) return;
    let alive = true;
    void mongoListDatabases(workspace.handleId)
      .then((names) => {
        if (alive && names[0]) setDb(names[0]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspace.handleId, db]);

  if (!db) {
    return <div className="rcli term mg-shell" />;
  }

  return (
    <MongoShellTab
      sessionId={session.id}
      workspaceId={workspace.id}
      handleId={workspace.handleId}
      db={db}
      serverVersion={workspace.info.serverVersion}
      serverHost={serverHost}
      connName={workspace.name}
      onUseDb={setDb}
    />
  );
}
