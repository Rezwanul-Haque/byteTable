// Kill-by-filter popover (M36 §A3) — ported from the prototype's
// `RedisKillFilter`. The six filters `CLIENT KILL` supports, each with a value
// field, suggestion chips drawn from the live list, the rendered command, and a
// live "N clients match" count computed with the same predicate the server
// applies. This is the surface that solves "kick the idle ones" — per-row
// killing does not scale to twenty leaked connections.
//
// It lives in `.proc-toolbar`, never in the wrapping `.rc-stats` strip: a
// wrapping `flex: 1` spacer would strand this `right: 0` popover at the left
// edge of the second row, painting over the sidebar.

import { useState } from "react";

import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { KILL_FILTERS } from "../clients";
import type { KvClient, KvKillFilter } from "../api";
import "./RedisClientsTab.css";

/** What the popover hands back when "Kill matching" is pressed. */
export interface KillFilterRequest {
  filter: KvKillFilter;
  value: string;
  /** The clients we predict it will hit (the confirm dialog lists them). */
  matched: KvClient[];
  cmd: string;
  title: string;
}

export function RedisKillFilter({
  clients,
  onRun,
  onClose,
}: {
  clients: KvClient[];
  onRun: (request: KillFilterRequest) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<KvKillFilter>("type");
  const [value, setValue] = useState("pubsub");
  const spec = KILL_FILTERS.find((f) => f.id === kind) ?? KILL_FILTERS[0];
  if (!spec) return null;

  // Our own connection is never a match — the server would close the socket
  // this very command travelled over.
  const matched = clients.filter((c) => !c.isSelf && spec.match(c, value));

  const suggestions: Record<KvKillFilter, string[]> = {
    type: ["normal", "pubsub", "replica"],
    user: [...new Set(clients.map((c) => c.user).filter(Boolean))],
    maxage: ["300", "3600", "86400"],
    laddr: [...new Set(clients.map((c) => c.laddr).filter(Boolean))],
    addr: [],
    id: [],
  };
  const chips = suggestions[kind];

  return (
    <div className="rc-kf" role="dialog" aria-label="Kill clients by filter">
      <div className="rc-kf-head">
        <Icon name="filter_alt" size={14} style={{ color: "var(--danger)" }} />
        Kill by filter
        <IconBtn icon="close" size={14} title="Close" onClick={onClose} />
      </div>
      <div className="rc-kf-kinds">
        {KILL_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={"rc-kf-kind" + (kind === f.id ? " on" : "")}
            onClick={() => {
              setKind(f.id);
              // Seed a value that already matches something for the filters
              // where a sensible default exists; the rest start empty.
              setValue(f.id === "type" ? "pubsub" : f.id === "maxage" ? "3600" : "");
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="rc-kf-val">
        <input
          value={value}
          placeholder={spec.hint}
          spellCheck="false"
          aria-label={spec.label + " value"}
          onChange={(e) => setValue(e.target.value)}
        />
        {chips && chips.length > 0 ? (
          <div className="rc-kf-sugg">
            {chips.slice(0, 4).map((s) => (
              <button
                key={s}
                type="button"
                className={value === s ? "on" : ""}
                onClick={() => setValue(s)}
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <pre className="rc-kf-cmd">{spec.cmd(value || "…")}</pre>
      <div className="rc-kf-foot">
        <span className={matched.length ? "rc-kf-n" : "rc-kf-n zero"}>
          {matched.length + (matched.length === 1 ? " client matches" : " clients match")}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-danger btn-small"
          disabled={matched.length === 0 || value.trim() === ""}
          onClick={() =>
            onRun({
              filter: kind,
              value: value.trim(),
              matched,
              cmd: spec.cmd(value.trim()),
              title:
                "Kill " +
                matched.length +
                (matched.length === 1 ? " client · " : " clients · ") +
                spec.label.toLowerCase(),
            })
          }
        >
          <Icon name="dangerous" size={14} />
          <span>Kill matching</span>
        </button>
      </div>
    </div>
  );
}
