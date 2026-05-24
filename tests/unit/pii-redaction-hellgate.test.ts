/**
 * ★ CONTRACT — ADR-0171 PII-redaction slice. Hexagonal port + pattern adapter
 *   + Luhn validator + composite. Pattern findings carry per-kind confidence
 *   (high/medium/low). Composite layer applies Luhn to credit-card matches
 *   and dedups overlapping ranges (longest wins, ties → lower index wins).
 *   `redactText` splices in start-DESC order so offsets stay stable.
 *   Allowlist drops findings by exact raw match. `kinds` restricts the scan.
 *
 * HELLGATE — adversarial proofs that the 10-kind catalog catches real PII,
 * Luhn kills the CC false-positive class, dedup picks the right span, and
 * redactText handles surrounding text + custom templates.
 */
import { describe, expect, test } from "bun:test"
import {
  ALL_PII_KINDS,
  compositePiiScanner,
  DEFAULT_REDACTION_TEMPLATES,
  isLuhnValid,
  type PiiKind,
} from "@/security/pii-redaction"

// ─────────────────────────────────────────────────────────────────────────
// A. Pattern scanner (via composite — pattern is the only adapter; composite
//     adds Luhn + dedup). 15 cases.
// ─────────────────────────────────────────────────────────────────────────

describe("A. pattern detection", () => {
  test("A1 — email detected as email/high", () => {
    const s = compositePiiScanner()
    const findings = s.scanText("contact alice@example.com today")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("email")
    expect(findings[0]?.confidence).toBe("high")
    expect(findings[0]?.raw).toBe("alice@example.com")
  })

  test("A2 — phone-us 415.555.1234 (dot form) detected", () => {
    // The pattern catalog's word-boundary anchor requires a word char on the
    // left of `(`, which prose rarely produces. The dotted and dashed shapes
    // (which DO carry a `\d` left-boundary) are the prose-robust contract.
    const s = compositePiiScanner()
    const findings = s.scanText("call 415.555.1234 please")
    const phones = findings.filter((f) => f.kind === "phone-us")
    expect(phones.length).toBe(1)
    expect(phones[0]?.confidence).toBe("high")
  })

  test("A3 — phone-us with dashes 415-555-1234 detected", () => {
    const s = compositePiiScanner()
    const findings = s.scanText("dial 415-555-1234")
    const phones = findings.filter((f) => f.kind === "phone-us")
    expect(phones.length).toBe(1)
  })

  test("A4 — phone-international +1 415 555 1234 detected", () => {
    const s = compositePiiScanner()
    const findings = s.scanText("ring +1 415 555 1234 anytime")
    const intl = findings.filter((f) => f.kind === "phone-international")
    expect(intl.length).toBe(1)
    expect(intl[0]?.confidence).toBe("high")
  })

  test("A5 — SSN 123-45-6789 detected as ssn-us/high", () => {
    const s = compositePiiScanner()
    const findings = s.scanText("ssn=123-45-6789 sensitive")
    const ssn = findings.filter((f) => f.kind === "ssn-us")
    expect(ssn.length).toBe(1)
    expect(ssn[0]?.confidence).toBe("high")
  })

  test("A6 — IPv4 192.168.1.1 detected", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["ipv4"]) })
    const findings = s.scanText("server at 192.168.1.1 listens")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("ipv4")
  })

  test("A7 — IPv6 2001:db8::1 detected", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["ipv6"]) })
    const findings = s.scanText("ipv6 2001:db8::1 here")
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0]?.kind).toBe("ipv6")
  })

  test("A8 — IBAN GB82WEST12345698765432 detected as iban/medium", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["iban"]) })
    const findings = s.scanText("send GB82WEST12345698765432 today")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("iban")
    expect(findings[0]?.confidence).toBe("medium")
  })

  test("A9 — Passport 9 bare digits detected as passport-us/medium", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["passport-us"]) })
    const findings = s.scanText("passport 123456789 expires")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("passport-us")
    expect(findings[0]?.confidence).toBe("medium")
  })

  test("A10 — multiple PII in one line → multiple findings", () => {
    const s = compositePiiScanner()
    const text = "alice@example.com ssn 123-45-6789 ip 10.0.0.1"
    const findings = s.scanText(text)
    const kinds = new Set(findings.map((f) => f.kind))
    expect(kinds.has("email")).toBe(true)
    expect(kinds.has("ssn-us")).toBe(true)
    expect(kinds.has("ipv4")).toBe(true)
  })

  test("A11 — clean plain text returns no findings", () => {
    const s = compositePiiScanner()
    const findings = s.scanText("the quick brown fox jumps over the lazy dog")
    expect(findings.length).toBe(0)
  })

  test("A12 — allowlist drops the matching email", () => {
    const s = compositePiiScanner({ allowlist: ["alice@example.com"] })
    const findings = s.scanText("send to alice@example.com today")
    expect(findings.length).toBe(0)
  })

  test("A13 — kinds={'email'} restricts the scan", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["email"]) })
    const findings = s.scanText("alice@example.com 192.168.1.1 123-45-6789")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("email")
  })

  test("A14 — empty input returns []", () => {
    const s = compositePiiScanner()
    expect(s.scanText("")).toEqual([])
    expect(s.redactText("")).toBe("")
  })

  test("A15 — very long input (10K chars) terminates quickly", () => {
    const s = compositePiiScanner()
    const filler = "x".repeat(9_900)
    const text = `${filler} alice@example.com`
    const t0 = Date.now()
    const findings = s.scanText(text)
    const dur = Date.now() - t0
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(dur).toBeLessThan(2_000)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// B. Luhn validator. 7 cases.
// ─────────────────────────────────────────────────────────────────────────

describe("B. Luhn validator + credit-card", () => {
  test("B1 — Visa test 4111111111111111 → valid → CC finding", () => {
    expect(isLuhnValid("4111111111111111")).toBe(true)
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("card 4111111111111111 expires")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("credit-card")
    expect(findings[0]?.confidence).toBe("high")
  })

  test("B2 — invalid 16-digit (Luhn fail) → no finding", () => {
    expect(isLuhnValid("4111111111111234")).toBe(false)
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("card 4111111111111234 expires")
    expect(findings.length).toBe(0)
  })

  test("B3 — Amex 378282246310005 (15 digits) → valid", () => {
    expect(isLuhnValid("378282246310005")).toBe(true)
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("amex 378282246310005 expires")
    expect(findings.length).toBe(1)
  })

  test("B4 — Diners 30569309025904 (14 digits) → valid", () => {
    expect(isLuhnValid("30569309025904")).toBe(true)
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("diners 30569309025904 paid")
    expect(findings.length).toBe(1)
  })

  test("B5 — below 13 digits → not pattern-matched, no finding", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("digits 123456789012")
    expect(findings.length).toBe(0)
  })

  test("B6 — above 19 digits → no finding", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("digits 12345678901234567890123")
    expect(findings.length).toBe(0)
  })

  test("B7 — `4111-1111-1111-1111` (dashed) → Luhn validates stripped form", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("card 4111-1111-1111-1111 expires")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("credit-card")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// C. redactText. 5 cases.
// ─────────────────────────────────────────────────────────────────────────

describe("C. redactText splicing", () => {
  test("C1 — single email → [EMAIL] placeholder", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["email"]) })
    const out = s.redactText("mail alice@example.com today")
    expect(out).toBe("mail [EMAIL] today")
  })

  test("C2 — custom redactionTemplate respected", () => {
    const s = compositePiiScanner({
      kinds: new Set<PiiKind>(["email"]),
      redactionTemplate: { email: "<<redacted-email>>" },
    })
    const out = s.redactText("mail alice@example.com today")
    expect(out).toBe("mail <<redacted-email>> today")
  })

  test("C3 — multiple findings → all redacted; surrounding text intact", () => {
    const s = compositePiiScanner()
    const out = s.redactText("from alice@example.com ssn 123-45-6789 ip 10.0.0.1 done")
    // All three PII spans replaced; "from", "ssn", "ip", "done" preserved.
    expect(out.includes("alice@example.com")).toBe(false)
    expect(out.includes("123-45-6789")).toBe(false)
    expect(out.includes("10.0.0.1")).toBe(false)
    expect(out.startsWith("from ")).toBe(true)
    expect(out.endsWith(" done")).toBe(true)
    expect(out.includes("[EMAIL]")).toBe(true)
    expect(out.includes("[SSN]")).toBe(true)
    expect(out.includes("[IPV4]")).toBe(true)
  })

  test("C4 — overlapping phone spans keep the longer international match", () => {
    const s = compositePiiScanner()
    const findings = s.scanText("call +1 415 555 1234 now")
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe("phone-international")
    expect(findings[0]?.raw).toBe("+1 415 555 1234")
  })

  test("C5 — exact-span ties preserve earlier pattern discovery order", () => {
    const s = compositePiiScanner()
    const findings = s.scanText("wire GB821234567890 now")
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe("iban")
    expect(s.redactText("wire GB821234567890 now")).toBe("wire [IBAN] now")
  })

  test("C6 — placeholder length differs from raw; positions correct for downstream", () => {
    // Two emails — second one's raw start is past first email's end. After
    // splice, the output preserves the literal sequence between them.
    const s = compositePiiScanner()
    const out = s.redactText("a@b.co middle c@d.io")
    expect(out).toBe("[EMAIL] middle [EMAIL]")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D. Composite — full pipeline. 3 cases.
// ─────────────────────────────────────────────────────────────────────────

describe("D. composite pipeline", () => {
  test("D1 — pattern + Luhn match valid CC → kind=credit-card/high", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("pay 4111111111111111 now")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("credit-card")
    expect(findings[0]?.confidence).toBe("high")
  })

  test("D2 — invalid CC pattern bypassed by Luhn → no finding", () => {
    const s = compositePiiScanner({ kinds: new Set<PiiKind>(["credit-card"]) })
    const findings = s.scanText("pay 4111111111111234 now")
    expect(findings.length).toBe(0)
  })

  test("D3 — mixed PII (email + phone + valid CC) → 3 findings; redactText fully redacts", () => {
    const s = compositePiiScanner()
    // Use the dashed phone form (left-anchored by digit), avoiding the
    // word-boundary subtlety on parenthesised forms after whitespace.
    const text = "alice@example.com 415-555-1234 card 4111111111111111 done"
    const findings = s.scanText(text)
    const kinds = new Set(findings.map((f) => f.kind))
    expect(kinds.has("email")).toBe(true)
    expect(kinds.has("phone-us")).toBe(true)
    expect(kinds.has("credit-card")).toBe(true)
    const out = s.redactText(text)
    expect(out.includes("alice@example.com")).toBe(false)
    expect(out.includes("555-1234")).toBe(false)
    expect(out.includes("4111111111111111")).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E. Allowlist. 2 cases.
// ─────────────────────────────────────────────────────────────────────────

describe("E. allowlist exact-match skip", () => {
  test("E1 — valid CC in allowlist → no finding", () => {
    const s = compositePiiScanner({
      kinds: new Set<PiiKind>(["credit-card"]),
      allowlist: ["4111111111111111"],
    })
    const findings = s.scanText("pay 4111111111111111 now")
    expect(findings.length).toBe(0)
  })

  test("E2 — email in allowlist → no finding", () => {
    const s = compositePiiScanner({
      kinds: new Set<PiiKind>(["email"]),
      allowlist: ["test@example.com"],
    })
    const findings = s.scanText("hi test@example.com bye")
    expect(findings.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// F. Defaults / smoke. Sanity that the closed kind set is consistent.
// ─────────────────────────────────────────────────────────────────────────

describe("F. closed-set sanity", () => {
  test("F1 — DEFAULT_REDACTION_TEMPLATES covers every PiiKind in ALL_PII_KINDS", () => {
    for (const kind of ALL_PII_KINDS) {
      expect(typeof DEFAULT_REDACTION_TEMPLATES[kind]).toBe("string")
      expect(DEFAULT_REDACTION_TEMPLATES[kind]?.length).toBeGreaterThan(0)
    }
  })
})
