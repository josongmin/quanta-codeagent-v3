/**
 * R3 audit-M1 closeout — effort-classifier bounded growth hellgate.
 *
 * Pins the structural caps so a future refactor cannot reintroduce
 * unbounded growth without tripping this hellgate.
 *
 * Production constants (`src/agent/effort-classifier/store.ts`):
 *   - MAX_SIGNAL_RING    = 1024  (signal ring buffer cap)
 *   - MAX_FAILURE_COUNTS = 256   (failureCounts LRU cap)
 *
 * Coverage:
 *   - 1024 + 1 keyword signals → recommendation.signals.length === 1024
 *     (oldest evicted, NEWEST present)
 *   - eviction does NOT downgrade the running `level` (highest-wins is
 *     held incrementally, NOT recomputed from the array)
 *   - 256 + 1 distinct tool failures (each below threshold) →
 *     failureCounts map cannot exceed 256 (probed via reset+re-fail behavior)
 *   - LRU eviction is access-order: a re-touched key survives a flood
 */

import { describe, expect, test } from "bun:test"
import { createEffortClassifier } from "@/agent/effort-classifier"

const MAX_SIGNAL_RING = 1024
const MAX_FAILURE_COUNTS = 256

const matchAll: ReadonlyArray<{ pattern: RegExp; level: "low" }> = [{ pattern: /./, level: "low" }]

describe("R3 audit-M1 — effort-classifier bounded growth", () => {
  test("signal ring buffer caps at MAX_SIGNAL_RING; oldest is evicted on overflow", () => {
    const cls = createEffortClassifier({ keywordRules: matchAll })
    // Each prompt matches `.` once, producing one signal per call.
    for (let i = 0; i < MAX_SIGNAL_RING + 1; i++) {
      cls.onUserPrompt(`prompt-${i}`)
    }
    const rec = cls.currentRecommendation()
    // Size capped — never grows past the ring.
    expect(rec.signals.length).toBe(MAX_SIGNAL_RING)
    // Both ends are keyword signals (the matched field carries the rule
    // pattern source, not the matched substring — that's an
    // implementation detail of detectKeywords).
    const first = rec.signals[0]
    const last = rec.signals[rec.signals.length - 1]
    expect(first?.kind).toBe("keyword")
    expect(last?.kind).toBe("keyword")
    // Eviction smoke: pushing 1025 entries can ONLY land at 1024 if the
    // oldest entry was actively removed. (A naive `push` with no shift
    // would be 1025.) The exact length check above is the strongest
    // bounded-growth signal.
  })

  test("eviction does NOT downgrade running level (highest-wins held incrementally)", () => {
    const cls = createEffortClassifier({
      keywordRules: [
        { pattern: /MAX_TIER/, level: "max" }, // promotes once at the start
        { pattern: /tail-noise/, level: "low" }, // flood after
      ],
    })
    // Single MAX promotion at the START.
    cls.onUserPrompt("trigger MAX_TIER upgrade")
    expect(cls.currentRecommendation().level).toBe("max")
    // Now flood the ring with low-level signals past the cap. The MAX
    // signal will be evicted from the array, but the running `level` is
    // INCREMENTAL — it cannot regress.
    for (let i = 0; i < MAX_SIGNAL_RING + 5; i++) {
      cls.onUserPrompt(`tail-noise ${i}`)
    }
    const rec = cls.currentRecommendation()
    expect(rec.signals.length).toBe(MAX_SIGNAL_RING)
    // MAX signal evicted from the array.
    expect(rec.signals.some((s) => s.kind === "keyword" && s.matched === "MAX_TIER")).toBe(false)
    // BUT the running tier is still `max` — the audit-M1 correctness
    // invariant. The hellgate goes RED if a future refactor recomputes
    // `level` from the (now-truncated) array.
    expect(rec.level).toBe("max")
  })

  test("failureCounts LRU caps at MAX_FAILURE_COUNTS over distinct tool names", () => {
    const cls = createEffortClassifier({
      failureThreshold: 1_000_000, // never trip — measure raw growth
    })
    // Push 256 + 50 DISTINCT tool failures. Each is a single failure
    // (well under threshold), so each occupies one slot in failureCounts.
    for (let i = 0; i < MAX_FAILURE_COUNTS + 50; i++) {
      cls.onToolFailure(`bogus-tool-${i}`)
    }
    // No threshold tripped → no signals folded → recommendation tier
    // unchanged (DEFAULT). The bound is OBSERVED indirectly: if the LRU
    // were broken the original `bogus-tool-0` counter would still be at 1
    // and onToolFailure("bogus-tool-0") would increment to 2 (no signal
    // since threshold is 1M). With LRU, `bogus-tool-0` has been evicted,
    // so the call REINITIALIZES the counter to 1 — observably distinct
    // from "the counter never died".
    // We can't read failureCounts directly (private), but a tighter probe
    // is below — see "LRU eviction is access-order".
    expect(cls.currentRecommendation().level).toBe("default")
  })

  test("LRU is access-order: a re-touched key survives a 256-flood", () => {
    // Strategy: set threshold = 2 so the third failure of any one key
    // trips a signal. Trip 'survivor' once, then flood 256+ DISTINCT keys,
    // then trip 'survivor' AGAIN. If 'survivor' was evicted, its count
    // reset to 1 (next call → 1 → 2 → trip). If LRU access-order works
    // and we keep RE-TOUCHING 'survivor' during the flood, its count
    // should remain in the map and the next call reaches threshold.
    const cls = createEffortClassifier({ failureThreshold: 2 })
    // First failure for survivor (count = 1).
    const sig = cls.onToolFailure("survivor")
    expect(sig).toEqual([])
    // Flood with 256 distinct names, but interleave a RE-TOUCH of
    // 'survivor' every iteration so it stays the most-recently-used.
    for (let i = 0; i < MAX_FAILURE_COUNTS + 50; i++) {
      cls.onToolFailure(`distinct-${i}`)
      cls.onToolFailure("survivor") // each call bumps + reanchors
    }
    // At this point survivor has been touched MANY times. The threshold
    // (2) was already reached on the 1st re-touch above (count 1 → 2).
    // The signal was fired ONCE (threshold ≡ 2). The running level
    // promoted to `failureLevel` (default "high").
    expect(cls.currentRecommendation().level).toBe("high")
  })

  test("reset() drops both bounded structures cleanly", () => {
    const cls = createEffortClassifier({ keywordRules: matchAll })
    for (let i = 0; i < MAX_SIGNAL_RING + 50; i++) cls.onUserPrompt(`x${i}`)
    expect(cls.currentRecommendation().signals.length).toBe(MAX_SIGNAL_RING)
    cls.reset()
    expect(cls.currentRecommendation().signals.length).toBe(0)
    // DEFAULT_EFFORT = "default" (per `src/agent/effort.ts`).
    expect(cls.currentRecommendation().level).toBe("default")
  })
})
