// The assistant in a non-SQL workspace (Cassandra, DynamoDB, MongoDB,
// Typesense, Redis): the same drawer the SQL tab has, hosted once per
// workspace over its content area. Whatever the assistant writes goes to the
// workspace's own shell — "Use in terminal" opens the docked panel and puts the
// command on its prompt line (`injectInput`); nothing runs until Enter.
//
// ⌘I / Ctrl+I toggles it, like the SQL tab's; the tab bar's Ask button
// (`AiAskTool`) and the status chip are the other ways in. The drawer's
// "editor" is the shell: the explain question reads the active session's
// pending text, or its last command.

import { useEffect, useState } from "react";

import { useT } from "../../../shared/i18n/useT";
import { useToast } from "../../../shared/ui/toastContext";
import { shellLabel, usePanelStore } from "../../console/state";
import type { Workspace } from "../../workspaces/types";
import { useAssistant } from "../hooks/useAssistant";
import { openAiSettings } from "../openSettings";
import { hostKey, useAssistantStore } from "../state";
import { AiPanel, type AiAltAction } from "./AiPanel";
import "./Assistant.css";

export function AiWorkspaceHost({
  workspace,
  scope,
  altAction,
}: {
  workspace: Workspace;
  /** What the schema is read from: a keyspace, a database, a Redis db
   *  number; empty for DynamoDB and Typesense. */
  scope: string;
  /** A workspace's own second destination (MongoDB's Aggregation tab). */
  altAction?: AiAltAction;
}) {
  const t = useT();
  const toast = useToast();
  const key = hostKey(workspace.id);
  const conn = { id: workspace.saved.id, env: workspace.saved.env, name: workspace.saved.name };
  const { state } = useAssistant(conn);
  const open = useAssistantStore((s) => !!s.open[key]);
  const setOpen = useAssistantStore((s) => s.setOpen);
  const injectInput = usePanelStore((s) => s.injectInput);
  const label = shellLabel(workspace.info.engine);
  const [askNonce, setAskNonce] = useState(0);

  // The shell's text the explain question is about: what is on its prompt /
  // in its editor, else the last command it ran.
  const shellText = usePanelStore((s) => {
    const p = s.byWorkspace[workspace.id];
    const cur = p?.sessions.find((x) => x.id === p.activeSessionId);
    return (cur?.buffer || cur?.history[0] || "").trim();
  });

  // ⌘I / Ctrl+I toggles the drawer. Capture phase, so a focused shell input
  // doesn't swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        e.stopPropagation();
        if (open) setOpen(key, false);
        else if (state === "off") openAiSettings();
        else {
          setOpen(key, true);
          setAskNonce((n) => n + 1);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, state, key, setOpen]);

  return (
    <>
      <div
        className={"drawer-scrim" + (open ? " show" : "")}
        onClick={() => setOpen(key, false)}
        aria-hidden="true"
      />
      <AiPanel
        tabId={key}
        wsKey={workspace.id}
        open={open}
        onClose={() => setOpen(key, false)}
        conn={conn}
        handleId={workspace.handleId}
        schemaName={scope}
        engine={workspace.info.engine}
        getSql={() => shellText}
        hasSql={shellText !== ""}
        askNonce={askNonce}
        planRequest={null}
        askRequest={null}
        useLabel={t("ai.term.use")}
        usedLabel={t("ai.term.used")}
        altAction={altAction}
        onAccept={(code) => {
          injectInput(workspace.id, label, code);
          toast(t("ai.term.placed", { shell: label }), "ok");
        }}
      />
    </>
  );
}
