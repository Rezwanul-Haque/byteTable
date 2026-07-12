// BINARY(n) / UUID cell helpers — ported from the prototype's binary-cell.jsx.
// BINARY(16) usually holds a UUID stored as 16 raw bytes (e.g. MySQL
// UUID_TO_BIN()). The backend serializes binary as a `0x…` hex string (small
// values) or a `[N bytes]` placeholder (large ones — see
// shared::engine::binary_to_json); these helpers turn that into a canonical
// UUID / hex / blob display and validate edits back to the right byte length.

import type { CellValue } from "../../../shared/api/engine";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^(0x)?[0-9a-f]*$/i;
/** The backend's large-blob placeholder, e.g. "[4096 bytes]". */
const PLACEHOLDER_RE = /^\[\d+ bytes\]$/;

/** True for binary column types (binary / varbinary / blob / bytea). */
export function isBinaryType(type: string | undefined): boolean {
  return /\b(binary|varbinary|blob|bytea)\b/i.test(type ?? "");
}

/** Declared byte length from `BINARY(n)` / `VARBINARY(n)`, else null. */
export function binaryBytes(type: string | undefined): number | null {
  const m = /\(\s*(\d+)\s*\)/.exec(type ?? "");
  return m ? Number(m[1]) : null;
}

export function looksUuid(v: unknown): boolean {
  return typeof v === "string" && UUID_RE.test(v.trim());
}

export function uuidToHex(u: string): string {
  return u.replace(/-/g, "").toLowerCase();
}

export function hexToUuid(h: string): string | null {
  const s = h.replace(/^0x/i, "").toLowerCase();
  if (s.length !== 32) return null;
  return (
    s.slice(0, 8) +
    "-" +
    s.slice(8, 12) +
    "-" +
    s.slice(12, 16) +
    "-" +
    s.slice(16, 20) +
    "-" +
    s.slice(20)
  );
}

export interface BinaryRepr {
  kind: "uuid" | "hex" | "blob";
  text: string;
}

/** Canonical display for a binary value: UUID (16-byte), 0x-hex, or a size/
 *  placeholder chip for arbitrary or oversized bytes. */
export function formatBinary(value: CellValue, type: string | undefined): BinaryRepr | null {
  if (value == null) return null;
  const s = String(value);
  // Large blobs arrive as the backend placeholder ("[N bytes]") — show as-is.
  if (PLACEHOLDER_RE.test(s)) return { kind: "blob", text: s };
  const expect = binaryBytes(type) ?? 16;
  if (looksUuid(s)) return { kind: "uuid", text: s.toLowerCase() };
  const hex = s.replace(/^0x/i, "");
  if (HEX_RE.test(s) && hex.length === expect * 2) {
    if (expect === 16) {
      const u = hexToUuid(hex);
      if (u) return { kind: "uuid", text: u };
    }
    return { kind: "hex", text: "0x" + hex.toUpperCase() };
  }
  // Hex of an unexpected (but even) length: still show it rather than a chip.
  if (HEX_RE.test(s) && hex.length > 0 && hex.length % 2 === 0) {
    return { kind: "hex", text: "0x" + hex.toUpperCase() };
  }
  return { kind: "blob", text: expect + " B" };
}

export type BinaryValidation =
  | { ok: true; empty: true }
  | { ok: true; empty?: false; uuid: string | null; hex: string }
  | { ok: false; message: string };

/** Validate a binary editor input: a canonical UUID (16-byte columns) or
 *  `0x`-hex of exactly the column's byte length. Empty → NULL. */
export function validateBinary(text: string, type: string | undefined): BinaryValidation {
  const expect = binaryBytes(type) ?? 16;
  const t = text.trim();
  if (t === "") return { ok: true, empty: true };
  if (expect === 16 && UUID_RE.test(t)) {
    return { ok: true, uuid: t.toLowerCase(), hex: uuidToHex(t) };
  }
  if (HEX_RE.test(t)) {
    const hex = t.replace(/^0x/i, "");
    if (hex.length === expect * 2) {
      return { ok: true, uuid: expect === 16 ? hexToUuid(hex) : null, hex: hex.toLowerCase() };
    }
    return {
      ok: false,
      message:
        hex.length % 2 === 1
          ? "Hex must have an even number of digits"
          : "Expected " +
            expect +
            " bytes (" +
            expect * 2 +
            " hex digits), got " +
            Math.floor(hex.length / 2),
    };
  }
  return { ok: false, message: "Enter a UUID (xxxxxxxx-xxxx-…) or 0x-hex" };
}

/** A random v4-ish UUID string (display form). Index-seeded externally to avoid
 *  Math.random pitfalls is unnecessary here — this is a UI convenience only. */
export function generateUuid(): string {
  const h = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s +=
      i === 12
        ? "4"
        : i === 16
          ? h[8 + Math.floor(Math.random() * 4)]
          : h[Math.floor(Math.random() * 16)];
  }
  return (
    s.slice(0, 8) +
    "-" +
    s.slice(8, 12) +
    "-" +
    s.slice(12, 16) +
    "-" +
    s.slice(16, 20) +
    "-" +
    s.slice(20)
  );
}
