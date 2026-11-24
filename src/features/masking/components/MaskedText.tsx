// A masked value (M49): the dots for the eye, "hidden" for a screen reader —
// never the real value, in any attribute.

import { useT } from "../../../shared/i18n/useT";
import "./Masking.css";

export function MaskedText({
  text,
  className,
  title,
}: {
  text: string;
  className?: string;
  /** Tooltip; defaults to "Hidden by masking". */
  title?: string;
}) {
  const t = useT();
  return (
    <span
      className={"cell-mask" + (className ? " " + className : "")}
      title={title ?? t("mask.cellHint")}
    >
      <span aria-hidden="true">{text}</span>
      <span className="mask-sr">{t("mask.hidden")}</span>
    </span>
  );
}
