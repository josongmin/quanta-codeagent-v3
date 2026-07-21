/**
 * ADR-0332 — `installCodexR2Wires` hellgate.
 *
 * Coverage:
 *   A. Empty deps ⇒ cfg untouched (byte-identical)           (1)
 *   B. getSnapshot + store ⇒ contextEventsForTurn wired      (2)
 *   C. store alone ⇒ compactionEventEmit wired               (1)
 *   D. resolver ⇒ mentionInjector wired                      (2)
 *   E. cache + sessionId ⇒ both pair slots wired             (1)
 *   F. cache without sessionId ⇒ NEITHER pair slot wired     (1)
 *   G. imageSanitizationRetry ⇒ slot wired (ADR-0333 hookup
 *      is separate)                                          (1)
 *   H. caller-override precedence (slot already set ⇒ skip)  (2)
 *   I. idempotent (2× call same deps ⇒ same end state)       (1)
 *   J. NO-THROW (getSnapshot throws / frozen cfg)            (2)
 *
 *  Total ≥ 14 cases.
 */

import { describe, expect, test } from "bun:test"
import type { MentionResolverPort } from "@/agent/mention-injection"
import type { AgentConfig } from "@/agent/types"
import { createInMemorySystemPromptCache } from "@/llm/system-prompt-cache"
import { createInMemoryTypedHistoryEventStore } from "@/memory/typed-event"
import { installCodexR2Wires } from "../install"
import type { CodexR2WireDeps } from "../types"

const makeBareCfg = (): AgentConfig => {
  // Minimal AgentConfig surface — only the 6 wire slots matter for these
  // tests; the install helper only touches those slots. We cast through
  // unknown so we don't pull every legacy field into the fixture.
  return {} as unknown as AgentConfig
}

/** cfg fixture that captures `stream.emit` events so we can assert the
 *  ALBB-09 observability contract (a throwing producer surfaces ONE
 *  non-fatal `error` event) at the CLOSURE boundary. */
const makeStreamCapturingCfg = (): {
  cfg: AgentConfig
  events: Array<{ type: string; message?: string }>
} => {
  const events: Array<{ type: string; message?: string }> = []
  const cfg = {
    stream: { emit: (ev: { type: string; message?: string }) => events.push(ev) },
  } as unknown as AgentConfig
  return { cfg, events }
}

const makeSnapshot = (
  over: Partial<import("@/agent/context-change").TurnStateSnapshot> = {},
): import("@/agent/context-change").TurnStateSnapshot => ({
  cwd: over.cwd ?? "/repo",
  mode: over.mode ?? "default",
  model: over.model ?? "gpt-5",
  repoRulesPaths: over.repoRulesPaths ?? [],
  activeSkills: over.activeSkills ?? [],
})

const stubResolver: MentionResolverPort = {
  resolveSkill: async (target) => ({ bodyText: `skill:${target}` }),
  resolvePlugin: async () => null,
  resolveApp: async () => null,
}

describe("ADR-0332 §A — empty deps", () => {
  test("empty deps ⇒ cfg untouched (byte-identical)", () => {
    const cfg = makeBareCfg()
    const snap = JSON.stringify(cfg)
    installCodexR2Wires(cfg, {})
    expect(JSON.stringify(cfg)).toBe(snap)
    expect(cfg.contextEventsForTurn).toBeUndefined()
    expect(cfg.mentionInjector).toBeUndefined()
    expect(cfg.compactionEventEmit).toBeUndefined()
    expect(cfg.systemPromptCache).toBeUndefined()
    expect(cfg.systemPromptCacheKey).toBeUndefined()
    expect(cfg.imageSanitizationRetry).toBeUndefined()
  })
})

describe("ADR-0332 §B — context-events producer", () => {
  test("getSnapshot + store ⇒ producer wired; detector emits on diff", () => {
    const cfg = makeBareCfg()
    const store = createInMemoryTypedHistoryEventStore()
    let snap = makeSnapshot({ cwd: "/a" })
    const deps: CodexR2WireDeps = {
      sessionId: "s1",
      getSnapshot: () => snap,
      store,
    }
    installCodexR2Wires(cfg, deps)
    expect(cfg.contextEventsForTurn).toBeDefined()

    // First call: seed cursor (no diff).
    const turn1 = cfg.contextEventsForTurn?.() ?? []
    expect(turn1.length).toBe(0)

    // Mutate snapshot → second call detects cwd change.
    snap = makeSnapshot({ cwd: "/b" })
    const turn2 = cfg.contextEventsForTurn?.() ?? []
    expect(turn2.length).toBeGreaterThan(0)
    const found = turn2.find(
      (e): e is import("@/memory/typed-event").ContextUpdateEvent =>
        e.kind === "context_update" && e.field === "cwd",
    )
    expect(found).toBeDefined()
    expect(found?.next).toBe("/b")

    // Side-channel: same events landed on the store.
    expect(store.snapshot().length).toBeGreaterThan(0)
  })

  test("store alone (no getSnapshot) ⇒ contextEventsForTurn NOT wired", () => {
    const cfg = makeBareCfg()
    const store = createInMemoryTypedHistoryEventStore()
    installCodexR2Wires(cfg, { store })
    expect(cfg.contextEventsForTurn).toBeUndefined()
  })
})

describe("ADR-0332 §C — compaction-event emit", () => {
  test("store ⇒ compactionEventEmit wired (appends to same store)", () => {
    const cfg = makeBareCfg()
    const store = createInMemoryTypedHistoryEventStore()
    installCodexR2Wires(cfg, { store })
    expect(cfg.compactionEventEmit).toBeDefined()

    cfg.compactionEventEmit?.({
      kind: "compaction_event",
      reason: "token_budget",
      trigger: "pre_sampling",
      tokensBefore: 12_000,
      tokensAfter: 5_000,
      messagesRemoved: 8,
      at: 1_700_000_000_000,
    })
    const events = store.snapshot()
    expect(events.length).toBe(1)
    expect(events[0]?.kind).toBe("compaction_event")
  })

  test("stored compaction replays only when the explicit opt-in is set", () => {
    const store = createInMemoryTypedHistoryEventStore()
    store.append({
      kind: "compaction_event",
      reason: "token_budget",
      trigger: "pre_sampling",
      tokensBefore: 12_000,
      tokensAfter: 5_000,
      messagesRemoved: 8,
      at: 1_700_000_000_000,
    })
    const off = makeBareCfg()
    installCodexR2Wires(off, { store, getSnapshot: () => makeSnapshot() })
    expect(off.contextEventsForTurn?.()).toEqual([])

    const on = makeBareCfg()
    installCodexR2Wires(on, {
      store,
      getSnapshot: () => makeSnapshot(),
      replayStoredEvents: true,
    })
    expect(on.contextEventsForTurn?.().map((event) => event.kind)).toEqual(["compaction_event"])
  })

  test("stored compaction is not delayed behind unrelated shared-store events", () => {
    const store = createInMemoryTypedHistoryEventStore()
    for (let i = 0; i < 16; i++) {
      store.append({
        kind: "context_update",
        field: "cwd",
        prev: `/before-${i}`,
        next: `/after-${i}`,
        at: i,
      })
    }
    store.append({
      kind: "compaction_event",
      reason: "token_budget",
      trigger: "pre_sampling",
      tokensBefore: 12_000,
      tokensAfter: 3_000,
      messagesRemoved: 8,
      at: 17,
    })
    const cfg = makeBareCfg()
    installCodexR2Wires(cfg, {
      store,
      getSnapshot: () => makeSnapshot(),
      replayStoredEvents: true,
    })
    expect(cfg.contextEventsForTurn?.().map((event) => event.kind)).toEqual(["compaction_event"])
  })
})

describe("ADR-0332 §D — mention injector", () => {
  test("resolver ⇒ mentionInjector wired; parses + builds messages", async () => {
    const cfg = makeBareCfg()
    installCodexR2Wires(cfg, { mentionResolver: stubResolver })
    expect(cfg.mentionInjector).toBeDefined()

    const msgs = (await cfg.mentionInjector?.("hey @demo please")) ?? []
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.role).toBe("user")
  })

  test("resolver + store ⇒ mention skill events also land on store", async () => {
    const cfg = makeBareCfg()
    const store = createInMemoryTypedHistoryEventStore()
    installCodexR2Wires(cfg, { mentionResolver: stubResolver, store })
    await cfg.mentionInjector?.("hey @demo please")
    const events = store.snapshot()
    expect(events.length).toBe(1)
    expect(events[0]?.kind).toBe("skill_activation")
  })
})

describe("ADR-0332 §E — system-prompt cache pair", () => {
  test("cache + sessionId ⇒ both pair slots wired atomically", () => {
    const cfg = makeBareCfg()
    const cache = createInMemorySystemPromptCache()
    installCodexR2Wires(cfg, { systemPromptCache: cache, sessionId: "sess-1" })
    expect(cfg.systemPromptCache).toBe(cache)
    // The minted key is a branded string — compare via string coercion to
    // sidestep the brand without inventing a new key.
    expect(String(cfg.systemPromptCacheKey)).toBe("sess-1")
  })
})

describe("ADR-0332 §F — cache requires sessionId pair", () => {
  test("cache without sessionId ⇒ NEITHER slot wired", () => {
    const cfg = makeBareCfg()
    const cache = createInMemorySystemPromptCache()
    installCodexR2Wires(cfg, { systemPromptCache: cache })
    expect(cfg.systemPromptCache).toBeUndefined()
    expect(cfg.systemPromptCacheKey).toBeUndefined()
  })
})

describe("ADR-0332 §G — image-sanitization-retry slot", () => {
  test("imageSanitizationRetry ⇒ slot filled verbatim", () => {
    const cfg = makeBareCfg()
    installCodexR2Wires(cfg, {
      imageSanitizationRetry: { enabled: true, maxAttempts: 2, placeholder: "X" },
    })
    expect(cfg.imageSanitizationRetry).toEqual({
      enabled: true,
      maxAttempts: 2,
      placeholder: "X",
    })
  })
})

describe("ADR-0332 §H — caller-override precedence", () => {
  test("cfg.mentionInjector already set ⇒ install does NOT overwrite", () => {
    const cfg = makeBareCfg()
    const sentinel = async (_t: string) => []
    cfg.mentionInjector = sentinel
    installCodexR2Wires(cfg, { mentionResolver: stubResolver })
    expect(cfg.mentionInjector).toBe(sentinel)
  })

  test("cfg.compactionEventEmit already set ⇒ NOT overwritten", () => {
    const cfg = makeBareCfg()
    const sentinel = () => undefined
    cfg.compactionEventEmit = sentinel
    const store = createInMemoryTypedHistoryEventStore()
    installCodexR2Wires(cfg, { store })
    expect(cfg.compactionEventEmit).toBe(sentinel)
  })
})

describe("ADR-0332 §I — idempotent", () => {
  test("2× call with same deps ⇒ same end state (second call no-op)", () => {
    const cfg = makeBareCfg()
    const store = createInMemoryTypedHistoryEventStore()
    const cache = createInMemorySystemPromptCache()
    const snap = makeSnapshot()
    const deps: CodexR2WireDeps = {
      sessionId: "s1",
      getSnapshot: () => snap,
      store,
      mentionResolver: stubResolver,
      systemPromptCache: cache,
      imageSanitizationRetry: { enabled: true },
    }
    installCodexR2Wires(cfg, deps)
    const ce1 = cfg.contextEventsForTurn
    const mi1 = cfg.mentionInjector
    const cee1 = cfg.compactionEventEmit
    installCodexR2Wires(cfg, deps)
    expect(cfg.contextEventsForTurn).toBe(ce1)
    expect(cfg.mentionInjector).toBe(mi1)
    expect(cfg.compactionEventEmit).toBe(cee1)
    void snap // suppress "unused" — referenced in deps closure
  })
})

describe("ADR-0332 §J — NO-THROW", () => {
  test("getSnapshot throws ⇒ producer returns []; install still succeeds", () => {
    const cfg = makeBareCfg()
    const store = createInMemoryTypedHistoryEventStore()
    expect(() => {
      installCodexR2Wires(cfg, {
        sessionId: "s1",
        getSnapshot: () => {
          throw new Error("boom")
        },
        store,
      })
    }).not.toThrow()
    expect(cfg.contextEventsForTurn).toBeDefined()
    // Producer call also no-throw → empty array.
    const out = cfg.contextEventsForTurn?.() ?? null
    expect(out ?? []).toEqual([])
  })

  test("getSnapshot throws ⇒ producer surfaces EXACTLY-ONE non-fatal error event (ALBB-09 observability)", () => {
    // ALBB-09 intent: a throwing producer must NOT vanish silently. The fix
    // keeps the closure NO-THROW (§J above) yet still surfaces the failure once
    // through the injected `onError` seam (`stream.emit({type:"error"})`).
    const { cfg, events } = makeStreamCapturingCfg()
    const store = createInMemoryTypedHistoryEventStore()
    installCodexR2Wires(cfg, {
      sessionId: "s1",
      getSnapshot: () => {
        throw new Error("boom")
      },
      store,
    })
    // Call the raw closure directly (SEED first-turn path) — must not throw.
    let out: readonly unknown[] = []
    expect(() => {
      out = cfg.contextEventsForTurn?.() ?? []
    }).not.toThrow()
    expect(out).toEqual([])
    // EXACTLY one error event, and it names the failure (not silently swallowed).
    const errs = events.filter((e) => e.type === "error")
    expect(errs.length).toBe(1)
    expect(errs[0]?.message).toContain("boom")
  })

  test("SUCCESS path emits NO error event (byte-identical; emit only on throw)", () => {
    // Paired control: a healthy producer must NOT emit anything on the stream.
    const { cfg, events } = makeStreamCapturingCfg()
    const store = createInMemoryTypedHistoryEventStore()
    let snap = makeSnapshot({ cwd: "/a" })
    installCodexR2Wires(cfg, { sessionId: "s1", getSnapshot: () => snap, store })
    cfg.contextEventsForTurn?.() // seed
    snap = makeSnapshot({ cwd: "/b" })
    cfg.contextEventsForTurn?.() // diff
    expect(events.filter((e) => e.type === "error").length).toBe(0)
  })

  test("frozen cfg ⇒ install completes without throwing", () => {
    const cfg = Object.freeze(makeBareCfg()) as AgentConfig
    const store = createInMemoryTypedHistoryEventStore()
    expect(() => {
      installCodexR2Wires(cfg, { store, mentionResolver: stubResolver })
    }).not.toThrow()
    // Slots remain undefined — write was rejected by the freeze.
    expect(cfg.compactionEventEmit).toBeUndefined()
    expect(cfg.mentionInjector).toBeUndefined()
  })
})
