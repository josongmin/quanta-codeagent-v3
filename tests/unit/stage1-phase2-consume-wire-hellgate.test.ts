/**
 * ADR-0233 (Wire 1) — Stage1→Phase2 reuse consume helper hellgate.
 *
 * Pins the contract for `consumeStage1ForPhase2`:
 *   - DEFAULT-OFF: store omitted ⇒ refresh + `store_missing` (NO reads).
 *   - Empty threadId ⇒ refresh + `thread_id_empty` (NO reads).
 *   - Missing record ⇒ refresh + `no_record`.
 *   - Fresh record + low usage ⇒ REUSE; verb order:
 *       read → reuseConsumedEntry (2 calls — audit C-1 single atomic consume).
 *   - Expired record (age > thresholdSec*1000) ⇒ refresh + `expired`.
 *   - Over-used record (usageCount >= maxUsageBeforeRefresh) ⇒ refresh +
 *     `over_used`.
 *   - Knob defaults pinned: stage1ReuseThresholdSec=3600 / maxUsage=5.
 *   - Knob defaults applied on invalid input (NaN/Infinity/<=0).
 *   - read throws ⇒ refresh + `store_error` (no escape).
 *   - reuseConsumedEntry throws OR returns ok:false AFTER a successful read ⇒
 *     refresh + `store_error` (caller never acts on a half-mutated record).
 *   - Single-bump invariant (audit C-1): one reuse bumps usageCount by EXACTLY
 *     +1 (not +2) — selection + usage accounting cannot drift.
 *   - Byte-identical to store-absent path: outcome SHAPE is the same
 *     discriminated union; refresh.reason distinguishes WHY.
 *
 * Source under test: src/agent/memory-consolidator-hook.ts —
 * `consumeStage1ForPhase2` + `STAGE1_REUSE_THRESHOLD_SEC_DEFAULT` +
 * `STAGE1_MAX_USAGE_BEFORE_REFRESH_DEFAULT`.
 *
 * The tests use the slice's own `inMemoryStage1Store` adapter as the
 * baseline reference impl, then wrap it with throwing spies for the
 * adversarial cases.
 */

import { describe, expect, test } from "bun:test"
import {
  inMemoryStage1Store,
  type Stage1Record,
  type Stage1Result,
  type Stage1StorePortV2,
  type WriteInput,
} from "@/agent/memory/stage1-store"
import {
  consumeStage1ForPhase2,
  STAGE1_MAX_USAGE_BEFORE_REFRESH_DEFAULT,
  STAGE1_REUSE_THRESHOLD_SEC_DEFAULT,
} from "@/agent/memory-consolidator-hook"

// ─── Fixtures + spies ────────────────────────────────────────────────

const SEED: WriteInput = {
  threadId: "t-1",
  rolloutSlug: "slug",
  rolloutSummary: "summary",
  rawMemory: "- decision",
  preferenceSignals: ["likes-haiku"],
  generatedAt: 1_700_000_000_000,
}

const seedStore = async (
  overrides: Partial<WriteInput> = {},
): Promise<{ store: Stage1StorePortV2; threadId: string }> => {
  const store = inMemoryStage1Store()
  const input = { ...SEED, ...overrides }
  await store.write(input)
  return { store, threadId: input.threadId }
}

interface SpyStore {
  readonly inner: Stage1StorePortV2
  readonly calls: string[]
  readonly port: Stage1StorePortV2
}

const wrapSpy = (inner: Stage1StorePortV2): SpyStore => {
  const calls: string[] = []
  const port: Stage1StorePortV2 = {
    write: async (i) => {
      calls.push("write")
      return inner.write(i)
    },
    read: async (id) => {
      calls.push("read")
      return inner.read(id)
    },
    incrementUsageCount: async (id) => {
      calls.push("incrementUsageCount")
      return inner.incrementUsageCount(id)
    },
    selectForPhase2: async (ids) => {
      calls.push("selectForPhase2")
      return inner.selectForPhase2(ids)
    },
    reuseConsumedEntry: async (id) => {
      calls.push("reuseConsumedEntry")
      return inner.reuseConsumedEntry(id)
    },
  }
  return { inner, calls, port }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("consumeStage1ForPhase2 — default-OFF (store missing)", () => {
  test("store undefined ⇒ refresh + store_missing (NO mutation possible)", async () => {
    const out = await consumeStage1ForPhase2({
      store: undefined,
      threadId: "t-1",
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("store_missing")
    }
  })

  test("empty threadId ⇒ refresh + thread_id_empty (NO reads on store)", async () => {
    const { store } = await seedStore()
    const spy = wrapSpy(store)
    const out = await consumeStage1ForPhase2({
      store: spy.port,
      threadId: "",
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("thread_id_empty")
    }
    expect(spy.calls).toEqual([]) // no reads
  })
})

describe("consumeStage1ForPhase2 — happy reuse path", () => {
  test("fresh record + low usage ⇒ reuse + 2-verb order: read → reuseConsumedEntry", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    const spy = wrapSpy(store)
    const out = await consumeStage1ForPhase2({
      store: spy.port,
      threadId,
      now: () => generatedAt + 60_000, // 1 min later
    })
    expect(out.kind).toBe("reuse")
    if (out.kind === "reuse") {
      expect(out.record.threadId).toBe(threadId)
      expect(out.record.rolloutSummary).toBe("summary")
    }
    // VERB ORDER pinned (audit C-1): the reuse path performs ONE atomic
    // consume — never a hand-composed increment + select (that double-bumped).
    expect(spy.calls).toEqual(["read", "reuseConsumedEntry"])
  })

  test("reuse bumps usageCount by EXACTLY +1 AND flips selectedForPhase2 (no double-bump)", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    const out = await consumeStage1ForPhase2({
      store,
      threadId,
      now: () => generatedAt + 1_000,
    })
    expect(out.kind).toBe("reuse")
    // The returned record reflects the post-consume state directly.
    if (out.kind === "reuse") {
      expect(out.record.usageCount).toBe(1)
      expect(out.record.selectedForPhase2).toBe(true)
    }
    // Verify the post-state with a direct read against the in-memory store.
    const after = await store.read(threadId)
    expect(after.ok).toBe(true)
    if (after.ok && after.value) {
      // Audit C-1: single atomic consume ⇒ +1, NOT +2.
      expect(after.value.usageCount).toBe(1)
      expect(after.value.selectedForPhase2).toBe(true)
    }
  })
})

describe("consumeStage1ForPhase2 — refresh conditions", () => {
  test("missing record (unknown threadId) ⇒ refresh + no_record", async () => {
    const { store } = await seedStore()
    const spy = wrapSpy(store)
    const out = await consumeStage1ForPhase2({
      store: spy.port,
      threadId: "unknown-thread",
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("no_record")
    }
    expect(spy.calls).toEqual(["read"]) // read happened, then no mutation
  })

  test("expired record (age > stage1ReuseThresholdSec * 1000) ⇒ refresh + expired", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    const spy = wrapSpy(store)
    // Threshold 10 sec → 10001 ms later is expired.
    const out = await consumeStage1ForPhase2({
      store: spy.port,
      threadId,
      stage1ReuseThresholdSec: 10,
      now: () => generatedAt + 10_001,
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("expired")
    }
    // No mutation when we refuse to reuse.
    expect(spy.calls).toEqual(["read"])
  })

  test("over-used record (usageCount >= maxUsageBeforeRefresh) ⇒ refresh + over_used", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    // Bump usage past the cap (cap=2 → bump to 2).
    await store.incrementUsageCount(threadId)
    await store.incrementUsageCount(threadId)
    const spy = wrapSpy(store)
    const out = await consumeStage1ForPhase2({
      store: spy.port,
      threadId,
      maxUsageBeforeRefresh: 2,
      now: () => generatedAt + 1_000, // still fresh
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("over_used")
    }
    expect(spy.calls).toEqual(["read"])
  })
})

describe("consumeStage1ForPhase2 — knob default + clamp posture", () => {
  test("defaults pinned: threshold=3600 sec, maxUsage=5", () => {
    expect(STAGE1_REUSE_THRESHOLD_SEC_DEFAULT).toBe(3600)
    expect(STAGE1_MAX_USAGE_BEFORE_REFRESH_DEFAULT).toBe(5)
  })

  test("invalid knob (NaN/Infinity/<=0) ⇒ default applied (record still reusable)", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    // NaN threshold falls back to 3600 sec ⇒ a 60s-old record is fresh.
    const outNaN = await consumeStage1ForPhase2({
      store,
      threadId,
      stage1ReuseThresholdSec: Number.NaN,
      now: () => generatedAt + 60_000,
    })
    expect(outNaN.kind).toBe("reuse")
    // Bump above the default cap (5) using selectForPhase2 (+1 each time)
    // and incrementUsageCount cycles to exceed cap. Re-seed clean to avoid
    // state bleed.
    const { store: s2, threadId: t2 } = await seedStore({
      generatedAt,
      threadId: "t-2",
    })
    // Push usage to 5 (exactly the default cap → should refresh).
    for (let i = 0; i < 5; i += 1) await s2.incrementUsageCount(t2)
    const outInf = await consumeStage1ForPhase2({
      store: s2,
      threadId: t2,
      maxUsageBeforeRefresh: Number.POSITIVE_INFINITY, // invalid ⇒ default 5
      now: () => generatedAt + 1_000,
    })
    expect(outInf.kind).toBe("refresh")
    if (outInf.kind === "refresh") expect(outInf.reason).toBe("over_used")
  })

  test("zero / negative maxUsageBeforeRefresh ⇒ default applied (not 'always refresh')", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    // 0 is invalid (default 5 applies), so a fresh record with usage=0
    // remains reusable.
    const out = await consumeStage1ForPhase2({
      store,
      threadId,
      maxUsageBeforeRefresh: 0,
      now: () => generatedAt + 1_000,
    })
    expect(out.kind).toBe("reuse")
  })
})

describe("consumeStage1ForPhase2 — no-throw under store failure", () => {
  test("read throws ⇒ refresh + store_error (no escape)", async () => {
    const throwingStore: Stage1StorePortV2 = {
      write: async () => ({ ok: false, code: "io-failed", message: "n/a" }),
      read: async () => {
        throw new Error("read boom")
      },
      incrementUsageCount: async () => ({ ok: false, code: "io-failed", message: "n/a" }),
      selectForPhase2: async () => ({ ok: false, code: "io-failed", message: "n/a" }),
      reuseConsumedEntry: async () => ({ ok: false, code: "io-failed", message: "n/a" }),
    }
    const out = await consumeStage1ForPhase2({
      store: throwingStore,
      threadId: "t-1",
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("store_error")
    }
  })

  test("reuseConsumedEntry throws AFTER successful read ⇒ refresh + store_error (no escape)", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    const calls: string[] = []
    const port: Stage1StorePortV2 = {
      write: store.write,
      read: async (id) => {
        calls.push("read")
        return store.read(id)
      },
      incrementUsageCount: async (id) => store.incrementUsageCount(id),
      selectForPhase2: async (ids) => store.selectForPhase2(ids),
      reuseConsumedEntry: async () => {
        calls.push("reuseConsumedEntry")
        throw new Error("consume boom")
      },
    }
    const out = await consumeStage1ForPhase2({
      store: port,
      threadId,
      now: () => generatedAt + 1_000,
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("store_error")
    }
    expect(calls).toEqual(["read", "reuseConsumedEntry"])
  })

  test("reuseConsumedEntry returns ok:false AFTER read ⇒ refresh + store_error (caller does not act on half-mutation)", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    const calls: string[] = []
    const port: Stage1StorePortV2 = {
      write: store.write,
      read: async (id) => {
        calls.push("read")
        return store.read(id)
      },
      incrementUsageCount: async (id) => store.incrementUsageCount(id),
      selectForPhase2: async (ids) => store.selectForPhase2(ids),
      reuseConsumedEntry: async () => {
        calls.push("reuseConsumedEntry")
        return { ok: false, code: "io-failed", message: "disk wedge" }
      },
    }
    const out = await consumeStage1ForPhase2({
      store: port,
      threadId,
      now: () => generatedAt + 1_000,
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("store_error")
    }
    expect(calls).toEqual(["read", "reuseConsumedEntry"])
  })

  test("read returns ok:false ⇒ refresh + no_record (degenerate Stage1Result.ok=false treated as miss)", async () => {
    const failingStore: Stage1StorePortV2 = {
      write: async () => ({ ok: false, code: "io-failed", message: "n/a" }),
      read: async (): Promise<Stage1Result<Stage1Record | null>> => ({
        ok: false,
        code: "io-failed",
        message: "disk wedge",
      }),
      incrementUsageCount: async () => ({ ok: false, code: "io-failed", message: "n/a" }),
      selectForPhase2: async () => ({ ok: false, code: "io-failed", message: "n/a" }),
      reuseConsumedEntry: async () => ({ ok: false, code: "io-failed", message: "n/a" }),
    }
    const out = await consumeStage1ForPhase2({
      store: failingStore,
      threadId: "t-1",
    })
    expect(out.kind).toBe("refresh")
    if (out.kind === "refresh") {
      expect(out.reason).toBe("no_record")
    }
  })
})

describe("consumeStage1ForPhase2 — discriminated outcome shape", () => {
  test("outcome ALWAYS discriminated by kind (reuse|refresh); refresh always carries a reason", async () => {
    const generatedAt = 1_700_000_000_000
    const { store, threadId } = await seedStore({ generatedAt })
    // reuse path
    const reuse = await consumeStage1ForPhase2({
      store,
      threadId,
      now: () => generatedAt + 1_000,
    })
    expect(reuse.kind === "reuse" || reuse.kind === "refresh").toBe(true)
    if (reuse.kind === "reuse") {
      expect(reuse.record).toBeDefined()
      // No `reason` leak on the reuse arm.
      expect("reason" in reuse).toBe(false)
    }
    // refresh path
    const refresh = await consumeStage1ForPhase2({
      store: undefined,
      threadId: "t-1",
    })
    expect(refresh.kind).toBe("refresh")
    if (refresh.kind === "refresh") {
      expect(typeof refresh.reason).toBe("string")
      // No `record` leak on the refresh arm.
      expect("record" in refresh).toBe(false)
    }
  })
})
