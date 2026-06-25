import { describe, expect, test } from "bun:test"
import { terminalAgentResult } from "@/runner/batch/eval/driver"
import { classifyOutcome } from "@/runner/batch/eval/retry-policy"
import type { Instance, InstanceResult } from "@/runner/batch/types"

const INSTANCE: Instance = {
  id: "inst-terminal",
  repoPath: "/tmp/repo",
  problemStatement: "fix the bug",
  testCmd: "true",
}

const CALIBRATION = {
  goldCalibrated: false,
  falseNegative: false,
  available: false,
  goldVotes: null,
  goldK: null,
} as const

const NO_WINNER_TELEMETRY = {
  attempted: 2,
  ownerFiles: [],
  earlyAccepted: false,
  successfulGenerations: 2,
  generationFailures: 0,
  generated: 1,
  admissibleCount: 0,
  winnerId: null,
  candidates: [],
} as const

const mkMaybeTerminal = (phase: Record<string, unknown>): InstanceResult | undefined =>
  terminalAgentResult({
    instance: INSTANCE,
    phase: {
      patch: "",
      turns: 2,
      selectionTelemetry: NO_WINNER_TELEMETRY,
      reproOracleCalibration: CALIBRATION,
      ...phase,
    } as never,
    reproTest: undefined,
    deps: {
      llm: {} as never,
      maxTurns: 2,
      timeoutMs: 1_000,
    },
    wiring: {} as never,
    startedAt: 0,
  }) as InstanceResult | undefined

const mkTerminal = (phase: Record<string, unknown>): InstanceResult =>
  mkMaybeTerminal(phase) as InstanceResult

describe("terminalAgentResult", () => {
  test("verify-select no-winner stays on the no-patch owner path", () => {
    const result = mkTerminal({ stopReason: "end_turn" })

    expect(result.error).toContain("verify-select produced no submittable candidate")
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(result.reproOracleCalibration).toEqual(CALIBRATION)
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("T5 single-pass red-on-injection: lost-edits captureClass ⇒ error carries capture_lost_edits ⇒ infra-fail (retry)", () => {
    // Single-pass shape (selectionTelemetry undefined, stopReason 'completed', empty
    // patch) — without the captureClass guard this laundered into real-fail/model-miss
    // (the agentless-v1 measurement hole). The guard must surface the marker.
    const result = mkTerminal({
      stopReason: "completed",
      selectionTelemetry: undefined,
      captureClass: "lost-edits",
      agentError: "capture_lost_edits: 2 source edit(s) but empty done-time diff",
      patch: "",
      editCount: 2,
    })
    expect(result.error).toContain("capture_lost_edits")
    expect(classifyOutcome(result).kind).toBe("infra-fail")
  })

  test("paired control: SAME single-pass shape WITHOUT a lost-edits captureClass ⇒ real-fail (byte-identical, no spurious retry)", () => {
    const result = mkTerminal({
      stopReason: "completed",
      selectionTelemetry: undefined,
      patch: "",
    })
    expect(result.error ?? "").not.toContain("capture_lost_edits")
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("proof-required no-winner surfaces proof-miss instead of generic no-submittable wording", () => {
    const result = mkTerminal({
      stopReason: "end_turn",
      selectionTelemetry: {
        ...NO_WINNER_TELEMETRY,
        proofRequired: true,
        noWinnerReason: "proof_required_missing",
      },
    })

    expect(result.error).toContain("proof-required mode produced no submittable candidate")
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("verify-select no-winner preserves max_turns authority from the terminal candidate", () => {
    const result = mkTerminal({
      stopReason: "max_turns",
      agentError: "no patch produced before max turns exhausted (no_patch_exhausted)",
    })

    expect(result.stopReason).toBe("max_turns")
    expect(result.error).toContain("max turns")
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "max_turns_exhausted",
    })
  })

  test("verify-select no-winner preserves budget_exhausted authority from the terminal candidate", () => {
    const result = mkTerminal({
      stopReason: "budget_exhausted",
      agentError: "no patch produced before token budget exhausted (no_patch_exhausted)",
    })

    expect(result.stopReason).toBe("budget_exhausted")
    expect(result.error).toContain("token budget")
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(result.reproOracleCalibration).toEqual(CALIBRATION)
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "budget_exhausted",
    })
  })

  test("verify-select no-winner preserves aborted authority from the terminal candidate", () => {
    const result = mkTerminal({
      stopReason: "aborted",
    })

    expect(result.stopReason).toBe("aborted")
    expect(result.error).toContain("aborted")
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(result.reproOracleCalibration).toEqual(CALIBRATION)
    expect(classifyOutcome(result)).toEqual({
      kind: "timeout",
    })
  })

  test("aborted after edits with empty patch surfaces patch-capture miss as infra", () => {
    // Genuine capture desync: a real SOURCE edit was applied yet the captured
    // diff is empty. sourceAppliedEditCount>0 ⇒ capture miss ⇒ infra-fail/retry.
    const result = mkTerminal({
      stopReason: "aborted",
      editCount: 3,
      sourceAppliedEditCount: 2,
      firstEditFile: "django/db/backends/mysql/operations.py",
    })

    expect(result.error).toContain("patch capture miss")
    expect(classifyOutcome(result)).toEqual({
      kind: "infra-fail",
      reason: "patch capture miss: agent edited files before abort, but final git diff was empty",
    })
  })

  test("aborted after editing ONLY a test/scratch file with empty patch ⇒ timeout, NOT capture-miss/retry", () => {
    // No-source-edit timeout: raw churn happened (a test/scratch file was touched)
    // but ZERO source edits were applied, so the empty captured diff is the real
    // miss — not a capture desync. Gating on sourceAppliedEditCount keeps this out
    // of the infra-fail/retry bucket and lands it in the timeout denominator.
    // TEETH: gating on raw `editCount` (the old over-broad guard) would surface a
    // spurious "patch capture miss" and reclassify this as infra-fail (retry) —
    // this assertion goes RED under that injection.
    const result = mkTerminal({
      stopReason: "aborted",
      editCount: 4,
      sourceAppliedEditCount: 0,
      firstEditFile: "tests/test_operations.py",
    })

    expect(result.error ?? "").not.toContain("patch capture miss")
    expect(classifyOutcome(result)).toEqual({
      kind: "timeout",
    })
  })

  test("hard provider/runtime errors still stay generation-fail even when no candidate won", () => {
    const result = mkTerminal({
      stopReason: "error",
      agentError: "429 Too Many Requests",
    })

    expect(result.stopReason).toBe("error")
    expect(result.error).toBe("429 Too Many Requests")
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(classifyOutcome(result)).toEqual({
      kind: "generation-fail",
      reason: "429 Too Many Requests",
    })
  })

  test("ADVERSARIAL: non-empty max_turns patch is preserved for later verification", () => {
    expect(
      mkMaybeTerminal({
        patch: "diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n+return a + b\n",
        stopReason: "max_turns",
      }),
    ).toBeUndefined()
  })

  test("ADVERSARIAL: non-empty budget_exhausted patch is preserved for later verification", () => {
    expect(
      mkMaybeTerminal({
        patch: "diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n+return a + b\n",
        stopReason: "budget_exhausted",
      }),
    ).toBeUndefined()
  })

  test("ADVERSARIAL: non-empty aborted patch is preserved for later verification", () => {
    expect(
      mkMaybeTerminal({
        patch: "diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n+return a + b\n",
        stopReason: "aborted",
      }),
    ).toBeUndefined()
  })

  test("ADVERSARIAL: non-empty error patch is preserved for later verification", () => {
    expect(
      mkMaybeTerminal({
        patch: "diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n+return a + b\n",
        stopReason: "error",
        agentError: "429 Too Many Requests",
      }),
    ).toBeUndefined()
  })

  test("ADVERSARIAL: non-empty refusal patch is preserved for later verification", () => {
    expect(
      mkMaybeTerminal({
        patch: "diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n+return a + b\n",
        stopReason: "refusal",
        agentError: "policy refusal after edit",
      }),
    ).toBeUndefined()
  })
})
