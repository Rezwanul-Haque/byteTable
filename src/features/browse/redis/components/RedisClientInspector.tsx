// Connected-client inspector (M36 §A2) — ported from the prototype's
// `RedisClientInspector`. Every reported field, grouped Connection / Activity /
// Pub-Sub & transactions / Buffers & memory and hover-documented from
// `FIELD_DOC`; the risk note; the raw `CLIENT INFO` line with copy; and the two
// client actions.
//
// One deliberate divergence from the prototype, forced by the real command:
// `CLIENT NO-EVICT` sets the eviction mode of the **calling** connection — it
// cannot be aimed at someone else's. So it is enabled only when the inspected
// client is your own, with a tooltip that says why, instead of toasting a
// command that would not have done what it claimed.

import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import {
  CLIENT_TYPE_COLOR,
  FIELD_DOC,
  clientField,
  clientRisk,
  flagSummary,
  humanAge,
  humanClientMem,
  humanNet,
  infoLine,
} from "../clients";
import type { KvClient } from "../api";
import "./RedisClientsTab.css";

/** The inspector's field groups, in the order they are shown. */
const GROUPS: [string, string[]][] = [
  ["Connection", ["id", "addr", "laddr", "fd", "name", "user", "resp", "lib-name"]],
  ["Activity", ["cmd", "flags", "events", "age", "idle", "db"]],
  ["Pub/Sub & transactions", ["sub", "psub", "ssub", "multi", "watch"]],
  [
    "Buffers & memory",
    ["tot-mem", "qbuf", "argv-mem", "obl", "oll", "omem", "tot-net-in", "tot-net-out"],
  ],
];

/** Humanize one field for display; anything unrecognised shows verbatim. */
function formatField(client: KvClient, field: string): string {
  const raw = clientField(client, field);
  const num = (fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  switch (field) {
    case "age":
    case "idle":
      return humanAge(num(0));
    case "tot-mem":
    case "argv-mem":
    case "omem":
      return humanClientMem(num(0));
    case "tot-net-in":
    case "tot-net-out":
      return humanNet(num(0));
    case "qbuf":
      return num(0) + " B";
    case "flags":
      return flagSummary(raw ?? client.flags);
    case "db":
      return "db" + (raw ?? client.db);
    case "lib-name": {
      const lib = raw ?? "";
      const version = clientField(client, "lib-ver") ?? "";
      return lib ? (version ? lib + " " + version : lib) : "—";
    }
    case "multi":
      return num(-1) < 0 ? "no transaction" : num(-1) + " queued";
    case "name":
      return raw || "—";
    default:
      return raw ?? "—";
  }
}

export function RedisClientInspector({
  client,
  onKill,
  onNoEvict,
  onUnpause,
  onCopyInfoLine,
  onClose,
}: {
  client: KvClient;
  onKill: (client: KvClient) => void;
  onNoEvict: () => void;
  onUnpause: () => void;
  onCopyInfoLine: (line: string) => void;
  onClose: () => void;
}) {
  const risk = clientRisk(client);
  const line = infoLine(client);
  const typeColor = CLIENT_TYPE_COLOR[client.clientType] ?? "var(--text-faint)";

  return (
    <aside className="rc-inspect" aria-label={"Client " + client.id}>
      <div className="rc-inspect-head">
        <span className="rc-type-dot" style={{ background: typeColor }} />
        <div className="rc-inspect-id">
          <b>#{client.id}</b>
          <span>{client.name || "unnamed client"}</span>
        </div>
        <IconBtn icon="close" size={15} title="Close inspector" onClick={onClose} />
      </div>
      <div className="rc-inspect-sub">
        {client.addr}
        {client.isSelf ? (
          <span className="proc-self" title="This connection">
            me
          </span>
        ) : null}
      </div>

      {risk ? (
        <div className={"rc-risk " + risk.sev}>
          <Icon name={risk.sev === "warn" ? "warning" : "info"} size={13} />
          <span>{risk.text}</span>
        </div>
      ) : null}

      <div className="rc-inspect-body">
        {GROUPS.map(([group, fields]) => {
          // Only show fields this server actually reported — an older Redis
          // omits some, and an empty row would be a lie about what it said.
          const present = fields.filter((f) => clientField(client, f) !== undefined);
          if (present.length === 0) return null;
          return (
            <div className="rc-igroup" key={group}>
              <div className="rc-igroup-h">{group}</div>
              {present.map((f) => (
                <div className="rc-ifield" key={f} title={FIELD_DOC[f] ?? ""}>
                  <span className="rc-ifield-k">{f}</span>
                  <span className="rc-ifield-v">{formatField(client, f)}</span>
                  {FIELD_DOC[f] ? <Icon name="help" size={11} className="rc-ifield-q" /> : null}
                </div>
              ))}
            </div>
          );
        })}
        <div className="rc-igroup">
          <div className="rc-igroup-h">CLIENT INFO</div>
          <pre className="rc-infoline">{line}</pre>
          <button type="button" className="rc-copy" onClick={() => onCopyInfoLine(line)}>
            <Icon name="content_copy" size={12} />
            Copy line
          </button>
        </div>
      </div>

      <div className="rc-inspect-foot">
        <button
          type="button"
          className="rc-act"
          disabled={!client.isSelf}
          title={
            client.isSelf
              ? "CLIENT NO-EVICT on — exempt this connection from client eviction"
              : "Redis applies CLIENT NO-EVICT to the calling connection only, so it cannot target another client"
          }
          onClick={onNoEvict}
        >
          <Icon name="shield" size={13} />
          No-evict
        </button>
        <button
          type="button"
          className="rc-act"
          title="CLIENT UNPAUSE — resume every paused client"
          onClick={onUnpause}
        >
          <Icon name="play_arrow" size={13} />
          Unpause
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-danger btn-small"
          disabled={client.isSelf}
          title={client.isSelf ? "This is your own connection" : "CLIENT KILL ID " + client.id}
          onClick={() => onKill(client)}
        >
          <Icon name="dangerous" size={14} />
          <span>Kill</span>
        </button>
      </div>
    </aside>
  );
}
