// Cluster node picker (M36 follow-up) — the popover behind the sidebar's
// `cluster keyspace` chip.
//
// Everything about a cluster keyspace is per node: `SCAN`, `INFO keyspace` and
// `CLIENT LIST` all answer for the server you are attached to, and a master
// only holds the slots it owns. So browsing a cluster means choosing a node,
// and the locked chip that replaced the db switcher was only telling half the
// story — `SELECT` is genuinely unavailable, but the shards are not one
// undifferentiated keyspace either.
//
// Two things the list has to be honest about:
//
//   - A **master** serves its own slot range. Switching to it is how you reach
//     keys that live on a different shard.
//   - A **replica** holds the same data but answers `MOVED` for a keyed read
//     unless the connection has sent `READONLY`. The caller does send it, so
//     replicas are browsable — the row says why they are different rather than
//     hiding them or offering something that half-works.

import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { useT } from "../../../../shared/i18n/useT";
import { allNodes, shardColor, shardName, shardSlots } from "../cluster";
import { humanBytes } from "../helpers";
import type { ClusterNode, ClusterShard, ClusterTopology } from "../api";
import "./ClusterDashboard.css";

/** Health flag → colour + label, matching the cluster dashboard's node rows. */
const HEALTH: Record<string, { color: string; label: string }> = {
  online: { color: "var(--accent)", label: "online" },
  "fail?": { color: "var(--warn)", label: "PFAIL" },
  fail: { color: "var(--danger)", label: "FAIL" },
  handshake: { color: "var(--warn)", label: "handshake" },
  noaddr: { color: "var(--danger)", label: "noaddr" },
};

export function ClusterNodePicker({
  topology,
  busy,
  onPick,
  onClose,
}: {
  topology: ClusterTopology;
  /** True while a switch is in flight — the rows disable rather than queue. */
  busy: boolean;
  onPick: (node: ClusterNode) => void;
  onClose: () => void;
}) {
  const t = useT();
  const nodes = allNodes(topology.shards);
  const current = nodes.find((n) => n.myself) ?? null;

  const row = (node: ClusterNode, shard: ClusterShard) => {
    const health = HEALTH[node.health] ?? HEALTH.online!;
    const isCurrent = current?.id === node.id;
    const isReplica = node.role === "replica";
    const nodeAddr = node.host + ":" + node.port;
    return (
      <button
        key={node.id}
        type="button"
        className={"cl-np-node" + (isCurrent ? " on" : "")}
        disabled={busy || isCurrent}
        title={
          isCurrent
            ? t("redis.np.already")
            : isReplica
              ? t("redis.np.browseReplica", { node: nodeAddr, shard: shardName(shard) })
              : t("redis.np.browseMaster", { node: nodeAddr, shard: shardName(shard) })
        }
        onClick={() => onPick(node)}
      >
        <Icon
          name={node.role === "master" ? "stars" : "content_copy"}
          size={13}
          style={{ color: node.role === "master" ? shardColor(shard.index) : "var(--text-faint)" }}
        />
        <span className="cl-np-addr">
          {node.host}:{node.port}
        </span>
        <span className={"cl-role " + node.role}>{node.role}</span>
        {isCurrent ? <span className="cl-me">{t("redis.np.here")}</span> : null}
        <div style={{ flex: 1 }} />
        <span className="cl-np-keys">
          {node.keys === null ? t("redis.np.noKeys") : t("redis.nKeys", { count: node.keys })}
        </span>
        <span className="cl-health" style={{ color: health.color }}>
          {health.label}
        </span>
      </button>
    );
  };

  return (
    <div className="cl-np" role="dialog" aria-label={t("redis.np.aria")}>
      <div className="cl-np-head">
        <Icon name="lan" size={14} style={{ color: "var(--accent)" }} />
        {t("redis.np.title")}
        <span className="cl-np-n">
          {t("redis.cl.shardsN", { count: topology.shards.length }) +
            " · " +
            t("redis.cl.nodesN", { count: nodes.length })}
        </span>
        <IconBtn icon="close" size={14} title={t("common.close")} onClick={onClose} />
      </div>

      <div className="cl-np-list">
        {topology.shards.map((shard) => (
          <div className="cl-np-shard" key={shard.master.id}>
            <div className="cl-np-shard-h">
              <span className="cl-shard-dot" style={{ background: shardColor(shard.index) }} />
              <b>{shardName(shard)}</b>
              <span className="cl-shard-slots">
                {t("redis.np.nSlots", { count: shardSlots(shard).toLocaleString() })}
              </span>
              <div style={{ flex: 1 }} />
              <span className="cl-np-mem">
                {shard.master.memory === null ? "" : humanBytes(shard.master.memory)}
              </span>
            </div>
            {row(shard.master, shard)}
            {shard.replicas.map((replica) => row(replica, shard))}
          </div>
        ))}
      </div>

      <div className="cl-np-foot">
        <Icon name="info" size={12} />
        <span>
          {t("redis.np.footA")} <code>SCAN</code> {t("redis.np.footB")} <code>SELECT</code>
          {t("redis.np.footC")}
        </span>
      </div>
    </div>
  );
}
