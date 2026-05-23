/**
 * Plan-exit lifecycle hellgate (ADR-0093 P6).
 *
 * Pins the pure-functional dispatch in `src/agent/plan-exit-lifecycle.ts`:
 * 3-way `PlanExitOutcome` × 3 `PlanStore` states (no plan / has plan /
 * has plan with todos) → `freeze` / `clear` / `preserve_with_feedback`.
 *
 * Hellgate invariants:
 *   - No heuristics. No text matching on feedback. Pure enum dispatch.
 *   - Closed 3-arm switch with `never` default — bogus decision throws.
 *   - `freeze`  ⇒ store UNTOUCHED (snapshot is by-value).
 *   - `clear`   ⇒ `store.current() === null` after; idempotent.
 *   - `preserve_with_feedback` ⇒ feedback exact-match preserved, empty
 *     string kept (not coerced), only `undefined` → `"(no feedback)"`.
 *   - Pure: same inputs → same outputs (deep-equal across repeated calls).
 *   - Snapshot taken BEFORE clear is not affected by clear.
 */

import { describe, expect, test } from "bun:test"
import { createInMemoryPlanStore, type PlanStore } from "../../../src/agent/plan/state"
import type { CreatePlanArgs } from "../../../src/agent/plan/types"
import { buildPlanExit, type PlanExitOutcome } from "../../../src/agent/plan-exit"
import {
  applyPlanExitOutcome,
  NO_FEEDBACK_SENTINEL,
  type PlanExitLifecycle,
} from "../../../src/agent/plan-exit-lifecycle"

// ── helpers ─────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000

const makeStore = (): PlanStore => {
  let n = 0
  return createInMemoryPlanStore({
    now: () => NOW,
    idGen: () => {
      n += 1
      return `t-${n}`
    },
  })
}

const seedPlan = (store: PlanStore, args?: Partial<CreatePlanArgs>): void => {
  const r = store.create({
    name: "seed",
    overview: "seeded plan",
    todos: [{ content: "A" }],
    ...(args ?? {}),
  })
  if (!r.ok) throw new Error(`seedPlan failed: ${JSON.stringify(r.error)}`)
}

const seedPlanWithTodos = (store: PlanStore): void => {
  seedPlan(store, {
    name: "with-todos",
    overview: "multi-todo plan",
    todos: [
      { content: "task-1" },
      { content: "task-2" },
      { content: "task-3", status: "in_progress" },
    ],
  })
}

// ── 3-way × 3-state matrix ──────────────────────────────────────────────

describe("applyPlanExitOutcome — approved", () => {
  test("approved + empty store → freeze with snapshot:null, store untouched", () => {
    const store = makeStore()
    const before = store.current()
    expect(before).toBeNull()

    const outcome = buildPlanExit({ decision: "approved" })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    expect(lifecycle).toEqual({ kind: "freeze", snapshot: null })
    // Store untouched: still null.
    expect(store.current()).toBeNull()
  })

  test("approved + store has plan → freeze with snapshot, store STILL has the plan", () => {
    const store = makeStore()
    seedPlan(store)
    const planBefore = store.current()
    expect(planBefore).not.toBeNull()

    const outcome = buildPlanExit({ decision: "approved" })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    expect(lifecycle.kind).toBe("freeze")
    if (lifecycle.kind !== "freeze") throw new Error("kind narrowing failed")
    expect(lifecycle.snapshot).not.toBeNull()
    expect(lifecycle.snapshot?.schema).toBe("plan-v1")
    expect(lifecycle.snapshot?.plan.name).toBe("seed")
    // Store STILL has the plan.
    expect(store.current()).not.toBeNull()
    expect(store.current()?.name).toBe("seed")
  })

  test("approved + plan with multiple todos → snapshot carries todos", () => {
    const store = makeStore()
    seedPlanWithTodos(store)

    const outcome = buildPlanExit({ decision: "approved" })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    expect(lifecycle.kind).toBe("freeze")
    if (lifecycle.kind !== "freeze") throw new Error("kind narrowing failed")
    expect(lifecycle.snapshot).not.toBeNull()
    const todoCount = Object.keys(lifecycle.snapshot?.plan.todos ?? {}).length
    expect(todoCount).toBe(3)
    // Store still owns the live plan.
    expect(Object.keys(store.current()?.todos ?? {}).length).toBe(3)
  })

  test("approved on store with versioned plan → snapshot captures current version", () => {
    const store = makeStore()
    seedPlan(store)
    const v0 = store.current()?.version
    expect(v0).toBe(0)

    const outcome = buildPlanExit({ decision: "approved" })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    if (lifecycle.kind !== "freeze") throw new Error("kind narrowing failed")
    expect(lifecycle.snapshot?.plan.version).toBe(0)
  })
})

describe("applyPlanExitOutcome — rejected", () => {
  test("rejected + empty store → clear (no-op effectively, still null)", () => {
    const store = makeStore()
    expect(store.current()).toBeNull()

    const outcome = buildPlanExit({ decision: "rejected" })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    expect(lifecycle).toEqual({ kind: "clear" })
    expect(store.current()).toBeNull()
  })

  test("rejected + store has plan → clear; store.current() === null", () => {
    const store = makeStore()
    seedPlan(store)
    expect(store.current()).not.toBeNull()

    const outcome = buildPlanExit({ decision: "rejected" })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    expect(lifecycle).toEqual({ kind: "clear" })
    expect(store.current()).toBeNull()
  })

  test("rejected + plan with todos → all todos dropped via clear", () => {
    const store = makeStore()
    seedPlanWithTodos(store)
    expect(Object.keys(store.current()?.todos ?? {}).length).toBe(3)

    const outcome = buildPlanExit({ decision: "rejected" })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    expect(lifecycle.kind).toBe("clear")
    expect(store.current()).toBeNull()
  })

  test("rejected emits no delta during clear", () => {
    let deltaCount = 0
    let n = 0
    const store = createInMemoryPlanStore({
      now: () => NOW,
      idGen: () => {
        n += 1
        return `t-${n}`
      },
      onDelta: () => {
        deltaCount += 1
      },
    })
    // Seed bumps delta once (plan_created).
    store.create({ name: "p", overview: "o", todos: [{ content: "A" }] })
    expect(deltaCount).toBe(1)

    const outcome = buildPlanExit({ decision: "rejected" })
    applyPlanExitOutcome(outcome, store)
    // clear() does NOT emit.
    expect(deltaCount).toBe(1)
    expect(store.current()).toBeNull()
  })

  test("rejected then create() — fresh plan starts at v0", () => {
    const store = makeStore()
    seedPlan(store)

    applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), store)
    expect(store.current()).toBeNull()

    const r = store.create({
      name: "reborn",
      overview: "after clear",
      todos: [{ content: "fresh" }],
    })
    expect(r.ok).toBe(true)
    expect(store.current()?.version).toBe(0)
    expect(store.current()?.name).toBe("reborn")
  })
})

describe("applyPlanExitOutcome — changes_requested", () => {
  test("changes_requested + feedback present → preserve_with_feedback with exact string", () => {
    const store = makeStore()
    seedPlan(store)

    const outcome = buildPlanExit({
      decision: "changes_requested",
      feedback: "please add a verify step",
    })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    expect(lifecycle).toEqual({
      kind: "preserve_with_feedback",
      feedback: "please add a verify step",
    })
    // Plan preserved.
    expect(store.current()).not.toBeNull()
    expect(store.current()?.name).toBe("seed")
  })

  test("changes_requested + feedback with whitespace edges → exact preservation", () => {
    const store = makeStore()
    seedPlan(store)

    // buildPlanExit enforces non-empty-trimmed but does NOT trim the string.
    const outcome = buildPlanExit({
      decision: "changes_requested",
      feedback: "  needs more detail  ",
    })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    if (lifecycle.kind !== "preserve_with_feedback") {
      throw new Error("kind narrowing failed")
    }
    expect(lifecycle.feedback).toBe("  needs more detail  ")
  })

  test("changes_requested + multiline feedback → exact preservation", () => {
    const store = makeStore()
    seedPlan(store)

    const multiline = "line one\nline two\nline three"
    const outcome = buildPlanExit({ decision: "changes_requested", feedback: multiline })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    if (lifecycle.kind !== "preserve_with_feedback") throw new Error("kind narrowing failed")
    expect(lifecycle.feedback).toBe(multiline)
  })

  test("changes_requested + unicode feedback → exact preservation", () => {
    const store = makeStore()
    seedPlan(store)

    const unicode = "한글 + emoji + 中文 + ñ"
    const outcome = buildPlanExit({ decision: "changes_requested", feedback: unicode })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    if (lifecycle.kind !== "preserve_with_feedback") throw new Error("kind narrowing failed")
    expect(lifecycle.feedback).toBe(unicode)
  })

  test("changes_requested + feedback undefined (forged outcome) → '(no feedback)' sentinel", () => {
    const store = makeStore()
    seedPlan(store)

    // buildPlanExit would reject this — but we test the router's defense in
    // depth against an out-of-band-constructed outcome. Cast to bypass TS.
    const forged: PlanExitOutcome = { decision: "changes_requested" } as PlanExitOutcome
    const lifecycle = applyPlanExitOutcome(forged, store)

    expect(lifecycle).toEqual({
      kind: "preserve_with_feedback",
      feedback: NO_FEEDBACK_SENTINEL,
    })
    expect(lifecycle).toEqual({
      kind: "preserve_with_feedback",
      feedback: "(no feedback)",
    })
    // Plan still preserved.
    expect(store.current()).not.toBeNull()
  })

  test("changes_requested + feedback empty string '' → preserved EXACT (not coerced)", () => {
    const store = makeStore()
    seedPlan(store)

    // buildPlanExit would reject "" — but test the router's exact-preservation
    // contract: only `undefined` substitutes the sentinel.
    const forged: PlanExitOutcome = {
      decision: "changes_requested",
      feedback: "",
    } as PlanExitOutcome
    const lifecycle = applyPlanExitOutcome(forged, store)

    expect(lifecycle).toEqual({ kind: "preserve_with_feedback", feedback: "" })
    // Critically: NOT the sentinel.
    if (lifecycle.kind !== "preserve_with_feedback") throw new Error("kind narrowing failed")
    expect(lifecycle.feedback).not.toBe(NO_FEEDBACK_SENTINEL)
  })

  test("changes_requested + empty store + feedback → still preserves (store stays empty)", () => {
    const store = makeStore()
    expect(store.current()).toBeNull()

    const outcome = buildPlanExit({
      decision: "changes_requested",
      feedback: "make a plan first",
    })
    const lifecycle = applyPlanExitOutcome(outcome, store)

    if (lifecycle.kind !== "preserve_with_feedback") throw new Error("kind narrowing failed")
    expect(lifecycle.feedback).toBe("make a plan first")
    // Empty store left empty (preserve = no mutation of any sort).
    expect(store.current()).toBeNull()
  })

  test("changes_requested + plan with todos → todos preserved", () => {
    const store = makeStore()
    seedPlanWithTodos(store)

    const outcome = buildPlanExit({
      decision: "changes_requested",
      feedback: "refine task-3",
    })
    applyPlanExitOutcome(outcome, store)

    // All 3 todos still there.
    expect(Object.keys(store.current()?.todos ?? {}).length).toBe(3)
  })

  test("changes_requested emits no delta (store untouched)", () => {
    let deltaCount = 0
    let n = 0
    const store = createInMemoryPlanStore({
      now: () => NOW,
      idGen: () => {
        n += 1
        return `t-${n}`
      },
      onDelta: () => {
        deltaCount += 1
      },
    })
    store.create({ name: "p", overview: "o", todos: [{ content: "A" }] })
    expect(deltaCount).toBe(1) // plan_created

    applyPlanExitOutcome(
      buildPlanExit({ decision: "changes_requested", feedback: "more please" }),
      store,
    )
    // No additional delta — store untouched.
    expect(deltaCount).toBe(1)
  })
})

// ── Closed-switch drift gate ────────────────────────────────────────────

describe("applyPlanExitOutcome — closed-switch drift gate", () => {
  test("bogus decision → throws (never arm catches forged outcome)", () => {
    const store = makeStore()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate type-bypass to exercise the `never` arm.
    const bogus = { decision: "bogus" as any } as PlanExitOutcome
    expect(() => applyPlanExitOutcome(bogus, store)).toThrow(/unreachable plan-exit decision/)
  })

  test("decision: null → throws via never arm", () => {
    const store = makeStore()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate type-bypass.
    const bogus = { decision: null as any } as PlanExitOutcome
    expect(() => applyPlanExitOutcome(bogus, store)).toThrow()
  })

  test("decision: undefined → throws via never arm", () => {
    const store = makeStore()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate type-bypass.
    const bogus = { decision: undefined as any } as PlanExitOutcome
    expect(() => applyPlanExitOutcome(bogus, store)).toThrow()
  })

  test("decision: number → throws via never arm", () => {
    const store = makeStore()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate type-bypass.
    const bogus = { decision: 42 as any } as PlanExitOutcome
    expect(() => applyPlanExitOutcome(bogus, store)).toThrow()
  })

  test("decision: empty string '' → throws via never arm", () => {
    const store = makeStore()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate type-bypass.
    const bogus = { decision: "" as any } as PlanExitOutcome
    expect(() => applyPlanExitOutcome(bogus, store)).toThrow()
  })
})

// ── Purity / determinism ────────────────────────────────────────────────

describe("applyPlanExitOutcome — pure function (same inputs → same outputs)", () => {
  test("approved on identical store state → identical lifecycle (deep-equal)", () => {
    const a = makeStore()
    seedPlan(a)
    const b = makeStore()
    seedPlan(b)

    const outcome = buildPlanExit({ decision: "approved" })
    const r1 = applyPlanExitOutcome(outcome, a)
    const r2 = applyPlanExitOutcome(outcome, b)

    // Both should be `freeze` with structurally-equal snapshots.
    expect(r1.kind).toBe(r2.kind)
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })

  test("rejected on identical store state → identical lifecycle", () => {
    const a = makeStore()
    seedPlan(a)
    const b = makeStore()
    seedPlan(b)

    const outcome = buildPlanExit({ decision: "rejected" })
    const r1 = applyPlanExitOutcome(outcome, a)
    const r2 = applyPlanExitOutcome(outcome, b)

    expect(r1).toEqual(r2)
    expect(r1).toEqual({ kind: "clear" })
  })

  test("changes_requested → identical preserve_with_feedback", () => {
    const a = makeStore()
    seedPlan(a)
    const b = makeStore()
    seedPlan(b)

    const outcome = buildPlanExit({ decision: "changes_requested", feedback: "fix x" })
    const r1 = applyPlanExitOutcome(outcome, a)
    const r2 = applyPlanExitOutcome(outcome, b)

    expect(r1).toEqual(r2)
    expect(r1).toEqual({ kind: "preserve_with_feedback", feedback: "fix x" })
  })

  test("approved + no plan twice → both null snapshots", () => {
    const a = makeStore()
    const b = makeStore()

    const r1 = applyPlanExitOutcome(buildPlanExit({ decision: "approved" }), a)
    const r2 = applyPlanExitOutcome(buildPlanExit({ decision: "approved" }), b)

    expect(r1).toEqual({ kind: "freeze", snapshot: null })
    expect(r2).toEqual({ kind: "freeze", snapshot: null })
  })

  test("rejected twice on same store → second is idempotent no-op", () => {
    const store = makeStore()
    seedPlan(store)

    const r1 = applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), store)
    expect(store.current()).toBeNull()
    const r2 = applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), store)
    expect(store.current()).toBeNull()

    expect(r1).toEqual({ kind: "clear" })
    expect(r2).toEqual({ kind: "clear" })
  })
})

// ── Snapshot is by-value (not affected by later clear) ───────────────────

describe("applyPlanExitOutcome — snapshot by-value (held snapshot survives clear)", () => {
  test("approved snapshot held outside store → unaffected by subsequent store.clear()", () => {
    const store = makeStore()
    seedPlanWithTodos(store)

    const lifecycle = applyPlanExitOutcome(buildPlanExit({ decision: "approved" }), store)
    if (lifecycle.kind !== "freeze") throw new Error("kind narrowing failed")
    const heldSnapshot = lifecycle.snapshot

    expect(heldSnapshot).not.toBeNull()
    const todoCountBefore = Object.keys(heldSnapshot?.plan.todos ?? {}).length
    expect(todoCountBefore).toBe(3)

    // Now clear the store.
    store.clear()
    expect(store.current()).toBeNull()

    // Held snapshot is by-value: still has the 3 todos.
    expect(heldSnapshot).not.toBeNull()
    expect(Object.keys(heldSnapshot?.plan.todos ?? {}).length).toBe(3)
    expect(heldSnapshot?.plan.name).toBe("with-todos")
  })

  test("snapshot from rejected path is impossible — rejected returns kind:'clear' (no snapshot)", () => {
    const store = makeStore()
    seedPlan(store)

    const lifecycle = applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), store)
    // Shape guarantee: no `snapshot` field on the clear arm.
    expect(lifecycle).toEqual({ kind: "clear" })
    expect("snapshot" in lifecycle).toBe(false)
  })

  test("approved snapshot survives a subsequent rejected lifecycle on same store", () => {
    const store = makeStore()
    seedPlanWithTodos(store)

    const r1 = applyPlanExitOutcome(buildPlanExit({ decision: "approved" }), store)
    if (r1.kind !== "freeze") throw new Error("kind narrowing failed")
    const held = r1.snapshot

    // Now reject — clears the store.
    const r2 = applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), store)
    expect(r2.kind).toBe("clear")
    expect(store.current()).toBeNull()

    // Held snapshot from approval is intact.
    expect(held).not.toBeNull()
    expect(Object.keys(held?.plan.todos ?? {}).length).toBe(3)
  })
})

// ── Type / shape sanity ─────────────────────────────────────────────────

describe("applyPlanExitOutcome — PlanExitLifecycle closed union shape", () => {
  test("freeze arm has exactly { kind, snapshot } keys", () => {
    const store = makeStore()
    seedPlan(store)
    const lifecycle = applyPlanExitOutcome(buildPlanExit({ decision: "approved" }), store)
    const keys = Object.keys(lifecycle).sort()
    expect(keys).toEqual(["kind", "snapshot"])
  })

  test("clear arm has exactly { kind } key", () => {
    const store = makeStore()
    seedPlan(store)
    const lifecycle = applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), store)
    const keys = Object.keys(lifecycle).sort()
    expect(keys).toEqual(["kind"])
  })

  test("preserve_with_feedback arm has exactly { feedback, kind } keys", () => {
    const store = makeStore()
    seedPlan(store)
    const lifecycle = applyPlanExitOutcome(
      buildPlanExit({ decision: "changes_requested", feedback: "more" }),
      store,
    )
    const keys = Object.keys(lifecycle).sort()
    expect(keys).toEqual(["feedback", "kind"])
  })

  test("PlanExitLifecycle kinds are exactly the 3 expected literals", () => {
    // Compile-time exhaustiveness mirror at runtime: every arm's kind
    // must be one of these 3 literals.
    const store = makeStore()
    seedPlan(store)
    const expected = new Set(["freeze", "clear", "preserve_with_feedback"])
    const r1 = applyPlanExitOutcome(buildPlanExit({ decision: "approved" }), store)
    expect(expected.has(r1.kind)).toBe(true)

    seedPlan(makeStore()) // reset isn't needed; just sanity
    const store2 = makeStore()
    seedPlan(store2)
    const r2 = applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), store2)
    expect(expected.has(r2.kind)).toBe(true)

    const store3 = makeStore()
    seedPlan(store3)
    const r3 = applyPlanExitOutcome(
      buildPlanExit({ decision: "changes_requested", feedback: "x" }),
      store3,
    )
    expect(expected.has(r3.kind)).toBe(true)
  })

  test("NO_FEEDBACK_SENTINEL exported as exact literal", () => {
    const sentinel: "(no feedback)" = NO_FEEDBACK_SENTINEL
    expect(sentinel).toBe("(no feedback)")
  })
})

// ── Cross-arm: lifecycle results are independent of store identity ───────

describe("applyPlanExitOutcome — store identity independence", () => {
  test("calling on store-A does not leak to store-B", () => {
    const a = makeStore()
    const b = makeStore()
    seedPlan(a)
    seedPlan(b)

    applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), a)
    expect(a.current()).toBeNull()
    // B untouched.
    expect(b.current()).not.toBeNull()
    expect(b.current()?.name).toBe("seed")
  })

  test("freeze on store-A does not perturb store-B's plan version", () => {
    const a = makeStore()
    const b = makeStore()
    seedPlan(a)
    seedPlan(b)
    const bVersionBefore = b.current()?.version

    applyPlanExitOutcome(buildPlanExit({ decision: "approved" }), a)

    expect(b.current()?.version).toBe(bVersionBefore)
  })
})

// ── PlanExitLifecycle type-narrowing exhaustiveness ─────────────────────

describe("PlanExitLifecycle — exhaustive consumer pattern compiles", () => {
  test("consumer can pattern-match all 3 arms", () => {
    const consumer = (l: PlanExitLifecycle): string => {
      switch (l.kind) {
        case "freeze":
          return l.snapshot === null ? "freeze-empty" : `freeze:${l.snapshot.plan.name}`
        case "clear":
          return "clear"
        case "preserve_with_feedback":
          return `preserve:${l.feedback}`
        default: {
          const exhaustive: never = l
          return exhaustive
        }
      }
    }

    const store = makeStore()
    seedPlan(store)
    expect(consumer(applyPlanExitOutcome(buildPlanExit({ decision: "approved" }), store))).toBe(
      "freeze:seed",
    )

    const store2 = makeStore()
    seedPlan(store2)
    expect(consumer(applyPlanExitOutcome(buildPlanExit({ decision: "rejected" }), store2))).toBe(
      "clear",
    )

    const store3 = makeStore()
    seedPlan(store3)
    expect(
      consumer(
        applyPlanExitOutcome(
          buildPlanExit({ decision: "changes_requested", feedback: "fb" }),
          store3,
        ),
      ),
    ).toBe("preserve:fb")
  })
})
