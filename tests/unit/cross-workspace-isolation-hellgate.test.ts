/**
 * Cross-workspace / cross-thread / cross-session isolation — hellgate
 * (Gap #5 of 4-axis audit).
 *
 * Same payload, different scoping key → fully isolated. Today's tests use a
 * single workspace/thread/session id throughout, so a regression that DROPPED
 * the scope key from a lookup would silently pass. This hellgate puts a brick
 * on every per-(scope) state.
 *
 * Sections (6+ cases):
 *   1. ConversationCheckpointStore — same id, different store instances → no leak
 *   2. PlanQueueStore — same textHash, 2 threads → both kept (per-thread dedup)
 *   3. BudgetLedger — same model, 2 sessions → independent breach tracking
 *   4. BackgroundSubagentScheduler — same task, 2 forks → 2 distinct handle ids
 *   5. CheckpointPolicy — same turnId, 2 workspaces → both anchored (per-(workspace,turnId) dedup)
 *   6. ShadowOdb.workspaceHash — 2 paths → different hashes/shadow dirs
 */

import { describe, expect, test } from "bun:test"
import { defaultBudgetLedger, type UsageEvent } from "@/agent/budget-ledger"
import { type DestructivenessOracle, defaultCheckpointPolicy } from "@/agent/checkpoint-policy"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { defaultPlanQueueStore } from "@/agent/plan-queue"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import type { Message, ToolUseBlock } from "@/llm"
import type { ShadowOdb } from "@/storage"
import { workspaceHash } from "@/storage/shadow-odb"
import type { SubagentResult as SliceResult, SubagentRequest, SubagentRunner } from "@/subagent"
import type { Tool, ToolContext } from "@/tool"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const mkMessage = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

/* ================================================================== */
/* 1. ConversationCheckpointStore — same id, different stores         */
/* ================================================================== */

describe("HELL-1: ConversationCheckpointStore — same id, different instances → no cross-leak", () => {
  test("two independent stores with same id key carry independent snapshots", () => {
    const sA = defaultConversationCheckpointStore()
    const sB = defaultConversationCheckpointStore()
    sA.record("shared-id", [mkMessage("A-side")])
    sB.record("shared-id", [mkMessage("B-side")])
    const a = sA.restore("shared-id")
    const b = sB.restore("shared-id")
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    const aText = (a?.[0]?.content as { type: string; text: string }[])[0]?.text
    const bText = (b?.[0]?.content as { type: string; text: string }[])[0]?.text
    expect(aText).toBe("A-side")
    expect(bText).toBe("B-side")
    // Clearing one does not affect the other.
    sA.clear()
    expect(sA.restore("shared-id")).toBeNull()
    expect(sB.restore("shared-id")).not.toBeNull()
  })
})

/* ================================================================== */
/* 2. PlanQueueStore — same textHash, 2 threadIds                     */
/* ================================================================== */

describe("HELL-2: PlanQueueStore — same text on 2 thread ids → both kept (per-thread dedup)", () => {
  test("enqueue('identical') on t1 and t2 both survive; dedup is per-thread NOT global", () => {
    const store = defaultPlanQueueStore()
    const id1 = store.enqueue({
      threadId: "t1",
      text: "identical",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    })
    const id2 = store.enqueue({
      threadId: "t2",
      text: "identical",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    })
    expect(id1).not.toBe(id2)
    expect(store.peek("t1").length).toBe(1)
    expect(store.peek("t2").length).toBe(1)
    expect(store.peek("t1")[0]?.text).toBe("identical")
    expect(store.peek("t2")[0]?.text).toBe("identical")
  })
})

/* ================================================================== */
/* 3. BudgetLedger — same model, 2 sessions → independent breaches    */
/* ================================================================== */

describe("HELL-3: BudgetLedger — same model on 2 sessions → independent breach tracking", () => {
  const usage = (over: Partial<UsageEvent> = {}): UsageEvent => ({
    model: "claude-opus-4-7",
    inputTokens: 1_000_000,
    outputTokens: 0,
    sessionId: "s1",
    at: 1_700_000_000_000,
    ...over,
  })

  test("session-soft breach on s1 does not pre-fire for s2; both fire independently", () => {
    // softLimit=$20. 1M opus input = $15. 2 records per session = $30 (breach).
    const l = defaultBudgetLedger({ policy: { sessionSoftLimit: 20 } })
    // s1 crosses cap → breach fires.
    l.record(usage({ sessionId: "s1" }))
    const b1 = l.record(usage({ sessionId: "s1" }))
    expect(b1.length).toBe(1)
    expect(b1[0]?.kind).toBe("session-soft")
    expect(b1[0]?.scope).toBe("s1")
    // s2 hasn't crossed yet → no breach.
    const b2 = l.record(usage({ sessionId: "s2" }))
    expect(b2.length).toBe(0)
    // s2 crosses → its OWN breach fires (independent of s1's).
    const b3 = l.record(usage({ sessionId: "s2" }))
    expect(b3.length).toBe(1)
    expect(b3[0]?.scope).toBe("s2")
  })
})

/* ================================================================== */
/* 4. BackgroundSubagentScheduler — same spec, 2 forks                */
/* ================================================================== */

describe("HELL-4: BackgroundSubagentScheduler — same task, 2 forks → 2 distinct handle ids", () => {
  test("2 forks with byte-equal SubagentSpec yield 2 different ids; each tracked independently", async () => {
    let n = 0
    const idGen = (): string => `det-${n++}`
    const resolvers: Array<(r: SliceResult) => void> = []
    const runner: SubagentRunner = (_req: SubagentRequest) =>
      new Promise<SliceResult>((res) => {
        resolvers.push(res)
      })
    const scheduler = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 2,
      idGen,
    })
    const spec = { task: "same-task" }
    const id1 = scheduler.fork(spec)
    const id2 = scheduler.fork(spec)
    expect(id1).not.toBe(id2)
    expect(id1).toBe("bg-det-0")
    expect(id2).toBe("bg-det-1")
    // Both are tracked independently in list().
    const list = scheduler.list()
    expect(list.length).toBe(2)
    // Resolving the first runner does not collapse the second.
    const first = resolvers[0]
    if (first) first({ ok: true, finalText: "A done", turns: 1 })
    await scheduler.await(id1)
    expect(scheduler.poll(id1)?.status).toBe("completed")
    expect(scheduler.poll(id2)?.status).toBe("running")
    scheduler.cancel(id2)
  })
})

/* ================================================================== */
/* 5. CheckpointPolicy — same turnId, 2 workspaces → both anchor      */
/* ================================================================== */

describe("HELL-5: CheckpointPolicy — same turnId, 2 different workspaces → both anchored (per-(workspace,turnId) dedup)", () => {
  test("recordAnchored({ws1, turn-A}) does NOT pre-empt the {ws2, turn-A} anchor", async () => {
    // Pluggable oracle that always classifies as destructive.
    const oracle: DestructivenessOracle = () => true
    // Fake ShadowOdb — we never consult it; the policy port is what we test.
    const fakeOdb = {} as ShadowOdb
    const policy = defaultCheckpointPolicy({
      mode: "pre-destructive",
      odb: fakeOdb,
      oracle,
    })
    // Minimal Tool + ToolUseBlock + ToolContext shaped enough to satisfy the
    // policy's signature. The policy only reads `ctx.cwd` and `ctx.turnId`.
    const tool = { isReadOnly: () => false } as Tool
    const call: ToolUseBlock = { type: "tool_use", id: "c1", name: "edit", input: {} }
    const ctxFor = (cwd: string, turnId: string): ToolContext => ({
      cwd,
      signal: new AbortController().signal,
      turnId,
    })
    // ws1, turn-A → first anchor fires.
    const a1 = await policy.shouldAnchorBefore(tool, call, ctxFor("/ws1", "turn-A"))
    expect(a1).toBe(true)
    // Record the anchor for (ws1, turn-A).
    policy.recordAnchored({ workspace: "/ws1", turnId: "turn-A" })
    // ws1, turn-A again → dedup; no second anchor.
    const a2 = await policy.shouldAnchorBefore(tool, call, ctxFor("/ws1", "turn-A"))
    expect(a2).toBe(false)
    // ws2, SAME turnId → DIFFERENT dedup key; ANCHORS.
    const a3 = await policy.shouldAnchorBefore(tool, call, ctxFor("/ws2", "turn-A"))
    expect(a3).toBe(true)
  })
})

/* ================================================================== */
/* 6. ShadowOdb.workspaceHash — 2 paths → distinct hashes             */
/* ================================================================== */

describe("HELL-6: ShadowOdb.workspaceHash — 2 different workspace paths → different shadow dirs", () => {
  test("workspaceHash('/repo/A') !== workspaceHash('/repo/B'); same path → same hash", () => {
    const hA = workspaceHash("/repo/A")
    const hB = workspaceHash("/repo/B")
    expect(hA).not.toBe(hB)
    // Same path → same hash (deterministic).
    expect(workspaceHash("/repo/A")).toBe(hA)
    // Trailing slash normalization: /foo and /foo/ collide.
    expect(workspaceHash("/foo")).toBe(workspaceHash("/foo/"))
    // 16-hex prefix.
    expect(hA).toMatch(/^[0-9a-f]{16}$/)
    expect(hB).toMatch(/^[0-9a-f]{16}$/)
  })
})
