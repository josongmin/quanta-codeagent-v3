/**
 * T05 / audit C-2,C-3,C-4 — logger no-throw contract is enforced BY
 * CONSTRUCTION.
 *
 * The consolidator hooks document a NO-THROW invariant ("the session-finishing
 * path is never derailed by a consolidator bug" / "every failure path returns
 * an outcome"). Before this ticket the `log?.(...)` call sites had NO guard, so
 * a hostile caller-supplied logger could:
 *   - C-3: throw out of `runMemoryConsolidatorHook` → flip a successful session
 *     span to error in `runAgent`'s finally.
 *   - C-4: reject the Promise of `runMemoryPhase2AutoTrigger`.
 *   - C-2: become a process-level `unhandledRejection` from the background
 *     Phase 2 dispatch microtask.
 *
 * This battery proves a throwing logger NEVER escapes any of the three entry
 * points, and that the OUTCOME the hook computed is still returned intact.
 */

import { describe, expect, test } from "bun:test"
import {
  type ConsolidatorHookInput,
  type Phase2AutoTriggerInput,
  runMemoryConsolidatorHook,
  runMemoryPhase2AutoTrigger,
} from "@/agent/memory-consolidator-hook"

const boom = (): never => {
  throw new Error("hostile logger boom")
}

describe("runMemoryConsolidatorHook — logger no-throw (C-3)", () => {
  test("a throwing logger does NOT escape; the outcome is still returned", async () => {
    // No consolidator config ⇒ deterministic `skipped` outcome; the only way
    // this rejects is if the logger throw escapes.
    const input: ConsolidatorHookInput = {
      sessionOk: true,
      consolidator: undefined,
      sessionId: "s-1",
      rolloutMessages: [],
      turnCount: 10,
    }
    const out = await runMemoryConsolidatorHook(input, boom)
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("consolidator_disabled")
  })
})

describe("runMemoryPhase2AutoTrigger — logger no-throw (C-4)", () => {
  test("a throwing logger does NOT reject the returned Promise", async () => {
    const out = await runMemoryPhase2AutoTrigger({ phase2: undefined }, boom)
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("phase2_disabled")
  })
})

describe("background Phase 2 dispatch — logger no-throw (C-2)", () => {
  test("a throwing completion/error logger cannot become an unhandledRejection", async () => {
    // Capture process-level unhandled rejections during the microtask window.
    const seen: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      seen.push(e)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      // Drive the actual background dispatch: enabled phase2 with a port that
      // resolves, and a logger that throws on EVERY event (scheduled +
      // completed). If the throw escaped the .then/.catch chain it would land
      // as an unhandledRejection.
      const writer = { write: async () => {} }
      const store = {
        // null lastSuccessAt + a high countSince ⇒ pending_count threshold met
        // ⇒ background dispatch fires (the path that .then/.catch the logger).
        getWatermark: async () => ({
          lastSuccessAt: null,
          lastInitAt: null,
          lastConsolidatedCount: 0,
        }),
        countSince: async () => 999,
        fetchSince: async () => [],
      }
      const port = {
        consolidate: async () => ({ memoryMd: "m", rawMemoriesMd: "r", memorySummaryMd: "s" }),
      }
      // Structural port stubs — this test only exercises the no-throw boundary,
      // not the full phase2 contract, so the duck-typed stubs are cast through
      // unknown to the input shape (not `any`, which would disable all checks).
      const phase2 = { enabled: true, port, store, writer } as unknown as NonNullable<
        Phase2AutoTriggerInput["phase2"]
      >
      const out = await runMemoryPhase2AutoTrigger({ phase2 }, boom)
      expect(out.kind === "scheduled" || out.kind === "skipped").toBe(true)
      // Let the queued microtask + its promise chain settle.
      await new Promise((r) => setTimeout(r, 25))
      expect(seen).toEqual([])
    } finally {
      process.removeListener("unhandledRejection", onUnhandled)
    }
  })
})
