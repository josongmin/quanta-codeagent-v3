/**
 * Resource limit boundary — hellgate (Gap #3 of 4-axis audit).
 *
 * For each primary cap, prove at-cap / under-cap / over-cap exhaustively.
 * Boundary bugs (off-by-one on a comparison, ≤ vs <) historically slip through
 * because they only surface on the EXACT-equal case; this suite pins all three.
 *
 * Sections:
 *   A. MAX_IMAGE_BYTES                          (3) — actually tested at the
 *      file-size boundary; the magic-byte mismatch case lives in B.
 *   B. ConversationCheckpointStore.maxEntries   (3)
 *   C. PlanQueueStore.maxPerThread              (3)
 *   D. BudgetLedger.maxEvents                   (3)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultBudgetLedger, type UsageEvent } from "@/agent/budget-ledger"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { defaultPlanQueueStore, type FollowUp } from "@/agent/plan-queue"
import type { Message } from "@/llm"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { MAX_IMAGE_BYTES, readImageTool } from "@/tool/image"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const mkMessage = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

const enqueueInput = (
  over: Partial<Omit<FollowUp, "id" | "enqueuedAtMs" | "textHash" | "drainedIntoTurn">> = {},
) => ({
  threadId: "t1",
  text: "default",
  source: "user_keystroke" as const,
  pausedReason: "tool_in_flight" as const,
  arrivedDuringTurn: 1,
  urgent: false,
  metadata: {} as Readonly<Record<string, string>>,
  ...over,
})

const usageOf = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  model: "claude-opus-4-7",
  inputTokens: 1_000,
  outputTokens: 0,
  sessionId: "s1",
  at: 1_700_000_000_000,
  ...over,
})

let workDir = ""

const runReadImage = async (relPath: string): Promise<ToolResult> => {
  const ctx: ToolContext = {
    cwd: workDir,
    signal: new AbortController().signal,
  }
  let final: ToolResult | undefined
  for await (const ev of readImageTool.execute(
    { path: relPath },
    ctx,
  ) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") final = ev.result
  }
  if (!final) throw new Error("no terminal result")
  return final
}

/** PNG header bytes — first 8 are the magic signature. */
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "resource-limit-boundary-hellgate-"))
  // Image exactly at the cap: PNG header + zero-padding to MAX_IMAGE_BYTES.
  const atCap = new Uint8Array(MAX_IMAGE_BYTES)
  atCap.set(PNG_HEADER, 0)
  await writeFile(path.join(workDir, "at-cap.png"), atCap)
  // Image at cap + 1 byte.
  const overCap = new Uint8Array(MAX_IMAGE_BYTES + 1)
  overCap.set(PNG_HEADER, 0)
  await writeFile(path.join(workDir, "over-cap.png"), overCap)
  // Image of 1 byte (size cap not triggered; magic-byte fails first).
  await writeFile(path.join(workDir, "one-byte.png"), new Uint8Array([0x89]))
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/* ================================================================== */
/* A. MAX_IMAGE_BYTES (3)                                             */
/* ================================================================== */

describe("A. MAX_IMAGE_BYTES boundary", () => {
  test("A1: image exactly = MAX_IMAGE_BYTES → ok:true (allowed at-cap)", async () => {
    const r = await runReadImage("at-cap.png")
    // Note: at-cap is allowed since the check is `stat.size > MAX_IMAGE_BYTES`
    // (strict >, so equal-to-cap passes).
    expect(r.ok).toBe(true)
    expect(r.images).toBeDefined()
    expect(r.images?.[0]?.mediaType).toBe("image/png")
  })

  test("A2: image = MAX_IMAGE_BYTES + 1 → ok:false 'too large'", async () => {
    const r = await runReadImage("over-cap.png")
    expect(r.ok).toBe(false)
    expect(r.output).toContain("too large")
    expect(r.images).toBeUndefined()
  })

  test("A3: 1-byte file → ok:false 'unsupported or unrecognized media type' (size cap NOT triggered; format does)", async () => {
    const r = await runReadImage("one-byte.png")
    expect(r.ok).toBe(false)
    expect(r.output).toContain("unsupported")
    expect(r.output).not.toContain("too large")
  })
})

/* ================================================================== */
/* B. ConversationCheckpointStore.maxEntries (3)                      */
/* ================================================================== */

describe("B. ConversationCheckpointStore.maxEntries boundary", () => {
  test("B4: record exactly maxEntries → list.length = maxEntries (no eviction)", () => {
    const store = defaultConversationCheckpointStore({ maxEntries: 5 })
    for (let i = 0; i < 5; i++) store.record(`id-${i}`, [mkMessage(`m${i}`)])
    expect(store.list().length).toBe(5)
    // Oldest still present (id-0).
    expect(store.restore("id-0")).not.toBeNull()
  })

  test("B5: record maxEntries + 1 → list.length = maxEntries; oldest evicted", () => {
    const store = defaultConversationCheckpointStore({ maxEntries: 5 })
    for (let i = 0; i < 6; i++) store.record(`id-${i}`, [mkMessage(`m${i}`)])
    expect(store.list().length).toBe(5)
    // id-0 (oldest) was evicted; id-5 (newest) is present.
    expect(store.restore("id-0")).toBeNull()
    expect(store.restore("id-5")).not.toBeNull()
  })

  test("B6: maxEntries = 1 → single entry survives; older one gone", () => {
    const store = defaultConversationCheckpointStore({ maxEntries: 1 })
    store.record("first", [mkMessage("a")])
    store.record("second", [mkMessage("b")])
    expect(store.list().length).toBe(1)
    expect(store.restore("first")).toBeNull()
    expect(store.restore("second")).not.toBeNull()
  })
})

/* ================================================================== */
/* C. PlanQueueStore.maxPerThread (3)                                 */
/* ================================================================== */

describe("C. PlanQueueStore.maxPerThread boundary", () => {
  test("C7: enqueue exactly maxPerThread → all in peek", () => {
    const store = defaultPlanQueueStore({ maxPerThread: 5 })
    for (let i = 0; i < 5; i++) store.enqueue(enqueueInput({ text: `t${i}` }))
    expect(store.peek("t1").length).toBe(5)
  })

  test("C8: enqueue maxPerThread + 1 (all non-urgent) → oldest dropped; count = maxPerThread", () => {
    const store = defaultPlanQueueStore({ maxPerThread: 5 })
    for (let i = 0; i < 6; i++) store.enqueue(enqueueInput({ text: `t${i}`, urgent: false }))
    const live = store.peek("t1")
    expect(live.length).toBe(5)
    // The dropped entry is the oldest non-urgent ⇒ "t0" gone, "t5" present.
    expect(live.find((f) => f.text === "t0")).toBeUndefined()
    expect(live.find((f) => f.text === "t5")).toBeDefined()
  })

  test("C9: all urgent + over cap → all-urgent fallback (oldest urgent dropped)", () => {
    const store = defaultPlanQueueStore({ maxPerThread: 3 })
    for (let i = 0; i < 4; i++) store.enqueue(enqueueInput({ text: `u${i}`, urgent: true }))
    const live = store.peek("t1")
    expect(live.length).toBe(3)
    // All-urgent fallback dropped the oldest urgent (u0).
    expect(live.find((f) => f.text === "u0")).toBeUndefined()
    expect(live.find((f) => f.text === "u3")).toBeDefined()
    for (const f of live) expect(f.urgent).toBe(true)
  })
})

/* ================================================================== */
/* D. BudgetLedger.maxEvents (3)                                      */
/* ================================================================== */

describe("D. BudgetLedger.maxEvents boundary", () => {
  test("D10: record exactly maxEvents → snapshot.events = maxEvents", () => {
    const l = defaultBudgetLedger({ maxEvents: 4 })
    for (let i = 0; i < 4; i++) l.record(usageOf({ at: 1_700_000_000_000 + i }))
    expect(l.snapshot().events).toBe(4)
  })

  test("D11: record maxEvents + 1 → snapshot.events = maxEvents; SPEND is not evicted", () => {
    // MR-05 — this test used to assert the evicted model DISAPPEARED from the
    // breakdown, because aggregates were recomputed from the retained slice.
    // That is the behaviour ledger contract clause #6 now supersedes: bounding
    // the event log must not un-bill spend, since the same aggregates are what
    // breach thresholds are compared against, and a cap compared to a shrinking
    // total can be crossed without ever firing.
    //
    // What D11 still guards is the BOUNDARY: the retained count stops at
    // maxEvents. The cost half is now asserted the other way round.
    const l = defaultBudgetLedger({ maxEvents: 4 })
    // First event has a DISTINCT model so we can follow it across eviction.
    l.record(usageOf({ model: "gpt-5", at: 1_700_000_000_000 }))
    for (let i = 1; i < 5; i++) {
      l.record(usageOf({ model: "claude-opus-4-7", at: 1_700_000_000_000 + i }))
    }
    const snap = l.snapshot()
    expect(snap.events).toBe(4) // the retained window really is capped
    // …and the evicted event's spend is still on the books, under its own model.
    expect(snap.perModel.has("gpt-5")).toBe(true)
    expect(snap.perModel.has("claude-opus-4-7")).toBe(true)
    expect(snap.totalCost).toBeCloseTo(
      (snap.perModel.get("gpt-5")?.totalCost ?? 0) +
        (snap.perModel.get("claude-opus-4-7")?.totalCost ?? 0),
      9,
    )
  })

  test("D12: maxEvents = 1 → single event lifecycle", () => {
    const l = defaultBudgetLedger({ maxEvents: 1 })
    l.record(usageOf({ at: 1_700_000_000_000 }))
    expect(l.snapshot().events).toBe(1)
    l.record(usageOf({ at: 1_700_000_000_001 }))
    const snap = l.snapshot()
    expect(snap.events).toBe(1)
  })
})
