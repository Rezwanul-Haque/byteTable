// The "?" beside the OpenAI-compatible Base URL: a short list of popular
// services that speak OpenAI's API, each with its base URL — click a URL to
// put it in the field, or the copy icon to take it to the clipboard. Closes on
// a click outside or Esc, like the app's other popovers.

import { useEffect, useRef, useState } from "react";

import { useT } from "../../../shared/i18n/useT";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { OPENAI_COMPATIBLE } from "../logic";

export function AiUrlHelp({ onUse }: { onUse: (url: string) => void }) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const copy = (url: string) => {
    void navigator.clipboard.writeText(url).then(
      () => toast(t("ai.urlHelp.copied", { url }), "ok"),
      () => toast(t("ai.copyFail"), "err"),
    );
  };

  return (
    <span className="ai-url-help-anchor" ref={ref}>
      <IconBtn
        icon="help"
        size={14}
        active={open}
        title={t("ai.urlHelp.title")}
        aria-label={t("ai.urlHelp.title")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <div className="ai-url-help" role="dialog" aria-label={t("ai.urlHelp.title")}>
          <div className="ai-url-help-h">{t("ai.urlHelp.title")}</div>
          <p>{t("ai.urlHelp.body")}</p>
          <div className="ai-url-help-list">
            {OPENAI_COMPATIBLE.map((p) => (
              <div key={p.name} className="ai-url-help-row">
                <span className="ai-url-help-n">{p.name}</span>
                <button
                  type="button"
                  className="ai-url-help-u"
                  title={t("ai.urlHelp.use")}
                  onClick={() => {
                    onUse(p.url);
                    setOpen(false);
                  }}
                >
                  {p.url}
                </button>
                <IconBtn
                  icon="content_copy"
                  size={13}
                  title={t("ai.urlHelp.copy", { name: p.name })}
                  aria-label={t("ai.urlHelp.copy", { name: p.name })}
                  onClick={() => copy(p.url)}
                />
              </div>
            ))}
          </div>
          <div className="ai-url-help-f">{t("ai.urlHelp.foot")}</div>
        </div>
      ) : null}
    </span>
  );
}
