/**
 * BARREL PARITY wiring test — the terminal surface's `./verify-gate` re-export must expose the
 * converge core's full public API, and each re-export must be the LIVE function (not a stale stub).
 * If the thin barrel (`verify-gate.ts`) drifts or the hoist breaks a symbol, this goes RED — so
 * every `./verify-gate` consumer (brain-mode / best-of-n) stays byte-identical after the hoist.
 */
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@/stream"
import {
  buildTaintedRefs,
  comparedToReference,
  deriveVerificationState,
  inspectExerciseEvidence,
  inspectSelfTest,
  isExerciseCommand,
  isSelfTestCommand,
  outputContractVerdict,
  resultObservedOutput,
} from "./verify-gate"

describe("terminal verify-gate barrel re-exports the @/agent/converge core (live)", () => {
  test("every public symbol is present and callable through the barrel", () => {
    for (const fn of [
      comparedToReference,
      inspectExerciseEvidence,
      outputContractVerdict,
      inspectSelfTest,
      deriveVerificationState,
      buildTaintedRefs,
      isExerciseCommand,
      isSelfTestCommand,
      resultObservedOutput,
    ]) {
      expect(typeof fn).toBe("function")
    }
  })

  test("a real verdict flows through the barrel (not a stub) — exercise recognized end to end", () => {
    const events: AgentEvent[] = [
      { type: "tool_call", id: "1", name: "container_exec", input: { command: "./solver in.txt" } },
      {
        type: "tool_result",
        id: "1",
        name: "container_exec",
        ok: true,
        preview: "42",
        exitCode: 0,
      },
    ] as unknown as AgentEvent[]
    expect(inspectExerciseEvidence(events).exercised).toBe(true)
    // taint SSOT is live through the barrel too (laundering refused)
    expect(buildTaintedRefs(["cp /app/tests/golden.csv ref.csv"]).has("ref.csv")).toBe(true)
  })
})
