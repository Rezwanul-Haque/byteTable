// BrandMark — the ByteTable logo on its rounded accent tile, as used in the
// connect screen header and the donate modal. The prototype declares the
// .brand-mark rule once globally; this component owns it so consumers don't
// duplicate the style.

import { BTLogo } from "./BTLogo";
import "./BrandMark.css";

interface BrandMarkProps {
  /** Logo size inside the 46px tile. */
  size?: number;
  /** Blink the logo's cursor block — brand contexts only. */
  blink?: boolean;
}

export function BrandMark({ size = 26, blink = false }: BrandMarkProps) {
  return (
    <div className="brand-mark">
      <BTLogo size={size} accent="var(--accent)" fg="var(--text)" blink={blink} />
    </div>
  );
}
