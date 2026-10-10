import { describe, expect, it } from "vitest";

import { highlightJson, type JsonToken } from "./json";

/** Tokens as `kind:text` pairs, for readable assertions. */
const pairs = (text: string) => highlightJson(text).map((t) => `${t.kind}:${t.text}`);
/** Only the tokens that carry meaning — whitespace and punctuation dropped. */
const values = (text: string) =>
  highlightJson(text)
    .filter((t) => t.kind !== "punct")
    .map((t) => `${t.kind}:${t.text}`);

/** The invariant everything else rests on. */
const roundTrips = (text: string) =>
  highlightJson(text)
    .map((t: JsonToken) => t.text)
    .join("") === text;

describe("highlightJson", () => {
  it("tells a key from a string by the colon that follows it", () => {
    expect(values('{ "item": "Paneer Tikka" }')).toEqual(['key:"item"', 'string:"Paneer Tikka"']);
  });

  it("still reads a key when the colon is on the next line", () => {
    expect(values('{\n  "item"\n  : 1\n}')).toEqual(['key:"item"', "number:1"]);
  });

  it("picks out numbers in every JSON spelling", () => {
    expect(values("[1, -2, 3.5, 6e3, -7.25e-4]")).toEqual([
      "number:1",
      "number:-2",
      "number:3.5",
      "number:6e3",
      "number:-7.25e-4",
    ]);
  });

  it("picks out the three bare words, and only as whole words", () => {
    expect(values("[true, false, null]")).toEqual([
      "keyword:true",
      "keyword:false",
      "keyword:null",
    ]);
    // `nullable` is not `null`.
    expect(values('{ "nullable": 1 }')).toEqual(['key:"nullable"', "number:1"]);
  });

  it("does not mistake a bare word inside a string for a keyword", () => {
    expect(values('{ "status": "null" }')).toEqual(['key:"status"', 'string:"null"']);
  });

  it("handles escaped quotes inside a string", () => {
    expect(values('{ "note": "say \\"hi\\"" }')).toEqual(['key:"note"', 'string:"say \\"hi\\""']);
  });

  it("keeps whitespace and punctuation verbatim, in order", () => {
    expect(pairs('{ "a": 1 }')).toEqual([
      "punct:{ ",
      'key:"a"',
      "punct:: ",
      "number:1",
      "punct: }",
    ]);
  });

  describe("is lossless", () => {
    const cases = [
      '{ "item": "Paneer Tikka",\n  "price": { "app": 249, "kiosk": 229 },\n  "mods": ["extra cheese"] }',
      "",
      "   ",
      "not json at all",
      "{",
      // Mid-typing: an unterminated string.
      '{ "item": "Paneer',
      // A trailing newline, which the editor's highlight layer has to mirror.
      '{ "a": 1 }\n',
    ];
    for (const text of cases) {
      it(JSON.stringify(text.slice(0, 32)), () => {
        expect(roundTrips(text)).toBe(true);
      });
    }
  });

  it("leaves an unterminated string unhighlighted rather than giving up", () => {
    // Half-typed: `"item"` is still a key, the open quote is just not a string yet.
    expect(values('{ "item": "Paneer')).toEqual(['key:"item"']);
  });

  it("returns nothing for empty input", () => {
    expect(highlightJson("")).toEqual([]);
  });

  it("colours a bare fragment that is not an object", () => {
    expect(values('"just a string"')).toEqual(['string:"just a string"']);
  });
});
