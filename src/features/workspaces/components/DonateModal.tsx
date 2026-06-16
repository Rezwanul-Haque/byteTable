// Donate modal — ported from the prototype's rail.jsx DonateModal (spec
// §3.1): brand mark + "Support ByteTable" copy, three amount cards, sponsor
// links, footer. Built on the shared Modal primitive (scrim/Esc/focus
// handling) with the prototype's "modal donate-modal" panel class — the
// prototype markup maps onto it 1:1, so no standalone scrim was needed.
//
// The prototype only toasted ("simulated in this prototype"); the product
// opens the real donation page in the default browser AND toasts the
// prototype's thanks message.

import { useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import { BrandMark } from "../../../shared/ui/BrandMark";
import { Btn } from "../../../shared/ui/Btn";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import "./DonateModal.css";

// Donation targets.
const GITHUB_SPONSORS_URL = "https://github.com/sponsors/rezwanul-Haque";
// supportkori is a BDT "buy me a coffee" platform — it has no USD per-amount
// deep link, so the coffee button just opens the page and the supporter picks
// the amount there. The USD chips below drive only the GitHub Sponsors link.
const BUY_ME_A_COFFEE_URL = "https://www.supportkori.com/rezwanul";

// Selectable amounts. The user picks one, THEN clicks a provider button, which
// opens that provider's page carrying the chosen amount (+ frequency).
// USD tiers for the GitHub Sponsors deep link (supportkori ignores them — it
// opens its own BDT page). Labels are provider-neutral, NOT coffee-themed, so
// they don't read as Buy Me a Coffee amounts.
const AMOUNTS = [
  { id: "coffee", amount: 3, label: "supporter", recurring: false, popular: false },
  { id: "big", amount: 5, label: "backer", recurring: false, popular: false },
  { id: "sustainer", amount: 10, label: "sustainer", recurring: true, popular: true },
] as const;
type AmountId = (typeof AMOUNTS)[number]["id"];

/** GitHub Sponsors deep link: ?frequency=one-time|recurring&amount=<dollars>. */
function sponsorsUrl(amount: number, recurring: boolean): string {
  const frequency = recurring ? "recurring" : "one-time";
  return `${GITHUB_SPONSORS_URL}?frequency=${frequency}&amount=${amount}`;
}

/** supportkori (BDT) has no USD per-amount deep link — open the base page and
 *  let the supporter choose the amount/currency there. The selected USD chip
 *  applies to GitHub Sponsors only. */
function buyMeACoffeeUrl(): string {
  return BUY_ME_A_COFFEE_URL;
}

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
  // The chosen amount (default $5 one-off "big coffee"); a provider button
  // then opens that provider carrying this amount. Picking a card does NOT
  // open a link.
  const [selectedId, setSelectedId] = useState<AmountId>("big");
  const selected = AMOUNTS.find((a) => a.id === selectedId) ?? AMOUNTS[1];

  // Open the chosen provider with the selected amount, then thank + close. The
  // open is awaited so a failed hand-off surfaces an error toast instead of a
  // false "Thank you!", and the modal stays open for a retry.
  const donate = async (provider: "sponsors" | "bmc") => {
    const url =
      provider === "sponsors"
        ? sponsorsUrl(selected.amount, selected.recurring)
        : buyMeACoffeeUrl();
    try {
      await openExternal(url);
    } catch {
      toast("Couldn't open browser — visit " + url, "err");
      return;
    }
    toast(`Thank you! ($${selected.amount}${selected.recurring ? "/mo" : ""})`, "ok");
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
      <div className="donate-amounts" role="radiogroup" aria-label="Donation amount">
        {AMOUNTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={selectedId === a.id}
            className={
              "donate-amount" +
              (a.popular ? " popular" : "") +
              (selectedId === a.id ? " selected" : "")
            }
            onClick={() => setSelectedId(a.id)}
          >
            <span className="donate-amount-n">
              ${a.amount}
              {a.recurring ? <small>/mo</small> : null}
            </span>
            <span>{a.label}</span>
            {a.popular ? <span className="donate-pop-tag">popular</span> : null}
          </button>
        ))}
      </div>
      <p className="donate-amount-note">
        Amount applies to GitHub Sponsors. Buy Me a Coffee opens its page to choose there.
      </p>
      <div className="donate-links">
        <Btn icon="favorite" variant="filled" onClick={() => void donate("sponsors")}>
          GitHub Sponsors
        </Btn>
        <Btn icon="local_cafe" variant="tonal" onClick={() => void donate("bmc")}>
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
