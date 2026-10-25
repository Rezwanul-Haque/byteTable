// Snippet prefix matching. The rule worth pinning is the ordering: the
// shorthand the user chose has to beat an incidental name match, or typing
// `sel` puts someone else's snippet first.

import { describe, expect, it } from "vitest";

import type { Snippet } from "./api";
import { matchSnippets, MAX_SNIPPET_OPTIONS } from "./match";

function snippet(name: string, abbreviation?: string): Snippet {
  return { id: name, name, abbreviation, body: "SELECT 1", savedAt: 0 };
}

describe("matchSnippets", () => {
  it("matches an abbreviation", () => {
    const library = [snippet("Recent rows", "recent"), snippet("Count all", "cnt")];
    expect(matchSnippets(library, "rec").map((s) => s.name)).toEqual(["Recent rows"]);
  });

  it("matches a name when no abbreviation does", () => {
    const library = [snippet("Count all", "cnt")];
    expect(matchSnippets(library, "cou").map((s) => s.name)).toEqual(["Count all"]);
  });

  it("puts abbreviation matches ahead of name matches", () => {
    const library = [snippet("Select recent"), snippet("Shorthand", "sel")];
    expect(matchSnippets(library, "sel").map((s) => s.name)).toEqual([
      "Shorthand",
      "Select recent",
    ]);
  });

  it("is case-insensitive on both sides", () => {
    const library = [snippet("Recent", "REC")];
    expect(matchSnippets(library, "rEc")).toHaveLength(1);
    expect(matchSnippets([snippet("UPPER")], "up")).toHaveLength(1);
  });

  it("matches on a prefix, not anywhere in the string", () => {
    // Substring matching would make almost everything match almost anything.
    expect(matchSnippets([snippet("Recent rows", "recent")], "cent")).toEqual([]);
  });

  it("returns the whole library for an empty or whitespace prefix", () => {
    const library = [snippet("A", "a"), snippet("B", "b")];
    expect(matchSnippets(library, "")).toHaveLength(2);
    expect(matchSnippets(library, "   ")).toHaveLength(2);
  });

  it("returns nothing when no snippet matches", () => {
    expect(matchSnippets([snippet("Recent", "rec")], "zzz")).toEqual([]);
  });

  it("keeps the library's own order within a group, so rows do not reshuffle", () => {
    const library = [snippet("S one", "s1"), snippet("S two", "s2"), snippet("S three", "s3")];
    expect(matchSnippets(library, "s").map((s) => s.name)).toEqual(["S one", "S two", "S three"]);
  });

  it("caps the rows so a big library cannot bury the schema suggestions", () => {
    const library = Array.from({ length: MAX_SNIPPET_OPTIONS + 8 }, (_, i) =>
      snippet(`Snippet ${i}`, `s${i}`),
    );
    expect(matchSnippets(library, "s")).toHaveLength(MAX_SNIPPET_OPTIONS);
    expect(matchSnippets(library, "")).toHaveLength(MAX_SNIPPET_OPTIONS);
  });

  it("still offers an abbreviation-less snippet, ranked below a shorthand hit", () => {
    const library = [snippet("Plain"), snippet("Shorthand", "pl")];
    expect(matchSnippets(library, "pl").map((s) => s.name)).toEqual(["Shorthand", "Plain"]);
  });
});
