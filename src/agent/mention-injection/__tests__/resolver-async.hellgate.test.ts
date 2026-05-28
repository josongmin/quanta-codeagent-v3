/**
 * ADR-0418 — async `buildInjectionFragments` parallelism + ordering hellgate.
 *
 *   A. parallel: total wall ≈ max(latency), not sum         (2)
 *   B. one resolver throws ⇒ that mention drops, rest stay  (2)
 *   C. one resolver rejects ⇒ same (drop, rest stay)        (1)
 *   D. one resolver hangs (slow) ⇒ others still in order    (1)
 *   E. output order == input order of RESOLVED mentions     (2)
 *   F. mixed kinds resolved concurrently, each once          (2)
 *   G. all-null ⇒ []                                         (1)
 *   H. single-mention degenerate path                        (1)
 *
 * Total = 12 cases. Complements resolver.hellgate (dispatch) and
 * resolver-file (file/symbol kind routing).
 */

import { describe, expect, mock, test } from "bun:test"
import { buildInjectionFragments, type MentionResolverPort } from "../resolver"
import type { ParsedMention } from "../types"

const M = (kind: ParsedMention["kind"], target: string, start: number): ParsedMention => ({
  kind,
  target,
  span: { start, end: start + target.length + 1 },
  raw: `@${target}`,
})

const SK = (t: string, s = 0) => M("skill", t, s)
const FI = (t: string, s = 0) => M("file", t, s)
const SY = (t: string, s = 0) => M("symbol", t, s)

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const port = (overrides: Partial<MentionResolverPort> = {}): MentionResolverPort => ({
  resolveSkill: async () => null,
  resolvePlugin: async () => null,
  resolveApp: async () => null,
  resolveFile: async () => null,
  resolveSymbol: async () => null,
  ...overrides,
})

describe("buildInjectionFragments async parallelism — ADR-0418 hellgate", () => {
  // -------- A. parallelism -------------------------------------------

  test("A1 — 3 skill mentions each ~40ms resolve in PARALLEL (< sum)", async () => {
    const mentions = [SK("a", 0), SK("b", 4), SK("c", 8)]
    const p = port({
      resolveSkill: async (t) => {
        await delay(40)
        return { bodyText: t }
      },
    })
    const t0 = Date.now()
    const out = await buildInjectionFragments(mentions, p)
    const elapsed = Date.now() - t0
    expect(out).toHaveLength(3)
    // serial would be ~120ms; parallel ≈ 40ms. Generous ceiling avoids flake.
    expect(elapsed).toBeLessThan(110)
  })

  test("A2 — all three resolver fns invoked (concurrent kinds)", async () => {
    const rs = mock(async () => ({ bodyText: "s" }))
    const rf = mock(async () => ({ bodyText: "f" }))
    const ry = mock(async () => ({ bodyText: "y" }))
    const out = await buildInjectionFragments(
      [SK("a", 0), FI("b/c.ts", 4), SY("Foo", 20)],
      port({ resolveSkill: rs, resolveFile: rf, resolveSymbol: ry }),
    )
    expect(out).toHaveLength(3)
    expect(rs).toHaveBeenCalledTimes(1)
    expect(rf).toHaveBeenCalledTimes(1)
    expect(ry).toHaveBeenCalledTimes(1)
  })

  // -------- B. one throws ⇒ drop, rest stay --------------------------

  test("B1 — middle resolver throws ⇒ that mention dropped, neighbours survive", async () => {
    const out = await buildInjectionFragments(
      [SK("a", 0), FI("b.ts", 4), SK("c", 12)],
      port({
        resolveSkill: async (t) => ({ bodyText: t }),
        resolveFile: async () => {
          throw new Error("fs boom")
        },
      }),
    )
    expect(out.map((f) => f.target)).toEqual(["a", "c"])
  })

  test("B2 — first resolver throws ⇒ does not abort the rest", async () => {
    const out = await buildInjectionFragments(
      [SY("Bad", 0), SK("ok", 6)],
      port({
        resolveSymbol: async () => {
          throw new Error("lsp boom")
        },
        resolveSkill: async (t) => ({ bodyText: t }),
      }),
    )
    expect(out.map((f) => f.target)).toEqual(["ok"])
  })

  // -------- C. one rejects -------------------------------------------

  test("C1 — a rejected promise drops only that mention", async () => {
    const out = await buildInjectionFragments(
      [SK("a", 0), SK("b", 4)],
      port({
        resolveSkill: async (t) => {
          if (t === "a") return Promise.reject(new Error("nope"))
          return { bodyText: t }
        },
      }),
    )
    expect(out.map((f) => f.target)).toEqual(["b"])
  })

  // -------- D. one hangs (resolves late) preserves order -------------

  test("D1 — slow first + fast second ⇒ OUTPUT order follows INPUT order", async () => {
    const out = await buildInjectionFragments(
      [SK("slow", 0), SK("fast", 5)],
      port({
        resolveSkill: async (t) => {
          await delay(t === "slow" ? 50 : 1)
          return { bodyText: t }
        },
      }),
    )
    // Even though "fast" finishes first, Promise.all keeps input index order.
    expect(out.map((f) => f.target)).toEqual(["slow", "fast"])
  })

  // -------- E. output order == input order of resolved ---------------

  test("E1 — skipped (null) mentions drop out, survivors keep order", async () => {
    const out = await buildInjectionFragments(
      [SK("a", 0), SK("skip", 4), SK("c", 12)],
      port({
        resolveSkill: async (t) => (t === "skip" ? null : { bodyText: t }),
      }),
    )
    expect(out.map((f) => f.target)).toEqual(["a", "c"])
  })

  test("E2 — originSpan propagated per surviving mention", async () => {
    const m1 = SK("a", 3)
    const m2 = FI("x.ts", 30)
    const out = await buildInjectionFragments(
      [m1, m2],
      port({
        resolveSkill: async () => ({ bodyText: "s" }),
        resolveFile: async () => ({ bodyText: "f" }),
      }),
    )
    expect(out[0]?.originSpan).toEqual(m1.span)
    expect(out[1]?.originSpan).toEqual(m2.span)
  })

  // -------- F. mixed kinds, exactly-once ------------------------------

  test("F1 — same target across skill+symbol resolves independently (no cross-call)", async () => {
    const rs = mock(async () => ({ bodyText: "skill-foo" }))
    const ry = mock(async () => ({ bodyText: "symbol-foo" }))
    const out = await buildInjectionFragments(
      [SK("foo", 0), SY("Foo", 6)],
      port({ resolveSkill: rs, resolveSymbol: ry }),
    )
    expect(out.map((f) => f.bodyText)).toEqual(["skill-foo", "symbol-foo"])
    expect(rs).toHaveBeenCalledTimes(1)
    expect(ry).toHaveBeenCalledTimes(1)
  })

  test("F2 — kind hard-dispatch: file mention never calls resolveSymbol", async () => {
    const ry = mock(async () => ({ bodyText: "WRONG" }))
    const out = await buildInjectionFragments(
      [FI("a/b.ts", 0)],
      port({ resolveFile: async () => ({ bodyText: "ok" }), resolveSymbol: ry }),
    )
    expect(out[0]?.bodyText).toBe("ok")
    expect(ry).not.toHaveBeenCalled()
  })

  // -------- G/H. degenerate -------------------------------------------

  test("G1 — all resolvers null ⇒ []", async () => {
    const out = await buildInjectionFragments([SK("a", 0), FI("b.ts", 4)], port())
    expect(out).toEqual([])
  })

  test("H1 — single resolvable mention ⇒ single fragment", async () => {
    const out = await buildInjectionFragments(
      [SK("only", 0)],
      port({ resolveSkill: async (t) => ({ bodyText: t }) }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.target).toBe("only")
  })
})
