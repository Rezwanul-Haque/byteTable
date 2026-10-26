// Export connections as an encrypted bundle (M40).
//
// Pick connections → set a passphrase → native save dialog → one file. The
// file holds the registry entries AND their OS-keychain secrets, sealed with
// Argon2id + AES-256-GCM, so the whole set can be carried to another machine
// without cloud sync.
//
// Two bits of copy here are load-bearing rather than decorative: the secrets
// toggle says plainly that passwords are about to leave the keychain, and the
// passphrase warning says plainly that nothing can recover it. Both describe
// consequences the user cannot undo once the file is out of their hands.

import { useMemo, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { EngineMark } from "../../../shared/ui/EngineMark";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { InfoHint } from "../../../shared/ui/InfoHint";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { connectionBundleExport, connectionDetail, type SavedConnection } from "../api";
import { pickBundleSaveFile } from "../dialog";
import {
  MIN_PASSPHRASE,
  passphraseStrength,
  strengthScore,
  type PassphraseStrength,
} from "../passphraseStrength";
import "./BundleModal.css";

/** Strength band → the locale key naming it. Spelled out rather than built as
 *  `"bundle.strength." + band`, so the keys stay statically checkable. */
const STRENGTH_LABEL = {
  weak: "bundle.strength.weak",
  fair: "bundle.strength.fair",
  good: "bundle.strength.good",
  strong: "bundle.strength.strong",
} as const satisfies Record<PassphraseStrength, string>;

/** The group label for connections with no project, matching the connect screen. */
const UNGROUPED = "__ungrouped__";

interface ExportBundleModalProps {
  connections: SavedConnection[];
  /** Pre-ticked ids — the card context menu's "Export…" passes exactly one. */
  initialSelection?: string[];
  onClose: () => void;
}

export function ExportBundleModal({
  connections,
  initialSelection,
  onClose,
}: ExportBundleModalProps) {
  const t = useT();
  const toast = useToast();
  const passRef = useRef<HTMLInputElement>(null);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelection ?? connections.map((c) => c.id)),
  );
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Grouped exactly as the connect screen groups: "Ungrouped" sinks to the end,
  // the rest alphabetical — so the list the user ticks matches the one they
  // just came from.
  const groups = useMemo(() => {
    const byProject = new Map<string, SavedConnection[]>();
    for (const c of connections) {
      const key = c.project || UNGROUPED;
      const list = byProject.get(key);
      if (list) list.push(c);
      else byProject.set(key, [c]);
    }
    return [...byProject.entries()].sort(([a], [b]) => {
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
  }, [connections]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const toggleGroup = (members: SavedConnection[]) => {
    const allOn = members.every((c) => selected.has(c.id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of members) {
        if (allOn) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });
  };

  // Code points, not UTF-16 units — matching the backend's `chars().count()`,
  // so a phrase the modal accepts is never rejected by the use-case.
  const passLen = [...passphrase].length;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const tooShort = passLen > 0 && passLen < MIN_PASSPHRASE;
  const strength = passphraseStrength(passphrase);
  const ready = selected.size > 0 && passLen >= MIN_PASSPHRASE && confirm === passphrase && !busy;

  const run = async () => {
    if (!ready) return;
    setError(null);
    let path: string | null;
    try {
      path = await pickBundleSaveFile();
    } catch {
      // The dialog plugin is absent in plain browser dev.
      setError(t("bundle.needsApp"));
      return;
    }
    if (!path) return; // cancelled

    setBusy(true);
    try {
      const outcome = await connectionBundleExport(path, [...selected], passphrase, includeSecrets);
      toast(t("bundle.export.done", { count: outcome.count }), "ok");
      // Naming them matters: these are the connections that will ask for a
      // password again on the other machine, and a silent omission would only
      // be discovered there.
      if (outcome.unreadableSecrets?.length) {
        toast(
          t("bundle.export.denied", {
            count: outcome.unreadableSecrets.length,
            names: outcome.unreadableSecrets.join(", "),
          }),
          "info",
        );
      }
      onClose();
    } catch (err) {
      setError(isAppErrorPayload(err) ? err.message : t("bundle.needsApp"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      label={t("bundle.export.title")}
      onClose={onClose}
      className="bundle-modal"
      width={560}
      initialFocusRef={passRef}
    >
      <ModalTitle>
        <span>{t("bundle.export.title")}</span>
        <IconBtn icon="close" onClick={onClose} title={t("grid.closeEsc")} />
      </ModalTitle>

      <div className="bundle-body">
        <p className="bundle-lede">{t("bundle.export.lede")}</p>

        <div className="bundle-section">
          <div className="bundle-section-head">
            <span>{t("bundle.export.pick")}</span>
            <span className="bundle-count">
              {t("bundle.export.selected", { count: selected.size })}
            </span>
            <button
              type="button"
              className="bundle-link"
              onClick={() =>
                setSelected(
                  selected.size === connections.length
                    ? new Set()
                    : new Set(connections.map((c) => c.id)),
                )
              }
            >
              {selected.size === connections.length
                ? t("bundle.export.selectNone")
                : t("bundle.export.selectAll")}
            </button>
          </div>

          <div className="bundle-list">
            {groups.map(([project, members]) => (
              <div className="bundle-group" key={project}>
                <label className="bundle-group-head">
                  <Checkbox
                    checked={members.every((c) => selected.has(c.id))}
                    // A partially-ticked group reads as indeterminate rather
                    // than as "off", which would misreport the rows below.
                    indeterminate={
                      members.some((c) => selected.has(c.id)) &&
                      !members.every((c) => selected.has(c.id))
                    }
                    onChange={() => toggleGroup(members)}
                  />
                  <span>{project === UNGROUPED ? t("ws.connect.ungrouped") : project}</span>
                </label>
                {members.map((c) => (
                  <label className="bundle-row" key={c.id}>
                    <Checkbox checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    <EngineMark engine={c.engine} size={18} />
                    <span className="bundle-row-name">{c.name}</span>
                    <span className="bundle-row-detail">{connectionDetail(c.params)}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>

        <label className="bundle-toggle">
          <Checkbox
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
          />
          <span>
            <strong>{t("bundle.export.secrets")}</strong>
            <em>{t("bundle.export.secretsHint")}</em>
          </span>
        </label>

        {/* Forewarns the wall of OS prompts. Each keychain item has its own
            access ACL, so there is one dialog per connection and no way to
            batch them — the only fix available is to say so beforehand, so it
            reads as expected rather than as the app malfunctioning. */}
        {includeSecrets ? (
          <div className="bundle-note warn bundle-prompt-note">
            <Icon name="info" size={13} />
            <span>{t("bundle.export.promptWarn", { count: selected.size })}</span>
          </div>
        ) : null}

        <div className="bundle-section">
          <div className="bundle-section-head">
            <span>{t("bundle.passphrase")}</span>
            {/* The rules have to be discoverable BEFORE the user types — a
                12-character minimum first announced as a red error after they
                have composed something shorter is a wasted round trip. The
                meter below judges what they typed; this says what is wanted. */}
            <InfoHint text={t("bundle.passphrase.rules", { count: MIN_PASSPHRASE })} />
          </div>
          <input
            ref={passRef}
            type="password"
            className="bundle-input"
            autoComplete="new-password"
            placeholder={t("bundle.passphrase.ph")}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          {/* Four segments rather than a percentage: the score is a judgement
              about orders of magnitude, and a precise-looking number would
              overclaim. Colour alone never carries the verdict — the band is
              named in text beside it. */}
          {passphrase ? (
            <div
              className="bundle-meter"
              role="meter"
              aria-valuenow={strengthScore(strength)}
              aria-valuemin={1}
              aria-valuemax={4}
              aria-label={t("bundle.strength.aria")}
            >
              {[1, 2, 3, 4].map((segment) => (
                <span
                  key={segment}
                  className={
                    "bundle-meter-seg" +
                    (segment <= strengthScore(strength) ? " on " + strength : "")
                  }
                />
              ))}
              <em className={"bundle-meter-label " + strength}>{t(STRENGTH_LABEL[strength])}</em>
            </div>
          ) : null}
          <input
            type="password"
            className={"bundle-input" + (mismatch ? " bad" : "")}
            autoComplete="new-password"
            placeholder={t("bundle.passphrase.confirm")}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <div className="bundle-pass-foot" aria-live="polite">
            {tooShort ? (
              <span className="bundle-bad">
                {t("bundle.passphrase.short", { count: MIN_PASSPHRASE })}
              </span>
            ) : mismatch ? (
              <span className="bundle-bad">{t("bundle.passphrase.mismatch")}</span>
            ) : strength === "weak" || strength === "fair" ? (
              // While the passphrase is still weak, the actionable advice beats
              // the irreversibility notice; the notice returns once it is good.
              <span className="bundle-warn-inline">
                <Icon name="info" size={12} /> {t("bundle.passphrase.tip")}
              </span>
            ) : (
              <span className="bundle-warn-inline">
                <Icon name="lock" size={12} /> {t("bundle.passphrase.noRecovery")}
              </span>
            )}
          </div>
        </div>

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
        <Btn variant="filled" disabled={!ready} onClick={() => void run()}>
          {busy ? t("bundle.export.working") : t("bundle.export.action")}
        </Btn>
      </ModalActions>
    </Modal>
  );
}
