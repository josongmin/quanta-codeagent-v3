/**
 * ★ HELLGATE — P1 Phase 2 (jul-11): swap the live session onto an opened thread.
 *
 * The daemon hosts ONE live session. Opening a persisted thread hydrates the
 * live session FROM that thread's lossless SavedSession (Phase 1) via
 * transcript.replace, then repoints future persistence to it (Phase 1's mutable
 * activeThreadId). Reuses the kernel's `transcript_replace_unavailable` guard:
 * a mid-turn swap is REFUSED, leaving live state untouched. Unknown thread ⇒
 * clean no-op (never a crash).
 */
import { describe, expect, test } from "bun:test"
import { hydrateThreadIntoLiveSession } from "@/apps/web-daemon/server/thread-hydrate"
import type { Message } from "@/llm"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import {
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageAccountingPort,
  type UsageProvenance,
} from "@/observability/usage-accounting"
import type { SessionMeta } from "@/session"

const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] } as never]
const meta = (id: string): SessionMeta => ({
  id,
  title: id,
  cwd: "/repo",
  createdAt: 0,
  lastTouched: 0,
  archived: false,
})

const provenance = (sessionId: string): UsageProvenance => ({
  sessionId,
  agentId: "root",
  agentKind: "root",
  depth: 0,
})

const admit = (accounting: UsageAccountingPort, sessionId: string, tokens: number) => {
  const prov = provenance(sessionId)
  const usage = normalizeUsage({ model: "claude-sonnet-4-6", inputTokens: tokens, outputTokens: 0 })
  return accounting.record({
    callId: accounting.mintCallId(prov),
    at: 1,
    usage,
    cost: priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION }),
    provenance: prov,
  })
}

describe("HELLGATE P1 Phase 2 — swap live session onto a thread", () => {
  test("cancel, validate, transcript, persist, objective, rearm order is fixed", async () => {
    const order: string[] = []
    const out = await hydrateThreadIntoLiveSession("t-order", {
      loadThread: async () => ({ meta: meta("t-order"), messages: msgs }),
      cancelGoalWake: () => order.push("cancel"),
      prepareObjectiveAttach: () => {
        order.push("validate")
        return {
          commit: () => {
            order.push("objective")
            return true
          },
        }
      },
      replaceTranscript: async () => void order.push("transcript"),
      setActiveThreadId: () => void order.push("persist"),
      rearmGoalWake: () => order.push("rearm"),
    })
    expect(out.kind).toBe("hydrated")
    expect(order).toEqual(["cancel", "validate", "transcript", "persist", "objective", "rearm"])
  })

  test("invalid objective snapshot rejects before transcript or persistence mutation", async () => {
    const effects: string[] = []
    const out = await hydrateThreadIntoLiveSession("t-invalid", {
      loadThread: async () => ({ meta: meta("t-invalid"), messages: msgs }),
      prepareObjectiveAttach: () => null,
      replaceTranscript: async () => void effects.push("transcript"),
      setActiveThreadId: () => void effects.push("persist"),
    })
    expect(out).toEqual({ kind: "invalid-objective", threadId: "t-invalid" })
    expect(effects).toEqual([])
  })

  test("persisted thread: replaces transcript + repoints the persist id", async () => {
    const replaced: (readonly Message[])[] = []
    let active: string | null = null
    const activeThreadId = (): string | null => active
    const out = await hydrateThreadIntoLiveSession("t-abc", {
      loadThread: async (id) =>
        id === "t-abc" ? { meta: meta("t-abc"), messages: msgs } : undefined,
      replaceTranscript: async (m) => void replaced.push(m),
      setActiveThreadId: (id) => (active = id),
    })
    expect(out).toEqual({ kind: "hydrated", threadId: "t-abc", count: 1 })
    expect(replaced).toEqual([msgs])
    expect(activeThreadId()).toBe("t-abc")
  })

  test("hydrated thread switches usage books and rebinds them to the live daemon session", async () => {
    const live = createUsageAccounting()
    admit(live, "daemon-live", 1_000_000)
    const target = createUsageAccounting()
    admit(target, "old-daemon", 2_000_000)
    const out = await hydrateThreadIntoLiveSession("t-cost", {
      loadThread: async () => ({
        meta: meta("t-cost"),
        messages: msgs,
        usageAccounting: target.serialize(),
      }),
      replaceTranscript: async () => undefined,
      setActiveThreadId: () => undefined,
      prepareUsageAccountingAttach: (snapshot) => ({
        commit: () => {
          if (snapshot === undefined) live.reset()
          else live.hydrate(snapshot, { rebindSessionId: "daemon-live" })
          return true
        },
      }),
    })
    expect(out.kind).toBe("hydrated")
    expect(live.snapshot()).toMatchObject({
      calls: 1,
      freshInputTokens: 2_000_000,
      boundSessionId: "daemon-live",
    })
    expect(admit(live, "daemon-live", 3_000_000)).toEqual({ admitted: true })
  })

  test("thread with no durable books resets prior live totals", async () => {
    const live = createUsageAccounting()
    admit(live, "daemon-live", 1_000_000)
    await hydrateThreadIntoLiveSession("fresh", {
      loadThread: async () => ({ meta: meta("fresh"), messages: msgs }),
      replaceTranscript: async () => undefined,
      setActiveThreadId: () => undefined,
      prepareUsageAccountingAttach: (snapshot) => ({
        commit: () => {
          if (snapshot === undefined) live.reset()
          return true
        },
      }),
    })
    expect(live.snapshot()).toMatchObject({ calls: 0, totalUsd: 0 })
  })

  test("unknown thread: clean no-op (no replace, no repoint)", async () => {
    const replaced: unknown[] = []
    let active: string | null = null
    const out = await hydrateThreadIntoLiveSession("nope", {
      loadThread: async () => undefined,
      replaceTranscript: async (m) => void replaced.push(m),
      setActiveThreadId: (id) => (active = id),
    })
    expect(out).toEqual({ kind: "unknown-thread", threadId: "nope" })
    expect(replaced).toEqual([])
    expect(active).toBeNull()
  })

  test("mid-turn: transcript_replace_unavailable ⇒ REFUSED, live state untouched", async () => {
    let active: string | null = null
    const out = await hydrateThreadIntoLiveSession("t-mid", {
      loadThread: async () => ({ meta: meta("t"), messages: msgs }),
      replaceTranscript: async () => {
        throw new Error("transcript_replace_unavailable")
      },
      setActiveThreadId: (id) => (active = id),
    })
    expect(out).toEqual({ kind: "refused-mid-turn", threadId: "t-mid" })
    expect(active).toBeNull() // NOT repointed — parent thread stays live
  })

  test("mid-turn refusal leaves usage books untouched", async () => {
    const live = createUsageAccounting()
    admit(live, "daemon-live", 1_000_000)
    const target = createUsageAccounting()
    admit(target, "old-daemon", 2_000_000)
    const out = await hydrateThreadIntoLiveSession("t-mid-cost", {
      loadThread: async () => ({
        meta: meta("t-mid-cost"),
        messages: msgs,
        usageAccounting: target.serialize(),
      }),
      replaceTranscript: async () => {
        throw new Error("transcript_replace_unavailable")
      },
      setActiveThreadId: () => undefined,
      prepareUsageAccountingAttach: (snapshot) => ({
        commit: () => {
          if (snapshot !== undefined) live.hydrate(snapshot, { rebindSessionId: "daemon-live" })
          return true
        },
      }),
    })
    expect(out.kind).toBe("refused-mid-turn")
    expect(live.snapshot().freshInputTokens).toBe(1_000_000)
  })

  test("a non-guard error propagates (never silently swallowed)", async () => {
    await expect(
      hydrateThreadIntoLiveSession("t-x", {
        loadThread: async () => ({ meta: meta("t"), messages: msgs }),
        replaceTranscript: async () => {
          throw new Error("disk exploded")
        },
        setActiveThreadId: () => undefined,
      }),
    ).rejects.toThrow("disk exploded")
  })
})
