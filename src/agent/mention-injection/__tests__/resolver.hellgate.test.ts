/**
 * ADR-0325 — Resolver hellgate.
 *
 *   A. Empty / boundary                          (2)
 *   B. Unknown target ⇒ skip                     (1)
 *   C. NO-THROW invariant (resolver throws)      (1)
 *   D. Kind dispatch hard isolation              (2)
 *   E. Mixed kind ordering                       (1)
 *   F. Partial-port safety (method absent)       (1)
 *
 * Total = 8 cases (matches the required 8).
 */

import { describe, expect, mock, test } from "bun:test"
import { buildInjectionFragments, type MentionResolverPort } from "../resolver"
import type { ParsedMention } from "../types"

const span = (start: number, end: number) => ({ start, end })

const SKILL_M: ParsedMention = {
  kind: "skill",
  target: "foo",
  span: span(0, 4),
  raw: "@foo",
}
const PLUGIN_M: ParsedMention = {
  kind: "plugin",
  target: "gh",
  span: span(10, 21),
  raw: "plugin://gh",
}
const APP_M: ParsedMention = {
  kind: "app",
  target: "chrome",
  span: span(30, 37),
  raw: "@@chrome",
}

const makeResolver = (overrides: Partial<MentionResolverPort> = {}): MentionResolverPort => ({
  resolveSkill: () => null,
  resolvePlugin: () => null,
  resolveApp: () => null,
  ...overrides,
})

describe("buildInjectionFragments — ADR-0325 hellgate", () => {
  // -------- A. empty / boundary --------------------------------------

  test("A1 — empty mentions ⇒ []", () => {
    expect(buildInjectionFragments([], makeResolver())).toEqual([])
  })

  test("A2 — resolver returns empty string body ⇒ fragment IS produced (not skipped)", () => {
    const out = buildInjectionFragments(
      [SKILL_M],
      makeResolver({ resolveSkill: () => ({ bodyText: "" }) }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.bodyText).toBe("")
  })

  // -------- B. unknown ⇒ skip ----------------------------------------

  test("B1 — resolver returns null ⇒ fragment skipped", () => {
    const out = buildInjectionFragments([SKILL_M], makeResolver({ resolveSkill: () => null }))
    expect(out).toEqual([])
  })

  // -------- C. NO-THROW invariant ------------------------------------

  test("C1 — resolver throws ⇒ swallow, treat as null, no escape", () => {
    const out = buildInjectionFragments(
      [SKILL_M],
      makeResolver({
        resolveSkill: () => {
          throw new Error("hostile registry")
        },
      }),
    )
    expect(out).toEqual([])
  })

  // -------- D. kind dispatch hard isolation --------------------------

  test("D1 — skill mention is NEVER routed to resolvePlugin / resolveApp", () => {
    const resolveSkill = mock(() => null)
    const resolvePlugin = mock(() => ({ bodyText: "plugin-wrong" }))
    const resolveApp = mock(() => ({ bodyText: "app-wrong" }))
    const out = buildInjectionFragments([SKILL_M], { resolveSkill, resolvePlugin, resolveApp })
    expect(out).toEqual([])
    expect(resolveSkill).toHaveBeenCalledTimes(1)
    expect(resolvePlugin).not.toHaveBeenCalled()
    expect(resolveApp).not.toHaveBeenCalled()
  })

  test("D2 — each of 3 kinds routes to the matching method exactly once", () => {
    const resolveSkill = mock(() => ({ bodyText: "S-body" }))
    const resolvePlugin = mock(() => ({ bodyText: "P-body" }))
    const resolveApp = mock(() => ({ bodyText: "A-body" }))
    const out = buildInjectionFragments([SKILL_M, PLUGIN_M, APP_M], {
      resolveSkill,
      resolvePlugin,
      resolveApp,
    })
    expect(out).toHaveLength(3)
    expect(out.map((f) => f.bodyText)).toEqual(["S-body", "P-body", "A-body"])
    expect(resolveSkill).toHaveBeenCalledTimes(1)
    expect(resolvePlugin).toHaveBeenCalledTimes(1)
    expect(resolveApp).toHaveBeenCalledTimes(1)
  })

  // -------- E. mixed kind ordering -----------------------------------

  test("E1 — output order matches input order of RESOLVED mentions (skipped ones drop out)", () => {
    const out = buildInjectionFragments(
      [SKILL_M, PLUGIN_M, APP_M],
      makeResolver({
        resolveSkill: () => ({ bodyText: "S" }),
        resolvePlugin: () => null, // skipped
        resolveApp: () => ({ bodyText: "A" }),
      }),
    )
    expect(out).toHaveLength(2)
    expect(out[0]?.kind).toBe("skill")
    expect(out[1]?.kind).toBe("app")
    // origin spans propagated unchanged
    expect(out[0]?.originSpan).toEqual(SKILL_M.span)
    expect(out[1]?.originSpan).toEqual(APP_M.span)
  })

  // -------- F. partial-port safety -----------------------------------

  test("F1 — resolver missing a method (undefined cast) ⇒ that kind is silently skipped", () => {
    // Build a partial port. We assert the cast is intentional via a comment.
    const partial = {
      resolveSkill: () => ({ bodyText: "S" }),
      // resolvePlugin missing entirely
      resolveApp: () => ({ bodyText: "A" }),
      // biome-ignore lint/suspicious/noExplicitAny: deliberate partial-port hostile shape
    } as any as MentionResolverPort

    const out = buildInjectionFragments([SKILL_M, PLUGIN_M, APP_M], partial)
    expect(out).toHaveLength(2)
    expect(out.map((f) => f.kind)).toEqual(["skill", "app"])
  })
})
