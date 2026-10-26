import { describe, expect, it } from "vitest";

import { previewFilename } from "./filename";

/** 2026-10-26 03:07:00 local — the same instant the Rust tests use. */
const now = new Date(2026, 9, 26, 3, 7, 0);

describe("previewFilename", () => {
  it("resolves the fixed tokens and takes the extension from the format", () => {
    expect(previewFilename("{{name}}_{{env}}_{{date}}", "csv", "Orders", "prod", now)).toBe(
      "Orders_prod_20261026.csv",
    );
    expect(previewFilename("{{name}}", "json", "Orders", "prod", now)).toBe("Orders.json");
  });

  it("resolves the date tokens in local time", () => {
    expect(previewFilename("{{today}}", "csv", "n", "", now)).toBe("2026-10-26.csv");
    expect(previewFilename("{{yesterday}}", "csv", "n", "", now)).toBe("2026-10-25.csv");
    expect(previewFilename("{{month_start}}", "csv", "n", "", now)).toBe("2026-10-01.csv");
    expect(previewFilename("{{days_ago:7}}", "csv", "n", "", now)).toBe("2026-10-19.csv");
    expect(previewFilename("{{time}}", "csv", "n", "", now)).toBe("030700.csv");
  });

  it("crosses a month boundary correctly", () => {
    const firstOfMonth = new Date(2026, 10, 1, 9, 0, 0);
    expect(previewFilename("{{yesterday}}", "csv", "n", "", firstOfMonth)).toBe("2026-10-31.csv");
  });

  it("tolerates whitespace inside a token", () => {
    expect(previewFilename("{{ name }}", "csv", "Orders", "", now)).toBe("Orders.csv");
  });

  it("leaves an unknown or unterminated token exactly as written", () => {
    // Visible in the preview, which is the point: a typo should look like one.
    expect(previewFilename("{{nope}}", "csv", "n", "", now)).toBe("{{nope}}.csv");
    expect(previewFilename("a{{date", "csv", "n", "", now)).toBe("a{{date.csv");
  });

  it("cannot produce a path separator, however the name is spelled", () => {
    const preview = previewFilename("{{name}}", "csv", "../../etc/passwd", "", now);
    expect(preview).not.toContain("/");
    expect(preview).not.toContain("\\");
    // Matches the Rust sanitizer: separators flattened, leading dots dropped.
    expect(preview).toBe("_.._etc_passwd.csv");
  });

  it("keeps ordinary punctuation that is legal in a filename", () => {
    // The character class must not swallow the whole punctuation range.
    expect(previewFilename("{{name}}", "csv", "Q3 report (final)-v2", "", now)).toBe(
      "Q3 report (final)-v2.csv",
    );
  });

  it("falls back to a generic stem rather than producing a nameless file", () => {
    expect(previewFilename("", "csv", "n", "", now)).toBe("export.csv");
    expect(previewFilename("{{name}}", "csv", "   ", "", now)).toBe("export.csv");
  });

  it("escapes a Windows device name and drops a leading dot", () => {
    expect(previewFilename("{{name}}", "csv", "NUL", "", now)).toBe("_NUL.csv");
    expect(previewFilename("{{name}}", "csv", ".hidden", "", now)).toBe("hidden.csv");
  });

  it("caps an absurdly long stem", () => {
    const preview = previewFilename("{{name}}", "csv", "x".repeat(400), "", now);
    expect(preview).toBe(`${"x".repeat(120)}.csv`);
  });
});
