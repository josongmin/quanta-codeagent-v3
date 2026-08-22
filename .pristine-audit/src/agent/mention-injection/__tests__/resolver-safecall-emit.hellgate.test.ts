/**
 * Per-mention resolution failure must be OBSERVABLE — hellgate.
 *
 * Sibling to the landed outer-wrapper fix (`resolveMentionInjectionMessages`
 * emits a non-fatal `error` event on throw). The INNER per-mention path
 * inside `buildInjectionFragments` catches FIRST in `safeCall`, so the outer
 * wrapper never sees a single `@file`/`@skill`/`@symbol` reference that
 * failed to resolve — it silently vanishes, indistinguishable from "no
 * mentions". Before this fix `safeCall` only `logger.warn`-ed with ZERO
 * operator-visible stream signal.
 *
 * The fix threads an OPTIONAL error-sink (`onResolveError`) from
 * `buildInjectionFragments` → `resolveOne` → `safeCall`. On a per-mention
 * throw / reject the sink is invoked with `{ kind, target, message }` while
 * the mention STILL resolves to `null` (no throw escapes, neighbours
 * survive, the `logger.warn` stays).
 *
 *   RED-anchor A. failing mention ⇒ sink called once, still returns null   (2)
 *   B. success path ⇒ sink NEVER called (byte-identical)                    (2)
 *   C. rejected promise (not throw) ⇒ sink still fires                      (1)
 *   D. multiple failing mentions ⇒ each surfaces exactly once               (2)
 *   E. sink carries kind + target + message of the FAILING mention          (1)
 *   F. no sink supplied ⇒ no throw, identical drop behaviour (opt-in)        (1)
 *   G. a mention that resolves to null (NOT a throw) ⇒ sink NOT called       (1)
 *   H. throwing sink itself does NOT crash the pipeline                      (1)
 */

import { describe, expect, mock, test } from "bun:test"
import {
  buildInjectionFragments,
  type MentionResolutionError,
  type MentionResolverPort,
} from "../resolver"
import type { ParsedMention } from "../types"

const M = (kind: ParsedMention["kind"], target: string, start = 0): ParsedMention => ({
  kind,
  target,
  span: { start, end: start + target.length + 1 },
  raw: `@${target}`,
})

const SK = (t: string, s = 0) => M("skill", t, s)
const FI = (t: string, s = 0) => M("file", t, s)
const SY = (t: string, s = 0) => M("symbol", t, s)

const port = (overrides: Partial<MentionResolverPort> = {}): MentionResolverPort => ({
  resolveSkill: async () => null,
  resolvePlugin: async () => null,
  resolveApp: async () => null,
  resolveFile: async () => null,
  resolveSymbol: async () => null,
  ...overrides,
})

describe("safeCall per-mention failure is observable — hellgate", () => {
  // -------- A. failing mention ⇒ sink called + still null ----------------

  test("A1 — a throwing resolver surfaces ONE error via the sink", async () => {
    const errs: MentionResolutionError[] = []
    const out = await buildInjectionFragments(
      [FI("b.ts", 0)],
      port({
        resolveFile: async () => {
          throw new Error("fs boom")
        },
      }),
      (e) => errs.push(e),
    )
    // still degrades clean: the failed mention drops out (returns null)
    expect(out).toEqual([])
    // ...but is now OPERATOR-VISIBLE (was 0 before the fix — RED anchor)
    expect(errs).toHaveLength(1)
    expect(errs[0]?.message).toContain("fs boom")
  })

  test("A2 — failing mention drops but neighbours survive AND the failure surfaces", async () => {
    const errs: MentionResolutionError[] = []
    const out = await buildInjectionFragments(
      [SK("a", 0), FI("b.ts", 4), SK("c", 12)],
      port({
        resolveSkill: async (t) => ({ bodyText: t }),
        resolveFile: async () => {
          throw new Error("mid boom")
        },
      }),
      (e) => errs.push(e),
    )
    expect(out.map((f) => f.target)).toEqual(["a", "c"])
    expect(errs).toHaveLength(1)
    expect(errs[0]?.target).toBe("b.ts")
  })

  // -------- B. success path ⇒ sink NEVER called -------------------------

  test("B1 — all-resolvable ⇒ sink is NEVER invoked (byte-identical success path)", async () => {
    const sink = mock((_e: MentionResolutionError) => {})
    const out = await buildInjectionFragments(
      [SK("a", 0), FI("b.ts", 4)],
      port({
        resolveSkill: async (t) => ({ bodyText: t }),
        resolveFile: async (t) => ({ bodyText: t }),
      }),
      sink,
    )
    expect(out).toHaveLength(2)
    expect(sink).not.toHaveBeenCalled()
  })

  test("B2 — empty mentions ⇒ sink never invoked", async () => {
    const sink = mock((_e: MentionResolutionError) => {})
    const out = await buildInjectionFragments([], port(), sink)
    expect(out).toEqual([])
    expect(sink).not.toHaveBeenCalled()
  })

  // -------- C. rejected promise (not synchronous throw) ------------------

  test("C1 — a REJECTED promise also surfaces via the sink", async () => {
    const errs: MentionResolutionError[] = []
    const out = await buildInjectionFragments(
      [SY("Bad", 0)],
      port({ resolveSymbol: async () => Promise.reject(new Error("lsp reject")) }),
      (e) => errs.push(e),
    )
    expect(out).toEqual([])
    expect(errs).toHaveLength(1)
    expect(errs[0]?.message).toContain("lsp reject")
  })

  // -------- D. multiple failing mentions ⇒ each surfaces once ------------

  test("D1 — two failing mentions ⇒ sink fires exactly twice (no double / no drop)", async () => {
    const errs: MentionResolutionError[] = []
    const out = await buildInjectionFragments(
      [FI("x.ts", 0), SK("ok", 6), SY("Y", 10)],
      port({
        resolveFile: async () => {
          throw new Error("x boom")
        },
        resolveSkill: async (t) => ({ bodyText: t }),
        resolveSymbol: async () => {
          throw new Error("y boom")
        },
      }),
      (e) => errs.push(e),
    )
    expect(out.map((f) => f.target)).toEqual(["ok"])
    expect(errs).toHaveLength(2)
    expect(errs.map((e) => e.target).sort()).toEqual(["Y", "x.ts"])
  })

  // -------- E. sink carries structured kind + target + message ----------

  test("E1 — sink payload identifies the failing kind + target", async () => {
    const errs: MentionResolutionError[] = []
    await buildInjectionFragments(
      [FI("pkg/mod.ts", 3)],
      port({
        resolveFile: async () => {
          throw new Error("ENOENT")
        },
      }),
      (e) => errs.push(e),
    )
    expect(errs[0]?.kind).toBe("file")
    expect(errs[0]?.target).toBe("pkg/mod.ts")
    expect(errs[0]?.message).toContain("ENOENT")
  })

  // -------- F. no sink supplied ⇒ opt-in, byte-identical drop ------------

  test("F1 — omitting the sink keeps legacy drop behaviour with NO throw", async () => {
    // The out-of-fence caller does not yet pass a sink; behaviour must be
    // byte-identical to before the fix (mention drops, no throw escapes).
    const out = await buildInjectionFragments(
      [SK("a", 0), FI("b.ts", 4)],
      port({
        resolveSkill: async (t) => ({ bodyText: t }),
        resolveFile: async () => {
          throw new Error("boom")
        },
      }),
    )
    expect(out.map((f) => f.target)).toEqual(["a"])
  })

  // -------- G. a plain null (not a throw) is NOT an error ----------------

  test("G1 — a resolver returning null (unknown target) does NOT fire the sink", async () => {
    const sink = mock((_e: MentionResolutionError) => {})
    const out = await buildInjectionFragments(
      [SK("unknown", 0)],
      port({ resolveSkill: async () => null }),
      sink,
    )
    expect(out).toEqual([])
    // "unknown target / skip" is intentional and silent — only THROWS surface.
    expect(sink).not.toHaveBeenCalled()
  })

  // -------- H. a hostile sink cannot crash the pipeline -----------------

  test("H1 — a sink that itself throws does NOT abort resolution", async () => {
    const out = await buildInjectionFragments(
      [FI("b.ts", 0), SK("c", 6)],
      port({
        resolveFile: async () => {
          throw new Error("boom")
        },
        resolveSkill: async (t) => ({ bodyText: t }),
      }),
      () => {
        throw new Error("hostile sink")
      },
    )
    // the surviving neighbour is still returned; sink-throw is swallowed.
    expect(out.map((f) => f.target)).toEqual(["c"])
  })
})
