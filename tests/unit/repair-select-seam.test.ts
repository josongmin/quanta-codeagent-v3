/**
 * jun-28 SOTA++ Phase-A — orchestrator SELECTOR seam.
 *
 * The breadth fan-out's winner is chosen by the injected `selectCandidates` port
 * when present (the driver's acceptance score-once + rerank), else by the legacy
 * validator-rank `selectCandidate`. These teeth pin:
 *   - PORT PRESENT  ⇒ the port's choice is adopted (overrides legacy green-first).
 *   - PORT ABSENT   ⇒ legacy selection (byte-identical default-OFF).
 * Hermetic: mocked candidate generator, no agent / no real fork.
 */

import { describe, expect, test } from "bun:test"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type {
  RepairCandidateOutcome,
  RunOnceResult,
  RunRepairCandidatesArgs,
  RunRepairRoundsArgs,
  ValidateArgs,
  ValidatorResult,
} from "@/runner/batch/eval/repair/types"

interface CandSpec {
  readonly patch: string
  readonly validator: ValidatorResult
}

const makeRunCandidatesPort =
  (specs: readonly CandSpec[], adopted: string[]) =>
  async (_a: RunRepairCandidatesArgs): Promise<readonly RepairCandidateOutcome[]> =>
    specs.map((spec): RepairCandidateOutcome => {
      const run: RunOnceResult = { patch: spec.patch, turns: 1, lastVerifyCmd: "pytest" }
      return {
        run,
        validator: spec.validator,
        adopt: async () => {
          adopted.push(spec.patch)
        },
      }
    })

const throwingRunOnce = async (): Promise<RunOnceResult> => {
  throw new Error("runOnce must NOT be called on the breadth path")
}
const throwingValidate = async (_a: ValidateArgs): Promise<ValidatorResult> => {
  throw new Error("validate must NOT be called on the breadth path")
}

const baseArgs = (over: Partial<RunRepairRoundsArgs>): RunRepairRoundsArgs => ({
  config: { maxRounds: 1, breadth: 3 },
  problem: "fix it",
  runOnce: throwingRunOnce,
  validate: throwingValidate,
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  ...over,
})

// round 0: TWO greens (P1, P3) — legacy green-first would pick P1.
const round0: readonly CandSpec[] = [
  { patch: "P1", validator: { ok: true } },
  { patch: "P2", validator: { ok: false, failTail: "red" } },
  { patch: "P3", validator: { ok: true } },
]

describe("repair selector seam — selectCandidates port", () => {
  test("PORT PRESENT: the injected selector's choice overrides legacy green-first", async () => {
    const adopted: string[] = []
    let sawCandidates = 0
    const out = await runRepairRounds(
      baseArgs({
        runCandidates: makeRunCandidatesPort(round0, adopted),
        // pick P3 (index 2) even though legacy green-first would pick P1 (index 0).
        selectCandidates: async (candidates) => {
          sawCandidates = candidates.length
          return candidates[2] as RepairCandidateOutcome
        },
      }),
    )
    expect(sawCandidates).toBe(3)
    expect(adopted).toEqual(["P3"]) // the port's choice, not legacy P1
    expect(out.patch).toBe("P3")
    expect(out.validated).toBe(true) // P3 is green ⇒ loop clears
  })

  test("PORT ABSENT: legacy green-first selection (byte-identical default-OFF)", async () => {
    const adopted: string[] = []
    const out = await runRepairRounds(
      baseArgs({ runCandidates: makeRunCandidatesPort(round0, adopted) }),
    )
    expect(adopted).toEqual(["P1"]) // legacy picks the FIRST green
    expect(out.patch).toBe("P1")
  })
})
