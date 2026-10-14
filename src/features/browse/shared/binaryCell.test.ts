import { describe, expect, it } from "vitest";

import { formatBinary, isBinaryType } from "./binaryCell";

describe("isBinaryType", () => {
  it("matches the binary column families only", () => {
    expect(isBinaryType("binary(16)")).toBe(true);
    expect(isBinaryType("varbinary(255)")).toBe(true);
    expect(isBinaryType("blob")).toBe(true);
    expect(isBinaryType("bytea")).toBe(true);
    expect(isBinaryType("varchar(32)")).toBe(false);
    expect(isBinaryType("longtext")).toBe(false);
    expect(isBinaryType(undefined)).toBe(false);
  });
});

describe("formatBinary", () => {
  it("renders a 16-byte value as a canonical UUID", () => {
    expect(formatBinary("0x0191f3a27b7e4c6e8f1d2a3b4c5d6e7f", "binary(16)")).toEqual({
      kind: "uuid",
      text: "0191f3a2-7b7e-4c6e-8f1d-2a3b4c5d6e7f",
    });
  });

  it("renders other hex as 0x-hex and keeps the backend's large-blob placeholder", () => {
    expect(formatBinary("0xdeadbeef", "binary(4)")).toEqual({ kind: "hex", text: "0xDEADBEEF" });
    expect(formatBinary("[4096 bytes]", "blob")).toEqual({
      kind: "blob",
      text: "[4096 bytes]",
    });
  });

  it("has no repr for NULL", () => {
    expect(formatBinary(null, "binary(16)")).toBeNull();
  });

  // MySQL sets the protocol BINARY flag for any `_bin` collation, so a text
  // value can arrive under a `blob` / `varbinary` type hint (see the MySQL
  // adapter's `blob_holds_text`). It is text, not a blob: no repr, so the cell
  // prints it instead of a "16 B" chip.
  it("has no repr for text that arrived under a binary type hint", () => {
    expect(formatBinary("https://www.bkash.com/terms-and-conditions", "blob")).toBeNull();
    expect(formatBinary("STRING", "varbinary(64)")).toBeNull();
    expect(formatBinary('{"co2": 39.82}', "blob")).toBeNull();
  });
});
