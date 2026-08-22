/**
 * HELLGATE — verify-select silently dropped a REAL candidate patch to EMPTY.
 *
 * PROVEN bug (django__django-11138, run-1782190012887): the verify-select path
 * generated 11 candidate sessions, EVERY one edited the 4 gold files and produced
 * a NON-EMPTY patch in its own fork worktree (`source-captured`, not a capture
 * desync — so the F0 `lost-edits` guard never fires). But NO candidate cleared the
 * hard gates, so `winner === null` ⇒ `selectionWinnerPhase` submitted
 * `winner?.patch ?? ""` = EMPTY, and `classifyOutcome` laundered the empty
 * submission into `real-fail / completed_unresolved` — a MODEL MISS — because the
 * generic no-submittable branch fell through to `classifyByPatchState`.
 *
 * That is a measurement LIE: `completed_unresolved` asserts "a patch was graded
 * and did not resolve", but NOTHING was graded (empty patch) while the model
 * DEMONSTRABLY produced non-empty candidate fixes. Per this project's
 * anti-laundering rule (throttle/empty-patch, lost-edits) it must surface as an
 * INFRA signal routed to retry — never silently counted as a no-fix miss.
 *
 * RED-ON-INJECTION: revert the `selectionDiscardedRealCandidate` wiring in
 * `noWinnerTerminalReasonOf` (driver.ts) OR the matching `SELECTION_DISCARD_RE`
 * branch in `retry-policy.ts` and the "11138 shape" test below flips back to
 * `real-fail / completed_unresolved`.
 *
 * PAIRED CONTROL: the SAME no-winner shape with ZERO real candidates (all empty
 * `files`) is a GENUINE no-patch miss and MUST stay `completed_unresolved`
 * (byte-identical, no spurious retry).
 */
import { describe, expect, test } from "bun:test"
import { terminalAgentResult } from "@/runner/batch/eval/driver"
import { classifyOutcome } from "@/runner/batch/eval/retry-policy"
import type { CandidateTelemetry, SelectionTelemetry } from "@/runner/batch/eval/selection-types"
import type { Instance, InstanceResult } from "@/runner/batch/types"

const INSTANCE: Instance = {
  id: "django__django-11138",
  repoPath: "/tmp/repo",
  problemStatement: "convert_field_to_tz should honor USE_TZ across backends",
  testCmd: "true",
}

const GOLD_FILES = [
  "django/db/backends/mysql/operations.py",
  "django/db/backends/oracle/operations.py",
  "django/db/backends/sqlite3/base.py",
  "django/db/backends/sqlite3/operations.py",
] as const

const realCandidate = (id: string): CandidateTelemetry => ({
  id,
  // Non-empty `files` ⇔ a non-empty patch was captured for this candidate. This
  // is the load-bearing fact: the model produced a real multi-file fix.
  files: [...GOLD_FILES],
  admissible: false,
  score: 0,
  // Hard-rejected by a (false-negative) gate — the candidate was NOT empty.
  reasons: ["hard:patchedResolvedKofN=false"],
})

const emptyCandidate = (id: string): CandidateTelemetry => ({
  id,
  files: [],
  admissible: false,
  score: 0,
  reasons: [],
})

const telemetry = (candidates: readonly CandidateTelemetry[]): SelectionTelemetry => ({
  attempted: candidates.length,
  ownerFiles: [...GOLD_FILES],
  earlyAccepted: false,
  successfulGenerations: candidates.length,
  generationFailures: 0,
  generated: candidates.length,
  admissibleCount: 0,
  winnerId: null,
  candidates,
})

const mkResult = (phase: Record<string, unknown>): InstanceResult =>
  terminalAgentResult({
    instance: INSTANCE,
    phase: {
      patch: "",
      turns: 14,
      stopReason: "completed",
      ...phase,
    } as never,
    reproTest: undefined,
    deps: { llm: {} as never, maxTurns: 14, timeoutMs: 1_000 },
    wiring: {} as never,
    startedAt: 0,
  }) as InstanceResult

describe("verify-select discarded a REAL candidate patch (11138 class)", () => {
  test("RED→GREEN: no-winner with ≥1 non-empty candidate ⇒ infra-fail (retry), NOT completed_unresolved", () => {
    const result = mkResult({
      selectionTelemetry: telemetry([
        realCandidate("cand-0"),
        realCandidate("cand-1"),
        realCandidate("cand-2"),
      ]),
    })

    // The empty submission must NOT be branded as a model miss.
    expect(classifyOutcome(result)).not.toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
    // It is an infra/measurement-hole signal routed to retry.
    expect(classifyOutcome(result).kind).toBe("infra-fail")
    // And the surfaced error names the discard so the campaign can self-diagnose.
    expect(result.error ?? "").toMatch(/discard|no submittable/i)
  })

  test("PAIRED CONTROL: no-winner with ONLY empty candidates ⇒ genuine completed_unresolved (no spurious retry)", () => {
    const result = mkResult({
      selectionTelemetry: telemetry([emptyCandidate("cand-0"), emptyCandidate("cand-1")]),
    })

    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("PAIRED CONTROL: proof-required intentional withhold with real candidates ⇒ NOT reclassified as infra (deliberate)", () => {
    // proof-required mode DELIBERATELY submits nothing when no candidate has an
    // executable positive proof — that withhold is a designed model-discipline
    // outcome, not a capture/laundering hole. It must keep its existing
    // classification (not be hijacked by the discard guard).
    const result = mkResult({
      selectionTelemetry: {
        ...telemetry([realCandidate("cand-0"), realCandidate("cand-1")]),
        proofRequired: true,
        noWinnerReason: "proof_required_missing",
      },
    })

    expect(classifyOutcome(result).kind).not.toBe("infra-fail")
    expect(result.error ?? "").toContain("proof-required mode produced no submittable candidate")
  })

  test("ADVERSARIAL: a real WINNER patch (non-empty) is byte-identically preserved, never touched by the guard", () => {
    const winnerPatch =
      "diff --git a/django/db/backends/mysql/operations.py b/django/db/backends/mysql/operations.py\n" +
      "--- a/django/db/backends/mysql/operations.py\n+++ b/.../operations.py\n+    CONVERT_TZ\n"
    const result = terminalAgentResult({
      instance: INSTANCE,
      phase: {
        patch: winnerPatch,
        turns: 14,
        stopReason: "completed",
        selectionTelemetry: {
          ...telemetry([realCandidate("cand-0")]),
          winnerId: "cand-0",
        },
      } as never,
      reproTest: undefined,
      deps: { llm: {} as never, maxTurns: 14, timeoutMs: 1_000 },
      wiring: {} as never,
      startedAt: 0,
    })

    // winnerId !== null ⇒ terminalAgentResult returns undefined (normal flow).
    expect(result).toBeUndefined()
  })
})
