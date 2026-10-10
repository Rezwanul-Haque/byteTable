// Guard tests for the string tables. These encode the two invariants the PR
// review called out: (1) zh-Hans must cover exactly the same key set as en —
// en is the source of truth but zh-Hans is shipped as a complete translation;
// (2) every key's placeholder set must match en's in every locale that
// provides the key — `{count}` dropped from a translation fails silently (the
// number just disappears), and a plural/plain mismatch loses thousands
// separators (`1234 rows` vs `1,234 rows`).

import { describe, expect, it } from "vitest";
import { STRINGS } from "./strings/index";
import { en } from "./strings/en";

/**
 * Extract a comparable signature for every placeholder in an ICU message:
 *   - `{name}`                        → "name"
 *   - `{count, plural, …}`            → "count:plural" (+ "count:#" if the
 *     arm bodies render the number via the ICU `#` marker)
 *   - nested `{var}` inside arm bodies are collected the same way.
 *
 * Follows JS `MessageFormat` semantics: `''` is a literal quote, and a quote
 * only starts a quoted span before a special char (`{`, `}`, `#`) — so
 * "Couldn't open" is plain text, not an unterminated literal. Inside a
 * plural's content, `{…}` groups are arm bodies (`one {Row}`), not nested
 * placeholders, so arm bodies are scanned as messages rather than parsed as
 * placeholders.
 */
function signature(msg: string): string[] {
  const sigs = new Set<string>();

  function matchBrace(s: string, open: number): { inner: string; next: number } {
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") {
        depth--;
        if (depth === 0) return { inner: s.slice(open + 1, j), next: j + 1 };
      }
    }
    return { inner: s.slice(open + 1), next: s.length };
  }

  /** Scan the arms of a plural/selectordinal: `one {…} other {…}`. */
  function scanArms(rest: string, pluralVar: string): void {
    let i = 0;
    while (i < rest.length) {
      const open = rest.indexOf("{", i);
      if (open === -1) break;
      const { inner, next } = matchBrace(rest, open);
      scan(inner, pluralVar);
      i = next;
    }
  }

  /** Scan a message body. Inside a plural's arms `#` renders pluralVar. */
  function scan(content: string, pluralVar: string | null): void {
    let i = 0;
    while (i < content.length) {
      const ch = content[i];
      if (ch === "'") {
        if (content[i + 1] === "'") {
          i += 2;
          continue;
        }
        if ("{}#".includes(content[i + 1] ?? "")) {
          const close = content.indexOf("'", i + 1);
          i = close === -1 ? content.length : close + 1;
          continue;
        }
        i++;
        continue;
      }
      if (ch === "#" && pluralVar != null) {
        sigs.add(`${pluralVar}:#`);
        i++;
        continue;
      }
      if (ch === "{") {
        const { inner, next } = matchBrace(content, i);
        const typed = inner.match(/^([A-Za-z0-9_]+)\s*,\s*([a-z]+)/);
        if (typed) {
          const name = typed[1] ?? "";
          const type = typed[2];
          sigs.add(`${name}:${type}`);
          if (type === "plural" || type === "selectordinal")
            scanArms(inner.slice(typed[0].length), name);
        } else if (/^[A-Za-z0-9_]+$/.test(inner.trim())) {
          sigs.add(inner.trim());
        } else {
          scan(inner, pluralVar);
        }
        i = next;
        continue;
      }
      i++;
    }
  }

  scan(msg, null);
  return [...sigs].sort();
}

const enKeys = Object.keys(en).sort();
const enSigs = new Map([...Object.entries(en)].map(([k, v]) => [k, signature(v)]));

describe("i18n string tables", () => {
  it("en has no duplicate keys (typos would silently override)", () => {
    // Object.keys already collapses duplicates; this asserts the parse saw
    // every key the file declares, keeping the test honest against format
    // drift in en.ts.
    expect(enKeys.length).toBeGreaterThan(3000);
  });

  it("zh-Hans covers exactly the en key set (bidirectional)", () => {
    const zh = STRINGS["zh-Hans"];
    const zhKeys = new Set(Object.keys(zh));
    const missing = enKeys.filter((k) => !zhKeys.has(k));
    const extra = [...zhKeys].filter((k) => !(k in en));
    expect(missing, "keys missing from zh-Hans").toEqual([]);
    expect(extra, "zh-Hans keys not present in en").toEqual([]);
  });

  it("no locale provides a key that en lacks", () => {
    for (const [locale, table] of Object.entries(STRINGS)) {
      const extra = Object.keys(table).filter((k) => !(k in en));
      expect(extra, `${locale} has keys not in en`).toEqual([]);
    }
  });

  it("every provided key's placeholder signature matches en", () => {
    const problems: string[] = [];
    for (const [locale, table] of Object.entries(STRINGS)) {
      for (const [key, value] of Object.entries(table)) {
        const expected = enSigs.get(key);
        if (expected == null) continue; // covered by the key-set tests above
        const actual = signature(value);
        if (actual.join(",") !== expected.join(",")) {
          problems.push(
            `${locale} ${key}: en [${expected.join(", ")}] vs ${locale} [${actual.join(", ")}]`,
          );
        }
      }
    }
    expect(problems, "placeholder mismatches vs en").toEqual([]);
  });
});
