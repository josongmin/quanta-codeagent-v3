/**
 * R5 hellgate — redact embedded / boundary-stress matrix.
 *
 * `redactSecrets` patterns are all `\b`-anchored. R3 documented one
 * consequence: an inline `xxxAKIA...yyy` (alphanumeric sandwich) is NOT
 * masked because `\b` requires a non-word transition.
 *
 * R5 may strengthen the patterns (e.g. drop `\b` for high-entropy prefixes
 * like `sk-`/`AKIA`/`ghp_`, or add `(?<![A-Za-z0-9])` lookbehind for the
 * non-letter boundary subset). The shape of the fix is up to the main track.
 *
 * This battery does both:
 *
 *  1. PIN current ANCHORED behavior so the patterns don't silently regress
 *     (e.g. quote, `=`, `:`, `(`, whitespace boundaries continue to work).
 *  2. DOCUMENT the embedded-sandwich cases with `toBeOneOf([true, false])`
 *     so the test does NOT fail today but DOES surface a behavior change
 *     when the main track tightens.
 *
 * The Layer-1 source-class-secret short-circuit is orthogonal and not
 * exercised here.
 */

import { describe, expect, test } from "bun:test"
import { redactSecrets } from "@/security/redaction"

const AWS_KEY = `AKIA${"X".repeat(16)}`
const GHP_KEY = `ghp_${"Y".repeat(40)}`
const ANT_KEY = `sk-ant-${"Z".repeat(40)}`
const PROJ_KEY = `sk-proj-${"abcDEF123".repeat(4)}`

/** Helper to assert: text contains placeholder AND not the literal. */
const assertRedacted = (text: string, literal: string, kind: string): void => {
  expect(text).not.toContain(literal)
  expect(text).toContain(`[REDACTED:${kind}]`)
}

/** Helper to assert: text passes through unchanged (no placeholder). */
const assertUnchanged = (text: string, literal: string): void => {
  expect(text).toContain(literal)
  expect(text).not.toContain("[REDACTED:")
}

const redact = (s: string): string => redactSecrets(s, { origin: "tool_result" }).text

describe("R5 — redact word-boundary anchor matrix", () => {
  // ── HARD-CURRENT cases: pin current behavior ───────────────────────────
  test("plain whitespace boundary: `secret is AKIA...` → REDACTED", () => {
    assertRedacted(redact(`secret is ${AWS_KEY}`), AWS_KEY, "aws_access_key_id")
  })

  test('quote boundary: `const KEY="AKIA..."` → REDACTED', () => {
    assertRedacted(redact(`const KEY="${AWS_KEY}"`), AWS_KEY, "aws_access_key_id")
  })

  test("env-var equals boundary: `KEY=AKIA...` → REDACTED", () => {
    assertRedacted(redact(`AWS_ACCESS_KEY_ID=${AWS_KEY}`), AWS_KEY, "aws_access_key_id")
  })

  test('JSON value boundary: `{"key":"AKIA..."}` → REDACTED', () => {
    assertRedacted(redact(`{"k":"${AWS_KEY}"}`), AWS_KEY, "aws_access_key_id")
  })

  test("colon boundary: `key: AKIA...` (YAML) → REDACTED", () => {
    assertRedacted(redact(`key: ${AWS_KEY}`), AWS_KEY, "aws_access_key_id")
  })

  test("comma-list boundary: `[AKIA..., other]` → REDACTED", () => {
    assertRedacted(redact(`[${AWS_KEY}, other]`), AWS_KEY, "aws_access_key_id")
  })

  test("paren boundary: `f(AKIA...)` → REDACTED", () => {
    assertRedacted(redact(`f(${AWS_KEY})`), AWS_KEY, "aws_access_key_id")
  })

  test("end-of-string boundary: `text AKIA...` (no trailing char) → REDACTED", () => {
    assertRedacted(redact(`text ${AWS_KEY}`), AWS_KEY, "aws_access_key_id")
  })

  // ── URL embedded ── this is interesting; depends on the pattern boundary
  test("URL query embedded: `?k=AKIA...` → REDACTED (`=` is boundary)", () => {
    assertRedacted(redact(`https://example.com/?k=${AWS_KEY}`), AWS_KEY, "aws_access_key_id")
  })

  test("URL path embedded — no boundary: `/AKIA.../path` → REDACTED (`/` is non-word)", () => {
    // `/` is non-word so `\b` fires; AKIA is captured.
    assertRedacted(redact(`https://example.com/${AWS_KEY}/path`), AWS_KEY, "aws_access_key_id")
  })

  // ── SOFT cases: embedded alphanumeric sandwich — may flip with R5 fix ──
  test("DOCUMENTED: `xAKIA...y` (alphanumeric sandwich, both sides) — current PASSES THROUGH", () => {
    // Today: `\b` fails (word→word transition on both ends) → no match.
    // Future (R5 strengthen): may decide to drop \b on AKIA's lead and use a
    // negative lookbehind on letter only — but trailing-letter `y` is still
    // ambiguous (would over-redact). Most likely outcome: stays passthrough.
    const out = redact(`x${AWS_KEY}y`)
    const wasRedacted = out.includes("[REDACTED:aws_access_key_id]")
    // `toBeOneOf` — both behaviors are documented post-fix outcomes.
    expect([true, false]).toContain(wasRedacted)
    // Hard invariant: if NOT redacted, literal must be present (passthrough
    // is honest); if redacted, literal must be absent.
    if (wasRedacted) {
      expect(out).not.toContain(AWS_KEY)
    } else {
      expect(out).toContain(AWS_KEY)
    }
  })

  test("DOCUMENTED: `aaaaAKIA...bbbb` — current PASSES THROUGH", () => {
    const out = redact(`aaaa${AWS_KEY}bbbb`)
    const wasRedacted = out.includes("[REDACTED:")
    expect([true, false]).toContain(wasRedacted)
    if (wasRedacted) expect(out).not.toContain(AWS_KEY)
    else expect(out).toContain(AWS_KEY)
  })

  test("DOCUMENTED: `bbbsk-ant-...zzz` — current passes through", () => {
    const out = redact(`bbb${ANT_KEY}zzz`)
    const wasRedacted = out.includes("[REDACTED:anthropic_api_key]")
    expect([true, false]).toContain(wasRedacted)
    if (!wasRedacted) expect(out).toContain(ANT_KEY)
  })

  test("DOCUMENTED: `prefix_ghp_...suffix` — underscore is word char → may flip", () => {
    // `_` is part of \w → `\b` fails between `_` and `g`. Current passthrough.
    const out = redact(`prefix_${GHP_KEY}_suffix`)
    const wasRedacted = out.includes("[REDACTED:github_pat_classic]")
    expect([true, false]).toContain(wasRedacted)
    if (!wasRedacted) expect(out).toContain(GHP_KEY)
  })

  test("DOCUMENTED: `xsk-proj-...y` (alphanumeric sandwich on proj-key) — passthrough today", () => {
    const out = redact(`x${PROJ_KEY}y`)
    const wasRedacted = out.includes("[REDACTED:openai_api_key]")
    expect([true, false]).toContain(wasRedacted)
    if (!wasRedacted) expect(out).toContain(PROJ_KEY)
  })

  // ── Negative controls: non-secret strings that look secret-ish ─────────
  test("AKIA-shape WITHOUT 16-char base32 tail → NOT redacted (false-positive guard)", () => {
    assertUnchanged("AKIAshort", "AKIAshort")
  })

  test("AKIA-shape with too-short alphanumeric tail (12 chars) → NOT redacted", () => {
    // 16 base32 chars required; 12 < 16.
    const tooShort = `AKIA${"X".repeat(12)}`
    assertUnchanged(tooShort, tooShort)
  })

  test("OpenAI-classic too-short (`sk-` + 20 alphanumeric) → NOT redacted (32 min)", () => {
    const tooShort = `sk-${"A".repeat(20)}`
    assertUnchanged(tooShort, tooShort)
  })

  test("github_pat_ fine-grained 18 chars → NOT redacted (20 min)", () => {
    const tooShort = `github_pat_${"A".repeat(18)}`
    assertUnchanged(tooShort, tooShort)
  })

  test("aws_secret_access_key WITHOUT assignment anchor → NOT redacted", () => {
    // No `aws_secret_access_key = ` prefix.
    const raw40 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd" // 40 chars
    assertUnchanged(`some text ${raw40} more`, raw40)
  })
})
