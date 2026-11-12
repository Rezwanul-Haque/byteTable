// Small pieces every assistant surface shares: the destination chip, the
// one-line prompt summary, the exact-prompt view, rich text in answers, and
// the opener for Settings → AI assistant.

import type { ReactNode } from "react";

import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import type { Dest, Prepared } from "../api";
import { richSegments, splitSlots } from "../logic";

/** `code` and **bold** in a model answer. */
export function AiRich({ text }: { text: string }) {
  return (
    <>
      {richSegments(text).map((p, i) =>
        p.k === "code" ? (
          <code key={i}>{p.t}</code>
        ) : p.k === "bold" ? (
          <b key={i}>{p.t}</b>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </>
  );
}

/**
 * One translated message with elements in it: `text` comes from
 * `t(key, { name: slot("name") })`, and each slot is replaced by its node, so
 * the sentence stays whole and each locale orders it as it needs.
 */
export function AiFill({ text, slots }: { text: string; slots: Record<string, ReactNode> }) {
  return (
    <>
      {splitSlots(text).map((seg, i) =>
        "slot" in seg ? <span key={i}>{slots[seg.slot]}</span> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

/** Accent = this machine (loopback); amber = the prompt leaves it. */
export function AiDest({ d, long }: { d: Dest; long?: boolean }) {
  const t = useT();
  return (
    <span
      className={"ai-dest " + (d.local ? "local" : "remote")}
      title={
        (d.local ? t("ai.dest.stays", { host: d.host }) : t("ai.dest.leaves", { host: d.host })) +
        " — " +
        (d.local ? t("ai.dest.localTitle") : t("ai.dest.remoteTitle", { host: d.host }))
      }
    >
      <Icon name={d.local ? "lan" : "cloud_upload"} size={13} />
      <span className="ai-dest-t">
        {long
          ? d.local
            ? t("ai.dest.stays", { host: d.host })
            : t("ai.dest.leaves", { host: d.host })
          : d.host}
      </span>
    </span>
  );
}

/** The exact prompt, line by line, styled by section. */
export function AiPromptView({ prompt }: { prompt: Prepared }) {
  const t = useT();
  return (
    <div className="ai-prompt" tabIndex={0} aria-label={t("ai.prompt.aria")}>
      {prompt.parts.map((p, i) => (
        <span key={i} className={p.k}>
          {p.t || " "}
        </span>
      ))}
    </div>
  );
}

/** "Structure of N tables (M columns) · no row values · ≈T tokens". */
export function AiPromptSummary({
  prompt,
  open,
  onToggle,
}: {
  prompt: Prepared;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const rows = prompt.rowTables.length > 0;
  return (
    <div className={"ai-sum" + (rows ? " warn" : "")}>
      <Icon name={rows ? "warning" : "shield"} size={15} />
      <span>
        {rows
          ? t("ai.sum.withRows", {
              count: prompt.tables,
              cols: prompt.cols,
              tables: prompt.rowTables.join(", "),
              tokens: prompt.tokens.toLocaleString(),
            })
          : t("ai.sum.structure", {
              count: prompt.tables,
              cols: prompt.cols,
              tokens: prompt.tokens.toLocaleString(),
            })}
      </span>
      <button type="button" className="ai-link" onClick={onToggle} aria-expanded={open}>
        {open ? t("ai.sum.hide") : t("ai.sum.view")}
      </button>
    </div>
  );
}

/** A note row with an icon, as the answers and the fix card use it. */
export function AiNote({
  icon,
  warn,
  children,
}: {
  icon: string;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={"ai-note" + (warn ? " warn" : "")}>
      <Icon name={icon} size={15} /> <span>{children}</span>
    </div>
  );
}
