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
  resolveSkill: async () => null,
  resolvePlugin: async () => null,
  resolveApp: async () => null,
  ...overrides,
})

describe("buildInjectionFragments — ADR-0325/0418 async hellgate", () => {
  // -------- A. empty / boundary --------------------------------------

  test("A1 — empty mentions ⇒ []", async () => {
    expect(await buildInjectionFragments([], makeResolver())).toEqual([])
  })

  test("A2 — resolver returns empty string body ⇒ fragment IS produced (not skipped)", async () => {
    const out = await buildInjectionFragments(
      [SKILL_M],
      makeResolver({ resolveSkill: async () => ({ bodyText: "" }) }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.bodyText).toBe("")
  })

  // -------- B. unknown ⇒ skip ----------------------------------------

  test("B1 — resolver returns null ⇒ fragment skipped", async () => {
    const out = await buildInjectionFragments(
      [SKILL_M],
      makeResolver({ resolveSkill: async () => null }),
    )
    expect(out).toEqual([])
  })

  // -------- C. NO-THROW invariant ------------------------------------

  test("C1 — resolver throws ⇒ swallow, treat as null, no escape", async () => {
    const out = await buildInjectionFragments(
      [SKILL_M],
      makeResolver({
        resolveSkill: async () => {
          throw new Error("hostile registry")
        },
      }),
    )
    expect(out).toEqual([])
  })

  test("C2 — resolver REJECTS (async rejection) ⇒ swallow, no escape", async () => {
    const out = await buildInjectionFragments(
      [SKILL_M],
      makeResolver({ resolveSkill: () => Promise.reject(new Error("rejected")) }),
    )
    expect(out).toEqual([])
  })

  // -------- D. kind dispatch hard isolation --------------------------

  test("D1 — skill mention is NEVER routed to resolvePlugin / resolveApp", async () => {
    const resolveSkill = mock(async () => null)
    const resolvePlugin = mock(async () => ({ bodyText: "plugin-wrong" }))
    const resolveApp = mock(async () => ({ bodyText: "app-wrong" }))
    const out = await buildInjectionFragments([SKILL_M], {
      resolveSkill,
      resolvePlugin,
      resolveApp,
    })
    expect(out).toEqual([])
    expect(resolveSkill).toHaveBeenCalledTimes(1)
    expect(resolvePlugin).not.toHaveBeenCalled()
    expect(resolveApp).not.toHaveBeenCalled()
  })

  test("D2 — each of 3 kinds routes to the matching method exactly once", async () => {
    const resolveSkill = mock(async () => ({ bodyText: "S-body" }))
    const resolvePlugin = mock(async () => ({ bodyText: "P-body" }))
    const resolveApp = mock(async () => ({ bodyText: "A-body" }))
    const out = await buildInjectionFragments([SKILL_M, PLUGIN_M, APP_M], {
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

  test("E1 — output order matches input order of RESOLVED mentions (skipped ones drop out)", async () => {
    const out = await buildInjectionFragments(
      [SKILL_M, PLUGIN_M, APP_M],
      makeResolver({
        resolveSkill: async () => ({ bodyText: "S" }),
        resolvePlugin: async () => null, // skipped
        resolveApp: async () => ({ bodyText: "A" }),
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

  test("F1 — resolver missing a method (undefined cast) ⇒ that kind is silently skipped", async () => {
    // Build a partial port. We assert the cast is intentional via a comment.
    const partial = {
      resolveSkill: async () => ({ bodyText: "S" }),
      // resolvePlugin missing entirely
      resolveApp: async () => ({ bodyText: "A" }),
      // biome-ignore lint/suspicious/noExplicitAny: deliberate partial-port hostile shape
    } as any as MentionResolverPort

    const out = await buildInjectionFragments([SKILL_M, PLUGIN_M, APP_M], partial)
    expect(out).toHaveLength(2)
    expect(out.map((f) => f.kind)).toEqual(["skill", "app"])
  })
})
