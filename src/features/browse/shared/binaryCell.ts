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

/** True for a text UUID/GUID column: Postgres `uuid`, SQL Server
 *  `uniqueidentifier` (also `guid` — tiberius reports the result column type as
 *  `Guid`, not the SQL name). A UUID stored as `binary(16)` is a binary column,
 *  handled by the binary helpers instead. */
export function isUuidType(type: string | undefined): boolean {
  return /\b(uuid|uniqueidentifier|guid)\b/i.test(type ?? "");
}

/** The UUID versions the editor can generate. v7 is the default: time-ordered,
 *  so it indexes far better than v4 as a key. */
export type UuidVersion = "v7" | "v4" | "v1";
export const UUID_VERSIONS: { id: UuidVersion; label: string; hint: string }[] = [
  { id: "v7", label: "v7", hint: "Time-ordered (recommended for keys)" },
  { id: "v4", label: "v4", hint: "Random" },
  { id: "v1", label: "v1", hint: "Timestamp + random node" },
];

/** Random lowercase hex of `len` digits, from a CSPRNG when available. */
function randomHex(len: number): string {
  const h = "0123456789abcdef";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = new Uint8Array(Math.ceil(len / 2));
    crypto.getRandomValues(bytes);
    let s = "";
    for (const b of bytes) s += h[b >> 4]! + h[b & 15]!;
    return s.slice(0, len);
  }
  let s = "";
  for (let i = 0; i < len; i++) s += h[Math.floor(Math.random() * 16)];
  return s;
}

/** Format an assembled 32-hex string as a canonical 8-4-4-4-12 UUID. */
function dashed(hex32: string): string {
  return (
    hex32.slice(0, 8) +
    "-" +
    hex32.slice(8, 12) +
    "-" +
    hex32.slice(12, 16) +
    "-" +
    hex32.slice(16, 20) +
    "-" +
    hex32.slice(20, 32)
  );
}

/** RFC 4122 v4 — fully random (bar version + variant bits). */
export function generateUuidV4(): string {
  const r = randomHex(32).split("");
  r[12] = "4"; // version
  r[16] = "89ab"[Math.floor(Math.random() * 4)]!; // variant 10xx
  return dashed(r.join(""));
}

/** RFC 9562 v7 — 48-bit Unix-ms timestamp prefix, then random. Time-ordered, so
 *  it keeps B-tree / clustered-index inserts sequential (unlike random v4). */
export function generateUuidV7(): string {
  const ts = BigInt(Date.now()) & 0xffffffffffffn; // 48-bit ms
  const tsHex = ts.toString(16).padStart(12, "0");
  const randA = randomHex(3); // 12 bits after the version nibble
  const variant = "89ab"[Math.floor(Math.random() * 4)]!;
  const randB = randomHex(15); // remaining bits after the variant nibble
  return dashed(tsHex + "7" + randA + variant + randB);
}

/** RFC 4122 v1 — 60-bit Gregorian (100-ns) timestamp + random clock-seq and a
 *  random node with the multicast bit set (we have no MAC address). */
export function generateUuidV1(): string {
  // 100-ns intervals since 1582-10-15, from Unix ms (+ the Gregorian offset).
  const t = BigInt(Date.now()) * 10000n + 0x01b21dd213814000n;
  const timeLow = (t & 0xffffffffn).toString(16).padStart(8, "0");
  const timeMid = ((t >> 32n) & 0xffffn).toString(16).padStart(4, "0");
  const timeHi = (((t >> 48n) & 0x0fffn) | 0x1000n).toString(16).padStart(4, "0"); // version 1
  const clockSeq = ((parseInt(randomHex(4), 16) & 0x3fff) | 0x8000).toString(16).padStart(4, "0"); // variant 10xx
  // Random 48-bit node with the multicast bit (LSB of the first octet) set, per
  // RFC 4122 §4.5 for a non-MAC node.
  const nodeBytes = randomHex(12).split("");
  const first = (parseInt(nodeBytes[0]! + nodeBytes[1]!, 16) | 0x01).toString(16).padStart(2, "0");
  const node = first + randomHex(10);
  return `${timeLow}-${timeMid}-${timeHi}-${clockSeq}-${node}`;
}

/** Generate a UUID string of the given version. */
export function generateUuidVersion(v: UuidVersion): string {
  return v === "v4" ? generateUuidV4() : v === "v1" ? generateUuidV1() : generateUuidV7();
}
