/**
 * ★ HELLGATE — ADR-0320 typed-history event store default adapter.
 *
 * Each test pins a real contract assertion from `./port.ts` JSDoc and
 * fails if the in-memory impl drifts. Coverage:
 *   - empty snapshot returns []
 *   - append + snapshot preserves insertion order
 *   - `since(t)` is INCLUSIVE on the lower bound
 *   - `clear` returns the store to empty
 *   - each of the 6 variants round-trips byte-identical (5 ADR-0320 +
 *     compaction_event from ADR-0324)
 *   - `turnId` is optional (absent in snapshot when omitted)
 *   - large-N (10k) snapshot deep-equals the appended sequence
 *   - same-`at` events stay in insertion order
 *   - compaction_event: all 3 triggers + all 3 reasons round-trip
 *   - compaction_event: messagesRemoved=0 (trivial pass) accepted
 *   - compaction_event: tokensAfter > tokensBefore is NOT rejected by
 *     the store (producer responsibility, no `append`-side validation)
 *   - compaction_event: `turnId` optional (mirrors other variants)
 */

import { describe, expect, test } from "bun:test"
import {
  type CompactionEventVariant,
  type ContextUpdateEvent,
  createInMemoryTypedHistoryEventStore,
  type ModeChangeEvent,
  type ReasoningEchoEvent,
  type RepoRulesChangeEvent,
  type SkillActivationEvent,
  type TypedHistoryEvent,
} from ".."

describe("ADR-0320 typed-event in-memory store — hellgate", () => {
  test("empty snapshot returns an empty frozen array", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const snap = store.snapshot()
    expect(snap).toEqual([])
    expect(Object.isFrozen(snap)).toBe(true)
  })

  test("append + snapshot preserves insertion order", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const events: TypedHistoryEvent[] = [
      { kind: "mode_change", prev: "architect", next: "editor", at: 1 },
      { kind: "skill_activation", skillId: "git", trigger: "user", at: 2 },
      {
        kind: "context_update",
        field: "cwd",
        prev: "/a",
        next: "/b",
        at: 3,
      },
    ]
    for (const e of events) store.append(e)
    expect(store.snapshot()).toEqual(events)
  })

  test("`since(t)` is INCLUSIVE on the lower bound", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const a: ModeChangeEvent = { kind: "mode_change", prev: "x", next: "y", at: 10 }
    const b: ModeChangeEvent = { kind: "mode_change", prev: "y", next: "z", at: 20 }
    const c: ModeChangeEvent = { kind: "mode_change", prev: "z", next: "w", at: 30 }
    store.append(a)
    store.append(b)
    store.append(c)
    // boundary INCLUSIVE: events with at === 20 must be returned
    expect(store.since(20)).toEqual([b, c])
    expect(store.since(21)).toEqual([c])
    // since(0) returns everything
    expect(store.since(0)).toEqual([a, b, c])
    // since(future) returns []
    expect(store.since(999)).toEqual([])
  })

  test("`clear` returns the store to empty", () => {
    const store = createInMemoryTypedHistoryEventStore()
    store.append({ kind: "mode_change", prev: "a", next: "b", at: 1 })
    store.append({ kind: "mode_change", prev: "b", next: "c", at: 2 })
    expect(store.snapshot().length).toBe(2)
    store.clear()
    expect(store.snapshot()).toEqual([])
    expect(store.since(0)).toEqual([])
    // Post-clear appends start a fresh stream
    store.append({ kind: "mode_change", prev: "c", next: "d", at: 3 })
    expect(store.snapshot()).toEqual([{ kind: "mode_change", prev: "c", next: "d", at: 3 }])
  })

  test("each of the 6 variants round-trips byte-identical", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const ctx: ContextUpdateEvent = {
      kind: "context_update",
      field: "active_skills",
      prev: ["a"],
      next: ["a", "b"],
      at: 1,
      turnId: "t-1",
    }
    const skill: SkillActivationEvent = {
      kind: "skill_activation",
      skillId: "git",
      trigger: "auto",
      at: 2,
      turnId: "t-1",
    }
    const rules: RepoRulesChangeEvent = {
      kind: "repo_rules_change",
      addedPaths: ["/r/a"],
      removedPaths: ["/r/b"],
      at: 3,
      turnId: "t-2",
    }
    const mode: ModeChangeEvent = {
      kind: "mode_change",
      prev: "architect",
      next: "editor",
      reason: "user-toggle",
      at: 4,
      turnId: "t-3",
    }
    const reason: ReasoningEchoEvent = {
      kind: "reasoning_echo",
      signature: "sig-xyz",
      redacted: true,
      tokenCount: 42,
      at: 5,
      turnId: "t-3",
    }
    const compaction: CompactionEventVariant = {
      kind: "compaction_event",
      trigger: "mid_turn",
      reason: "context_limit",
      tokensBefore: 100_000,
      tokensAfter: 32_000,
      messagesRemoved: 47,
      at: 6,
      turnId: "t-3",
    }
    store.append(ctx)
    store.append(skill)
    store.append(rules)
    store.append(mode)
    store.append(reason)
    store.append(compaction)
    const snap = store.snapshot()
    expect(snap.length).toBe(6)
    expect(snap[0]).toEqual(ctx)
    expect(snap[1]).toEqual(skill)
    expect(snap[2]).toEqual(rules)
    expect(snap[3]).toEqual(mode)
    expect(snap[4]).toEqual(reason)
    expect(snap[5]).toEqual(compaction)
  })

  test("`turnId` is optional — absent in snapshot when omitted", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const withId: ModeChangeEvent = {
      kind: "mode_change",
      prev: "a",
      next: "b",
      at: 1,
      turnId: "t-1",
    }
    const withoutId: ModeChangeEvent = {
      kind: "mode_change",
      prev: "b",
      next: "c",
      at: 2,
    }
    store.append(withId)
    store.append(withoutId)
    const snap = store.snapshot()
    expect(snap[0]?.turnId).toBe("t-1")
    expect(snap[1]?.turnId).toBeUndefined()
    // The property key itself must not have been auto-introduced —
    // `exactOptionalPropertyTypes` is on, so we assert the produced
    // object literally lacks the key.
    expect(Object.hasOwn(snap[1] as object, "turnId")).toBe(false)
  })

  test("large-N (10k) snapshot deep-equals the appended sequence", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const N = 10_000
    const expected: TypedHistoryEvent[] = []
    for (let i = 0; i < N; i++) {
      const e: ModeChangeEvent = {
        kind: "mode_change",
        prev: `s-${i}`,
        next: `s-${i + 1}`,
        at: i,
      }
      store.append(e)
      expected.push(e)
    }
    const snap = store.snapshot()
    expect(snap.length).toBe(N)
    // Reference equality is NOT preserved (fresh frozen array each call) —
    // documented in `in-memory-store.ts`. Deep equality must hold.
    expect(snap).not.toBe(expected)
    expect(snap).toEqual(expected)
    // Last element sanity (cheap O(1) probe in case toEqual hides drift)
    expect(snap[N - 1]).toEqual(expected[N - 1] as TypedHistoryEvent)
  })

  test("same-`at` events stay in insertion order", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const a: ModeChangeEvent = { kind: "mode_change", prev: "x", next: "y", at: 100 }
    const b: SkillActivationEvent = {
      kind: "skill_activation",
      skillId: "s",
      trigger: "system",
      at: 100,
    }
    const c: ModeChangeEvent = { kind: "mode_change", prev: "y", next: "z", at: 100 }
    store.append(a)
    store.append(b)
    store.append(c)
    expect(store.snapshot()).toEqual([a, b, c])
    // since(100) must include all three (inclusive lower bound) in order
    expect(store.since(100)).toEqual([a, b, c])
  })

  // ----- ADR-0324 compaction_event variant hellgate -----

  test("compaction_event: all 3 trigger values round-trip", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const triggers: CompactionEventVariant["trigger"][] = [
      "pre_sampling",
      "mid_turn",
      "user_requested",
    ]
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i] as CompactionEventVariant["trigger"]
      store.append({
        kind: "compaction_event",
        trigger: t,
        reason: "context_limit",
        tokensBefore: 1000,
        tokensAfter: 500,
        messagesRemoved: 3,
        at: i,
      })
    }
    const snap = store.snapshot()
    expect(snap.length).toBe(3)
    expect((snap[0] as CompactionEventVariant).trigger).toBe("pre_sampling")
    expect((snap[1] as CompactionEventVariant).trigger).toBe("mid_turn")
    expect((snap[2] as CompactionEventVariant).trigger).toBe("user_requested")
  })

  test("compaction_event: all 3 reason values round-trip", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const reasons: CompactionEventVariant["reason"][] = ["context_limit", "token_budget", "manual"]
    for (let i = 0; i < reasons.length; i++) {
      const r = reasons[i] as CompactionEventVariant["reason"]
      store.append({
        kind: "compaction_event",
        trigger: "mid_turn",
        reason: r,
        tokensBefore: 2000,
        tokensAfter: 1000,
        messagesRemoved: 5,
        at: i,
      })
    }
    const snap = store.snapshot()
    expect(snap.length).toBe(3)
    expect((snap[0] as CompactionEventVariant).reason).toBe("context_limit")
    expect((snap[1] as CompactionEventVariant).reason).toBe("token_budget")
    expect((snap[2] as CompactionEventVariant).reason).toBe("manual")
  })

  test("compaction_event: messagesRemoved=0 (trivial pass) is accepted", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const trivial: CompactionEventVariant = {
      kind: "compaction_event",
      trigger: "pre_sampling",
      reason: "token_budget",
      tokensBefore: 8_000,
      tokensAfter: 8_000,
      messagesRemoved: 0,
      at: 1,
    }
    store.append(trivial)
    const snap = store.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]).toEqual(trivial)
    // The store contract (`port.ts:append`) is total: no validation,
    // no rejection. A trivial pass is still a real attempt — recording
    // it lets the model see the attempt occurred.
    expect((snap[0] as CompactionEventVariant).messagesRemoved).toBe(0)
  })

  test("compaction_event: tokensAfter > tokensBefore is NOT rejected by the store", () => {
    // Invariant `tokensAfter <= tokensBefore` is the PRODUCER's
    // responsibility — documented in `types.ts` JSDoc and in the
    // `port.ts:append` contract ("the event is stored verbatim; no
    // validation"). The store must accept the payload as-is. If a
    // future ADR adds a producer-side check, this test pins that the
    // check is NOT on the store boundary.
    const store = createInMemoryTypedHistoryEventStore()
    const invalid: CompactionEventVariant = {
      kind: "compaction_event",
      trigger: "manual" as never as CompactionEventVariant["trigger"], // intentional dummy — store doesn't validate
      reason: "manual",
      tokensBefore: 500,
      tokensAfter: 1_500, // intentionally larger
      messagesRemoved: 2,
      at: 1,
    }
    // We do the actual call with a valid trigger value so the type
    // checker stays happy AND the test still pins "store does not
    // reject" — replace the trigger with a valid one for the runtime
    // call.
    const payload: CompactionEventVariant = { ...invalid, trigger: "user_requested" }
    expect(() => store.append(payload)).not.toThrow()
    const snap = store.snapshot()
    expect(snap.length).toBe(1)
    expect((snap[0] as CompactionEventVariant).tokensAfter).toBe(1_500)
    expect((snap[0] as CompactionEventVariant).tokensBefore).toBe(500)
  })

  test("compaction_event: `turnId` is optional — absent when omitted", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const withId: CompactionEventVariant = {
      kind: "compaction_event",
      trigger: "mid_turn",
      reason: "context_limit",
      tokensBefore: 4_000,
      tokensAfter: 2_000,
      messagesRemoved: 10,
      at: 1,
      turnId: "t-7",
    }
    const withoutId: CompactionEventVariant = {
      kind: "compaction_event",
      trigger: "pre_sampling",
      reason: "token_budget",
      tokensBefore: 5_000,
      tokensAfter: 3_000,
      messagesRemoved: 6,
      at: 2,
    }
    store.append(withId)
    store.append(withoutId)
    const snap = store.snapshot()
    expect((snap[0] as CompactionEventVariant).turnId).toBe("t-7")
    expect((snap[1] as CompactionEventVariant).turnId).toBeUndefined()
    // `exactOptionalPropertyTypes` invariant: the property key must
    // not be auto-introduced when the producer omits it.
    expect(Object.hasOwn(snap[1] as object, "turnId")).toBe(false)
  })

  test("`snapshot()` is frozen — mutation attempts throw in strict mode", () => {
    const store = createInMemoryTypedHistoryEventStore()
    store.append({ kind: "mode_change", prev: "a", next: "b", at: 1 })
    const snap = store.snapshot()
    expect(Object.isFrozen(snap)).toBe(true)
    // The strict-mode shim ESM modules run under makes mutating a frozen
    // array throw a TypeError. Capture both shapes (throw OR silent no-op
    // under non-strict eval) so the test is robust on every runtime, but
    // the freeze itself is the load-bearing invariant.
    let threw = false
    try {
      ;(snap as TypedHistoryEvent[]).push({
        kind: "mode_change",
        prev: "x",
        next: "y",
        at: 2,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
