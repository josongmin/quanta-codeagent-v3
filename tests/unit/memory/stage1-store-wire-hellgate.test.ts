/**
 * ADR-0207 wire hellgate — `AgentConfig.stage1OutputsStore` slot mirror pattern.
 *
 * The slot is helper-only (caller-side composition); these 3 invariants pin
 * the wire pattern the session-end hook is expected to follow when it
 * mirrors a fresh Phase 1 `Stage1Output` (from `@/memory/consolidate`) into
 * the sibling `Stage1OutputsStore` usage cache:
 *
 *   HELL-S1W-01  default-OFF byte-identical — when the slot is undefined,
 *                the mirror helper is a no-op (no allocation, never throws).
 *   HELL-S1W-02  wired slot: a `distilled` Phase1 outcome triggers exactly
 *                one `put()` call; `get(threadId)` then returns the entry
 *                with `selectedForPhase2:true` (matching the Phase 2
 *                candidate semantics).
 *   HELL-S1W-03  wired slot + `markSelectedForPhase2` follow-up: the entry
 *                surfaces in `list({ selectedForPhase2: true })`.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent/types"
import { InMemoryStage1Store, type Stage1Entry } from "@/memory/stage1-store"

// ----------------------------------------------------------------------------
// harness
// ----------------------------------------------------------------------------

/** Shape returned by `runPhase1` on the success branch (subset of the real
 *  `Stage1Output` — the wire mirror only needs these fields). */
interface Stage1OutputLike {
  readonly threadId: string
  readonly rolloutSlug: string
  readonly rolloutSummary: string
  readonly rawMemory: string
  readonly sourceUpdatedAt: number
}

/** The canonical mirror helper the session-end caller is documented to
 *  invoke after `runPhase1` returns `{kind:"distilled"}`. Helper-only —
 *  extracted so the test asserts the pattern verbatim. */
const mirrorStage1ToSlot = (
  slot: Pick<AgentConfig, "stage1OutputsStore">["stage1OutputsStore"],
  out: Stage1OutputLike,
  generatedAtMs: number,
): void => {
  if (slot === undefined) return
  const entry: Stage1Entry = {
    threadId: out.threadId,
    sourceUpdatedAt: out.sourceUpdatedAt,
    rawMemory: out.rawMemory,
    rolloutSummary: out.rolloutSummary,
    generatedAt: generatedAtMs,
    rolloutSlug: out.rolloutSlug,
    usageCount: 0,
    lastUsage: generatedAtMs,
    selectedForPhase2: true,
  }
  slot.put(entry)
}

// ----------------------------------------------------------------------------
// HELL-S1W-01 default-OFF byte-identical
// ----------------------------------------------------------------------------

describe("HELL-S1W-01 default-OFF byte-identical", () => {
  test("undefined slot ⇒ mirror helper is a silent no-op", () => {
    const cfg: { stage1OutputsStore?: AgentConfig["stage1OutputsStore"] } = {}
    const sampleOut: Stage1OutputLike = {
      threadId: "T1",
      rolloutSlug: "sess",
      rolloutSummary: "sum",
      rawMemory: "raw",
      sourceUpdatedAt: 100,
    }
    expect(() => mirrorStage1ToSlot(cfg.stage1OutputsStore, sampleOut, 100)).not.toThrow()
  })
})

// ----------------------------------------------------------------------------
// HELL-S1W-02 wired slot: distilled phase1 → one put + get returns entry
// ----------------------------------------------------------------------------

describe("HELL-S1W-02 wired slot ⇒ put exactly once + get returns entry", () => {
  test("after mirror, get(threadId) returns the frozen entry with selectedForPhase2:true", () => {
    const now = 100
    const store = new InMemoryStage1Store({ now: () => now })
    const cfg: Pick<AgentConfig, "stage1OutputsStore"> = { stage1OutputsStore: store }
    const sampleOut: Stage1OutputLike = {
      threadId: "T_mirror",
      rolloutSlug: "sess-1",
      rolloutSummary: "rollout-summary",
      rawMemory: "raw-bullets",
      sourceUpdatedAt: 100,
    }
    mirrorStage1ToSlot(cfg.stage1OutputsStore, sampleOut, now)
    const fetched = store.get("T_mirror")
    expect(fetched).not.toBeNull()
    if (!fetched) throw new Error()
    expect(fetched.threadId).toBe("T_mirror")
    expect(fetched.selectedForPhase2).toBe(true)
    expect(fetched.rolloutSummary).toBe("rollout-summary")
    expect(fetched.usageCount).toBe(0)
    expect(Object.isFrozen(fetched)).toBe(true)
    // No advance of the clock between put and get; lastUsage == generatedAt.
    expect(fetched.lastUsage).toBe(100)
    expect(fetched.generatedAt).toBe(100)
    // Unrelated thread untouched.
    expect(store.get("T_unknown")).toBeNull()
    void now
  })

  test("counted store: mirror helper invokes put exactly ONCE per distilled outcome", () => {
    const calls = { put: 0 }
    const counting = new (class extends InMemoryStage1Store {
      override put(e: Stage1Entry): void {
        calls.put += 1
        super.put(e)
      }
    })({ now: () => 1 })
    const cfg: Pick<AgentConfig, "stage1OutputsStore"> = { stage1OutputsStore: counting }
    const out: Stage1OutputLike = {
      threadId: "T_count",
      rolloutSlug: "s",
      rolloutSummary: "s",
      rawMemory: "r",
      sourceUpdatedAt: 1,
    }
    mirrorStage1ToSlot(cfg.stage1OutputsStore, out, 1)
    expect(calls.put).toBe(1)
  })
})

// ----------------------------------------------------------------------------
// HELL-S1W-03 wired slot + markSelectedForPhase2: list filter sees entry
// ----------------------------------------------------------------------------

describe("HELL-S1W-03 wired slot + markSelectedForPhase2 surfaces in list filter", () => {
  test("after mirror + mark, list({selectedForPhase2:true}) returns the entry", () => {
    const store = new InMemoryStage1Store({ now: () => 200 })
    const cfg: Pick<AgentConfig, "stage1OutputsStore"> = { stage1OutputsStore: store }
    mirrorStage1ToSlot(
      cfg.stage1OutputsStore,
      {
        threadId: "T_sel",
        rolloutSlug: "s",
        rolloutSummary: "r",
        rawMemory: "r",
        sourceUpdatedAt: 200,
      },
      200,
    )
    store.markSelectedForPhase2("T_sel", 250)
    const selected = store.list({ selectedForPhase2: true })
    expect(selected.length).toBe(1)
    expect(selected[0]?.threadId).toBe("T_sel")
    expect(selected[0]?.selectedForPhase2SourceUpdatedAt).toBe(250)
  })
})
