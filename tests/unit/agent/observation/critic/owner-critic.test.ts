/**
 * HELLGATE RED battery for the OwnerCritic refute logic (jul-6, Stream S1).
 * Design SSOT: docs/plans/jul-6-observation-providers/README.md §5.
 *
 * These tests pin the HARD invariants from the adversarial audit:
 *   - 3-WAY only; `not_refuted`/`inconclusive` assert NOTHING; only `refuted`
 *     carries a claim, and only when the engine can PROVE wrongness.
 *   - Static incompleteness (dynamic dispatch / reflection) ⇒ `inconclusive`,
 *     DOMINATING a would-be `refuted` (we cannot claim "no path" when a dynamic
 *     path may exist that the static engine cannot see).
 *   - Pure/deterministic leaf: same facts ⇒ same verdict, no IO.
 *
 * Test design: assert-then-narrow (every path first asserts the discriminant,
 * then the payload) + red-on-injection (a mutated mapping flips at least one
 * assertion). The deterministic `fakeRefuter` is the injection surface.
 */

import { describe, expect, test } from "bun:test"
import type { EditTarget, RefuteResult } from "@/agent/observation/critic"
import { makeOwnerCritic } from "@/agent/observation/critic/owner-critic"
import {
  type GraphFacts,
  makeFakeOwnerRefuter,
  type OwnerRefuter,
} from "@/agent/observation/critic/refuter"
import type { TaskContext } from "@/agent/observation/port"

const ctx = (): TaskContext => ({
  cwd: "/repo",
  issueText: "some issue",
  repoFiles: ["a.py", "b.py"],
})

const target = (file: string, symbol?: string): EditTarget =>
  symbol !== undefined ? { file, symbol } : { file }

/** Facts for a symbol the engine can PROVE never runs: reachable=false, no
 *  incompleteness ⇒ the engine has full visibility and sees no path. */
const unreachableFacts = (t: EditTarget): GraphFacts => ({
  target: t,
  reachableFromEntrypoints: false,
  shadowedByOverride: false,
  staticallyComplete: true,
})

/** Facts for a symbol shadowed by an override on the runtime path. */
const shadowedFacts = (t: EditTarget): GraphFacts => ({
  target: t,
  reachableFromEntrypoints: true,
  shadowedByOverride: true,
  shadowingSymbol: "Sub.method",
  staticallyComplete: true,
})

/** Facts where static analysis is INCOMPLETE (dynamic dispatch / reflection). */
const incompleteFacts = (t: EditTarget): GraphFacts => ({
  target: t,
  reachableFromEntrypoints: false,
  shadowedByOverride: false,
  staticallyComplete: false,
  incompletenessReasons: ["dynamic dispatch"],
})

/** Facts where the edited symbol is reached, no shadow, full visibility. */
const reachedFacts = (t: EditTarget): GraphFacts => ({
  target: t,
  reachableFromEntrypoints: true,
  shadowedByOverride: false,
  staticallyComplete: true,
})

const criticFrom = (facts: readonly GraphFacts[]) => makeOwnerCritic(makeFakeOwnerRefuter(facts))

describe("makeOwnerCritic — 3-way refute mapping", () => {
  test("PROVES-WRONG (no callgraph path) ⇒ refuted, and carries a reason", async () => {
    const t = target("dead.py", "neverCalled")
    const critic = criticFrom([unreachableFacts(t)])
    const r = await critic.refute(t, ctx())
    // assert-then-narrow: discriminant first.
    expect(r.verdict).toBe("refuted")
    if (r.verdict !== "refuted") throw new Error("unreachable")
    expect(r.reason.length).toBeGreaterThan(0)
    // The claim must be grounded in the proof (no callgraph path).
    expect(r.reason.toLowerCase()).toContain("no callgraph path")
  })

  test("PROVES-WRONG (override shadows the edited symbol) ⇒ refuted", async () => {
    const t = target("base.py", "Base.method")
    const critic = criticFrom([shadowedFacts(t)])
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("refuted")
    if (r.verdict !== "refuted") throw new Error("unreachable")
    expect(r.reason.toLowerCase()).toContain("override")
    // the shadowing symbol must be named in the claim (proof provenance)
    expect(r.reason).toContain("Sub.method")
  })

  test("static INCOMPLETENESS (dynamic dispatch) ⇒ inconclusive, NEVER refuted", async () => {
    const t = target("dyn.py", "handler")
    const critic = criticFrom([incompleteFacts(t)])
    const r = await critic.refute(t, ctx())
    // MUST NOT be refuted even though reachableFromEntrypoints=false — the engine
    // cannot SEE the dynamic path, so it cannot PROVE unreachability.
    expect(r.verdict).toBe("inconclusive")
    if (r.verdict !== "inconclusive") throw new Error("unreachable")
    expect(r.reason.toLowerCase()).toContain("dynamic dispatch")
  })

  test("reached-and-plausible, full visibility ⇒ not_refuted (NOT an endorsement)", async () => {
    const t = target("live.py", "prepare")
    const critic = criticFrom([reachedFacts(t)])
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("not_refuted")
  })
})

describe("HARD invariant — incompleteness DOMINATES a would-be refuted", () => {
  test("unreachable AND incomplete ⇒ inconclusive (proof of wrongness is void)", async () => {
    // reachable=false would be `refuted` in isolation, but incompleteness means
    // the "no path" fact is not a PROOF — a dynamic path may exist. Must NOT refute.
    const t = target("dead-but-dynamic.py", "handler")
    const facts: GraphFacts = {
      target: t,
      reachableFromEntrypoints: false,
      shadowedByOverride: false,
      staticallyComplete: false,
      incompletenessReasons: ["reflection"],
    }
    const critic = criticFrom([facts])
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("inconclusive")
    if (r.verdict !== "inconclusive") throw new Error("unreachable")
    expect(r.reason.toLowerCase()).toContain("reflection")
  })

  test("shadowed AND incomplete ⇒ inconclusive (override proof is void too)", async () => {
    const t = target("base-but-dynamic.py", "Base.method")
    const facts: GraphFacts = {
      target: t,
      reachableFromEntrypoints: true,
      shadowedByOverride: true,
      shadowingSymbol: "Sub.method",
      staticallyComplete: false,
      incompletenessReasons: ["dynamic dispatch"],
    }
    const critic = criticFrom([facts])
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("inconclusive")
  })
})

describe("HARD invariant — no facts ⇒ inconclusive, never refuted/not_refuted", () => {
  test("engine returns no facts for the target ⇒ inconclusive (no knowledge claimed)", async () => {
    // The critic asked about a symbol the engine has NO facts on. It must NOT
    // silently coerce to `not_refuted` (which could read as 'clean/endorsed') and
    // must NOT `refuted`. Absence of evidence is inconclusive.
    const t = target("unknown.py", "mystery")
    const critic = criticFrom([]) // fake has zero facts
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("inconclusive")
    if (r.verdict !== "inconclusive") throw new Error("unreachable")
    expect(r.reason.length).toBeGreaterThan(0)
  })
})

describe("structural gaps (self-audit) — no fabrication when a field is absent", () => {
  test("shadowed but shadowingSymbol absent ⇒ still refuted, reason invents no symbol name", async () => {
    const t = target("base.py", "Base.method")
    const critic = criticFrom([
      {
        target: t,
        reachableFromEntrypoints: true,
        shadowedByOverride: true,
        // shadowingSymbol intentionally omitted
        staticallyComplete: true,
      },
    ])
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("refuted")
    if (r.verdict !== "refuted") throw new Error("unreachable")
    // Must fall back to a generic phrase, NOT undefined / "undefined".
    expect(r.reason).toContain("override")
    expect(r.reason.toLowerCase()).not.toContain("undefined")
  })

  test("incomplete but incompletenessReasons absent ⇒ inconclusive with a generic detail (no empty parens)", async () => {
    const t = target("dyn.py", "handler")
    const critic = criticFrom([
      {
        target: t,
        reachableFromEntrypoints: false,
        shadowedByOverride: false,
        staticallyComplete: false,
        // incompletenessReasons intentionally omitted
      },
    ])
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("inconclusive")
    if (r.verdict !== "inconclusive") throw new Error("unreachable")
    expect(r.reason.toLowerCase()).toContain("incomplete")
    expect(r.reason).not.toContain("()")
  })
})

describe("determinism / purity", () => {
  test("same facts ⇒ same verdict across repeated calls", async () => {
    const t = target("dead.py", "neverCalled")
    const critic = criticFrom([unreachableFacts(t)])
    const a = await critic.refute(t, ctx())
    const b = await critic.refute(t, ctx())
    expect(a).toEqual(b)
  })

  test("verdict depends ONLY on facts, not on ctx contents", async () => {
    const t = target("dead.py", "neverCalled")
    const critic = criticFrom([unreachableFacts(t)])
    const a = await critic.refute(t, {
      cwd: "/x",
      issueText: "AAAA",
      repoFiles: [],
    })
    const b = await critic.refute(t, {
      cwd: "/y",
      issueText: "BBBB",
      repoFiles: ["z.py"],
      language: "python",
    })
    expect(a.verdict).toBe(b.verdict)
  })
})

describe("red-on-injection — every branch is load-bearing", () => {
  // A custom refuter lets us prove the critic reads EACH fact field. If the
  // mapping ignored a field, one of these would misclassify.
  const constRefuter = (facts: GraphFacts): OwnerRefuter => ({
    query: async () => facts,
  })

  test("flipping reachable false→true (complete, no shadow) moves refuted→not_refuted", async () => {
    const t = target("s.py", "f")
    const refutedCritic = makeOwnerCritic(
      constRefuter({
        target: t,
        reachableFromEntrypoints: false,
        shadowedByOverride: false,
        staticallyComplete: true,
      }),
    )
    const notRefutedCritic = makeOwnerCritic(
      constRefuter({
        target: t,
        reachableFromEntrypoints: true,
        shadowedByOverride: false,
        staticallyComplete: true,
      }),
    )
    expect((await refutedCritic.refute(t, ctx())).verdict).toBe("refuted")
    expect((await notRefutedCritic.refute(t, ctx())).verdict).toBe("not_refuted")
  })

  test("flipping staticallyComplete true→false moves refuted→inconclusive", async () => {
    const t = target("s.py", "f")
    const base = {
      target: t,
      reachableFromEntrypoints: false,
      shadowedByOverride: false,
    }
    const complete = makeOwnerCritic(constRefuter({ ...base, staticallyComplete: true }))
    const incomplete = makeOwnerCritic(
      constRefuter({
        ...base,
        staticallyComplete: false,
        incompletenessReasons: ["dynamic dispatch"],
      }),
    )
    expect((await complete.refute(t, ctx())).verdict).toBe("refuted")
    expect((await incomplete.refute(t, ctx())).verdict).toBe("inconclusive")
  })

  test("flipping shadowedByOverride false→true (reachable, complete) moves not_refuted→refuted", async () => {
    const t = target("s.py", "f")
    const notShadowed = makeOwnerCritic(
      constRefuter({
        target: t,
        reachableFromEntrypoints: true,
        shadowedByOverride: false,
        staticallyComplete: true,
      }),
    )
    const shadowed = makeOwnerCritic(
      constRefuter({
        target: t,
        reachableFromEntrypoints: true,
        shadowedByOverride: true,
        shadowingSymbol: "Sub.method",
        staticallyComplete: true,
      }),
    )
    expect((await notShadowed.refute(t, ctx())).verdict).toBe("not_refuted")
    expect((await shadowed.refute(t, ctx())).verdict).toBe("refuted")
  })
})

describe("overtrust guard — not_refuted / inconclusive never phrase as endorsement", () => {
  const endorsementWords = [
    "confirmed",
    "correct owner",
    "is the owner",
    "endorse",
    "verified owner",
  ]

  const assertNoEndorsement = (r: RefuteResult): void => {
    const reason = "reason" in r && r.reason !== undefined ? r.reason.toLowerCase() : ""
    for (const w of endorsementWords) {
      expect(reason).not.toContain(w)
    }
  }

  test("not_refuted reason (if present) does NOT read as an endorsement", async () => {
    const t = target("live.py", "prepare")
    const critic = criticFrom([reachedFacts(t)])
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("not_refuted")
    assertNoEndorsement(r)
  })

  test("inconclusive reason does NOT read as an endorsement", async () => {
    const t = target("dyn.py", "handler")
    const critic = criticFrom([incompleteFacts(t)])
    const r = await critic.refute(t, ctx())
    expect(r.verdict).toBe("inconclusive")
    assertNoEndorsement(r)
  })
})
