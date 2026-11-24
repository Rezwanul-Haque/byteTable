import { describe, expect, it } from "vitest";

import { kindOf, maskSqlText, render, type MaskConfig } from "./mask";

const ALL: MaskConfig = {
  maskEmail: true,
  maskPhone: true,
  maskSecret: true,
  maskPerson: true,
  maskCustom: "",
};
const DEFAULTS: MaskConfig = { ...ALL, maskPerson: false };

describe("kindOf · column names", () => {
  it.each([
    ["email", "email"],
    ["u.email", "email"],
    ["billing_mail", "email"],
    ["customer_phone", "phone"],
    ["mobile", "phone"],
    ["msisdn", "phone"],
    ["whatsapp_no", "phone"],
    ["tel", "phone"],
    ["fax", "phone"],
    ["home_cell", "phone"],
    ["api_token", "secret"],
    ["client_secret", "secret"],
    ["password_hash", "secret"],
    ["pwd", "secret"],
    ["api_key", "secret"],
    ["private_key", "secret"],
    ["credentials", "secret"],
    ["salt", "secret"],
    ["hash", "secret"],
    ["otp_code", "secret"],
    ["session_id", "secret"],
    ["ssn", "secret"],
    ["iban", "secret"],
    ["card_number", "secret"],
    ["card_no", "secret"],
    ["cvv", "secret"],
    ["cvc", "secret"],
    ["txn_id", "secret"],
    ["full_name", "person"],
    ["first_name", "person"],
    ["last_name", "person"],
    ["surname", "person"],
    ["customer_name", "person"],
    ["ship_name", "person"],
    ["bill_name", "person"],
    ["address", "person"],
    ["line1", "person"],
    ["line2", "person"],
    ["postcode", "person"],
    ["zip", "person"],
    ["vat_id", "person"],
    ["birth_date", "person"],
  ])("%s → %s", (col, kind) => {
    expect(kindOf(null, col, ALL)).toBe(kind);
  });

  it("respects the category switches, the custom list and its * patterns", () => {
    expect(kindOf(null, "full_name", DEFAULTS)).toBeNull();
    expect(kindOf(null, "email", { ...ALL, maskEmail: false })).toBeNull();
    expect(kindOf(null, "salary", { ...ALL, maskCustom: "salary, *_note" })).toBe("custom");
    expect(kindOf(null, "staff_note", { ...ALL, maskCustom: "salary, *_note" })).toBe("custom");
    // Custom wins over the built-in categories.
    expect(kindOf(null, "email", { ...ALL, maskCustom: "email" })).toBe("custom");
  });
});

describe("kindOf · values", () => {
  it.each([
    ["grace.rossi@fastmail.com", "email"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-DEF_123", "secret"],
    ["sk_live_9fQ2xLr8TzB1mVe7", "secret"],
    ["ghp_abcdefghijklmnop", "secret"],
    ["xoxb-123456789012345", "secret"],
    ["AKIAABCDEFGHIJKLMNOP", "secret"],
    ["key-abcdefghijklmn", "secret"],
    ["0123456789abcdef0123456789abcdef", "secret"],
    ["QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZn", "secret"],
    ["+31 20 555 0142", "phone"],
    ["(020) 555-0142", "phone"],
  ])("%s → %s", (value, kind) => {
    expect(kindOf(value, "e", ALL)).toBe(kind);
  });

  it.each([
    ["2025-12-11 14:45:25"],
    ["ORD-2025-00012"],
    [
      "the quick brown fox jumps over the lazy dog while the cat sleeps on a warm mat near the old door",
    ],
    [12],
    [true],
    [null],
    [""],
  ])("never masks %s", (value) => {
    expect(kindOf(value, "note", ALL)).toBeNull();
  });

  it("does not mask a plain column like country", () => {
    expect(kindOf("DE", "country", ALL)).toBeNull();
  });
});

describe("render", () => {
  it("draws each category", () => {
    expect(render("grace@fastmail.com", "email")).toBe("g••••@•••••.com");
    expect(render("+31 20 555 0142", "phone")).toBe("+•• ••• ••• •42");
    expect(render("Grace Rossi", "person")).toBe("G•••• R••••");
    expect(render("sk_live_123", "secret")).toBe("••••••••••••");
    expect(render("x", "custom")).toBe("••••••••••••");
  });

  it("never reveals the original's length", () => {
    expect(render("a@b.io", "email").length).toBe(
      render("bartholomew.longname@example.io", "email").length,
    );
    expect(render("+1 555 0100 123", "phone").length).toBe(
      render("+44 20 7946 0958 42", "phone").length,
    );
  });
});

describe("maskSqlText", () => {
  it("masks literals that look sensitive, or that the caller names", () => {
    const sql = "UPDATE t SET email = 'g@x.com', note = 'hi', pw = 'abc' WHERE id = 1";
    expect(maskSqlText(sql, DEFAULTS, new Map([["abc", "••••••••••••"]]))).toBe(
      "UPDATE t SET email = 'g••••@•••••.com', note = 'hi', pw = '••••••••••••' WHERE id = 1",
    );
    expect(maskSqlText("SELECT N'a@b.com'", DEFAULTS)).toBe("SELECT N'a••••@•••••.com'");
  });
});
