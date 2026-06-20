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

const mkTerminal = (phase: Record<string, unknown>): InstanceResult =>
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
  }) as InstanceResult

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

  test("verify-select no-winner preserves max_turns authority from the terminal candidate", () => {
    const result = mkTerminal({
      stopReason: "max_turns",
      agentError: "no patch produced before max turns exhausted (no_patch_exhausted)",
    })

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

    expect(result.error).toContain("aborted")
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(result.reproOracleCalibration).toEqual(CALIBRATION)
    expect(classifyOutcome(result)).toEqual({
      kind: "timeout",
    })
  })

  test("hard provider/runtime errors still stay generation-fail even when no candidate won", () => {
    const result = mkTerminal({
      stopReason: "error",
      agentError: "429 Too Many Requests",
    })

    expect(result.error).toBe("429 Too Many Requests")
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(classifyOutcome(result)).toEqual({
      kind: "generation-fail",
      reason: "429 Too Many Requests",
    })
  })
})
