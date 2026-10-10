// About modal (ported from the prototype's updater.jsx `AboutModal`) — opened
// from the rail version label. Shows the app identity + version, repo / release
// / license rows, and a "Check for updates" button that re-runs the updater and
// hands a found update back to the app (which opens the UpdateModal).

import { useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import { BrandMark } from "../../../shared/ui/BrandMark";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions } from "../../../shared/ui/Modal";
import { useT } from "../../../shared/i18n/useT";
import { checkForUpdate, UPDATE_REPO, type Update } from "../api";
import "./AboutModal.css";

const REPO_URL = `https://github.com/${UPDATE_REPO}`;

/** Open a URL in the OS browser; window.open fallback in plain-browser dev. */
function openExternal(url: string): void {
  if ("__TAURI_INTERNALS__" in window) {
    void openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function AboutModal({
  version,
  onClose,
  onShowUpdate,
}: {
  version: string;
  onClose: () => void;
  /** Called with a found update so the app can open the UpdateModal. */
  onShowUpdate: (update: Update) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const t = useT();

  const check = () => {
    setChecking(true);
    setResult(null);
    void (async () => {
      try {
        const found = await checkForUpdate();
        if (found) {
          onClose();
          onShowUpdate(found);
        } else {
          setResult(t("about.latest", { version }));
        }
      } catch {
        setResult(t("about.err.check"));
      } finally {
        setChecking(false);
      }
    })();
  };

  return (
    <Modal className="about-modal" width={390} label={t("about.title")} onClose={onClose}>
      <div className="about-head">
        <div className="about-mark">
          <BrandMark size={30} blink />
        </div>
        <div className="about-name">
          Byte<span className="about-name-accent">Table</span>
        </div>
        <div className="about-ver">v{version}</div>
        <div className="about-tag">{t("about.tag")}</div>
        <IconBtn icon="close" onClick={onClose} title={t("common.close")} className="about-close" />
      </div>

      <div className="about-rows">
        <button
          type="button"
          className="about-row"
          onClick={() => openExternal(REPO_URL)}
          title={t("about.repositoryTitle")}
        >
          <Icon name="code" size={15} /> <span>{t("about.repository")}</span>
          <span className="about-row-val">{UPDATE_REPO}</span>
        </button>
        <button
          type="button"
          className="about-row"
          onClick={() => openExternal(`${REPO_URL}/releases`)}
          title={t("about.releasesTitle")}
        >
          <Icon name="history" size={15} /> <span>{t("about.releases")}</span>
          <Icon name="open_in_new" size={13} style={{ color: "var(--text-faint)" }} />
        </button>
        <div className="about-row">
          <Icon name="balance" size={15} /> <span>{t("about.license")}</span>
          <span className="about-row-val">Apache-2.0</span>
        </div>
      </div>

      {result ? (
        <div className="about-status">
          <Icon name="check_circle" size={14} />
          <span>{result}</span>
        </div>
      ) : null}

      <ModalActions>
        <span className="about-credit">
          {t("about.builtBy")} <span className="about-credit-name">Rezwanul-Haque</span>
        </span>
        <div style={{ flex: 1 }} />
        <Btn
          variant="tonal"
          icon={checking ? "sync" : "system_update_alt"}
          small
          onClick={check}
          disabled={checking}
        >
          {checking ? t("about.checking") : t("about.check")}
        </Btn>
        <Btn variant="text" small onClick={onClose}>
          {t("common.close")}
        </Btn>
      </ModalActions>
    </Modal>
  );
}
