// Redis status bar (REDIS_SPEC §9) — workspace color chip · name · env tag ·
// "Redis {version}" · tunnel lock (when tunneled) · "db{N}" ·
// spacer · active-key `type · memory` (when a key tab is active — humanBytes) ·
// "RESP{N}". The active-key info is reported up by the active KeyTab and passed
// in here. (The prototype's "mock engine" tag is dropped in production.)

import { EnvTag } from "../../../../shared/ui/EnvTag";
import { BuiltByCredit } from "../../../../shared/ui/BuiltByCredit";
import { ResourceMeter } from "../../../app_metrics/ResourceMeter";
import { Icon } from "../../../../shared/ui/Icon";
import type { Env } from "../../../../shared/types";
import type { ClusterTopology, KeyType } from "../api";
import { allNodes, totalKeys } from "../cluster";
import { humanBytes, humanNum, REDIS_TYPES } from "../helpers";
import "../../../processes/ProcessList.css";
import "./ClusterDashboard.css";
import "./RedisStatusBar.css";

interface RedisStatusBarProps {
  workspaceColor: string;
  workspaceName: string;
  env: Env;
  serverVersion: string;
  respVersion: number;
  isTunneled: boolean;
  tunnelHint: string;
  dbIndex: number;
  /**
   * The cluster topology when this connection is a cluster node (M36 §B3) —
   * adds the `cluster · N shards · M nodes` segment and switches the key count
   * to the cluster's single db0 keyspace.
   */
  cluster: ClusterTopology | null;
  /** The active key tab's type (null when no key tab is active). */
  activeKeyType: KeyType | null;
  /** The active key's `MEMORY USAGE` bytes (null when unknown / no key tab). */
  activeKeyMemory: number | null;
  /** Open (or focus) the connected-clients (processes) tab (M26). */
  onOpenProcesses: () => void;
}

export function RedisStatusBar(props: RedisStatusBarProps) {
  const {
    workspaceColor,
    workspaceName,
    env,
    serverVersion,
    respVersion,
    isTunneled,
    tunnelHint,
    dbIndex,
    cluster,
    activeKeyType,
    activeKeyMemory,
    onOpenProcesses,
  } = props;

  const clusterKeys = cluster ? totalKeys(cluster.shards) : null;
  // The node this connection is attached to, per CLUSTER NODES' `myself` flag.
  const currentNode = cluster ? (allNodes(cluster.shards).find((n) => n.myself) ?? null) : null;

  const keyMeta = activeKeyType
    ? activeKeyType + (activeKeyMemory !== null ? " · " + humanBytes(activeKeyMemory) : "")
    : null;

  return (
    <div className="redis-statusbar" role="status">
      <span className="ws-chip" style={{ background: workspaceColor }} />
      <span className="status-strong">{workspaceName}</span>
      <EnvTag env={env} />
      <span className="status-dim">{serverVersion}</span>
      {isTunneled ? (
        <span className="status-dim status-tunnel" title={tunnelHint}>
          <Icon name="vpn_lock" size={13} style={{ color: "var(--accent)" }} />
        </span>
      ) : null}
      {cluster ? (
        <span className="status-dim cl-status" title="Redis Cluster">
          <Icon name="lan" size={11} />
          {"cluster · " +
            cluster.shards.length +
            (cluster.shards.length === 1 ? " shard · " : " shards · ") +
            allNodes(cluster.shards).length +
            (allNodes(cluster.shards).length === 1 ? " node" : " nodes")}
        </span>
      ) : null}
      {/* Which node is being browsed. Not decoration: the keyspace, the client
          list and the INFO counters on screen all belong to THIS node. */}
      {currentNode ? (
        <span
          className="status-dim"
          title={
            "Attached to " +
            currentNode.host +
            ":" +
            currentNode.port +
            " (" +
            currentNode.role +
            ") — the keyspace, clients and stats shown are this node's"
          }
        >
          {currentNode.host}:{currentNode.port}
        </span>
      ) : null}
      {/* Cluster mode has one logical db, so the segment names db0 and the
          cluster-wide key total instead of a switchable index. */}
      <span className="status-dim">
        {cluster
          ? "db0" + (clusterKeys !== null ? " · " + humanNum(clusterKeys) + " keys" : "")
          : "db" + dbIndex}
      </span>
      <div style={{ flex: 1 }} />
      {keyMeta ? (
        <span
          className="status-dim"
          style={{ color: activeKeyType ? REDIS_TYPES[activeKeyType].color : undefined }}
        >
          {keyMeta}
        </span>
      ) : null}
      <button
        type="button"
        className="status-btn"
        title="Connected clients"
        onClick={onOpenProcesses}
      >
        <Icon name="monitor_heart" size={13} /> clients
      </button>
      <ResourceMeter />
      <BuiltByCredit className="status-dim" />
      <span className="status-dim">RESP{respVersion}</span>
    </div>
  );
}
