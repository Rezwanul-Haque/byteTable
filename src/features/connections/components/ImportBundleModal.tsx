// Import connections from an encrypted bundle (M40).
//
// Two steps, deliberately: unlock, then review. The preview step is not
// ceremony — it is where the user learns that three of the twelve entries
// collide with connections they already have, and decides per row whether to
// skip, replace, or take a copy. A one-shot import would have to guess, and
// the only safe guess (skip everything that exists) makes the feature useless
// for keeping two machines in step.
//
// The renderer never sees a decrypted secret: the backend decrypts, derives
// the preview, and re-reads the file to apply it. All this component holds is
// the passphrase, for exactly as long as the modal is open.

import { useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import type { BadgeEngine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { EngineMark } from "../../../shared/ui/EngineMark";
import { ENGINE_META, engineLabel } from "../../../shared/ui/engineMeta";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import {
  connectionBundleImport,
  connectionBundleInspect,
  type BundlePreview,
  type ImportAction,
} from "../api";
import { pickBundleOpenFile } from "../dialog";
import "./BundleModal.css";

/** The actions offered per row, in the order the selector lists them. */
const CONFLICT_ACTIONS: ImportAction[] = ["skip", "replace", "copy"];
const CLEAN_ACTIONS: ImportAction[] = ["import", "skip"];

/** Written out rather than built as `"bundle.action." + action`, so the string
 *  keys stay statically checkable against the locale table. */
const ACTION_LABEL = {
  skip: "bundle.action.skip",
  import: "bundle.action.import",
  replace: "bundle.action.replace",
  copy: "bundle.action.copy",
} as const;

interface ImportBundleModalProps {
  onClose: () => void;
  /** Reload the connect screen's list once something was actually written. */
  onImported: () => void;
}

export function ImportBundleModal({ onClose, onImported }: ImportBundleModalProps) {
  const t = useT();
  const toast = useToast();

  const [path, setPath] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [actions, setActions] = useState<Record<string, ImportAction>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setError(null);
    try {
      const picked = await pickBundleOpenFile();
      if (picked) {
        setPath(picked);
        // A new file invalidates whatever was previewed from the last one.
        setPreview(null);
        setActions({});
      }
    } catch {
      setError(t("bundle.needsApp"));
    }
  };

  const unlock = async () => {
    if (!path || !passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await connectionBundleInspect(path, passphrase);
      setPreview(result);
      // Seed each row with the backend's own default, so the selector shows
      // the action that will actually run if the user changes nothing.
      setActions(
        Object.fromEntries(
          result.entries.map((e) => [e.id, e.conflict ? "skip" : "import"] as const),
        ),
      );
    } catch (err) {
      setError(isAppErrorPayload(err) ? err.message : t("bundle.needsApp"));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!path || !preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await connectionBundleImport(path, passphrase, actions);
      const written = outcome.imported + outcome.replaced + outcome.copied;
      if (written > 0) onImported();
      toast(
        t("bundle.import.done", {
          imported: outcome.imported,
          replaced: outcome.replaced,
          copied: outcome.copied,
          skipped: outcome.skipped,
        }),
        outcome.failed?.length ? "info" : "ok",
      );
      // Failures are listed individually: a tally that says "2 failed" without
      // naming them leaves the user with no way to find out which.
      for (const failure of outcome.failed ?? []) {
        toast(t("bundle.import.failed", { name: failure.name, reason: failure.reason }), "err");
      }
      onClose();
    } catch (err) {
      setError(isAppErrorPayload(err) ? err.message : t("bundle.needsApp"));
    } finally {
      setBusy(false);
    }
  };

  const conflicts = preview?.entries.filter((e) => e.conflict).length ?? 0;
  const warned = preview?.entries.filter((e) => e.warnings?.length).length ?? 0;

  return (
    <Modal label={t("bundle.import.title")} onClose={onClose} className="bundle-modal" width={600}>
      <ModalTitle>
        <span>{t("bundle.import.title")}</span>
        <IconBtn icon="close" onClick={onClose} title={t("grid.closeEsc")} />
      </ModalTitle>

      <div className="bundle-body">
        {!preview ? (
          <>
            <p className="bundle-lede">{t("bundle.import.lede")}</p>

            <div className="bundle-section">
              <div className="bundle-section-head">
                <span>{t("bundle.import.file")}</span>
              </div>
              <div className="bundle-file">
                <Btn icon="folder_open" variant="tonal" onClick={() => void pick()}>
                  {t("bundle.import.choose")}
                </Btn>
                <span className="bundle-file-path" title={path ?? ""}>
                  {path ?? t("bundle.import.noFile")}
                </span>
              </div>
            </div>

            <div className="bundle-section">
              <div className="bundle-section-head">
                <span>{t("bundle.passphrase")}</span>
              </div>
              <input
                type="password"
                className="bundle-input"
                autoComplete="off"
                placeholder={t("bundle.passphrase.ph")}
                value={passphrase}
                disabled={!path}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void unlock();
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="bundle-summary">
              <Icon name="inventory_2" size={14} />
              <span>
                {t("bundle.import.summary", {
                  count: preview.entries.length,
                  conflicts,
                  warned,
                })}
              </span>
              <span className="bundle-summary-meta">
                {t("bundle.import.exportedOn", {
                  date: new Date(preview.exportedAt).toLocaleDateString(),
                  version: preview.appVersion,
                })}
              </span>
            </div>

            <div className="bundle-list bundle-preview">
              {preview.entries.map((entry) => (
                <div className="bundle-prow" key={entry.id}>
                  <div className="bundle-prow-main">
                    <span className="bundle-row-name">{entry.name}</span>
                    {/* Gate on ENGINE_META membership, not on `supported`:
                        both say the same thing today, but only this one
                        guarantees the lookups below cannot return undefined
                        and crash the whole preview on a bundle from a newer
                        build. Unknown engines keep the raw-string chip. */}
                    {entry.engine in ENGINE_META ? (
                      <span className="bundle-engine">
                        <EngineMark engine={entry.engine as BadgeEngine} size={15} />
                        {engineLabel(entry.engine as BadgeEngine)}
                      </span>
                    ) : (
                      <span className="bundle-chip">{entry.engine}</span>
                    )}
                    {entry.hasSecrets ? (
                      <span className="bundle-chip key" title={t("bundle.import.hasSecrets")}>
                        <Icon name="key" size={11} />
                      </span>
                    ) : null}
                    {entry.project ? <span className="bundle-chip">{entry.project}</span> : null}
                    <span className="bundle-row-detail">{entry.detail}</span>
                    {/* The app's own dropdown, not a native <select>: the
                        native one renders through the OS widget (washed out on
                        the dark themes, no chevron of ours) AND opens inside
                        `.bundle-list`, which is a scroll container — `Select`
                        portals its popover to <body>, so it escapes that. */}
                    <Select<ImportAction>
                      className="bundle-action"
                      mono={false}
                      aria-label={t("bundle.import.actionAria", { name: entry.name })}
                      value={actions[entry.id] ?? (entry.conflict ? "skip" : "import")}
                      options={(entry.conflict ? CONFLICT_ACTIONS : CLEAN_ACTIONS).map(
                        (action) => ({ value: action, label: t(ACTION_LABEL[action]) }),
                      )}
                      onChange={(action) => setActions((prev) => ({ ...prev, [entry.id]: action }))}
                    />
                  </div>
                  {entry.conflict ? (
                    <div className="bundle-note conflict">
                      <Icon name="info" size={12} />
                      <span>{t("bundle.import.conflict", { name: entry.conflict })}</span>
                    </div>
                  ) : null}
                  {/* Shown only under Replace, where it applies — under Skip or
                      Copy nothing local is reused and the warning would be
                      noise that teaches people to scroll past it. Deliberately
                      a warning and not a block: "the database moved, here is
                      the new host" is a legitimate, ordinary reason to replace,
                      and the user is the one who knows which this is. */}
                  {entry.replaceWarning &&
                  (actions[entry.id] ?? (entry.conflict ? "skip" : "import")) === "replace" ? (
                    <div className="bundle-note danger">
                      <Icon name="warning" size={12} />
                      <span>{entry.replaceWarning}</span>
                    </div>
                  ) : null}
                  {!entry.supported ? (
                    <div className="bundle-note">
                      <Icon name="help" size={12} />
                      <span>{t("bundle.import.unsupported", { engine: entry.engine })}</span>
                    </div>
                  ) : null}
                  {(entry.warnings ?? []).map((warning) => (
                    <div className="bundle-note warn" key={warning}>
                      <Icon name="warning" size={12} />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        {error ? (
          <div className="bundle-error">
            <Icon name="error" size={13} /> <span>{error}</span>
          </div>
        ) : null}
      </div>

      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Btn>
        {!preview ? (
          <Btn
            variant="filled"
            disabled={!path || !passphrase || busy}
            onClick={() => void unlock()}
          >
            {busy ? t("bundle.import.unlocking") : t("bundle.import.unlock")}
          </Btn>
        ) : (
          <Btn variant="filled" disabled={busy} onClick={() => void apply()}>
            {busy ? t("bundle.import.working") : t("bundle.import.action")}
          </Btn>
        )}
      </ModalActions>
    </Modal>
  );
}
