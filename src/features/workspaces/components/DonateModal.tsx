// Donate modal — ported from the prototype's rail.jsx DonateModal (spec
// §3.1): brand mark + "Support ByteTable" copy, three amount cards, sponsor
// links, footer. Built on the shared Modal primitive (scrim/Esc/focus
// handling) with the prototype's "modal donate-modal" panel class — the
// prototype markup maps onto it 1:1, so no standalone scrim was needed.
//
// The prototype only toasted ("simulated in this prototype"); the product
// opens the real donation page in the default browser AND toasts the
// prototype's thanks message.

import { openUrl } from "@tauri-apps/plugin-opener";

import { BrandMark } from "../../../shared/ui/BrandMark";
import { Btn } from "../../../shared/ui/Btn";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import "./DonateModal.css";

// Donation targets — placeholder slugs until the real accounts exist. The
// one-off amounts go to Buy Me a Coffee; the monthly sustainer tier goes to
// GitHub Sponsors.
const GITHUB_SPONSORS_URL = "https://github.com/sponsors/bytetable";
const BUY_ME_A_COFFEE_URL = "https://buymeacoffee.com/bytetable";

/**
 * Open a URL in the OS default browser. Inside Tauri (detected via the
 * `__TAURI_INTERNALS__` global the runtime injects) the opener plugin is
 * used, and a rejection — e.g. a capability/scope denial — propagates to the
 * caller. In plain-browser dev (`pnpm dev:vite`) there is no Tauri IPC, so
 * fall back to window.open to keep the flow testable in a browser.
 */
async function openExternal(url: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

interface DonateModalProps {
  onClose: () => void;
}

export function DonateModal({ onClose }: DonateModalProps) {
  const toast = useToast();

  // Prototype thank(): toast + close — plus the real browser hand-off. The
  // open is awaited so a failed hand-off surfaces an error toast instead of
  // a false "Thank you!", and the modal stays open for a retry.
  const thank = async (what: string, url: string) => {
    try {
      await openExternal(url);
    } catch {
      toast("Couldn't open browser — visit " + url, "err");
      return;
    }
    toast("Thank you! " + what, "ok");
    onClose();
  };

  return (
    <Modal className="donate-modal" label="Support ByteTable" onClose={onClose}>
      <div className="donate-head">
        <BrandMark size={26} />
        <div>
          <div className="modal-title-text">Support ByteTable</div>
          <p className="donate-sub">
            ByteTable is free and open source, with no pro tier and no subscription. Donations keep
            it that way.
          </p>
        </div>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </div>
      <div className="donate-amounts">
        <button
          type="button"
          className="donate-amount"
          onClick={() => void thank("One coffee ☕", BUY_ME_A_COFFEE_URL)}
        >
          <span className="donate-amount-n">$3</span>
          <span>coffee</span>
        </button>
        <button
          type="button"
          className="donate-amount"
          onClick={() => void thank("A generous coffee", BUY_ME_A_COFFEE_URL)}
        >
          <span className="donate-amount-n">$5</span>
          <span>big coffee</span>
        </button>
        <button
          type="button"
          className="donate-amount popular"
          onClick={() => void thank("Monthly support 💛", GITHUB_SPONSORS_URL)}
        >
          <span className="donate-amount-n">
            $10<small>/mo</small>
          </span>
          <span>sustainer</span>
          <span className="donate-pop-tag">popular</span>
        </button>
      </div>
      <div className="donate-links">
        <Btn
          icon="favorite"
          variant="filled"
          onClick={() => void thank("GitHub Sponsors", GITHUB_SPONSORS_URL)}
        >
          GitHub Sponsors
        </Btn>
        <Btn
          icon="local_cafe"
          variant="tonal"
          onClick={() => void thank("Buy Me a Coffee", BUY_ME_A_COFFEE_URL)}
        >
          Buy Me a Coffee
        </Btn>
        <Btn variant="text" onClick={onClose}>
          Maybe later
        </Btn>
      </div>
      <div className="donate-foot">
        100% of donations fund development. No feature is ever paywalled.
      </div>
    </Modal>
  );
}
