/**
 * PlanQueueStore — per-msg mutator hellgate (ADR-0221).
 *
 * Sibling to `plan-queue-hellgate.test.ts` (which covers enqueue / drain /
 * dedup / LRU / exactOptional). THIS file pins the four per-message mutator
 * surfaces — `retry / edit / delete / sendNow` + `findEntry` — that ADR-0221
 * adds for Codex-composer parity. 14 distinct adversarial cases.
 *
 * Coverage gap closed:
 *   - Existing hellgate has ZERO calls to retry/edit/delete/sendNow/findEntry.
 *   - This file is the FIRST adversarial probe of typed mutate errors,
 *     SendNowSink wiring, drained-tombstone non-reachability, merge-on-edit,
 *     and the per-msg label exactOptional flow.
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

// ─────────────────────────────────────────────────────────────
// helpers (shared shape with sibling test — independent instances)
// ─────────────────────────────────────────────────────────────

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}
const resetTick = (start = 1_000): void => {
  tickValue = start
}

const fresh = (maxPerThread = 32, sendNowSink?: SendNowSink): PlanQueueStore => {
  resetTick()
  return defaultPlanQueueStore({
    maxPerThread,
    now: tick,
    ...(sendNowSink !== undefined ? { sendNowSink } : {}),
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

const makeSink = (
  reply: "ok" | "reject" | "throw" = "ok",
): SendNowSink & { calls: SendNowInjection[] } => {
  const calls: SendNowInjection[] = []
  return {
    calls,
    inject(payload) {
      calls.push(payload)
      if (reply === "throw") throw new Error("sink boom")
      if (reply === "reject") return { ok: false, reason: "downstream-full" }
      return { ok: true }
    },
  }
}

// =============================================================
// A. sendNow surface (4)
// =============================================================

describe("PlanQueueStore mutators — A. sendNow without/with sink", () => {
  test("MUT-1: sendNow without sink → error 'send-not-possible' AND entry STILL REMOVED", () => {
    // Documented contract (plan-queue.ts L640-L647): entry is removed BEFORE
    // the sink call so a sink-side throw can't leave it half-state. With NO
    // sink wired, the same removal happens (then the early `errR` lands).
    const s = fresh()
    const id = s.enqueue(input("t1", "hello")).id
    const r = s.sendNow(id)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("send-not-possible")
    // Entry already gone — caller can re-enqueue (intent in docstring).
    expect(s.peek("t1")).toEqual([])
    expect(s.findEntry(id)).toBeUndefined()
  })

  test("MUT-2: sendNow with sink ok → entry removed AND sink received the EXACT payload (no label key when label absent)", () => {
    const sink = makeSink("ok")
    const s = fresh(32, sink)
    const enq = s.enqueue(input("t1", "ship-it"))
    const r = s.sendNow(enq.id)
    expect(r.ok).toBe(true)
    expect(sink.calls).toHaveLength(1)
    const got = sink.calls[0]
    expect(got?.threadId).toBe("t1")
    expect(got?.text).toBe("ship-it")
    expect(got?.source).toBe("user_keystroke")
    expect(got?.metadata).toEqual({})
    // exactOptionalPropertyTypes — label key omitted entirely, not undefined.
    expect("label" in (got as object)).toBe(false)
    expect(s.peek("t1")).toEqual([])
  })

  test("MUT-3: sendNow with sink that THROWS → error 'send-not-possible' (throw NEVER escapes); entry stays removed", () => {
    // The store wraps sink.inject in try/catch and converts any throw to a
    // typed error. Caller must be able to wire a buggy sink and never see
    // an unhandled exception.
    const sink = makeSink("throw")
    const s = fresh(32, sink)
    const id = s.enqueue(input("t1", "boom")).id
    let threw: unknown = null
    let r: ReturnType<PlanQueueStore["sendNow"]> | null = null
    try {
      r = s.sendNow(id)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(r?.ok).toBe(false)
    if (r && r.ok === false) expect(r.error).toBe("send-not-possible")
    expect(s.peek("t1")).toEqual([])
  })

  test("MUT-4: sendNow with sink that returns {ok:false} → typed error AND entry STILL removed (re-enqueue path)", () => {
    const sink = makeSink("reject")
    const s = fresh(32, sink)
    const id = s.enqueue(input("t1", "fix")).id
    const r = s.sendNow(id)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("send-not-possible")
    expect(sink.calls).toHaveLength(1)
    // Documented (plan-queue.ts L642-L645): "if the sink rejects, the caller
    // observes a removed entry + a typed error and can re-enqueue".
    expect(s.peek("t1")).toEqual([])
  })
})

// =============================================================
// B. retry surface (3)
// =============================================================

describe("PlanQueueStore mutators — B. retry", () => {
  test("MUT-5: retry on missing id → 'not-found'", () => {
    const s = fresh()
    s.enqueue(input("t1", "alive"))
    const r = s.retry("fu-bogus-999")
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("not-found")
  })

  test("MUT-6: retry on drained entry → 'not-found' (drained = tombstone, never resurrect)", () => {
    // Contract (plan-queue.ts L127-L131): "drained entries are tombstones —
    // they NEVER resurrect via retry/edit/delete; sendNow ignores them too".
    const s = fresh()
    const id = s.enqueue(input("t1", "fix")).id
    const drained = s.drain("t1", 5)
    expect(drained).toHaveLength(1)
    const r = s.retry(id)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("not-found")
    // Sibling mutators agree on the tombstone rule.
    expect(s.edit(id, "anything").ok).toBe(false)
    expect(s.delete(id).ok).toBe(false)
    expect(s.sendNow(id).ok).toBe(false)
  })

  test("MUT-7: retry on LIVE entry → NEW id; old gone; dedup-with-self avoided (text + urgent + metadata + label preserved)", () => {
    // The 'already-active' Result variant exists for forward-compat but the
    // SYNCHRONOUS impl always proceeds — what we verify here is the retry
    // semantics: remove + re-enqueue with a FRESH id (no dedup-with-self
    // pitfall). All carried fields must survive.
    const s = fresh()
    const orig = s.enqueue(
      input("t1", "retry-me", {
        urgent: true,
        label: "chip-X",
        metadata: { viewportFile: "src/foo.ts" },
      }),
    ).id
    const r = s.retry(orig)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    const next = r.value
    expect(next.id).not.toBe(orig)
    expect(next.text).toBe("retry-me")
    expect(next.urgent).toBe(true)
    expect(next.label).toBe("chip-X")
    expect(next.metadata).toEqual({ viewportFile: "src/foo.ts" })
    // Old id is gone — findEntry returns undefined.
    expect(s.findEntry(orig)).toBeUndefined()
    // Exactly one live entry.
    expect(s.peek("t1")).toHaveLength(1)
    expect(s.peek("t1")[0]?.id).toBe(next.id)
  })
})

// =============================================================
// C. edit surface (3)
// =============================================================

describe("PlanQueueStore mutators — C. edit", () => {
  test("MUT-8: edit with empty / whitespace-only / oversize text → 'invalid-text' (typed, no throw)", () => {
    const s = fresh()
    const id = s.enqueue(input("t1", "original")).id
    // Empty.
    const a = s.edit(id, "")
    expect(a.ok).toBe(false)
    if (a.ok === false) expect(a.error).toBe("invalid-text")
    // Whitespace only.
    const b = s.edit(id, "   \n\t  ")
    expect(b.ok).toBe(false)
    if (b.ok === false) expect(b.error).toBe("invalid-text")
    // Oversize (> MAX_FOLLOWUP_TEXT_BYTES).
    const huge = "x".repeat(MAX_FOLLOWUP_TEXT_BYTES + 1)
    const c = s.edit(id, huge)
    expect(c.ok).toBe(false)
    if (c.ok === false) expect(c.error).toBe("invalid-text")
    // Original entry unchanged after all rejected attempts.
    expect(s.findEntry(id)?.text).toBe("original")
  })

  test("MUT-9: edit no-op (same text) → same entry returned, id stable, no merge work", () => {
    const s = fresh()
    const id = s.enqueue(input("t1", "stable")).id
    const r = s.edit(id, "stable")
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.value.id).toBe(id)
    expect(r.value.text).toBe("stable")
    expect(s.peek("t1")).toHaveLength(1)
  })

  test("MUT-10: edit that COLLIDES with a sibling LIVE entry → merge: this entry deleted, sibling kept; sibling's urgent OR-ed with self's urgent", () => {
    // Contract (plan-queue.ts L221-L225): "if the new text would collapse to
    // another LIVE entry's hash, the OTHER entry's urgent is OR-ed with this
    // one's and the THIS entry is removed (caller sees ok:true with the
    // SURVIVING entry — the merge target)."
    const s = fresh()
    const survivorId = s.enqueue(input("t1", "twin", { urgent: false })).id
    const editedId = s.enqueue(input("t1", "different", { urgent: true })).id
    const r = s.edit(editedId, "twin")
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    // Survivor is the OTHER entry (not the edited one).
    expect(r.value.id).toBe(survivorId)
    // urgency OR-ed in (edited was urgent → survivor now urgent).
    expect(r.value.urgent).toBe(true)
    // Edited entry is gone.
    expect(s.findEntry(editedId)).toBeUndefined()
    // Exactly one live entry.
    expect(s.peek("t1")).toHaveLength(1)
  })
})

// =============================================================
// D. delete + findEntry + isolation (4)
// =============================================================

describe("PlanQueueStore mutators — D. delete / findEntry / isolation", () => {
  test("MUT-11: delete LIVE entry → ok; then drain returns empty; subsequent delete = 'not-found'", () => {
    const s = fresh()
    const id = s.enqueue(input("t1", "doomed")).id
    expect(s.delete(id).ok).toBe(true)
    expect(s.drain("t1", 1)).toEqual([])
    // Second delete of same id is 'not-found' (no idempotent silent ok —
    // the queue surface is typed-error explicit).
    const second = s.delete(id)
    expect(second.ok).toBe(false)
    if (second.ok === false) expect(second.error).toBe("not-found")
  })

  test("MUT-12: findEntry across threads — same text + different threads → DISTINCT findEntry hits, no cross-pollution", () => {
    // Per-thread isolation contract is in the sibling test but mutator-side
    // is NOT: findEntry must locate the LIVE entry across all threads and
    // return a snapshot with the correct threadId.
    const s = fresh()
    const idA = s.enqueue(input("t1", "same-text")).id
    const idB = s.enqueue(input("t2", "same-text")).id
    expect(idA).not.toBe(idB)
    const fA = s.findEntry(idA)
    const fB = s.findEntry(idB)
    expect(fA).toBeDefined()
    expect(fB).toBeDefined()
    expect(fA?.threadId).toBe("t1")
    expect(fB?.threadId).toBe("t2")
  })

  test("MUT-13: delete on one thread does NOT touch sibling thread's queue", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "alpha")).id
    s.enqueue(input("t2", "alpha"))
    s.enqueue(input("t2", "beta"))
    expect(s.delete(id1).ok).toBe(true)
    expect(s.peek("t1")).toEqual([])
    // t2 untouched.
    expect(s.peek("t2").map((e) => e.text)).toEqual(["alpha", "beta"])
  })

  test("MUT-14: mutators NEVER throw on adversarial inputs (string-typed id with weird shapes)", () => {
    const s = fresh()
    s.enqueue(input("t1", "alive"))
    const bogus = ["", "fu-", "fu-t-x", "../../etc/passwd", "fu-t1-99999999", " "]
    for (const id of bogus) {
      // All four mutators (and findEntry) must return cleanly. No throws.
      let threw: unknown = null
      try {
        s.findEntry(id)
        const r1 = s.retry(id)
        const r2 = s.edit(id, "new")
        const r3 = s.delete(id)
        const r4 = s.sendNow(id)
        // All must be typed errors (no sink wired ⇒ sendNow yields not-found
        // on miss BEFORE the send-not-possible branch).
        expect(r1.ok).toBe(false)
        expect(r2.ok).toBe(false)
        expect(r3.ok).toBe(false)
        expect(r4.ok).toBe(false)
      } catch (e) {
        threw = e
      }
      expect(threw).toBeNull()
    }
    // Original entry untouched.
    expect(s.peek("t1")).toHaveLength(1)
  })
})
