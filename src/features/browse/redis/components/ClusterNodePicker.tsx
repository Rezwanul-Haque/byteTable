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
import { allNodes, shardColor, shardName, shardSlots } from "../cluster";
import { humanBytes, humanNum } from "../helpers";
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
  const nodes = allNodes(topology.shards);
  const current = nodes.find((n) => n.myself) ?? null;

  const row = (node: ClusterNode, shard: ClusterShard) => {
    const health = HEALTH[node.health] ?? HEALTH.online!;
    const isCurrent = current?.id === node.id;
    const isReplica = node.role === "replica";
    return (
      <button
        key={node.id}
        type="button"
        className={"cl-np-node" + (isCurrent ? " on" : "")}
        disabled={busy || isCurrent}
        title={
          isCurrent
            ? "Already browsing this node"
            : isReplica
              ? "Browse " +
                node.host +
                ":" +
                node.port +
                " — a replica of " +
                shardName(shard) +
                ". Reads are served in READONLY mode and may lag its master."
              : "Browse " +
                node.host +
                ":" +
                node.port +
                " — the master for " +
                shardName(shard) +
                "'s slots"
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
        {isCurrent ? <span className="cl-me">here</span> : null}
        <div style={{ flex: 1 }} />
        <span className="cl-np-keys">
          {node.keys === null ? "— keys" : humanNum(node.keys) + " keys"}
        </span>
        <span className="cl-health" style={{ color: health.color }}>
          {health.label}
        </span>
      </button>
    );
  };

  return (
    <div className="cl-np" role="dialog" aria-label="Browse a cluster node">
      <div className="cl-np-head">
        <Icon name="lan" size={14} style={{ color: "var(--accent)" }} />
        Browse a node
        <span className="cl-np-n">
          {topology.shards.length +
            (topology.shards.length === 1 ? " shard · " : " shards · ") +
            nodes.length +
            (nodes.length === 1 ? " node" : " nodes")}
        </span>
        <IconBtn icon="close" size={14} title="Close" onClick={onClose} />
      </div>

      <div className="cl-np-list">
        {topology.shards.map((shard) => (
          <div className="cl-np-shard" key={shard.master.id}>
            <div className="cl-np-shard-h">
              <span className="cl-shard-dot" style={{ background: shardColor(shard.index) }} />
              <b>{shardName(shard)}</b>
              <span className="cl-shard-slots">
                {shardSlots(shard).toLocaleString() + " slots"}
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
          A node only holds the slots it owns, and <code>SCAN</code> answers for the node you are
          attached to — so this is how you reach another shard&apos;s keys. There is still no{" "}
          <code>SELECT</code>: a cluster has one database.
        </span>
      </div>
    </div>
  );
}
