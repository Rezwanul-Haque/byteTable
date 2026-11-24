// The Change history tab (M48 D): changes made through ByteTable on this
// connection, newest first, grouped by day — and on the right, the selected
// one with what undo would do. Ported from the prototype's UndoLogTab.

import { useEffect, useMemo, useState } from "react";

import { fmtNumber } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { useSettingsStore } from "../../settings/state";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Tab, Workspace } from "../../workspaces/types";
import { historyClear, historyList, type Summary } from "../api";
import { dayOf, sourceLabel, statusOf, timeOf, titleOf, undoable } from "../model";
import { useHistoryStore } from "../state";
import { UndoDetail } from "./UndoDetail";
import "./ChangeHistoryTab.css";

type HistoryTab = Extract<Tab, { kind: "history" }>;

const openHistorySettings = () => useSettingsStore.getState().openSettings("history");

export function ChangeHistoryTab({ workspace, tab }: { workspace: Workspace; tab: HistoryTab }) {
  const t = useT();
  const toast = useToast();
  const connId = workspace.saved.id;
  const settings = useSettingsStore((s) => s.settings);
  const version = useHistoryStore((s) => s.version);
  const bump = useHistoryStore((s) => s.bump);
  const recordingMap = useHistoryStore((s) => s.recording);
  const loadRecording = useHistoryStore((s) => s.loadRecording);
  const setRecording = useHistoryStore((s) => s.setRecording);
  const openHistoryTab = useWorkspacesStore((s) => s.openHistoryTab);
  const [entries, setEntries] = useState<Summary[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [armClear, setArmClear] = useState(false);
  const filter = tab.filter ?? null;
  const connOn = recordingMap[connId] ?? true;
  const recording = settings.undoRecord && connOn;

  useEffect(() => {
    void loadRecording(connId);
  }, [connId, loadRecording]);

  useEffect(() => {
    let live = true;
    historyList(connId, filter ? { table: filter.table, key: filter.key } : null)
      .then((list) => {
        if (live) setEntries(list);
      })
      .catch(() => {
        if (live) setEntries([]);
      });
    return () => {
      live = false;
    };
  }, [connId, filter, version]);

  // "View in history" / the table and row links open on the newest entry;
  // ⌥⌘Z opens on the newest that can still be undone. `nonce` re-applies.
  const [handled, setHandled] = useState<number | null>(null);
  if (entries && tab.nonce && handled !== tab.nonce) {
    setHandled(tab.nonce);
    const target =
      tab.focus === "undoable" ? entries.find(undoable) : tab.focus ? entries[0] : null;
    setSel(target ? target.id : null);
  }

  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (entries ?? []).filter(
        (e) =>
          !needle ||
          (titleOf(e) + " " + e.sql + " " + e.tables.join(" ")).toLowerCase().includes(needle),
      ),
    [entries, needle],
  );
  const current = shown.find((e) => e.id === sel) ?? shown[0] ?? null;
  const groups: { day: string; items: Summary[] }[] = [];
  for (const e of shown) {
    const day = dayOf(e.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  const total = entries?.length ?? 0;

  return (
    <div className="ul">
      <div className="ul-head">
        <Icon name="history" size={18} style={{ color: "var(--accent)" }} />
        <div className="ul-head-t">
          <b>{t("history.tabTitle")}</b>
          <span>
            {t("history.head.sub")} <span className="mono">{workspace.saved.name}</span>
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <label className="ul-search">
          <Icon name="search" size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("history.search")}
            aria-label={t("history.searchLabel")}
          />
        </label>
        <label
          className="ul-rec"
          title={t(settings.undoRecord ? "history.rec.hint" : "history.rec.offHint")}
        >
          <input
            type="checkbox"
            checked={recording}
            disabled={!settings.undoRecord}
            onChange={(e) => void setRecording(connId, e.target.checked)}
          />
          <span>{t("history.rec.label")}</span>
        </label>
        <IconBtn
          icon="settings"
          size={16}
          title={t("history.settingsHint")}
          onClick={openHistorySettings}
        />
      </div>

      {!recording ? (
        <div className="ul-paused" role="status">
          <Icon name="history_toggle_off" size={16} />
          <span>
            {t(settings.undoRecord ? "history.paused.conn" : "history.paused.all")}{" "}
            {t("history.paused.tail")}
          </span>
          {!settings.undoRecord ? (
            <button type="button" onClick={openHistorySettings}>
              {t("history.openSettings")}
            </button>
          ) : null}
        </div>
      ) : null}

      {entries && !total && !filter ? (
        <div className="ul-empty">
          <Icon name="history" size={30} />
          <div>{t("history.empty.title")}</div>
          <p>{t("history.empty.body")}</p>
        </div>
      ) : (
        <div className="ul-body">
          <div className="ul-list" role="listbox" aria-label={t("history.listLabel")}>
            {filter ? (
              <div className="ul-filter">
                <span>{t("history.filter.showing")}</span>
                <span className="ul-chip">
                  <Icon name="table" size={12} /> {filter.table}
                  {filter.key
                    ? " · " +
                      (filter.pk ?? []).map((k, i) => k + " " + String(filter.key?.[i])).join(", ")
                    : ""}
                </span>
                <button type="button" onClick={() => openHistoryTab({ filter: null })}>
                  {t("history.filter.all")}
                </button>
              </div>
            ) : null}
            {groups.map((g) => (
              <div key={g.day} role="presentation">
                <div className="ul-day">{g.day}</div>
                {g.items.map((e) => {
                  const s = statusOf(e);
                  const on = current?.id === e.id;
                  return (
                    <button
                      type="button"
                      key={e.id}
                      role="option"
                      aria-selected={on}
                      className={"ul-item" + (on ? " on" : "") + " s-" + s}
                      onClick={() => setSel(e.id)}
                    >
                      <span className="ul-item-time">{timeOf(e.at)}</span>
                      <span className="ul-item-main">
                        <span className="ul-item-title">{titleOf(e)}</span>
                        <span className="ul-item-sub">
                          {e.verb ? (
                            <span className={"txn-verb " + e.verb.toLowerCase()}>{e.verb}</span>
                          ) : null}
                          <span>{sourceLabel(e.source)}</span>
                          {s === "undone" ? (
                            <span className="ul-badge undone">{t("history.badge.undone")}</span>
                          ) : s === "partial" ? (
                            <span className="ul-badge partial">{t("history.badge.partial")}</span>
                          ) : s === "cant" ? (
                            <span className="ul-badge cant">{t("history.badge.cant")}</span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {entries && !shown.length ? (
              <div className="ul-nomatch">
                {needle ? t("history.noMatch", { q }) : t("history.noneHere")}
              </div>
            ) : null}
          </div>
          {current ? (
            <UndoDetail key={current.id} workspace={workspace} id={current.id} />
          ) : (
            <div className="ul-detail" />
          )}
        </div>
      )}

      <div className="ul-foot">
        <Icon name="laptop_mac" size={13} />
        <span className="ul-foot-note">
          {t("history.foot", {
            days: t("history.days", { count: settings.undoKeepDays }),
            n: fmtNumber(settings.undoKeepEntries),
            max: fmtNumber(settings.undoMaxRows),
          })}
        </span>
        <button type="button" onClick={openHistorySettings}>
          {t("history.foot.limits")}
        </button>
        {total && !filter ? (
          armClear ? (
            <>
              <span>{t("history.clear.confirm", { n: fmtNumber(total) })}</span>
              <button type="button" onClick={() => setArmClear(false)}>
                {t("history.cancel")}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void historyClear(connId).then(() => {
                    setArmClear(false);
                    bump();
                    toast(t("history.toast.cleared"), "ok");
                  });
                }}
              >
                {t("history.clear.go")}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setArmClear(true)}>
              {t("history.clear.open")}
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
