/**
 * ADR-0037 HELL E2E — Queued follow-ups (per-thread FIFO, paused-reason
 * gating, snapshot round-trip, docs completeness).
 *
 * Scenarios:
 *  1. 10 PausedReason × 3 thread cross-matrix → 30 distinct assertions.
 *  2. FIFO ordering under deterministic multi-thread enqueue interleaving
 *     (100 items across 3 threads, T1/T2/T3/T1/T2/T1 cadence).
 *  3. Snapshot round-trip after partial drain (50 enqueued → 10 popped →
 *     snapshot → restore → exact 40 remain → re-snapshot+restore is
 *     idempotent).
 *  4. drain() clears the thread; subsequent peek=null; enqueue works fresh.
 *  5. PausedReason enum + PAUSED_REASON_DOCS completeness (per-reason
 *     keyword match + min length).
 *  6. Snapshot vs production-code parity: JSON-safe shape (no Map/Set/
 *     function refs survive a JSON.parse round-trip, cap included).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ALL_PAUSED_REASONS,
  type FollowUp,
  FollowUpQueue,
  PAUSED_REASON_DOCS,
  type PausedReason,
  threadId,
} from "@/agent/follow-up-queue"
import { __resetRuntimeConfig } from "@/shared"

beforeEach(() => {
  delete process.env.QUANTA_SESSIONS_DIR
  __resetRuntimeConfig()
})

afterEach(() => {
  __resetRuntimeConfig()
})

const baseFu = (content: string, ts = 0): Omit<FollowUp, "id"> => ({
  content,
  submittedAt: ts,
  submittedTurnId: null,
  metadata: {},
})

/** Recursively walk a JSON-decoded tree and throw if any function ref
 *  survives. Pulled to module scope to keep test body complexity bounded. */
const assertNoFunctionRefs = (v: unknown): void => {
  if (typeof v === "function") throw new Error("function survived JSON encode")
  if (v === null || typeof v !== "object") return
  if (Array.isArray(v)) {
    for (const item of v) assertNoFunctionRefs(item)
    return
  }
  for (const k of Object.keys(v as Record<string, unknown>)) {
    assertNoFunctionRefs((v as Record<string, unknown>)[k])
  }
}

/* ------------------------------------------------------------------------- */
/* scenario 1 — 10 reasons × 3 threads cross-matrix                          */
/* ------------------------------------------------------------------------- */

describe("hell-1: 10 PausedReason × 3 threads = 30 assertions", () => {
  test("non-null reason ⇒ popReady returns null; null reason ⇒ FIFO head", () => {
    const q = new FollowUpQueue()
    const threads = [threadId("th-1"), threadId("th-2"), threadId("th-3")]
    // Seed each thread with one queued follow-up.
    for (const tid of threads) {
      q.enqueue(tid, baseFu(`first-${tid}`))
    }
    // 10 × 3 = 30 assertions of "non-null reason returns null".
    for (const tid of threads) {
      for (const reason of ALL_PAUSED_REASONS) {
        expect(q.popReady(tid, reason)).toBeNull()
      }
    }
    // Now unpause each thread: popReady(tid, null) returns the FIFO head
    // (the seeded entry).
    for (const tid of threads) {
      const ready = q.popReady(tid, null)
      expect(ready).not.toBeNull()
      expect(ready?.ready.content).toBe(`first-${tid}`)
      expect(ready?.remaining).toEqual([])
    }
  })
})

/* ------------------------------------------------------------------------- */
/* scenario 2 — FIFO under deterministic multi-thread interleaving           */
/* ------------------------------------------------------------------------- */

describe("hell-2: 100 follow-ups across 3 threads — strict FIFO per thread", () => {
  test("deterministic interleaving preserves per-thread submission order", () => {
    const q = new FollowUpQueue({ maxPerThread: 128 })
    const t1 = threadId("hell-t1")
    const t2 = threadId("hell-t2")
    const t3 = threadId("hell-t3")
    // Cadence: T1, T2, T3, T1, T2, T1, repeat — biases T1 heavier than
    // T2 which is heavier than T3.
    const cadence: Array<typeof t1> = [t1, t2, t3, t1, t2, t1]
    const submissionLog = new Map<string, string[]>([
      [t1, []],
      [t2, []],
      [t3, []],
    ])
    for (let i = 0; i < 100; i++) {
      const tid = cadence[i % cadence.length] ?? t1
      const content = `msg-${tid}-${i.toString().padStart(3, "0")}`
      q.enqueue(tid, baseFu(content, i))
      submissionLog.get(tid)?.push(content)
    }
    // Cadence T1 appears 3/6 = 50/100 times, T2 = 2/6 = 33-34/100, T3 = 1/6
    // = 16-17/100. Exact counts depend on 100 mod 6 = 4, so:
    //   indices 0..99, modulo 6: cadence[i%6]
    //   T1 hits at i%6 in {0,3,5} → 3 per 6 cycles, last partial 0..3:
    //   {0,3} ⇒ 2 in the final partial. Total: 16*3 + 2 = 50.
    //   T2 hits at i%6 in {1,4} → 2 per 6. Final partial {1} ⇒ 1. Total:
    //   16*2 + 1 = 33.
    //   T3 hits at i%6 in {2} → 1 per 6. Final partial: 2 not in range
    //   (0..3 only). Wait — final partial is 96..99 (i%6 = 0,1,2,3). So
    //   T3 hits at i=98 (98%6 = 2). Total: 16*1 + 1 = 17.
    expect(submissionLog.get(t1)).toHaveLength(50)
    expect(submissionLog.get(t2)).toHaveLength(33)
    expect(submissionLog.get(t3)).toHaveLength(17)
    expect(q.size()).toBe(100)
    expect(q.sizeFor(t1)).toBe(50)
    expect(q.sizeFor(t2)).toBe(33)
    expect(q.sizeFor(t3)).toBe(17)

    // Drain each thread and verify it sees ITS own items in submission
    // order — nothing from any other thread.
    for (const tid of [t1, t2, t3] as const) {
      const expected = submissionLog.get(tid) ?? []
      for (const exp of expected) {
        const ready = q.popReady(tid, null)
        expect(ready).not.toBeNull()
        expect(ready?.ready.content).toBe(exp)
      }
      // After draining, the thread is empty.
      expect(q.popReady(tid, null)).toBeNull()
      expect(q.sizeFor(tid)).toBe(0)
    }
    expect(q.size()).toBe(0)
  })
})

/* ------------------------------------------------------------------------- */
/* scenario 3 — snapshot round-trip after partial drain (and idempotency)    */
/* ------------------------------------------------------------------------- */

describe("hell-3: snapshot round-trip after partial drain — idempotent", () => {
  test("50 enqueued → pop 10 → snapshot → restore → 40 in same order; re-round-trip is identical", () => {
    const q = new FollowUpQueue({ maxPerThread: 128 })
    const tid = threadId("hell-snap")
    const submitted: string[] = []
    for (let i = 0; i < 50; i++) {
      const content = `snap-${i.toString().padStart(2, "0")}`
      q.enqueue(tid, baseFu(content, i))
      submitted.push(content)
    }
    expect(q.sizeFor(tid)).toBe(50)
    // Pop 10 — the FIRST 10.
    const popped: string[] = []
    for (let i = 0; i < 10; i++) {
      const r = q.popReady(tid, null)
      expect(r).not.toBeNull()
      popped.push(r?.ready.content ?? "")
    }
    expect(popped).toEqual(submitted.slice(0, 10))
    expect(q.sizeFor(tid)).toBe(40)

    // Snapshot, serialize to JSON, deserialize, restore.
    const snap1 = q.toSnapshot()
    const serialized = JSON.stringify(snap1)
    const reparsed = JSON.parse(serialized) as typeof snap1
    expect(reparsed.version).toBe(2)
    expect(reparsed.maxPerThread).toBeGreaterThanOrEqual(1)
    const q2 = FollowUpQueue.fromSnapshot(reparsed)
    expect(q2.sizeFor(tid)).toBe(40)
    // Pop the next 40 and verify EXACT submission order match.
    const remaining: string[] = []
    for (let i = 0; i < 40; i++) {
      const r = q2.popReady(tid, null)
      expect(r).not.toBeNull()
      remaining.push(r?.ready.content ?? "")
    }
    expect(remaining).toEqual(submitted.slice(10))

    // Idempotency check: re-snapshot the (now-empty) q2, restore, snapshot
    // again — the result must be byte-identical.
    const snap2 = q2.toSnapshot()
    const q3 = FollowUpQueue.fromSnapshot(snap2)
    const snap3 = q3.toSnapshot()
    expect(JSON.stringify(snap2)).toBe(JSON.stringify(snap3))
    // Mid-snapshot idempotency: take a fresh q with 5 items, round-trip
    // twice, compare both snapshots.
    const qA = new FollowUpQueue()
    const tidA = threadId("idem-thread")
    for (let i = 0; i < 5; i++) qA.enqueue(tidA, baseFu(`x-${i}`, i))
    const sA1 = qA.toSnapshot()
    const qB = FollowUpQueue.fromSnapshot(JSON.parse(JSON.stringify(sA1)) as typeof sA1)
    const sB1 = qB.toSnapshot()
    const qC = FollowUpQueue.fromSnapshot(JSON.parse(JSON.stringify(sB1)) as typeof sB1)
    const sC1 = qC.toSnapshot()
    expect(JSON.stringify(sA1)).toBe(JSON.stringify(sB1))
    expect(JSON.stringify(sB1)).toBe(JSON.stringify(sC1))
  })
})

/* ------------------------------------------------------------------------- */
/* scenario 4 — drain clears thread + enqueue works fresh                    */
/* ------------------------------------------------------------------------- */

describe("hell-4: drain clears the thread; queue is reusable", () => {
  test("drain returns FIFO, peek/popReady go null, then a fresh enqueue works", () => {
    const q = new FollowUpQueue()
    const tid = threadId("hell-drain")
    q.enqueue(tid, baseFu("alpha"))
    q.enqueue(tid, baseFu("beta"))
    q.enqueue(tid, baseFu("gamma"))
    expect(q.sizeFor(tid)).toBe(3)
    const drained = q.drain(tid)
    expect(drained.map((f) => f.content)).toEqual(["alpha", "beta", "gamma"])
    // Post-drain: empty.
    expect(q.peek(tid)).toBeNull()
    expect(q.popReady(tid, null)).toBeNull()
    expect(q.sizeFor(tid)).toBe(0)
    expect(q.threads()).not.toContain(tid)
    // Fresh enqueue WORKS — the thread can be reused after drain.
    const fresh = q.enqueue(tid, baseFu("delta"))
    expect(fresh.content).toBe("delta")
    expect(q.sizeFor(tid)).toBe(1)
    // The fresh id's seq counter continues monotonically (does NOT reset
    // to 0; deterministic per-process counter).
    const seqMatch = /^fu-.+-([0-9a-z]+)$/.exec(fresh.id)
    expect(seqMatch).not.toBeNull()
    const seqStr = seqMatch?.[1] ?? "0"
    const seq = Number.parseInt(seqStr, 36)
    expect(seq).toBe(3)
  })
})

/* ------------------------------------------------------------------------- */
/* scenario 5 — PausedReason enum + docs completeness (keyword check)        */
/* ------------------------------------------------------------------------- */

describe("hell-5: PausedReason + PAUSED_REASON_DOCS completeness", () => {
  test("docs keys equal the 10 reason values (sorted)", () => {
    const keys = Object.keys(PAUSED_REASON_DOCS).sort()
    const values = [...ALL_PAUSED_REASONS].sort()
    expect(keys).toEqual(values)
    expect(keys).toHaveLength(10)
  })

  test("every doc string is >= 8 chars and contains a relevant keyword", () => {
    // Each PausedReason MUST cite an explicit v3 surface. The keyword list
    // mirrors the brief's required vocabulary set.
    const KEYWORDS: Record<PausedReason, string[]> = {
      model_streaming: ["model", "stream"],
      tool_running: ["tool"],
      awaiting_approval: ["approval", "hitl"],
      awaiting_user: ["user", "asked", "question"],
      network_retry: ["network", "backoff", "retry", "429", "5xx"],
      compaction_in_progress: ["compaction"],
      review_in_progress: ["review"],
      hand_off_in_progress: ["handoff", "hand-off", "hand off"],
      mid_turn_steer_in_flight: ["steer"],
      unknown_blocking: ["blocking", "unknown"],
    }
    for (const r of ALL_PAUSED_REASONS) {
      const doc = PAUSED_REASON_DOCS[r]
      expect(doc.length).toBeGreaterThanOrEqual(8)
      const lower = doc.toLowerCase()
      const accepted = KEYWORDS[r]
      const hit = accepted.some((kw) => lower.includes(kw.toLowerCase()))
      if (!hit) {
        throw new Error(
          `Doc for "${r}" lacks any required keyword (${accepted.join(", ")}): ${JSON.stringify(doc)}`,
        )
      }
      expect(hit).toBe(true)
    }
  })

  test("each PausedReason actually pauses popReady for a fresh queue", () => {
    for (const r of ALL_PAUSED_REASONS) {
      const q = new FollowUpQueue()
      const tid = threadId(`fresh-${r}`)
      q.enqueue(tid, baseFu(`payload-${r}`))
      expect(q.popReady(tid, r)).toBeNull()
      // Queue did NOT lose the entry.
      expect(q.sizeFor(tid)).toBe(1)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* scenario 6 — snapshot is JSON-safe (no Map/Set/function survival)         */
/* ------------------------------------------------------------------------- */

describe("hell-6: toSnapshot is JSON-safe (no Map/Set/function leakage)", () => {
  test("snapshot survives JSON.parse(JSON.stringify(.)) with stable schema", () => {
    const q = new FollowUpQueue()
    const t1 = threadId("schema-1")
    const t2 = threadId("schema-2")
    q.enqueue(t1, baseFu("one", 100))
    q.enqueue(t1, baseFu("two", 200))
    q.enqueue(t2, baseFu("three", 300))
    const snap = q.toSnapshot()
    // Direct shape: version === 2, maxPerThread is persisted, and threads is
    // an array of {threadId, entries}.
    expect(snap.version).toBe(2)
    expect(snap.maxPerThread).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(snap.threads)).toBe(true)
    expect(snap.threads).toHaveLength(2)
    // No Map/Set in the snapshot tree.
    expect(snap.threads instanceof Map).toBe(false)
    expect(snap.threads instanceof Set).toBe(false)
    for (const t of snap.threads) {
      expect(typeof t.threadId).toBe("string")
      expect(Array.isArray(t.entries)).toBe(true)
      for (const e of t.entries) {
        expect(typeof e.id).toBe("string")
        expect(typeof e.content).toBe("string")
        expect(typeof e.submittedAt).toBe("number")
        // submittedTurnId is `string | null` in the type.
        expect(e.submittedTurnId === null || typeof e.submittedTurnId === "string").toBe(true)
        // metadata is a plain object — NOT a Map.
        expect(e.metadata instanceof Map).toBe(false)
        expect(typeof e.metadata).toBe("object")
      }
    }

    // JSON round-trip identity.
    const json = JSON.stringify(snap)
    const decoded = JSON.parse(json) as typeof snap
    expect(decoded).toEqual(snap)
    // No function references survive a JSON encode — assert via the
    // top-level walker `assertNoFunctionRefs`.
    assertNoFunctionRefs(decoded)

    // Documented keys: top-level = {version, maxPerThread, threads}; per-thread =
    // {threadId, entries}; per-entry = {id, content, submittedAt,
    // submittedTurnId, metadata}.
    expect(Object.keys(decoded).sort()).toEqual(["maxPerThread", "threads", "version"])
    for (const t of decoded.threads) {
      expect(Object.keys(t).sort()).toEqual(["entries", "threadId"])
      for (const e of t.entries) {
        expect(Object.keys(e).sort()).toEqual([
          "content",
          "id",
          "metadata",
          "submittedAt",
          "submittedTurnId",
        ])
      }
    }
  })
})
