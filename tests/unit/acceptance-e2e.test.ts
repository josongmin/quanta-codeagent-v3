/**
 * SOTA++ Phase-A — FULL-CHAIN e2e through the REAL orchestrator.
 *
 * Drives the actual `runRepairRounds` with a breadth fan-out and the production
 * toggle seam `maybeAcceptanceSelector` as the `selectCandidates` port — exercising
 * ALL six modules composed (toggle → wire → adapter → selectByAcceptance → rerank,
 * + the orchestrator hook) end-to-end. Hermetic: the only injected I/O is a fake
 * `runReproOnPatch` (no LLM, no sandbox, no box). This is the confident local e2e:
 * it proves the chain SELECTS and ADOPTS the acceptance winner inside the loop.
 */

import { describe, expect, test } from "bun:test"
import { maybeAcceptanceSelector } from "@/runner/batch/eval/acceptance-wire"
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

const baseArgs = (over: Partial<RunRepairRoundsArgs>): RunRepairRoundsArgs => ({
  config: { maxRounds: 1, breadth: 3 },
  problem: "fix it",
  runOnce: async () => {
    throw new Error("breadth path: runOnce must not be called")
  },
  validate: async (_a: ValidateArgs): Promise<ValidatorResult> => {
    throw new Error("breadth path: validate must not be called")
  },
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  ...over,
})

describe("acceptance e2e — full chain through runRepairRounds", () => {
  test("acceptance (repro oracle) selects + adopts the repro-passing candidate", async () => {
    const adopted: string[] = []
    const reproSeen: string[] = []
    // All three validator-green; legacy green-first would pick P1. Acceptance picks
    // by the REPRO oracle (P3). P3 is also validator-ok ⇒ the round clears on P3.
    const specs: readonly CandSpec[] = [
      { patch: "P1", validator: { ok: true } },
      { patch: "P2", validator: { ok: true } },
      { patch: "P3", validator: { ok: true } },
    ]
    const selectCandidates = maybeAcceptanceSelector({
      enabled: true,
      runReproOnPatch: async (patch) => {
        reproSeen.push(patch)
        return patch === "P3" // only P3 "resolves" the issue per the repro oracle
      },
    })
    const out = await runRepairRounds(
      baseArgs({
        runCandidates: makeRunCandidatesPort(specs, adopted),
        ...(selectCandidates !== undefined ? { selectCandidates } : {}),
      }),
    )
    // The WHOLE chain ran: every candidate scored once by the repro oracle...
    expect(reproSeen).toEqual(["P1", "P2", "P3"])
    // ...and the acceptance winner (P3, the repro-passing one) was adopted —
    // NOT the legacy green-first P1.
    expect(adopted).toEqual(["P3"])
    expect(out.patch).toBe("P3")
  })

  test("signal interaction (KNOWN): acceptance picks the continuation; the VALIDATOR still gates clear", async () => {
    // Acceptance selects P3 by repro, but P3's validator is RED ⇒ the loop does NOT
    // clear and runs the next round (acceptance = which candidate to continue from;
    // validator = done). Coherent: the loop keeps improving an unvalidated patch.
    const adopted: string[] = []
    const reproSeen: string[] = []
    const specs: readonly CandSpec[] = [
      { patch: "P1", validator: { ok: false } },
      { patch: "P3", validator: { ok: false, failTail: "red" } },
    ]
    const selectCandidates = maybeAcceptanceSelector({
      enabled: true,
      runReproOnPatch: async (patch) => {
        reproSeen.push(patch)
        return patch === "P3"
      },
    })
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 2 }, // round 0 + 1 repair round
        runCandidates: makeRunCandidatesPort(specs, adopted),
        ...(selectCandidates !== undefined ? { selectCandidates } : {}),
      }),
    )
    // Both rounds re-scored (validator never cleared) and both adopted P3.
    expect(reproSeen).toEqual(["P1", "P3", "P1", "P3"])
    expect(adopted).toEqual(["P3", "P3"])
    expect(out.validated).toBe(false)
    expect(out.patch).toBe("P3")
  })

  test("toggle OFF (enabled:false ⇒ no selectCandidates) ⇒ legacy green-first P1", async () => {
    const adopted: string[] = []
    const specs: readonly CandSpec[] = [
      { patch: "P1", validator: { ok: true } },
      { patch: "P2", validator: { ok: true } },
      { patch: "P3", validator: { ok: false } },
    ]
    const selectCandidates = maybeAcceptanceSelector({
      enabled: false,
      runReproOnPatch: async () => true,
    })
    expect(selectCandidates).toBeUndefined()
    const out = await runRepairRounds(
      baseArgs({
        runCandidates: makeRunCandidatesPort(specs, adopted),
        ...(selectCandidates !== undefined ? { selectCandidates } : {}),
      }),
    )
    expect(adopted).toEqual(["P1"]) // legacy validator-rank green-first
    expect(out.patch).toBe("P1")
  })

  test("dual-guard e2e: repro + regression failure count selects min-regression", async () => {
    const adopted: string[] = []
    const specs: readonly CandSpec[] = [
      { patch: "A", validator: { ok: true } },
      { patch: "B", validator: { ok: true } },
    ]
    const selectCandidates = maybeAcceptanceSelector({
      enabled: true,
      runReproOnPatch: async () => true, // both pass repro
      runRegressionOnPatch: async (patch) => (patch === "B" ? 0 : 4), // B has fewer regressions
    })
    const out = await runRepairRounds(
      baseArgs({
        config: { maxRounds: 1, breadth: 2 },
        runCandidates: makeRunCandidatesPort(specs, adopted),
        ...(selectCandidates !== undefined ? { selectCandidates } : {}),
      }),
    )
    expect(adopted).toEqual(["B"]) // min regression failures wins the dual-guard
    expect(out.patch).toBe("B")
  })
})
