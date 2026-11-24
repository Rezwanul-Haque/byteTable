// Which statements go through the recorder (M48 A2). A coarse, cheap test on
// the leading keyword — the backend decides exactly what each one captures;
// this only keeps plain reads on the editor's usual path (and row limit).

const LEADING_WRITE =
  /^(insert|update|delete|merge|replace|upsert|truncate|create|alter|drop|rename|grant|revoke|begin|start|commit|rollback|call|exec|execute)\b/i;
const CTE_WRITE = /\b(insert|update|delete|merge)\b/i;

/** Strip leading whitespace, `--` line comments and block comments. */
function lead(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.trimStart();
    if (t.startsWith("--")) {
      const nl = t.indexOf("\n");
      s = nl < 0 ? "" : t.slice(nl + 1);
    } else if (t.startsWith("/*")) {
      const end = t.indexOf("*/");
      s = end < 0 ? "" : t.slice(end + 2);
    } else {
      return t;
    }
  }
}

/** Could this statement change data or structure (or drive a transaction)? */
export function isWrite(sql: string): boolean {
  const s = lead(sql);
  if (LEADING_WRITE.test(s)) return true;
  return /^with\b/i.test(s) && CTE_WRITE.test(s);
}
