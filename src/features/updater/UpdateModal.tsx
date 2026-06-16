// Update-available modal (ported from the prototype's updater.jsx) — wired to
// the real Tauri updater. Shows current→new version, release notes, then
// downloads + installs the signed update with a progress bar and relaunches.

import { useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";

import { BrandMark } from "../../shared/ui/BrandMark";
import { Btn } from "../../shared/ui/Btn";
import { Icon } from "../../shared/ui/Icon";
import { IconBtn } from "../../shared/ui/IconBtn";
import { Modal, ModalActions } from "../../shared/ui/Modal";
import { useToast } from "../../shared/ui/toastContext";
import { releaseUrl, skipVersion, type Update } from "./api";
import "./UpdateModal.css";

/** Tiny markdown → elements (### headings + `-` bullet lists only), matching the
 *  prototype's renderNotes. */
function renderNotes(body: string) {
  type Block = { kind: "h" | "p"; text: string } | { kind: "ul"; items: string[] };
  const blocks: Block[] = [];
  let list: { kind: "ul"; items: string[] } | null = null;
  for (const line of body.split("\n")) {
    if (/^###\s/.test(line)) {
      if (list) {
        blocks.push(list);
        list = null;
      }
      blocks.push({ kind: "h", text: line.replace(/^###\s/, "") });
    } else if (/^[-*]\s/.test(line)) {
      if (!list) list = { kind: "ul", items: [] };
      list.items.push(line.replace(/^[-*]\s/, ""));
    } else if (line.trim()) {
      if (list) {
        blocks.push(list);
        list = null;
      }
      blocks.push({ kind: "p", text: line });
    }
  }
  if (list) blocks.push(list);
  return blocks.map((b, i) => {
    if (b.kind === "ul") {
      return (
        <ul className="rel-ul" key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{it}</li>
          ))}
        </ul>
      );
    }
    return (
      <div className={b.kind === "h" ? "rel-h" : "rel-p"} key={i}>
        {b.text}
      </div>
    );
  });
}

/** Format the release date (Tauri gives e.g. "2026-06-14 9:00:00.0 +00:00:00";
 *  fall back to the raw string if Date can't parse it). */
function formatDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw.replace(" ", "T").replace(/ /g, ""));
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type Stage = "idle" | "downloading" | "ready" | "error";

export function UpdateModal({ update, onClose }: { update: Update; onClose: () => void }) {
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("idle");
  const [pct, setPct] = useState(0);

  const version = update.version.replace(/^v/, "");
  const current = (update.currentVersion ?? "").replace(/^v/, "");
  const date = formatDate(update.date);
  const notes = update.body?.trim();

  const install = async () => {
    setStage("downloading");
    setPct(0);
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setPct(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0);
            break;
          case "Finished":
            setPct(100);
            setStage("ready");
            break;
        }
      });
      // Relaunch into the freshly-installed version.
      toast(`Restarting into v${version}…`, "ok");
      await relaunch();
    } catch (err) {
      setStage("error");
      toast(err instanceof Error ? err.message : "Update failed.", "err");
    }
  };

  return (
    <Modal className="update-modal" width={480} label="Update available" onClose={onClose}>
      <div className="update-head">
        <div className="update-mark">
          <BrandMark size={26} blink />
        </div>
        <div style={{ flex: 1 }}>
          <div className="update-title">Update available</div>
          <div className="update-versions">
            {current ? <span className="ver-old">v{current}</span> : null}
            <Icon name="arrow_forward" size={14} style={{ color: "var(--text-faint)" }} />
            <span className="ver-new">v{version}</span>
            {date ? <span className="update-date">· {date}</span> : null}
          </div>
        </div>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </div>

      {notes ? <div className="update-notes">{renderNotes(notes)}</div> : null}

      {stage === "downloading" || stage === "ready" ? (
        <div className="update-progress">
          <div className="update-progress-bar">
            <span style={{ width: pct + "%" }} />
          </div>
          <span className="update-progress-txt">
            {stage === "ready" ? "Downloaded — restarting…" : "Downloading… " + pct + "%"}
          </span>
        </div>
      ) : null}

      <ModalActions>
        <button
          type="button"
          className="update-link"
          onClick={() => void openUrl(releaseUrl(version))}
        >
          <Icon name="open_in_new" size={13} />
          <span className="update-link-label">Release notes</span>
        </button>
        <div style={{ flex: 1 }} />
        {stage === "idle" || stage === "error" ? (
          <>
            <Btn
              variant="text"
              onClick={() => {
                skipVersion(version);
                toast(`Skipped v${version}`);
                onClose();
              }}
            >
              Skip this version
            </Btn>
            <Btn variant="text" onClick={onClose}>
              Later
            </Btn>
            <Btn variant="filled" icon="download" onClick={() => void install()}>
              {stage === "error" ? "Retry" : "Download & install"}
            </Btn>
          </>
        ) : (
          <Btn variant="text" onClick={onClose}>
            Hide
          </Btn>
        )}
      </ModalActions>
    </Modal>
  );
}
