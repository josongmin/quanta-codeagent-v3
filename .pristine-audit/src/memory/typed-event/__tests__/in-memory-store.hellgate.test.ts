/**
 * ★ HELLGATE — ADR-0320 typed-history event store default adapter.
 *
 * Each test pins a real contract assertion from `./port.ts` JSDoc and
 * fails if the in-memory impl drifts. Coverage:
 *   - empty snapshot returns []
 *   - append + snapshot preserves insertion order
 *   - `since(t)` is INCLUSIVE on the lower bound
 *   - `clear` returns the store to empty
 *   - each of the 8 variants round-trips byte-identical (5 ADR-0320 +
 *     compaction_event from ADR-0324 + plugin_activation + app_activation
 *     from ADR-0335)
 *   - `turnId` is optional (absent in snapshot when omitted)
 *   - large-N (10k) snapshot deep-equals the appended sequence
 *   - same-`at` events stay in insertion order
 *   - compaction_event: all 3 triggers + all 3 reasons round-trip
 *   - compaction_event: messagesRemoved=0 (trivial pass) accepted
 *   - compaction_event: tokensAfter > tokensBefore is NOT rejected by
 *     the store (producer responsibility, no `append`-side validation)
 *   - compaction_event: `turnId` optional (mirrors other variants)
 *   - plugin_activation: 3 triggers × multi-capability round-trip
 *   - plugin_activation: empty capabilities array accepted
 *   - plugin_activation: empty pluginId accepted (validation = producer)
 *   - app_activation: 3 surfaces × 3 triggers round-trip (9 combos)
 *   - app_activation: empty appId accepted (validation = producer)
 *   - 8-variant union exhaustiveness (compile-time)
 *   - compaction_event: 4-reason set (context_limit / token_budget /
 *     manual / cadence) producer-emit verified
 */

import { describe, expect, test } from "bun:test"
import {
  type AppActivationEvent,
  type CompactionEventVariant,
  type ContextUpdateEvent,
  createInMemoryTypedHistoryEventStore,
  type ModeChangeEvent,
  type PluginActivationEvent,
  type ReasoningEchoEvent,
  type RepoRulesChangeEvent,
  type SkillActivationEvent,
  type TypedHistoryEvent,
  type TypedHistoryEventKind,
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

  test("each of the 8 variants round-trips byte-identical", () => {
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
    const plugin: PluginActivationEvent = {
      kind: "plugin_activation",
      pluginId: "git-tools",
      trigger: "user",
      capabilities: ["Interactive", "Read", "Write"],
      at: 7,
      turnId: "t-4",
    }
    const app: AppActivationEvent = {
      kind: "app_activation",
      appId: "browser",
      surface: "cli-browser",
      trigger: "auto",
      at: 8,
      turnId: "t-4",
    }
    store.append(ctx)
    store.append(skill)
    store.append(rules)
    store.append(mode)
    store.append(reason)
    store.append(compaction)
    store.append(plugin)
    store.append(app)
    const snap = store.snapshot()
    expect(snap.length).toBe(8)
    expect(snap[0]).toEqual(ctx)
    expect(snap[1]).toEqual(skill)
    expect(snap[2]).toEqual(rules)
    expect(snap[3]).toEqual(mode)
    expect(snap[4]).toEqual(reason)
    expect(snap[5]).toEqual(compaction)
    expect(snap[6]).toEqual(plugin)
    expect(snap[7]).toEqual(app)
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

  test("compaction_event: all 4 reason values round-trip", () => {
    const store = createInMemoryTypedHistoryEventStore()
    // jul-3 — `cadence` (tier-1 microcompaction, cadence-gated) joined the set.
    const reasons: CompactionEventVariant["reason"][] = [
      "context_limit",
      "token_budget",
      "manual",
      "cadence",
    ]
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
    expect(snap.length).toBe(4)
    expect((snap[0] as CompactionEventVariant).reason).toBe("context_limit")
    expect((snap[1] as CompactionEventVariant).reason).toBe("token_budget")
    expect((snap[2] as CompactionEventVariant).reason).toBe("manual")
    expect((snap[3] as CompactionEventVariant).reason).toBe("cadence")
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

  // ----- ADR-0335 plugin_activation variant hellgate -----

  test("plugin_activation: all 3 trigger values × multi-capability round-trip", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const triggers: PluginActivationEvent["trigger"][] = ["user", "auto", "system"]
    const caps: PluginActivationEvent["capabilities"] = ["Interactive", "Read", "Write"]
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i] as PluginActivationEvent["trigger"]
      store.append({
        kind: "plugin_activation",
        pluginId: `p-${i}`,
        trigger: t,
        capabilities: caps,
        at: i,
      })
    }
    const snap = store.snapshot()
    expect(snap.length).toBe(3)
    expect((snap[0] as PluginActivationEvent).trigger).toBe("user")
    expect((snap[1] as PluginActivationEvent).trigger).toBe("auto")
    expect((snap[2] as PluginActivationEvent).trigger).toBe("system")
    // capabilities round-trip exactly
    for (const e of snap) {
      expect((e as PluginActivationEvent).capabilities).toEqual(caps)
    }
  })

  test("plugin_activation: empty capabilities array is accepted", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const ev: PluginActivationEvent = {
      kind: "plugin_activation",
      pluginId: "empty-cap",
      trigger: "auto",
      capabilities: [],
      at: 1,
    }
    store.append(ev)
    const snap = store.snapshot()
    expect(snap.length).toBe(1)
    expect((snap[0] as PluginActivationEvent).capabilities).toEqual([])
    // The store contract is total: even a 0-capability discovery
    // emits — the model sees "a plugin was discovered" without
    // re-parsing the manifest.
    expect(snap[0]).toEqual(ev)
  })

  test("plugin_activation: empty pluginId accepted (producer-side validation)", () => {
    // Mirrors the compaction_event "store does not validate" invariant —
    // `port.ts:append` is total. A blank id is a producer bug, not a
    // store bug; recording it preserves the failure for triage.
    const store = createInMemoryTypedHistoryEventStore()
    const ev: PluginActivationEvent = {
      kind: "plugin_activation",
      pluginId: "",
      trigger: "system",
      capabilities: ["Read"],
      at: 1,
    }
    expect(() => store.append(ev)).not.toThrow()
    const snap = store.snapshot()
    expect((snap[0] as PluginActivationEvent).pluginId).toBe("")
  })

  test("plugin_activation: `turnId` is optional — absent when omitted", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const withId: PluginActivationEvent = {
      kind: "plugin_activation",
      pluginId: "with",
      trigger: "user",
      capabilities: ["Interactive"],
      at: 1,
      turnId: "t-10",
    }
    const withoutId: PluginActivationEvent = {
      kind: "plugin_activation",
      pluginId: "without",
      trigger: "user",
      capabilities: ["Interactive"],
      at: 2,
    }
    store.append(withId)
    store.append(withoutId)
    const snap = store.snapshot()
    expect((snap[0] as PluginActivationEvent).turnId).toBe("t-10")
    expect((snap[1] as PluginActivationEvent).turnId).toBeUndefined()
    expect(Object.hasOwn(snap[1] as object, "turnId")).toBe(false)
  })

  // ----- ADR-0335 app_activation variant hellgate -----

  test("app_activation: 3 surfaces × 3 triggers round-trip (9 combos)", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const surfaces: AppActivationEvent["surface"][] = ["cli", "web-tauri", "cli-browser"]
    const triggers: AppActivationEvent["trigger"][] = ["user", "auto", "system"]
    let i = 0
    for (const s of surfaces) {
      for (const t of triggers) {
        store.append({
          kind: "app_activation",
          appId: `app-${s}-${t}`,
          surface: s,
          trigger: t,
          at: i,
        })
        i++
      }
    }
    const snap = store.snapshot()
    expect(snap.length).toBe(9)
    // Verify every (surface, trigger) cell shows up exactly once.
    const seen = new Set<string>()
    for (const e of snap) {
      const a = e as AppActivationEvent
      seen.add(`${a.surface}/${a.trigger}`)
    }
    expect(seen.size).toBe(9)
    for (const s of surfaces) {
      for (const t of triggers) {
        expect(seen.has(`${s}/${t}`)).toBe(true)
      }
    }
  })

  test("app_activation: empty appId accepted (producer-side validation)", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const ev: AppActivationEvent = {
      kind: "app_activation",
      appId: "",
      surface: "web-tauri",
      trigger: "auto",
      at: 1,
    }
    expect(() => store.append(ev)).not.toThrow()
    const snap = store.snapshot()
    expect((snap[0] as AppActivationEvent).appId).toBe("")
  })

  test("app_activation: `turnId` is optional — absent when omitted", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const withId: AppActivationEvent = {
      kind: "app_activation",
      appId: "with",
      surface: "cli",
      trigger: "user",
      at: 1,
      turnId: "t-11",
    }
    const withoutId: AppActivationEvent = {
      kind: "app_activation",
      appId: "without",
      surface: "cli",
      trigger: "user",
      at: 2,
    }
    store.append(withId)
    store.append(withoutId)
    const snap = store.snapshot()
    expect((snap[0] as AppActivationEvent).turnId).toBe("t-11")
    expect((snap[1] as AppActivationEvent).turnId).toBeUndefined()
    expect(Object.hasOwn(snap[1] as object, "turnId")).toBe(false)
  })

  // ----- ADR-0335 union-level invariants -----

  test("8-variant union exhaustiveness (compile + runtime smoke)", () => {
    // If a future change drops a variant from the union, the `never`
    // arm below disappears at compile and the test fails to typecheck.
    const tags: TypedHistoryEventKind[] = [
      "context_update",
      "skill_activation",
      "repo_rules_change",
      "mode_change",
      "reasoning_echo",
      "compaction_event",
      "plugin_activation",
      "app_activation",
    ]
    for (const tag of tags) {
      switch (tag) {
        case "context_update":
        case "skill_activation":
        case "repo_rules_change":
        case "mode_change":
        case "reasoning_echo":
        case "compaction_event":
        case "plugin_activation":
        case "app_activation":
          break
        default: {
          const _never: never = tag
          throw new Error(`unreachable: ${String(_never)}`)
        }
      }
    }
    expect(tags.length).toBe(8)
  })

  test("compaction_event reason set: producer can emit all 3 reasons end-to-end", () => {
    // ADR-0335 confirms ADR-0324's `CompactionEventReason` already
    // carries all 3 values (`context_limit | token_budget | manual`).
    // No schema change in this ADR — the reason axis is producer
    // policy. This test pins the producer-emit contract: each reason
    // round-trips through the store unmodified.
    const store = createInMemoryTypedHistoryEventStore()
    const reasons: CompactionEventVariant["reason"][] = ["context_limit", "token_budget", "manual"]
    for (let i = 0; i < reasons.length; i++) {
      const r = reasons[i] as CompactionEventVariant["reason"]
      store.append({
        kind: "compaction_event",
        // pair each reason with a sensible producer-emit trigger so
        // the (reason, trigger) tuple reads as a real production path:
        //   context_limit ⇒ pre_sampling (provider ceiling)
        //   token_budget  ⇒ mid_turn     (breaker fired)
        //   manual        ⇒ user_requested (slash command)
        trigger:
          r === "context_limit"
            ? "pre_sampling"
            : r === "token_budget"
              ? "mid_turn"
              : "user_requested",
        reason: r,
        tokensBefore: 8_000,
        tokensAfter: 4_000,
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
