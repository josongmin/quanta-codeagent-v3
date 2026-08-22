import { describe, expect, test } from "bun:test"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import { buildRepairRoundLlmEvidencePacket } from "@/runner/batch/eval/repair/llm-evidence"
import type {
  BuildRepairContextArgs,
  RunOnceResult,
  ValidateArgs,
  ValidatorResult,
} from "@/runner/batch/eval/repair/types"

/**
 * jun-23 A3 (Unit X handoff #2) — PRODUCER forwards the validator's classified
 * repro/exec outcome into the repair context.
 *
 * Wave 1 made the CONSUMER (`proofStateOf`) map `validationOutcome==="exec_failed"`
 * ⇒ `execution_failed`. But the producer (`validationGateContextOf` in
 * repair/index.ts) never forwarded the validator's classified outcome into
 * `BuildRepairContextArgs.validationOutcome`. Result: in production, an infra/exec
 * crash that the validator already classified as `exec_failed` was coerced to
 * `candidate_red` (a correctness verdict) whenever the exit-code path did not
 * already catch it (e.g. exit code unavailable / not an OS-reserved code).
 *
 * These tests observe the END-TO-END forward: drive the real orchestrator with a
 * validator that classifies a repair round as an exec failure, capture the EXACT
 * args the orchestrator hands to `buildContext`, then render the proof receipt via
 * the SAME builder the production seed uses and assert the proof state is
 * `execution_failed` — NOT `candidate_red`.
 *
 * Teeth (red-without-fix): with the producer NOT forwarding `validationOutcome`,
 * the captured arg is `undefined`, so `proofStateOf` falls back to the exit code.
 * The validator here reports a crash WITHOUT an OS-reserved exit code (the realistic
 * case the exit-code path misses), so the proof state collapses to `candidate_red`
 * and the assertion fails. Forwarding the outcome turns it green.
 */

const railRun: RunOnceResult = {
  patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
  turns: 1,
  lastVerifyCmd: "pytest tests/test_x.py",
}

/** Capture the args the orchestrator passes to buildContext for round ≥1. */
const captureBuildContext = () => {
  const captured: BuildRepairContextArgs[] = []
  return {
    captured,
    buildContext: (a: BuildRepairContextArgs): string => {
      captured.push(a)
      return "seed"
    },
  }
}

const base = {
  problem: "fix the crash",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  runOnce: async (_seed: string | undefined): Promise<RunOnceResult> => railRun,
}

describe("jun-23 A3 producer — validator exec-failure outcome forwarded into repair context", () => {
  test("EXEC-1: validator classifies the round as exec_failed ⇒ context.validationOutcome ⇒ proof state execution_failed (end-to-end, not candidate_red)", async () => {
    const cap = captureBuildContext()
    // Round 0 fails so the loop builds a round-1 context (where buildContext is
    // called). The validator reports an INFRA crash: reproOutcome "exec_failed"
    // but the observed exit code is an ORDINARY nonzero (1), so the legacy
    // exit-code-only path would mislabel it candidate_red.
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "ImportError: cannot import name 'thing'",
      reproOutcome: "exec_failed",
      observed: { stdout: "ImportError", stderr: "", exitCode: 1 },
    })
    await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      buildContext: cap.buildContext,
      validate,
    })

    // The orchestrator built a round-1 context.
    expect(cap.captured.length).toBeGreaterThanOrEqual(1)
    const ctx = cap.captured[0]
    if (ctx === undefined) throw new Error("no context captured")

    // SOURCED from the validator's classification (not inferred here).
    expect(ctx.validationOutcome).toBe("exec_failed")

    // End-to-end: the SAME production builder renders an INFRA proof receipt.
    const packet = buildRepairRoundLlmEvidencePacket(ctx)
    const receipt = packet.proofReceipts?.[0]
    expect(receipt).toBeDefined()
    expect(receipt?.state).toBe("execution_failed")
    expect(receipt?.state).not.toBe("candidate_red")
  })

  test("EXEC-2 (paired control): a REAL candidate regression (validator NOT exec_failed) still maps to candidate_red", async () => {
    const cap = captureBuildContext()
    // Same shape, but the validator classifies the failure as a genuine repro
    // verdict ("reproduced" — the bug is still present), an ordinary assertion
    // failure (exit 1). This MUST stay candidate_red — forwarding must not blanket
    // every failure into execution_failed.
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "AssertionError: expected 2 got 1",
      reproOutcome: "reproduced",
      observed: { stdout: "Issue reproduced", stderr: "", exitCode: 1 },
    })
    await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      buildContext: cap.buildContext,
      validate,
    })

    const ctx = cap.captured[0]
    if (ctx === undefined) throw new Error("no context captured")
    expect(ctx.validationOutcome).toBe("reproduced")

    const packet = buildRepairRoundLlmEvidencePacket(ctx)
    const receipt = packet.proofReceipts?.[0]
    expect(receipt?.state).toBe("candidate_red")
  })

  test("EXEC-3: no explicit reproOutcome ⇒ no marker-derived validationOutcome is forwarded", async () => {
    const cap = captureBuildContext()
    // The validator omits reproOutcome. The producer must not infer one from
    // observed stdout/exit code: the sidecar/validator classification is the
    // authority, and legacy marker projection is not a fallback.
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "Segmentation fault",
      observed: { stdout: "no markers here", stderr: "", exitCode: 2 },
    })
    await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      buildContext: cap.buildContext,
      validate,
    })

    const ctx = cap.captured[0]
    if (ctx === undefined) throw new Error("no context captured")
    expect(ctx.validationOutcome).toBeUndefined()

    const packet = buildRepairRoundLlmEvidencePacket(ctx)
    expect(packet.proofReceipts?.[0]?.state).toBe("candidate_red")
  })
})
