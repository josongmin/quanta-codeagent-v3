/**
 * ADR-0325 / ADR-0418 — Mention parser hellgate (legacy 3-kind subset).
 *
 *   A. Empty / boundary                         (2)
 *   B. Sigil alternatives + dedup               (5)
 *   C. False positives (word boundary)          (4)
 *   D. Identifier alphabet / length             (3)
 *   E. Span correctness                         (2)
 *   F. Mixed input order preservation           (1)
 *
 * Total = 17 cases (>= the required 15). These prove the skill / plugin /
 * app classification is unchanged under ADR-0418's cascade for kebab /
 * plugin:// / @@ inputs. The file/symbol cascade is proven separately in
 * `parser-file-symbol.hellgate.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { parseMentions } from "../parser"

describe("parseMentions — ADR-0325 hellgate", () => {
  // -------- A. empty / boundary --------------------------------------

  test("A1 — empty input ⇒ []", () => {
    expect(parseMentions("")).toEqual([])
  })

  test("A2 — non-string input (NO-THROW invariant; type-cast through unknown)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile-input cast for NO-THROW invariant
    expect(parseMentions(null as any)).toEqual([])
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile-input cast for NO-THROW invariant
    expect(parseMentions(undefined as any)).toEqual([])
  })

  // -------- B. sigil alternatives + dedup ----------------------------

  test("B1 — single @skill mention", () => {
    const out = parseMentions("please run @code-review now")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("skill")
    expect(out[0]?.target).toBe("code-review")
    expect(out[0]?.raw).toBe("@code-review")
  })

  test("B2 — single plugin:// mention", () => {
    const out = parseMentions("use plugin://github please")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("plugin")
    expect(out[0]?.target).toBe("github")
    expect(out[0]?.raw).toBe("plugin://github")
  })

  test("B3 — single @@app mention", () => {
    const out = parseMentions("open @@chrome now")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("app")
    expect(out[0]?.target).toBe("chrome")
    expect(out[0]?.raw).toBe("@@chrome")
  })

  test("B4 — same mention twice ⇒ dedup, FIRST span preserved", () => {
    const text = "@foo and again @foo"
    const out = parseMentions(text)
    expect(out).toHaveLength(1)
    expect(out[0]?.target).toBe("foo")
    expect(out[0]?.span.start).toBe(0)
    expect(out[0]?.span.end).toBe(4)
  })

  test("B5 — three kinds mixed in one input", () => {
    const out = parseMentions("@code-review plugin://gh and @@browser")
    expect(out).toHaveLength(3)
    expect(out.map((m) => m.kind)).toEqual(["skill", "plugin", "app"])
    expect(out.map((m) => m.target)).toEqual(["code-review", "gh", "browser"])
  })

  // -------- C. false positives (word boundary) -----------------------

  test("C1 — email-shaped `foo@bar.com` is NOT a skill mention", () => {
    expect(parseMentions("ping foo@bar.com please")).toEqual([])
  })

  test("C2 — word-internal `hello@skill` is NOT a mention", () => {
    expect(parseMentions("hello@skill rest")).toEqual([])
  })

  test("C3 — `plugin://` with empty target is NOT a mention", () => {
    expect(parseMentions("see plugin:// for help")).toEqual([])
  })

  test("C4 — bare `@` or `@@` with nothing after is NOT a mention", () => {
    expect(parseMentions("@ and @@ alone")).toEqual([])
  })

  // -------- D. identifier alphabet / length --------------------------

  test("D1 — number-leading identifier is NOT a mention (`@123abc`)", () => {
    expect(parseMentions("see @123abc")).toEqual([])
  })

  test("D2 — uppercase identifier is NOT a SKILL (ADR-0418: routes to symbol)", () => {
    // Under the ADR-0418 cascade, an uppercase-leading `@<rest>` is a
    // SYMBOL, not a skill. `@Code-Review` ⇒ symbol `Code` (the `-` is not
    // in the symbol alphabet, so it stops there). The KEY invariant for
    // THIS legacy-subset suite is: it is NOT a `skill`.
    const out = parseMentions("@Code-Review")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.kind).not.toBe("skill")
    expect(out[0]?.target).toBe("Code")
  })

  test("D3 — identifier > 64 chars is rejected", () => {
    const long = "a".repeat(65)
    expect(parseMentions(`@${long}`)).toEqual([])
    // 64-char boundary still accepted
    const exactly64 = "a".repeat(64)
    expect(parseMentions(`@${exactly64}`)).toHaveLength(1)
  })

  // -------- E. span correctness --------------------------------------

  test("E1 — span.end - span.start === raw.length (invariant)", () => {
    const out = parseMentions("xx @skill-a yy plugin://p zz @@app-x")
    expect(out).toHaveLength(3)
    for (const m of out) {
      expect(m.span.end - m.span.start).toBe(m.raw.length)
    }
  })

  test("E2 — span.start points at the sigil, not the identifier", () => {
    const text = "hi @code-review here"
    const out = parseMentions(text)
    expect(out).toHaveLength(1)
    const first = out[0]
    expect(first).toBeDefined()
    if (first) {
      expect(text.slice(first.span.start, first.span.end)).toBe("@code-review")
    }
  })

  // -------- F. mixed input order preservation ------------------------

  test("F1 — three different mentions preserve textual order; 5x `@a` dedups to 1", () => {
    const text = "@a then @b then @a and @a more @a and @a"
    const out = parseMentions(text)
    expect(out.map((m) => m.target)).toEqual(["a", "b"])
    // first @a span at offset 0
    expect(out[0]?.span.start).toBe(0)
  })
})
