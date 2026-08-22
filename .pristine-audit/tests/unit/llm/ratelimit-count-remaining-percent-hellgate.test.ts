/**
 * jul-03 B3 BROADEN hellgate — count/limit-based provider remaining% parser.
 *
 * THE GAP THIS CLOSES: the provider rate-limit tap that arms the memory
 * write-guard only understood Codex `x-codex-*-used-percent` (a dual-window
 * PERCENTAGE). OpenAI (`x-ratelimit-remaining-{requests,tokens}` +
 * `x-ratelimit-limit-{requests,tokens}`) and Anthropic
 * (`anthropic-ratelimit-{requests,tokens}-remaining` +
 * `anthropic-ratelimit-{requests,tokens}-limit`) send RAW COUNTS with a paired
 * limit. With no percentage source for them, the tap stayed `undefined` and the
 * write-guard's provider arm fail-open FOREVER on those providers (provider-
 * partial guard). This parser derives remaining% = remaining/limit*100 per
 * window and takes the MIN (tightest window governs), so the guard is armed
 * across providers.
 *
 * NO-LEAK / NO invented number (project rule): a window contributes ONLY when
 * BOTH a well-formed remaining AND a well-formed positive limit are present.
 * Any garbage (missing pair, zero/negative limit, remaining>limit, non-finite)
 * ⇒ that window is skipped; no window ⇒ `undefined` (fail-open). Pure/leaf: no
 * clock, no env, no throw on a hostile getter.
 */

import { describe, expect, test } from "bun:test"
import { parseCountRemainingPercent } from "@/llm/ratelimit-snapshot"

const getter =
  (h: Record<string, string>) =>
  (name: string): string | null =>
    h[name.toLowerCase()] ?? null

describe("B3 broaden — count/limit ⇒ provider remaining% (OpenAI/Anthropic)", () => {
  test("OpenAI requests window: remaining 20 of limit 100 ⇒ 20%", () => {
    expect(
      parseCountRemainingPercent(
        getter({
          "x-ratelimit-remaining-requests": "20",
          "x-ratelimit-limit-requests": "100",
        }),
      ),
    ).toBe(20)
  })

  test("Anthropic tokens window: remaining 5000 of limit 10000 ⇒ 50%", () => {
    expect(
      parseCountRemainingPercent(
        getter({
          "anthropic-ratelimit-tokens-remaining": "5000",
          "anthropic-ratelimit-tokens-limit": "10000",
        }),
      ),
    ).toBe(50)
  })

  test("BOTH windows present ⇒ the TIGHTEST (min) governs", () => {
    // requests 90/100 = 90%, tokens 100/10000 = 1% ⇒ min = 1
    expect(
      parseCountRemainingPercent(
        getter({
          "x-ratelimit-remaining-requests": "90",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-tokens": "100",
          "x-ratelimit-limit-tokens": "10000",
        }),
      ),
    ).toBe(1)
  })

  test("Anthropic + OpenAI spellings both recognized for requests", () => {
    expect(
      parseCountRemainingPercent(
        getter({
          "anthropic-ratelimit-requests-remaining": "3",
          "anthropic-ratelimit-requests-limit": "12",
        }),
      ),
    ).toBe(25)
  })

  test("remaining present but NO paired limit ⇒ undefined (fail-open, no invented number)", () => {
    expect(
      parseCountRemainingPercent(getter({ "x-ratelimit-remaining-requests": "20" })),
    ).toBeUndefined()
  })

  test("limit present but NO remaining ⇒ undefined", () => {
    expect(
      parseCountRemainingPercent(getter({ "x-ratelimit-limit-requests": "100" })),
    ).toBeUndefined()
  })

  test("zero limit ⇒ skipped (no divide-by-zero, no fabricated 0/Infinity)", () => {
    expect(
      parseCountRemainingPercent(
        getter({
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-limit-requests": "0",
        }),
      ),
    ).toBeUndefined()
  })

  test("remaining exceeds limit (junk) — SOLE window ⇒ undefined (never fabricate >100)", () => {
    // Isolates the `remaining > limit` skip: the ONLY window is malformed
    // (150 > 100). Without the guard this would compute 150% and clamp to 100 —
    // a fabricated "full" reading. It must instead be skipped ⇒ undefined.
    expect(
      parseCountRemainingPercent(
        getter({
          "x-ratelimit-remaining-requests": "150",
          "x-ratelimit-limit-requests": "100",
        }),
      ),
    ).toBeUndefined()
  })

  test("remaining exceeds limit (junk) — OTHER window valid ⇒ the valid one governs", () => {
    // requests junk (150/100 skipped), tokens valid (10/100=10) ⇒ 10
    expect(
      parseCountRemainingPercent(
        getter({
          "x-ratelimit-remaining-requests": "150",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-tokens": "10",
          "x-ratelimit-limit-tokens": "100",
        }),
      ),
    ).toBe(10)
  })

  test("exhausted window: remaining 0 of limit 100 ⇒ 0 (a REAL zero, not skipped)", () => {
    expect(
      parseCountRemainingPercent(
        getter({
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-limit-requests": "100",
        }),
      ),
    ).toBe(0)
  })

  test("no recognized header ⇒ undefined (byte-identical no-snapshot)", () => {
    expect(parseCountRemainingPercent(getter({ "x-unrelated": "1" }))).toBeUndefined()
  })

  test("hostile getter (throws) ⇒ undefined, no throw", () => {
    const hostile = (): string => {
      throw new Error("boom")
    }
    expect(() => parseCountRemainingPercent(hostile)).not.toThrow()
    expect(parseCountRemainingPercent(hostile)).toBeUndefined()
  })

  test("non-finite / fractional limit ⇒ window skipped", () => {
    expect(
      parseCountRemainingPercent(
        getter({
          "x-ratelimit-remaining-requests": "5",
          "x-ratelimit-limit-requests": "not-a-number",
        }),
      ),
    ).toBeUndefined()
  })

  test("result is clamped into [0,100] band (defensive, remaining==limit ⇒ 100)", () => {
    expect(
      parseCountRemainingPercent(
        getter({
          "x-ratelimit-remaining-requests": "100",
          "x-ratelimit-limit-requests": "100",
        }),
      ),
    ).toBe(100)
  })
})
