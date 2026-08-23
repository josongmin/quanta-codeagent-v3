/**
 * HELLGATE — DedupGate can END a wedged run, not only steer it
 * (aug-23 Grok-Build diff, priority 2)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §10.2. Our `DedupGate`
 * is content-based and default-ON, and in one respect beats the competitor's
 * (a sliding TURN window catches A-B-A-B alternation that their consecutive
 * counter misses). But it only ever STEERS: a blocked call returns a synthetic
 * non-error `tool_result` and the loop continues. A model that keeps re-issuing
 * the same call in a slightly different shape has no brake. Grok Build ends the
 * turn outright at its threshold (`StationarityEnded`).
 *
 * This adds the brake as an OPT-IN ceiling on top of the existing steer.
 *
 * Invariants:
 *
 *  H1  DEFAULT-OFF BYTE-IDENTICAL — with no `hardStopAfter`, a gate that blocks
 *      forever never ends the run. This is the repo's hard invariant and is not
 *      covered for this slot by any ledger entry, so it is pinned here.
 *
 *  H2  FIRES AT THE CEILING — once blocks for one bucket reach `hardStopAfter`,
 *      the condition returns a `TurnFinish`.
 *
 *  H3  NOT BEFORE — at ceiling-1 it must NOT fire (off-by-one is the whole
 *      risk with a counter).
 *
 *  H4  CATEGORIZED HONESTLY — the finish carries `loop.no_progress` under kind
 *      `failed`. It must NOT masquerade as a completion: this whole workstream
 *      exists because stops were being laundered into success.
 *
 *  H5  PAIRED CONTROL — a gate that never blocks never fires the condition, so
 *      the ceiling cannot be "always stop".
 *
 *  H6  PER-BUCKET, NOT GLOBAL — blocks against DIFFERENT buckets do not add up
 *      into a stop. Repeating two different commands alternately is thrash the
 *      window already handles; it is not the wedge this brake is for.
 */

import { describe, expect, test } from "bun:test"
import { DedupGate } from "@/agent/dispatch-dedup"
import { dedupNoProgressCondition } from "@/agent/loop/stop-conditions"
import type { RunAgentContext } from "@/agent/loop/types"

/** Drive a gate to `blocks` blocked verdicts on ONE bucket. The gate blocks
 *  from the 3rd identical call in the general regime (threshold 3). */
const gateBlockedTimes = (blocks: number, key = "same-args"): DedupGate => {
  const gate = new DedupGate()
  let turn = 0
  let seen = 0
  while (seen < blocks) {
    turn += 1
    const verdict = gate.record("read_file", { path: key }, turn)
    if (verdict.blocked) seen += 1
  }
  return gate
}

const ctxWith = (gate: unknown, hardStopAfter?: number): RunAgentContext =>
  ({
    dedupGate: gate,
    cfg: {
      dedupGateConfig: hardStopAfter === undefined ? {} : { hardStopAfter },
    },
  }) as unknown as RunAgentContext

describe("H1 — default-OFF is byte-identical", () => {
  test("no hardStopAfter ⇒ never fires, however many blocks", () => {
    expect(dedupNoProgressCondition(ctxWith(gateBlockedTimes(25)), 25)).toBeUndefined()
  })

  test("an absent gate is a no-op", () => {
    expect(dedupNoProgressCondition(ctxWith(undefined, 2), 9)).toBeUndefined()
  })
})

describe("H2/H3 — the ceiling fires exactly at the threshold", () => {
  test("at the ceiling ⇒ finishes", () => {
    const finish = dedupNoProgressCondition(ctxWith(gateBlockedTimes(3), 3), 12)
    expect(finish).toBeDefined()
    expect(finish?.turns).toBe(12)
  })

  test("one below the ceiling ⇒ does NOT finish", () => {
    expect(dedupNoProgressCondition(ctxWith(gateBlockedTimes(2), 3), 11)).toBeUndefined()
  })
})

describe("H4 — the stop is categorized honestly", () => {
  test("failed / loop.no_progress, never a completion", () => {
    const finish = dedupNoProgressCondition(ctxWith(gateBlockedTimes(3), 3), 12)
    expect(finish?.stopCategory.kind).toBe("failed")
    expect(finish?.stopCategory.reasonCode).toBe("loop.no_progress")
    expect(finish?.reason).not.toBe("completed")
  })
})

describe("H5 — paired control", () => {
  test("a gate that never blocked never fires", () => {
    const gate = new DedupGate()
    gate.record("read_file", { path: "a" }, 1)
    expect(dedupNoProgressCondition(ctxWith(gate, 1), 1)).toBeUndefined()
  })
})

describe("H6 — the ceiling is per-bucket", () => {
  test("blocks spread across two buckets do not sum into a stop", () => {
    const gate = new DedupGate()
    // Two distinct buckets, each driven to exactly ONE blocked verdict.
    for (const key of ["alpha", "beta"]) {
      let turn = 0
      let blocked = 0
      while (blocked < 1) {
        turn += 1
        if (gate.record("read_file", { path: key }, turn).blocked) blocked += 1
      }
    }
    expect(dedupNoProgressCondition(ctxWith(gate, 2), 8)).toBeUndefined()
  })
})
