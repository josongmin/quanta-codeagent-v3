/**
 * T05 / audit C-1 — Stage1 reuse must NOT double-bump `usageCount`.
 *
 * Owning-seam proof: consuming a Stage1 entry for Phase 2 (mark selected +
 * account one read) is ONE semantic operation `reuseConsumedEntry`, so
 * "selection" and "usage accounting" cannot drift apart into a +2.
 *
 * Before this ticket, `consumeStage1ForPhase2` called `incrementUsageCount`
 * (+1) THEN `selectForPhase2` (+1, because the adapter's select ALSO bumped),
 * netting +2 per reuse — silently halving the `maxUsageBeforeRefresh` budget
 * (ADR-0216 cache-freshness contract). This battery pins the single-bump
 * invariant on BOTH adapters and the degenerate / not-found arms.
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { inMemoryStage1Store } from "../in-memory"
import type { Stage1StorePortV2, WriteInput } from "../port"
import { sqliteStage1Store } from "../sqlite"

const SEED: WriteInput = {
  threadId: "thr-1",
  rolloutSlug: "slug",
  rolloutSummary: "summary",
  rawMemory: "- decision",
  preferenceSignals: ["likes-haiku"],
  generatedAt: 1_700_000_000_000,
}

const adapters: ReadonlyArray<readonly [string, () => Stage1StorePortV2]> = [
  ["in-memory", () => inMemoryStage1Store()],
  ["sqlite", () => sqliteStage1Store(new Database(":memory:"))],
]

for (const [name, make] of adapters) {
  describe(`reuseConsumedEntry — ${name}`, () => {
    test("single reuse bumps usageCount by EXACTLY +1 (not +2) and flips selectedForPhase2", async () => {
      const store = make()
      await store.write(SEED)

      const res = await store.reuseConsumedEntry(SEED.threadId)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.value.usageCount).toBe(1)
        expect(res.value.selectedForPhase2).toBe(true)
      }

      // Post-state observed via an independent read — the single source of
      // truth on disk / in the map must also read back +1.
      const after = await store.read(SEED.threadId)
      expect(after.ok).toBe(true)
      if (after.ok && after.value) {
        expect(after.value.usageCount).toBe(1)
        expect(after.value.selectedForPhase2).toBe(true)
      }
    })

    test("N reuses ⇒ usageCount === N (monotonic single-step, never doubling)", async () => {
      const store = make()
      await store.write(SEED)
      for (let i = 1; i <= 4; i += 1) {
        const r = await store.reuseConsumedEntry(SEED.threadId)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.usageCount).toBe(i)
      }
    })

    test("reuse on missing thread ⇒ not-found (no silent create)", async () => {
      const store = make()
      const r = await store.reuseConsumedEntry("ghost")
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("not-found")
    })

    test("empty threadId ⇒ invalid-input (no mutation)", async () => {
      const store = make()
      const r = await store.reuseConsumedEntry("")
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("invalid-input")
    })
  })
}
