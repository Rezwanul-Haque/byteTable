import { describe, expect, it } from "vitest";

import {
  MIN_PASSPHRASE,
  passphraseStrength,
  strengthScore,
  type PassphraseStrength,
} from "./passphraseStrength";

describe("passphraseStrength", () => {
  it("rejects anything below the minimum length outright", () => {
    expect(passphraseStrength("")).toBe("weak");
    expect(passphraseStrength("Tr0ub4dor")).toBe("weak"); // 9 chars, every class
    expect(passphraseStrength("x".repeat(MIN_PASSPHRASE - 1))).toBe("weak");
  });

  it("caps obvious patterns at weak however long they are", () => {
    // Length alone must not rescue the first guesses an attacker makes.
    expect(passphraseStrength("aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("weak");
    expect(passphraseStrength("qwertyqwertyqwerty123")).toBe("weak");
    expect(passphraseStrength("MyPasswordIsVerySecure!")).toBe("weak");
    expect(passphraseStrength("bytetable-bundle-2026")).toBe("weak");
  });

  it("rates a long memorable phrase above a short complex one", () => {
    // The point of the whole module: length beats punctuation against an
    // offline attack, and most meters get this backwards.
    const memorable = passphraseStrength("correct horse battery staple");
    const fiddly = passphraseStrength("P@ssw0rd!x9Z");
    expect(memorable).toBe("strong");
    expect(strengthScore(memorable)).toBeGreaterThan(strengthScore(fiddly));
  });

  it("grades the band between the minimum and comfortably long", () => {
    expect(passphraseStrength("zqbflmvtdkrh")).toBe("fair"); // 12, one class
    expect(passphraseStrength("Zqbf7mvtDkrh")).toBe("good"); // 12, three classes
    expect(passphraseStrength("Zqbf7mvtDkrhWxyp")).toBe("strong"); // 16, three
    expect(passphraseStrength("zqbflmvtdkrhwxyp")).toBe("good"); // 16, one class
  });

  it("is monotonic: appending never lowers the band", () => {
    const base = "zqbflmvtdkrh";
    let previous = strengthScore(passphraseStrength(base));
    for (const suffix of ["w", "wx", "wxy", "wxyzQ", "wxyzQ7", "wxyzQ7mnbvcx"]) {
      const next = strengthScore(passphraseStrength(base + suffix));
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  it("counts code points, not UTF-16 units", () => {
    // Twelve emoji is twelve characters to a user; `.length` would say 24 and
    // wrongly promote an eleven-emoji phrase past the minimum.
    expect(passphraseStrength("🔐".repeat(MIN_PASSPHRASE - 1))).toBe("weak");
    expect(passphraseStrength("🔐".repeat(MIN_PASSPHRASE))).not.toBe("weak");
  });

  it("maps every band to a distinct meter segment count", () => {
    const bands: PassphraseStrength[] = ["weak", "fair", "good", "strong"];
    expect(bands.map(strengthScore)).toEqual([1, 2, 3, 4]);
  });
});
