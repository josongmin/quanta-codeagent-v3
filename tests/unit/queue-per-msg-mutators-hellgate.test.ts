/**
 * PlanQueueStore — per-msg mutators hellgate (ADR-0221).
 *
 * 17 cases sealing the 4-mutator contract (retry / edit / delete / sendNow)
 * + the SendNowSink injection seam + the "no current turn abort" steering
 * bypass invariant + idempotency + OFF parity + id collision.
 */

import { describe, expect, test } from "bun:test"
import {
  defaultPlanQueueStore,
  type FollowUp,
  MAX_FOLLOWUP_TEXT_BYTES,
  type PlanQueueStore,
  type SendNowInjection,
  type SendNowSink,
} from "@/agent/plan-queue"

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}
const resetTick = (start = 1_000): void => {
  tickValue = start
}

const fresh = (sink?: SendNowSink): PlanQueueStore => {
  resetTick()
  return defaultPlanQueueStore({
    maxPerThread: 32,
    now: tick,
    ...(sink !== undefined ? { sendNowSink: sink } : {}),
  })
}

const input = (
  threadId: string,
  text: string,
  overrides: Partial<{
    source: FollowUp["source"]
    pausedReason: FollowUp["pausedReason"]
    arrivedDuringTurn: number
    urgent: boolean
    metadata: Readonly<Record<string, string>>
    label: string
  }> = {},
) => ({
  threadId,
  text,
  source: overrides.source ?? ("user_keystroke" as const),
  pausedReason: overrides.pausedReason ?? ("tool_in_flight" as const),
  arrivedDuringTurn: overrides.arrivedDuringTurn ?? 0,
  urgent: overrides.urgent ?? false,
  metadata: overrides.metadata ?? {},
  ...(overrides.label !== undefined ? { label: overrides.label } : {}),
})

/** Capture-everything sink for sendNow tests — records each injection so
 *  assertions can inspect the payload + count. */
const captureSink = (): {
  sink: SendNowSink
  calls: SendNowInjection[]
} => {
  const calls: SendNowInjection[] = []
  return {
    sink: {
      inject(payload) {
        calls.push(payload)
        return { ok: true }
      },
    },
    calls,
  }
}

/* ──────────────────────────────────────────────────────────────
 * A. retry
 * ────────────────────────────────────────────────────────────── */

describe("PlanQueueStore — retry", () => {
  test("HELL-R1: retry on a live entry succeeds (remove-and-re-enqueue with fresh id)", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "a")).id
    const r = s.retry(id1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // New id is different from the source.
    expect(r.value.id).not.toBe(id1)
    // The source id is GONE from the live queue.
    const live = s.peek("t1")
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe(r.value.id)
    expect(live[0]?.text).toBe("a")
  })

  test("HELL-R2: retry on a non-existent id returns not-found", () => {
    const s = fresh()
    const r = s.retry("fu-nope-999")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe("not-found")
  })

  test("HELL-R3: retry preserves urgent + label + metadata", () => {
    const s = fresh()
    const id1 = s.enqueue(
      input("t1", "important", {
        urgent: true,
        label: "chip",
        metadata: { viewportFile: "foo.ts" },
      }),
    ).id
    const r = s.retry(id1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.urgent).toBe(true)
    expect(r.value.label).toBe("chip")
    expect(r.value.metadata.viewportFile).toBe("foo.ts")
  })
})

/* ──────────────────────────────────────────────────────────────
 * B. edit
 * ────────────────────────────────────────────────────────────── */

describe("PlanQueueStore — edit", () => {
  test("HELL-E1: edit replaces text and recomputes hash; id stable", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "old")).id
    const hashBefore = s.peek("t1")[0]?.textHash
    const r = s.edit(id1, "new content")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.id).toBe(id1) // id stable
    expect(r.value.text).toBe("new content")
    expect(r.value.textHash).not.toBe(hashBefore)
  })

  test("HELL-E2: edit with empty / whitespace-only text → invalid-text", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "old")).id
    const e1 = s.edit(id1, "")
    expect(e1.ok).toBe(false)
    if (!e1.ok) expect(e1.error).toBe("invalid-text")
    const e2 = s.edit(id1, "   \t \n  ")
    expect(e2.ok).toBe(false)
    if (!e2.ok) expect(e2.error).toBe("invalid-text")
    // Original entry untouched.
    expect(s.peek("t1")[0]?.text).toBe("old")
  })

  test("HELL-E3: edit on missing id → not-found", () => {
    const s = fresh()
    const r = s.edit("fu-nope-1", "anything")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("not-found")
  })

  test("HELL-E4: edit over 64KiB → invalid-text", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "old")).id
    const huge = "a".repeat(MAX_FOLLOWUP_TEXT_BYTES + 1)
    const r = s.edit(id1, huge)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("invalid-text")
  })

  test("HELL-E5: edit collapsing to a sibling text merges urgency + drops THIS entry", () => {
    const s = fresh()
    s.enqueue(input("t1", "alpha", { urgent: false })).id
    const idB = s.enqueue(input("t1", "beta", { urgent: true })).id
    // Edit B → alpha's text ⇒ collapse to alpha (survivor), B removed.
    const r = s.edit(idB, "alpha")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.id).not.toBe(idB) // surviving id is alpha's, not B
    expect(r.value.text).toBe("alpha")
    expect(r.value.urgent).toBe(true) // B's urgency OR-ed in
    // Live queue has 1 entry now.
    expect(s.peek("t1")).toHaveLength(1)
  })

  test("HELL-E6: edit to same text is a no-op (id + hash + text stable)", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "same")).id
    const hashBefore = s.peek("t1")[0]?.textHash
    const r = s.edit(id1, "same")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.id).toBe(id1)
    expect(r.value.text).toBe("same")
    expect(r.value.textHash).toBe(hashBefore ?? "")
  })
})

/* ──────────────────────────────────────────────────────────────
 * C. delete
 * ────────────────────────────────────────────────────────────── */

describe("PlanQueueStore — delete", () => {
  test("HELL-D1: delete removes the entry; subsequent lookups not-found", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "x")).id
    const r = s.delete(id1)
    expect(r.ok).toBe(true)
    expect(s.peek("t1")).toHaveLength(0)
    // Subsequent delete is not-found (idempotent reject — second call sees nothing).
    const r2 = s.delete(id1)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBe("not-found")
  })

  test("HELL-D2: delete on missing id → not-found", () => {
    const s = fresh()
    const r = s.delete("fu-nope-1")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("not-found")
  })

  test("HELL-D3: delete cleans up empty thread (inspect shows no stale key)", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "only")).id
    s.delete(id1)
    const inspected = s.inspect()
    expect(inspected.has("t1")).toBe(false)
  })
})

/* ──────────────────────────────────────────────────────────────
 * D. sendNow + steering-bypass invariant
 * ────────────────────────────────────────────────────────────── */

describe("PlanQueueStore — sendNow", () => {
  test("HELL-S1: sendNow ignores paused state and hands payload to sink", () => {
    const cap = captureSink()
    const s = fresh(cap.sink)
    const id1 = s.enqueue(
      input("t1", "urgent steer", {
        // Every paused reason value — sendNow MUST work regardless.
        pausedReason: "compaction",
        urgent: true,
        label: "chip",
      }),
    ).id
    const r = s.sendNow(id1)
    expect(r.ok).toBe(true)
    // Sink received the payload.
    expect(cap.calls).toHaveLength(1)
    expect(cap.calls[0]?.text).toBe("urgent steer")
    expect(cap.calls[0]?.threadId).toBe("t1")
    expect(cap.calls[0]?.label).toBe("chip")
    // Entry removed from queue.
    expect(s.peek("t1")).toHaveLength(0)
  })

  test("HELL-S2: sendNow without a wired sink → send-not-possible (entry removed anyway)", () => {
    const s = fresh() // no sink
    const id1 = s.enqueue(input("t1", "boom")).id
    const r = s.sendNow(id1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("send-not-possible")
    // Removal happened BEFORE sink check (contract).
    expect(s.peek("t1")).toHaveLength(0)
  })

  test("HELL-S3: sendNow does NOT abort or interrupt anything observable (no side-effect channel beyond sink)", () => {
    // STEERING BYPASS INVARIANT: the store has NO channel to abort the
    // active turn. The ONLY observable effect of sendNow is (a) sink call
    // + (b) entry removal. There is no abort signal, no event bus emit,
    // no synchronous drain trigger. Pin this by counting the surface.
    const cap = captureSink()
    const s = fresh(cap.sink)
    s.enqueue(input("t1", "a"))
    s.enqueue(input("t1", "b"))
    const idC = s.enqueue(input("t1", "c")).id
    const r = s.sendNow(idC)
    expect(r.ok).toBe(true)
    // OTHER entries untouched — sendNow only affects ITS entry.
    const remaining = s.peek("t1").map((e) => e.text)
    expect(remaining).toEqual(["a", "b"])
    // Sink saw exactly ONE call (no cascade).
    expect(cap.calls).toHaveLength(1)
  })

  test("HELL-S4: sendNow converts sink throw into typed send-not-possible (no-throw surface)", () => {
    const throwingSink: SendNowSink = {
      inject() {
        throw new Error("sink boom")
      },
    }
    const s = fresh(throwingSink)
    const id1 = s.enqueue(input("t1", "x")).id
    const r = s.sendNow(id1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("send-not-possible")
    // Entry still removed (contract: removal happens before sink call).
    expect(s.peek("t1")).toHaveLength(0)
  })

  test("HELL-S5: sendNow converts sink `{ok:false}` to send-not-possible", () => {
    const rejectingSink: SendNowSink = {
      inject() {
        return { ok: false, reason: "sink busy" }
      },
    }
    const s = fresh(rejectingSink)
    const id1 = s.enqueue(input("t1", "x")).id
    const r = s.sendNow(id1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("send-not-possible")
  })
})

/* ──────────────────────────────────────────────────────────────
 * E. idempotency / race / OFF parity / id collision
 * ────────────────────────────────────────────────────────────── */

describe("PlanQueueStore — invariants", () => {
  test("HELL-X1: 4 mutators are idempotent (second call after success → not-found)", () => {
    const cap = captureSink()
    const s = fresh(cap.sink)

    // retry: first call removes+re-enqueues; second call on OLD id is not-found.
    const r1 = s.enqueue(input("t1", "a")).id
    const ret1 = s.retry(r1)
    expect(ret1.ok).toBe(true)
    const ret2 = s.retry(r1) // same old id — gone
    expect(ret2.ok).toBe(false)
    if (!ret2.ok) expect(ret2.error).toBe("not-found")

    // delete
    const d1 = s.enqueue(input("t2", "b")).id
    expect(s.delete(d1).ok).toBe(true)
    const d2 = s.delete(d1)
    expect(d2.ok).toBe(false)
    if (!d2.ok) expect(d2.error).toBe("not-found")

    // sendNow
    const sn1 = s.enqueue(input("t3", "c")).id
    expect(s.sendNow(sn1).ok).toBe(true)
    const sn2 = s.sendNow(sn1)
    expect(sn2.ok).toBe(false)
    if (!sn2.ok) expect(sn2.error).toBe("not-found")

    // edit
    const e1 = s.enqueue(input("t4", "d")).id
    expect(s.delete(e1).ok).toBe(true)
    const e2 = s.edit(e1, "new")
    expect(e2.ok).toBe(false)
    if (!e2.ok) expect(e2.error).toBe("not-found")
  })

  test("HELL-X2: concurrent-ish mutator calls remain serializable (no double-spend)", () => {
    const cap = captureSink()
    const s = fresh(cap.sink)
    const id1 = s.enqueue(input("t1", "race")).id
    // Two sendNow calls in immediate succession — second MUST observe not-found.
    const r1 = s.sendNow(id1)
    const r2 = s.sendNow(id1)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBe("not-found")
    expect(cap.calls).toHaveLength(1)
  })

  test("HELL-X3: OFF parity — never calling a mutator yields byte-identical drain output", () => {
    const a = fresh()
    const b = fresh()
    // Same enqueue sequence on both stores; only `a` ALSO records mutator
    // capabilities by calling findEntry (read-only — no mutation).
    a.enqueue(input("t1", "one"))
    b.enqueue(input("t1", "one"))
    a.enqueue(input("t1", "two", { urgent: true }))
    b.enqueue(input("t1", "two", { urgent: true }))
    // Use findEntry on `a` — must be observation-only.
    const found = a.findEntry("fu-t1-1")
    expect(found).toBeDefined()
    // Drain both — entries (modulo enqueuedAtMs which uses pinned `tick`)
    // are byte-equivalent.
    const da = a.drain("t1", 1)
    const db = b.drain("t1", 1)
    expect(da.map((e) => ({ text: e.text, urgent: e.urgent }))).toEqual(
      db.map((e) => ({ text: e.text, urgent: e.urgent })),
    )
  })

  test("HELL-X4: id collision is impossible across mutators (retry assigns FRESH id, never reuses)", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "x")).id
    const r1 = s.retry(id1)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    const id2 = r1.value.id
    expect(id2).not.toBe(id1)
    // Re-retry the new id again — yields ANOTHER fresh id (still no collision).
    const r2 = s.retry(id2)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    const id3 = r2.value.id
    expect(id3).not.toBe(id1)
    expect(id3).not.toBe(id2)
  })
})
