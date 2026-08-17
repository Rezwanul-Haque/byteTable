// Hover/focus hint chip — ported from the prototype's connect.jsx `InfoHint`
// (M30 Task 5b). A small info glyph that reveals a bubble on hover AND on
// keyboard focus (`tabIndex={0}`), so the help is not mouse-only.
//
// Deliberately generic (`{ text, icon }`): it replaces the long `.form-note`
// blocks the Typesense connect form used to carry, and is the pattern to reuse
// for any future long-form field help rather than growing a form vertically.
//
// # Why the bubble is a portal and not just `position: absolute`
//
// The prototype anchors the bubble absolutely inside the chip. That is fine in a
// mock and wrong in the app, for two reasons:
//
//  1. **It creates overflow.** An absolutely-positioned box still contributes to
//     its ancestors' scrollable overflow even while `visibility: hidden` — so a
//     250px bubble centred on an icon near the right edge of the 480px connect
//     modal pushed the modal 9.5px wider and gave it a permanent horizontal
//     scrollbar, with nothing visible to explain it.
//  2. **It gets clipped.** Anchored inside a scrolling panel (the cluster
//     dashboard), the bubble is cut off by that panel's edge.
//
// So it renders into `document.body` as `position: fixed`, measured from the
// icon and clamped to the window — the same portal-and-clamp approach
// `LanguageChip` and `Select` already use for their popovers. Fixed-position
// boxes contribute no scrollable overflow to any ancestor, so neither problem
// can recur wherever the hint is used.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon";

import "./InfoHint.css";

/** Bubble width (mirrors `.info-hint-bubble`) + the gap kept from the edge. */
const BUBBLE_WIDTH = 250;
const EDGE_GAP = 8;
/** Distance between the icon and the bubble. */
const OFFSET = 7;

interface At {
  left: number;
  /** Set when the bubble sits above the icon; else `top` is set. */
  bottom?: number;
  top?: number;
}

export function InfoHint({ text, icon = "info" }: { text: string; icon?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [at, setAt] = useState<At | null>(null);

  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    // Centred on the icon, then pulled back inside the window — the bubble is
    // wider than most of the fields it annotates, so an edge-adjacent hint
    // would otherwise run off-screen.
    const left = Math.max(
      EDGE_GAP,
      Math.min(
        rect.left + rect.width / 2 - BUBBLE_WIDTH / 2,
        window.innerWidth - BUBBLE_WIDTH - EDGE_GAP,
      ),
    );
    // Above by default (the prototype's placement); flipped below when there is
    // not enough room above, so a hint near the top of the window stays legible.
    const spaceAbove = rect.top;
    setAt(
      spaceAbove > 140
        ? { left, bottom: window.innerHeight - rect.top + OFFSET }
        : { left, top: rect.bottom + OFFSET },
    );
  };

  /**
   * Focus opens the bubble only for KEYBOARD focus. A programmatic `.focus()`
   * — most visibly `Modal`'s "focus the first tabbable element" on open, which
   * lands here whenever the chip is the first one in the dialog — would
   * otherwise pop the help bubble the instant the dialog appeared, with no
   * pointer anywhere near it. `:focus-visible` is exactly the "the user is
   * navigating by keyboard" signal we want, and it keeps the hint reachable by
   * Tab, which is why the chip is focusable in the first place.
   */
  const showOnFocus = () => {
    if (ref.current?.matches(":focus-visible")) show();
  };

  const hide = () => setAt(null);

  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    // The bubble is anchored to a measured rect, so it would drift away from
    // the icon if the page scrolled or the window resized underneath it.
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [at]);

  return (
    <>
      <span
        ref={ref}
        className={"info-hint" + (at ? " open" : "")}
        tabIndex={0}
        role="note"
        aria-label={text}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={showOnFocus}
        onBlur={hide}
      >
        <Icon name={icon} size={13} />
      </span>
      {at
        ? createPortal(
            <span
              className="info-hint-bubble"
              style={{ left: at.left, top: at.top, bottom: at.bottom }}
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
