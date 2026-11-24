// Data masking (M49): what counts as sensitive, and how it is drawn. Ported
// exactly from the prototype's `BT_MASK.kindOf` / `render` / `sql`. Pure — the
// switch, the settings and the columns shown in the clear are passed in by
// `state.ts`, which is the only thing render sites call.
//
// A value is masked when its COLUMN NAME says it is sensitive, or when the
// VALUE itself looks like an email, a phone number or a secret (so
// `SELECT email AS e` is still caught). Display only: nothing here changes
// data, copies, exports or saved files.

export type MaskKind = "email" | "phone" | "secret" | "person" | "custom";

/** The categories in force (Settings → Masking). */
export interface MaskConfig {
  maskEmail: boolean;
  maskPhone: boolean;
  maskSecret: boolean;
  maskPerson: boolean;
  /** Extra column names, comma separated; `*` = any text. */
  maskCustom: string;
}

const DOT = "•";

const NAME = {
  email: /(^|[_.])e?mail($|[_.])/i,
  phone: /(phone|mobile|msisdn|whatsapp|(^|[_.])(tel|fax|cell)($|[_.]))/i,
  secret:
    /(token|secret|passw|pwd|api_?key|private_?key|credential|salt|(^|[_.])hash|otp|session_?id|ssn|iban|card_?(number|no|num)|cvv|cvc|txn_id)/i,
  person:
    /(full_?name|first_?name|last_?name|surname|customer_name|ship_name|bill_name|address|(^|_)line[12]$|postcode|post_?code|zip|vat_id|birth)/i,
};
const VALUE = {
  email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i,
  jwt: /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/,
  key: /^(sk|pk|rk|ghp|gho|xox[abp]|AKIA|key)[-_]?[A-Za-z0-9_-]{12,}$/,
  hex: /^[0-9a-f]{32,}$/i,
  b64: /^[A-Za-z0-9+/_-]{40,}={0,2}$/,
};

/** A column name without its table prefix: `u.email` → `email`. */
export const baseName = (col: string | null | undefined): string =>
  String(col ?? "")
    .split(".")
    .pop() ?? "";

function customHit(name: string, custom: string): boolean {
  const c = name.toLowerCase();
  return custom
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((p) =>
      p.includes("*")
        ? new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(
            c,
          )
        : p === c,
    );
}

const looksPhone = (s: string) =>
  /^[+(][\d\s().-]{7,}$/.test(s) && s.replace(/\D/g, "").length >= 8;

/** The category, or null. Ignores the on/off switch. First match wins. */
export function kindOf(
  value: unknown,
  col: string | null | undefined,
  cfg: MaskConfig,
): MaskKind | null {
  const name = baseName(col);
  if (name && customHit(name, cfg.maskCustom)) return "custom";
  if (cfg.maskEmail && name && NAME.email.test(name)) return "email";
  if (cfg.maskPhone && name && NAME.phone.test(name)) return "phone";
  if (cfg.maskSecret && name && NAME.secret.test(name)) return "secret";
  if (cfg.maskPerson && name && NAME.person.test(name)) return "person";
  if (typeof value !== "string" || value.length < 6) return null;
  if (cfg.maskEmail && VALUE.email.test(value)) return "email";
  if (
    cfg.maskSecret &&
    (VALUE.jwt.test(value) ||
      VALUE.key.test(value) ||
      VALUE.hex.test(value) ||
      VALUE.b64.test(value))
  )
    return "secret";
  if (cfg.maskPhone && looksPhone(value)) return "phone";
  return null;
}

/** The masked text: just enough shape to tell rows apart, never the length. */
export function render(value: unknown, kind: MaskKind): string {
  const s = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  if (kind === "email") {
    const at = s.lastIndexOf("@");
    if (at < 1) return DOT.repeat(8);
    const tld = s.slice(s.lastIndexOf("."));
    return s[0] + DOT.repeat(4) + "@" + DOT.repeat(5) + (tld.length <= 6 ? tld : "");
  }
  if (kind === "phone") {
    const d = s.replace(/\D/g, "");
    return (
      (s.trim()[0] === "+" ? "+" : "") +
      DOT.repeat(2) +
      " " +
      DOT.repeat(3) +
      " " +
      DOT.repeat(3) +
      " " +
      DOT +
      (d.length >= 2 ? d.slice(-2) : DOT.repeat(2))
    );
  }
  if (kind === "person") {
    return s
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((w) => w[0] + DOT.repeat(4))
      .join(" ");
  }
  return DOT.repeat(12);
}

/** Unescape a SQL string literal's body (`''` → `'`). */
const unquote = (inner: string) => inner.replace(/''/g, "'");

/**
 * Mask string literals in a SQL text. A literal is masked when it is one of
 * `known` (values already judged sensitive by their column — the change
 * history passes these), or when it looks sensitive by itself.
 */
export function maskSqlText(
  sql: string,
  cfg: MaskConfig,
  known?: ReadonlyMap<string, string>,
): string {
  return sql.replace(/(N?)'((?:[^']|'')*)'/g, (all, n: string, inner: string) => {
    const raw = unquote(inner);
    const hit = known?.get(raw);
    if (hit !== undefined) return n + "'" + hit + "'";
    const k = kindOf(raw, null, cfg);
    return k ? n + "'" + render(raw, k) + "'" : all;
  });
}
