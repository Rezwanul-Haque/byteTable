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
import { useT } from "../../../../shared/i18n/useT";
import {
  CLIENT_TYPE_COLOR,
  fieldDoc,
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

/** The inspector's field groups, in the order they are shown — headers are
 *  i18n keys resolved at render time. */
const GROUPS: [
  "redis.ig.connection" | "redis.ig.activity" | "redis.ig.pubsub" | "redis.ig.buffers",
  string[],
][] = [
  ["redis.ig.connection", ["id", "addr", "laddr", "fd", "name", "user", "resp", "lib-name"]],
  ["redis.ig.activity", ["cmd", "flags", "events", "age", "idle", "db"]],
  ["redis.ig.pubsub", ["sub", "psub", "ssub", "multi", "watch"]],
  [
    "redis.ig.buffers",
    ["tot-mem", "qbuf", "argv-mem", "obl", "oll", "omem", "tot-net-in", "tot-net-out"],
  ],
];

/** Humanize one field for display; anything unrecognised shows verbatim. */
function formatField(
  client: KvClient,
  field: string,
  t: (key: "redis.ig.noTxn" | "redis.ig.queued", vars?: { count: number }) => string,
): string {
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
      return num(-1) < 0 ? t("redis.ig.noTxn") : t("redis.ig.queued", { count: num(-1) });
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
  const t = useT();
  const risk = clientRisk(client);
  const line = infoLine(client);
  const typeColor = CLIENT_TYPE_COLOR[client.clientType] ?? "var(--text-faint)";

  return (
    <aside className="rc-inspect" aria-label={t("redis.ig.clientAria", { id: client.id })}>
      <div className="rc-inspect-head">
        <span className="rc-type-dot" style={{ background: typeColor }} />
        <div className="rc-inspect-id">
          <b>#{client.id}</b>
          <span>{client.name || t("redis.ig.unnamedClient")}</span>
        </div>
        <IconBtn icon="close" size={15} title={t("redis.ig.closeTitle")} onClick={onClose} />
      </div>
      <div className="rc-inspect-sub">
        {client.addr}
        {client.isSelf ? (
          <span className="proc-self" title={t("redis.ct.thisConn")}>
            me
          </span>
        ) : null}
      </div>

      {risk ? (
        <div className={"rc-risk " + risk.sev}>
          <Icon name={risk.sev === "warn" ? "warning" : "info"} size={13} />
          <span>{t(risk.key, risk.vars)}</span>
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
              <div className="rc-igroup-h">{t(group)}</div>
              {present.map((f) => (
                <div className="rc-ifield" key={f} title={fieldDoc(f) ?? ""}>
                  <span className="rc-ifield-k">{f}</span>
                  <span className="rc-ifield-v">{formatField(client, f, t)}</span>
                  {fieldDoc(f) ? <Icon name="help" size={11} className="rc-ifield-q" /> : null}
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
            {t("redis.ig.copyLine")}
          </button>
        </div>
      </div>

      <div className="rc-inspect-foot">
        <button
          type="button"
          className="rc-act"
          disabled={!client.isSelf}
          title={client.isSelf ? t("redis.ig.noEvictSelf") : t("redis.ig.noEvictOther")}
          onClick={onNoEvict}
        >
          <Icon name="shield" size={13} />
          {t("redis.ig.noEvictBtn")}
        </button>
        <button
          type="button"
          className="rc-act"
          title={t("redis.ig.unpauseTitle")}
          onClick={onUnpause}
        >
          <Icon name="play_arrow" size={13} />
          {t("redis.ig.unpauseBtn")}
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-danger btn-small"
          disabled={client.isSelf}
          title={client.isSelf ? t("redis.ct.selfTitle") : "CLIENT KILL ID " + client.id}
          onClick={() => onKill(client)}
        >
          <Icon name="dangerous" size={14} />
          <span>{t("redis.ig.killBtn")}</span>
        </button>
      </div>
    </aside>
  );
}
