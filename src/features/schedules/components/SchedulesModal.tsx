// Scheduled queries manager (M41) — the list of schedules, their next and
// last runs, and the editor form.
//
// Hosted as a MODAL rather than as a fourth right-side drawer beside saved
// queries / history / snippets. Those three are "pick one and put it in the
// editor you are looking at"; this one is a settings surface for work that
// happens when nobody is looking, with no relationship to the active tab — and
// it needs the width for a two-column form the drawer's 420px cannot give.
//
// Connected to the global schedules store itself (rather than taking a list),
// so no opener has to own the store wiring.

import { useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalTitle } from "../../../shared/ui/Modal";
import { Select, type SelectOption } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import { useConnectionsStore } from "../../connections/state";
import { useSavedQueriesStore } from "../../saved_queries/state";
import {
  DEFAULT_KEEP,
  DEFAULT_ROW_LIMIT,
  MIN_EVERY_MINUTES,
  RUN_FINISHED_EVENT,
  RUN_STARTED_EVENT,
  scheduleReveal,
  type OutputFormat,
  type RecurrenceKind,
  type RunRecord,
  type RunStarted,
  type Schedule,
} from "../api";
import { FILENAME_TOKENS, previewFilename, SQL_TOKENS } from "../filename";
import { baseName, shortenPath } from "../path";
import {
  describeRecurrence,
  RECURRENCE_KINDS,
  weekdayLabel,
  withField,
  withKind,
} from "../recurrence";
import { historyNewestFirst, lastRun, useSchedulesStore } from "../state";
import "./SchedulesModal.css";

/** Engines a schedule can run against: the ones that produce a SQL result set. */
const SQL_ENGINES = new Set(["postgres", "mysql", "sqlite", "mssql", "clickhouse"]);

/** A blank schedule, with the defaults the Rust side would apply anyway. */
function emptySchedule(connectionId: string): Schedule {
  return {
    id: "",
    name: "",
    enabled: true,
    connectionId,
    schema: null,
    savedQueryId: null,
    sql: "",
    recurrence: { kind: "daily", hour: 3, minute: 0 },
    format: "csv",
    directory: "",
    filename: "{{name}}_{{date}}",
    keep: DEFAULT_KEEP,
    rowLimit: DEFAULT_ROW_LIMIT,
    createdAt: 0,
    nextRunAt: 0,
  };
}

/** A timestamp as a short local date-time, or an em dash for "never". */
function stamp(ms: number | undefined | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SchedulesModal({
  /** Connection the active workspace is on, as the new-schedule default. The
   *  app hosts this modal, so there may be no workspace and no default. */
  defaultConnectionId,
  /** Schema the active workspace is on, as the new-schedule default. */
  defaultSchema,
}: {
  defaultConnectionId?: string;
  defaultSchema?: string;
}) {
  const t = useT();
  const toast = useToast();
  const schedules = useSchedulesStore((s) => s.schedules);
  const runs = useSchedulesStore((s) => s.runs);
  const loaded = useSchedulesStore((s) => s.loaded);
  const loadError = useSchedulesStore((s) => s.loadError);
  const runningId = useSchedulesStore((s) => s.runningId);
  const load = useSchedulesStore((s) => s.load);
  const save = useSchedulesStore((s) => s.save);
  const remove = useSchedulesStore((s) => s.remove);
  const setEnabled = useSchedulesStore((s) => s.setEnabled);
  const runNow = useSchedulesStore((s) => s.runNow);
  const applyRun = useSchedulesStore((s) => s.applyRun);
  const markRunning = useSchedulesStore((s) => s.markRunning);
  const seed = useSchedulesStore((s) => s.seed);
  const onClose = useSchedulesStore((s) => s.closeManager);

  const savedConnections = useConnectionsStore((s) => s.savedConnections);
  const loadConnections = useConnectionsStore((s) => s.load);
  const savedQueries = useSavedQueriesStore((s) => s.savedQueries);
  const loadSavedQueries = useSavedQueriesStore((s) => s.load);

  // The schedule being edited, or null while browsing. An empty `id` is a new
  // one; otherwise it edits that entry in place.
  const [draft, setDraft] = useState<Schedule | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Which schedule's history is expanded in the list.
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  const connectionOptions: SelectOption[] = useMemo(
    () =>
      savedConnections
        .filter((c) => SQL_ENGINES.has(c.engine))
        .map((c) => ({ value: c.id, label: c.name })),
    [savedConnections],
  );

  useEffect(() => {
    void load();
    void loadConnections();
    void loadSavedQueries();
  }, [load, loadConnections, loadSavedQueries]);

  // A run that starts or finishes ANYWHERE — the 3am one, or one begun before
  // this modal opened — drives the list without a reload. Both halves matter:
  // a run against a real server takes time, and without the start event the
  // row would sit still and then change with no explanation.
  useEffect(() => {
    const disposers: (() => void)[] = [];
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await Promise.all([
          listen<RunStarted>(RUN_STARTED_EVENT, (event) => markRunning(event.payload.scheduleId)),
          listen<RunRecord>(RUN_FINISHED_EVENT, (event) => applyRun(event.payload)),
        ]);
        // Mounted and unmounted before the listeners attached: drop them now.
        if (cancelled) unlisten.forEach((off) => off());
        else disposers.push(...unlisten);
      } catch {
        // Plain browser dev — no Tauri, so no events. The list is static.
      }
    })();
    return () => {
      cancelled = true;
      disposers.forEach((off) => off());
    };
  }, [applyRun, markRunning]);

  // Opened from "Schedule this query…": straight into a prefilled form, since
  // browsing the list is not what that caller asked for. Guarded by a ref so
  // the store's saved-query list arriving a tick later does not rebuild the
  // draft over edits the user has already started making.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !seed) return;
    prefilled.current = true;
    setDraft({
      ...emptySchedule(defaultConnectionId ?? connectionOptions[0]?.value ?? ""),
      sql: seed.sql,
      savedQueryId: seed.savedQueryId ?? null,
      schema: seed.schema ?? defaultSchema ?? null,
      name: savedQueries.find((q) => q.id === seed.savedQueryId)?.name ?? "",
    });
  }, [seed, defaultConnectionId, defaultSchema, connectionOptions, savedQueries]);

  const startNew = () => {
    setFormError(null);
    setDraft({
      ...emptySchedule(defaultConnectionId ?? connectionOptions[0]?.value ?? ""),
      schema: defaultSchema ?? null,
    });
  };

  const commit = async () => {
    if (!draft) return;
    setFormError(null);
    try {
      await save(draft);
      setDraft(null);
      toast(t("sched.saved", { name: draft.name.trim() }), "ok");
    } catch (error) {
      setFormError(appErrorMessage(error, t("sched.saveFailed")));
    }
  };

  const doRunNow = async (schedule: Schedule) => {
    try {
      const record = await runNow(schedule.id);
      if (record.error) toast(t("sched.runFailed", { name: schedule.name }), "err");
      else toast(t("sched.ranOk", { rows: record.rowCount, name: schedule.name }), "ok");
      setOpenHistory(schedule.id);
    } catch (error) {
      toast(appErrorMessage(error, t("sched.runFailed", { name: schedule.name })), "err");
    }
  };

  // Open the folder (or reveal the file) in Finder / Explorer. Failures are
  // worth a toast rather than a silent no-op: the commonest one is a schedule
  // that has not run yet, where the folder genuinely is not there, and saying
  // so is more use than a click that appears to do nothing.
  const reveal = async (path: string) => {
    try {
      await scheduleReveal(path);
    } catch (error) {
      toast(appErrorMessage(error, t("sched.revealFailed")), "err");
    }
  };

  const doDelete = async (schedule: Schedule) => {
    try {
      await remove(schedule.id);
      if (draft?.id === schedule.id) setDraft(null);
    } catch (error) {
      toast(appErrorMessage(error, t("sched.deleteFailed")), "err");
    }
  };

  const doToggle = async (schedule: Schedule) => {
    try {
      await setEnabled(schedule.id, !schedule.enabled);
    } catch (error) {
      toast(appErrorMessage(error, t("sched.saveFailed")), "err");
    }
  };

  return (
    <Modal onClose={onClose} label={t("sched.title")} width={720} className="sched-modal">
      <ModalTitle>
        <span>{t("sched.title")}</span>
        {draft ? null : (
          <Btn small icon="add" variant="filled" onClick={startNew}>
            {t("sched.new")}
          </Btn>
        )}
      </ModalTitle>

      {draft ? (
        <ScheduleForm
          draft={draft}
          onChange={setDraft}
          error={formError}
          connectionOptions={connectionOptions}
          onCancel={() => {
            setDraft(null);
            setFormError(null);
          }}
          onSave={commit}
        />
      ) : (
        <div className="sched-body">
          {loadError ? <div className="sched-error">{loadError}</div> : null}

          {loaded && schedules.length === 0 && !loadError ? (
            <div className="sched-empty">
              <Icon name="schedule" size={28} />
              <p>{t("sched.emptyTitle")}</p>
              <p className="sched-empty-hint">{t("sched.emptyHint")}</p>
            </div>
          ) : null}

          {schedules.map((schedule) => {
            const last = lastRun(runs, schedule.id);
            const expanded = openHistory === schedule.id;
            const running = runningId === schedule.id;
            return (
              <div
                key={schedule.id}
                className={
                  "sched-row" +
                  (schedule.enabled ? "" : " sched-row-off") +
                  (running ? " sched-row-running" : "")
                }
              >
                <div className="sched-row-main">
                  <div className="sched-row-head">
                    <span className="sched-name">{schedule.name}</span>
                    {running ? (
                      <span className="sched-chip sched-chip-running">
                        <span className="sched-spinner" /> {t("sched.running")}
                      </span>
                    ) : null}
                    <span className="sched-chip">{describeRecurrence(schedule.recurrence, t)}</span>
                    <span className="sched-chip sched-chip-format">{schedule.format}</span>
                    {last?.error ? (
                      <span className="sched-chip sched-chip-bad">{t("sched.lastFailed")}</span>
                    ) : null}
                    {last?.truncated ? (
                      <span className="sched-chip sched-chip-warn">{t("sched.truncated")}</span>
                    ) : null}
                  </div>
                  <div className="sched-row-meta">
                    <span>
                      {t("sched.next")}:{" "}
                      {schedule.enabled ? stamp(schedule.nextRunAt) : t("sched.paused")}
                    </span>
                    <span>
                      {t("sched.last")}: {running ? t("sched.runningNow") : stamp(last?.startedAt)}
                    </span>
                    <button
                      type="button"
                      className="sched-path"
                      title={schedule.directory}
                      onClick={() => void reveal(schedule.directory)}
                    >
                      <Icon name="folder_open" size={12} />
                      {shortenPath(schedule.directory)}
                    </button>
                  </div>
                </div>

                <div className="sched-row-actions">
                  <IconBtn
                    icon={running ? "hourglass_top" : "play_arrow"}
                    title={running ? t("sched.running") : t("sched.runNow")}
                    // Every ▶ goes quiet while ANY run is in flight, not just
                    // this row's: the backend serializes runs behind one gate,
                    // so a second click would queue invisibly rather than do
                    // anything the user can see.
                    disabled={runningId !== null}
                    onClick={() => void doRunNow(schedule)}
                  />
                  <IconBtn
                    icon={schedule.enabled ? "pause" : "play_circle"}
                    title={schedule.enabled ? t("sched.pause") : t("sched.resume")}
                    onClick={() => void doToggle(schedule)}
                  />
                  <IconBtn
                    icon="history"
                    title={t("sched.history")}
                    onClick={() => setOpenHistory(expanded ? null : schedule.id)}
                  />
                  <IconBtn
                    icon="edit"
                    title={t("sched.edit")}
                    onClick={() => {
                      setFormError(null);
                      setDraft(schedule);
                    }}
                  />
                  <IconBtn
                    icon="delete"
                    title={t("common.delete")}
                    onClick={() => void doDelete(schedule)}
                  />
                </div>

                {expanded ? (
                  <History
                    records={historyNewestFirst(runs, schedule.id)}
                    onReveal={(path) => void reveal(path)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/** A schedule's past runs, newest first. */
function History({
  records,
  onReveal,
}: {
  records: RunRecord[];
  onReveal: (path: string) => void;
}) {
  const t = useT();
  if (records.length === 0) return <div className="sched-history-empty">{t("sched.noRuns")}</div>;
  return (
    <div className="sched-history">
      {records.map((record) => (
        <div
          key={`${record.startedAt}-${record.trigger}`}
          className={"sched-run" + (record.error ? " sched-run-bad" : "")}
        >
          <span className="sched-run-when">{stamp(record.startedAt)}</span>
          <span className="sched-run-trigger">{record.trigger}</span>
          <span className="sched-run-detail">
            {record.error ?? t("sched.wroteRows", { rows: record.rowCount })}
          </span>
          {record.path ? (
            <button
              type="button"
              className="sched-run-path"
              title={record.path}
              onClick={() => void onReveal(record.path!)}
            >
              {baseName(record.path)}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ScheduleForm({
  draft,
  onChange,
  error,
  connectionOptions,
  onCancel,
  onSave,
}: {
  draft: Schedule;
  onChange: (next: Schedule) => void;
  error: string | null;
  connectionOptions: SelectOption[];
  onCancel: () => void;
  onSave: () => void;
}) {
  const t = useT();
  const savedConnections = useConnectionsStore((s) => s.savedConnections);
  const env = savedConnections.find((c) => c.id === draft.connectionId)?.env ?? "";

  const kindOptions: SelectOption<RecurrenceKind>[] = RECURRENCE_KINDS.map((kind) => ({
    value: kind,
    label: t(
      kind === "every"
        ? "sched.kind.every"
        : kind === "daily"
          ? "sched.kind.daily"
          : kind === "weekly"
            ? "sched.kind.weekly"
            : "sched.kind.monthly",
    ),
  }));
  const weekdayOptions: SelectOption[] = [0, 1, 2, 3, 4, 5, 6].map((n) => ({
    value: String(n),
    label: weekdayLabel(n, t),
  }));
  const formatOptions: SelectOption<OutputFormat>[] = [
    { value: "csv", label: "CSV" },
    { value: "json", label: "JSON" },
  ];

  const pickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") onChange({ ...draft, directory: picked });
    } catch {
      // Plain browser dev — no native dialog. The field stays typable.
    }
  };

  const recurrence = draft.recurrence;
  const setRecurrence = (next: Schedule["recurrence"]) => onChange({ ...draft, recurrence: next });

  return (
    <>
      <div className="sched-form">
        <div className="sched-field">
          <label className="sched-label" htmlFor="sched-name">
            {t("sched.name")}
          </label>
          <input
            id="sched-name"
            className="sched-input"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder={t("sched.namePlaceholder")}
          />
        </div>

        <div className="sched-grid">
          <div className="sched-field">
            <span className="sched-label">{t("sched.connection")}</span>
            <Select
              className="sched-select"
              mono={false}
              value={draft.connectionId}
              options={connectionOptions}
              onChange={(value) => onChange({ ...draft, connectionId: value })}
              aria-label={t("sched.connection")}
            />
          </div>
          <div className="sched-field">
            <label className="sched-label" htmlFor="sched-schema">
              {t("sched.schema")}
            </label>
            <input
              id="sched-schema"
              className="sched-input"
              value={draft.schema ?? ""}
              onChange={(e) => onChange({ ...draft, schema: e.target.value || null })}
            />
          </div>
        </div>

        <div className="sched-field">
          <label className="sched-label" htmlFor="sched-sql">
            {t("sched.sql")}
          </label>
          <textarea
            id="sched-sql"
            className="sched-input sched-sql"
            value={draft.sql}
            onChange={(e) => onChange({ ...draft, sql: e.target.value })}
            spellCheck={false}
          />
          <div className="sched-hint">
            {t("sched.sqlHint")} <code>{SQL_TOKENS.join("  ")}</code>
          </div>
        </div>

        <div className="sched-grid">
          <div className="sched-field">
            <span className="sched-label">{t("sched.runs")}</span>
            <Select
              className="sched-select"
              mono={false}
              value={recurrence.kind}
              options={kindOptions}
              onChange={(kind) => setRecurrence(withKind(recurrence, kind))}
              aria-label={t("sched.runs")}
            />
          </div>
          <div className="sched-field">
            <span className="sched-label">{t("sched.when")}</span>
            <div className="sched-when">
              {recurrence.kind === "every" ? (
                <>
                  <input
                    className="sched-input sched-num"
                    type="number"
                    min={MIN_EVERY_MINUTES}
                    value={recurrence.minutes}
                    onChange={(e) =>
                      setRecurrence(withField(recurrence, "minutes", Number(e.target.value)))
                    }
                    aria-label={t("sched.minutes")}
                  />
                  <span className="sched-unit">{t("sched.minutes")}</span>
                </>
              ) : null}

              {recurrence.kind === "weekly" ? (
                <Select
                  className="sched-select"
                  mono={false}
                  value={String(recurrence.weekday)}
                  options={weekdayOptions}
                  onChange={(value) =>
                    setRecurrence(withField(recurrence, "weekday", Number(value)))
                  }
                  aria-label={t("sched.weekday")}
                />
              ) : null}

              {recurrence.kind === "monthly" ? (
                <input
                  className="sched-input sched-num"
                  type="number"
                  min={1}
                  max={31}
                  value={recurrence.day}
                  onChange={(e) =>
                    setRecurrence(withField(recurrence, "day", Number(e.target.value)))
                  }
                  aria-label={t("sched.dayOfMonth")}
                />
              ) : null}

              {recurrence.kind !== "every" ? (
                <>
                  <input
                    className="sched-input sched-num"
                    type="number"
                    min={0}
                    max={23}
                    value={recurrence.hour}
                    onChange={(e) =>
                      setRecurrence(withField(recurrence, "hour", Number(e.target.value)))
                    }
                    aria-label={t("sched.hour")}
                  />
                  <span className="sched-unit">:</span>
                  <input
                    className="sched-input sched-num"
                    type="number"
                    min={0}
                    max={59}
                    value={recurrence.minute}
                    onChange={(e) =>
                      setRecurrence(withField(recurrence, "minute", Number(e.target.value)))
                    }
                    aria-label={t("sched.minute")}
                  />
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="sched-field">
          <label className="sched-label" htmlFor="sched-dir">
            {t("sched.folder")}
          </label>
          <div className="sched-when">
            <input
              id="sched-dir"
              className="sched-input"
              value={draft.directory}
              onChange={(e) => onChange({ ...draft, directory: e.target.value })}
              placeholder={t("sched.folderPlaceholder")}
            />
            <Btn small icon="folder_open" onClick={() => void pickFolder()}>
              {t("sched.browse")}
            </Btn>
          </div>
        </div>

        <div className="sched-grid">
          <div className="sched-field">
            <label className="sched-label" htmlFor="sched-filename">
              {t("sched.filename")}
            </label>
            <input
              id="sched-filename"
              className="sched-input"
              value={draft.filename}
              onChange={(e) => onChange({ ...draft, filename: e.target.value })}
            />
          </div>
          <div className="sched-field">
            <span className="sched-label">{t("sched.format")}</span>
            <Select
              className="sched-select"
              mono={false}
              value={draft.format}
              options={formatOptions}
              onChange={(format) => onChange({ ...draft, format })}
              aria-label={t("sched.format")}
            />
          </div>
        </div>

        <div className="sched-hint">
          {t("sched.writes")}{" "}
          <code>
            {previewFilename(
              draft.filename,
              draft.format,
              // Preview `{{name}}` against the SAME text the empty name field
              // is showing. Resolving it to "" is accurate but useless: a
              // brand-new schedule previewed as `_20261026.csv`, which reads
              // like a bug in the token rather than an unfilled field. The
              // name is required to save, so this is a preview of the only
              // outcome that can actually happen.
              draft.name.trim() || t("sched.namePlaceholder"),
              env,
            )}
          </code>
          <br />
          {t("sched.filenameHint")} <code>{FILENAME_TOKENS.join("  ")}</code>
        </div>

        <div className="sched-grid">
          <div className="sched-field">
            <label className="sched-label" htmlFor="sched-keep">
              {t("sched.keep")}
            </label>
            <input
              id="sched-keep"
              className="sched-input sched-num-cell"
              type="number"
              min={1}
              value={draft.keep}
              onChange={(e) =>
                onChange({ ...draft, keep: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </div>
          <div className="sched-field">
            <label className="sched-label" htmlFor="sched-rows">
              {t("sched.rowLimit")}
            </label>
            <input
              id="sched-rows"
              className="sched-input sched-num-cell"
              type="number"
              min={1}
              value={draft.rowLimit}
              onChange={(e) =>
                onChange({ ...draft, rowLimit: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </div>
        </div>

        {error ? <div className="sched-error">{error}</div> : null}
      </div>

      {/* OUTSIDE the scrolling fields, and that is load-bearing twice over.
          Save stays reachable on a short window without scrolling to it — and,
          less obviously, the primary button's glow (`box-shadow` under the
          material themes) is not clipped. `overflow-y: auto` clips descendant
          painting to the padding box, which turned the soft round glow into a
          hard-edged rectangle sitting behind the pill. */}
      <div className="sched-form-actions">
        <Btn variant="text" onClick={onCancel}>
          {t("common.cancel")}
        </Btn>
        <Btn variant="filled" onClick={onSave}>
          {t("common.save")}
        </Btn>
      </div>
    </>
  );
}
