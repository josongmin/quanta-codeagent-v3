import { describe, expect, test } from "bun:test"
import type { EvalRecord, GroundingPayload } from "@/../src/apps/eval/storage"
import { buildGroundingReport, evaluateGroundingGate } from "@/../src/apps/eval/grounding"

const payload = (over: Partial<GroundingPayload> = {}): GroundingPayload => ({
  kind: "grounding",
  suite: "canary",
  caseId: "case",
  verdict: "pass",
  bucket: "reference",
  severity: "medium",
  gold: {
    activeThreadId: "prompt_rules",
    referentId: "prompt_rules",
    intent: "status_check",
    scope: "current_workstream",
    shouldClarify: false,
    confidence: "high",
  },
  actual: {
    activeThreadId: "prompt_rules",
    referentId: "prompt_rules",
    intent: "status_check",
    scope: "current_workstream",
    shouldClarify: false,
    confidence: "high",
  },
  matches: {
    activeThread: true,
    referent: true,
    intent: true,
    scope: true,
    shouldClarify: true,
    exactTuple: true,
    wrongThread: false,
    mustClarifyMiss: false,
    staleContextTrapMiss: false,
  },
  rawResponse: "{}",
  durationMs: 10,
  provider: "openai",
  model: "gpt-4.1",
  surfaceId: "openai-responses",
  transportId: "public",
  ...over,
})

const record = (runId: string, p: GroundingPayload): EvalRecord => ({
  ts: 1,
  schema: 1,
  runId,
  tier: "grounding",
  usecase: "persistent-context.conversation-state.thread-grounding",
  payload: p,
})

describe("grounding report", () => {
  test("aggregates metric math and summary-pair equivalence", () => {
    const runId = "run-grounding"
    const records: EvalRecord[] = [
      record(runId, payload({ caseId: "raw", pairId: "pair-1", pairRole: "raw" })),
      record(runId, payload({ caseId: "summary", pairId: "pair-1", pairRole: "summary" })),
      record(
        runId,
        payload({
          caseId: "partial",
          verdict: "partial",
          bucket: "must_clarify",
          gold: {
            activeThreadId: "route_cleanup",
            referentId: null,
            intent: "execute_change",
            scope: "specific_file",
            shouldClarify: true,
            confidence: "high",
          },
          actual: {
            activeThreadId: "route_cleanup",
            referentId: "src/apps/eval/index.ts",
            intent: "execute_change",
            scope: "specific_file",
            shouldClarify: true,
            confidence: "high",
          },
          matches: {
            activeThread: true,
            referent: false,
            intent: true,
            scope: true,
            shouldClarify: true,
            exactTuple: false,
            wrongThread: false,
            mustClarifyMiss: false,
            staleContextTrapMiss: false,
          },
        }),
      ),
      record(
        runId,
        payload({
          caseId: "must-clarify-miss",
          verdict: "fail",
          bucket: "must_clarify",
          gold: {
            activeThreadId: "route_cleanup",
            referentId: null,
            intent: "execute_change",
            scope: "specific_file",
            shouldClarify: true,
            confidence: "high",
          },
          actual: {
            activeThreadId: "route_cleanup",
            referentId: "src/apps/eval/index.ts",
            intent: "execute_change",
            scope: "specific_file",
            shouldClarify: false,
            confidence: "high",
          },
          matches: {
            activeThread: true,
            referent: false,
            intent: true,
            scope: true,
            shouldClarify: false,
            exactTuple: false,
            wrongThread: false,
            mustClarifyMiss: true,
            staleContextTrapMiss: false,
          },
        }),
      ),
      record(
        runId,
        payload({
          caseId: "stale",
          verdict: "fail",
          bucket: "stale_context_trap",
          gold: {
            activeThreadId: "prompt_rules",
            referentId: "prompt_rules",
            intent: "status_check",
            scope: "current_workstream",
            shouldClarify: false,
            confidence: "high",
          },
          actual: {
            activeThreadId: "old_thread",
            referentId: "old_thread",
            intent: "status_check",
            scope: "current_workstream",
            shouldClarify: false,
            confidence: "high",
          },
          matches: {
            activeThread: false,
            referent: false,
            intent: true,
            scope: true,
            shouldClarify: true,
            exactTuple: false,
            wrongThread: true,
            mustClarifyMiss: false,
            staleContextTrapMiss: true,
          },
        }),
      ),
    ]

    const out = buildGroundingReport(records, runId)
    expect(out.report.counts).toEqual({
      pass: 2,
      partial: 1,
      fail: 2,
      error: 0,
      skipped: 0,
    })
    expect(out.report.route).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      surfaceId: "openai-responses",
      transportId: "public",
    })
    expect(out.report.errorKinds).toEqual({})
    expect(out.report.metrics.thread_selection_accuracy).toBe(0.8)
    expect(out.report.metrics.referent_accuracy).toBe(0.4)
    expect(out.report.metrics.intent_accuracy).toBe(1)
    expect(out.report.metrics.scope_accuracy).toBe(1)
    expect(out.report.metrics.clarify_precision).toBe(1)
    expect(out.report.metrics.clarify_recall).toBe(0.5)
    expect(out.report.metrics.wrong_thread_rate).toBe(0.2)
    expect(out.report.metrics.stale_context_attachment_rate).toBe(1)
    expect(out.report.metrics.summary_equivalence_rate).toBe(1)
    expect(out.report.metrics.exact_tuple_match_rate).toBe(0.4)
    expect(out.markdown).toContain("summary_equivalence_rate")
    expect(evaluateGroundingGate(out.report, "canary")).toEqual([
      { metric: "wrong_thread_rate", expected: "== 0", actual: 0.2 },
      { metric: "clarify_recall", expected: "== 1.0", actual: 0.5 },
      { metric: "thread_selection_accuracy", expected: ">= 0.97", actual: 0.8 },
      { metric: "referent_accuracy", expected: ">= 0.95", actual: 0.4 },
      { metric: "exact_tuple_match_rate", expected: ">= 0.90", actual: 0.4 },
    ])
  })

  test("gate fail-closed adds error_count when any case errored", () => {
    const runId = "run-grounding-error"
    const out = buildGroundingReport(
      [
        record(
          runId,
          payload({
            verdict: "error",
            caseId: "infra",
            parseError: "llm stream failed: 401 unauthorized",
            errorKind: "auth",
            matches: {
              activeThread: false,
              referent: false,
              intent: false,
              scope: false,
              shouldClarify: false,
              exactTuple: false,
              wrongThread: false,
              mustClarifyMiss: false,
              staleContextTrapMiss: false,
            },
          }),
        ),
      ],
      runId,
    )
    expect(out.report.errorKinds).toEqual({ auth: 1 })
    expect(evaluateGroundingGate(out.report, "canary")).toEqual([
      { metric: "error_count", expected: "== 0", actual: 1 },
      { metric: "clarify_recall", expected: "== 1.0", actual: 0 },
      { metric: "summary_equivalence_rate", expected: "== 1.0", actual: 0 },
      { metric: "thread_selection_accuracy", expected: ">= 0.97", actual: 0 },
      { metric: "referent_accuracy", expected: ">= 0.95", actual: 0 },
      { metric: "exact_tuple_match_rate", expected: ">= 0.90", actual: 0 },
    ])
  })
})
