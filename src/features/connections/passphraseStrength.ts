// Passphrase strength scoring for the connection-bundle export (M40).
//
// Pure, dependency-free, and deliberately modest in what it claims. It does not
// pretend to estimate crack time — a real estimate needs a dictionary and a
// model of the attacker, and a wrong number printed confidently is worse than
// no number. It answers the narrower question the export modal actually needs:
// "is this long and varied enough that an offline attack on the file is
// expensive?"
//
// Why offline is the right threat: a bundle is a *file*. Once it has been
// emailed or dropped in shared storage it can be attacked forever, with
// unlimited guesses, by whoever holds it. There is no server to rate-limit and
// no account to lock. The Argon2id cost in the codec raises the price per
// guess; this raises the number of guesses needed.

/** Strength bands, ascending. Rendered as a four-segment meter. */
export type PassphraseStrength = "weak" | "fair" | "good" | "strong";

/** Shortest passphrase the export accepts. Mirrors `MIN_PASSPHRASE_LEN` in
 *  `src-tauri/src/features/connection_bundle/domain/mod.rs`, which is the rule
 *  with teeth — this constant only drives the UI. */
export const MIN_PASSPHRASE = 12;

/** A long passphrase is strong on length alone: four random words beat a short
 *  string with every character class, and the latter is far harder to type. */
const LONG_ENOUGH_ALONE = 20;

/** Sequences and repeats a dictionary attack tries first. */
const OBVIOUS = [
  /^(.)\1+$/, // aaaaaaaa
  /0123|1234|2345|3456|4567|5678|6789/,
  /abcdef|qwerty|asdfgh|zxcvbn/i,
  /password|passphrase|letmein|admin|bytetable/i,
];

/** How many distinct character classes the string draws on (0–4). */
function classes(value: string): number {
  let n = 0;
  if (/[a-z]/.test(value)) n++;
  if (/[A-Z]/.test(value)) n++;
  if (/[0-9]/.test(value)) n++;
  if (/[^a-zA-Z0-9]/.test(value)) n++;
  return n;
}

/**
 * Score a passphrase.
 *
 * Length dominates, because it is what actually defeats an offline attack:
 * character variety multiplies the per-character search space, but each extra
 * character multiplies the whole space again. A memorable 24-character phrase
 * of plain lowercase words therefore scores above a 12-character
 * `P@ssw0rd!x` — which is the correct answer, and the opposite of what most
 * strength meters say.
 *
 * Anything matching an obvious pattern is capped at `weak` no matter how long,
 * since those are the first guesses an attacker makes rather than the last.
 */
export function passphraseStrength(value: string): PassphraseStrength {
  const len = [...value].length; // code points: emoji and CJK count once
  if (len < MIN_PASSPHRASE) return "weak";
  if (OBVIOUS.some((re) => re.test(value))) return "weak";

  const variety = classes(value);
  if (len >= LONG_ENOUGH_ALONE + 8) return "strong";
  if (len >= LONG_ENOUGH_ALONE) return variety >= 2 ? "strong" : "good";
  if (len >= 16) return variety >= 3 ? "strong" : "good";
  // At the minimum length, variety is all that is left to lean on.
  return variety >= 3 ? "good" : "fair";
}

/** Meter segments to fill, 1–4. */
export function strengthScore(strength: PassphraseStrength): number {
  return { weak: 1, fair: 2, good: 3, strong: 4 }[strength];
}
