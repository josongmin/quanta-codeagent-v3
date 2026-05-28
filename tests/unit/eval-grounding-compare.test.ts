import { describe, expect, test } from "bun:test"
import type { EvalRecord, GroundingPayload, RunSummaryRecord } from "@/../src/apps/eval/storage"
import {
  buildGroundingComparison,
  buildGroundingRegressionResult,
  buildGroundingReport,
  evaluateGroundingRegression,
} from "@/../src/apps/eval/grounding"

const payload = (over: Partial<GroundingPayload> = {}): GroundingPayload => ({
  kind: "grounding",
  suite: "canary",
  caseId: "case",
  verdict: "pass",
  bucket: "reference",
  severity: "high",
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

const summary = (
  runId: string,
  counts: RunSummaryRecord["counts"],
  params: RunSummaryRecord["params"],
): RunSummaryRecord => ({
  ts: 1,
  schema: 1,
  runId,
  tier: "grounding",
  argv: [],
  counts,
  durationMs: 100,
  status: "finished",
  ...(params !== undefined ? { params } : {}),
})

describe("grounding compare", () => {
  test("computes run-to-run metric deltas and strict regression failures", () => {
    const baselineRunId = "baseline-run"
    const candidateRunId = "candidate-run"
    const records: EvalRecord[] = [
      record(baselineRunId, payload({ caseId: "a", severity: "critical" })),
      record(
        baselineRunId,
        payload({
          caseId: "b",
          severity: "high",
          bucket: "must_clarify",
          gold: {
            activeThreadId: "prompt_rules",
            referentId: null,
            intent: "clarify_request",
            scope: "specific_file",
            shouldClarify: true,
            confidence: "high",
          },
          actual: {
            activeThreadId: "prompt_rules",
            referentId: null,
            intent: "clarify_request",
            scope: "specific_file",
            shouldClarify: true,
            confidence: "high",
          },
        }),
      ),
      record(
        candidateRunId,
        payload({
          caseId: "a",
          severity: "critical",
          verdict: "partial",
          actual: {
            activeThreadId: "prompt_rules",
            referentId: "other_thread",
            intent: "status_check",
            scope: "current_workstream",
            shouldClarify: false,
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
        candidateRunId,
        payload({
          caseId: "b",
          severity: "high",
          bucket: "must_clarify",
          verdict: "error",
          actual: {
            activeThreadId: "prompt_rules",
            referentId: null,
            intent: "clarify_request",
            scope: "specific_file",
            shouldClarify: false,
            confidence: "high",
          },
          matches: {
            activeThread: true,
            referent: true,
            intent: true,
            scope: true,
            shouldClarify: false,
            exactTuple: false,
            wrongThread: false,
            mustClarifyMiss: true,
            staleContextTrapMiss: false,
          },
          parseError: "llm stream failed: 401 unauthorized",
          errorKind: "auth",
        }),
      ),
    ]

    const baseline = buildGroundingReport(
      records,
      baselineRunId,
      summary(
        baselineRunId,
        { pass: 2, partial: 0, fail: 0, error: 0, skipped: 0 },
        {
          suite: "canary",
          harnessFingerprint: "harness-1",
          provider: "openai",
          model: "gpt-4.1",
          surfaceId: "openai-responses",
          transportId: "public",
          routeFingerprint: "route-1",
          caseSetFingerprint: "cases-1",
        },
      ),
    ).report
    const candidate = buildGroundingReport(
      records,
      candidateRunId,
      summary(
        candidateRunId,
        { pass: 0, partial: 1, fail: 0, error: 1, skipped: 0 },
        {
          suite: "canary",
          harnessFingerprint: "harness-1",
          provider: "openai",
          model: "gpt-4.1",
          surfaceId: "openai-responses",
          transportId: "public",
          routeFingerprint: "route-1",
          caseSetFingerprint: "cases-1",
        },
      ),
    ).report
    const out = buildGroundingComparison(baseline, candidate)

    expect(out.comparison.comparability).toEqual({
      suite: "match",
      harness: "match",
      route: "match",
      caseSet: "match",
      baselineHarnessFingerprint: "harness-1",
      candidateHarnessFingerprint: "harness-1",
      baselineRouteFingerprint: "route-1",
      candidateRouteFingerprint: "route-1",
      baselineCaseSetFingerprint: "cases-1",
      candidateCaseSetFingerprint: "cases-1",
    })
    expect(out.comparison.metricDeltas.exact_tuple_match_rate).toEqual({
      baseline: 1,
      candidate: 0,
      delta: -1,
    })
    expect(out.comparison.regressions).toHaveLength(2)
    expect(out.comparison.changes.map((change) => [change.caseId, change.kind])).toEqual([
      ["a", "regressed"],
      ["b", "regressed"],
    ])
    expect(out.markdown).toContain("## Buckets")

    expect(evaluateGroundingRegression(out.comparison, "strict")).toEqual([
      {
        kind: "error_count_increase",
        message: "candidate introduced additional harness errors",
        baseline: 0,
        candidate: 1,
      },
      {
        kind: "clarify_recall_decrease",
        message: "clarify recall decreased",
        baseline: 1,
        candidate: 0,
      },
      {
        kind: "referent_accuracy_decrease",
        message: "referent accuracy decreased",
        baseline: 1,
        candidate: 0.5,
      },
      {
        kind: "exact_tuple_match_rate_decrease",
        message: "exact tuple match rate decreased",
        baseline: 1,
        candidate: 0,
      },
      {
        kind: "critical_bucket_regression",
        message: "reference critical bucket regressed on exact_tuple_match_rate",
        bucket: "reference",
        severity: "critical",
        baseline: 1,
        candidate: 0,
      },
      {
        kind: "critical_bucket_regression",
        message: "reference critical bucket regressed on referent_accuracy",
        bucket: "reference",
        severity: "critical",
        baseline: 1,
        candidate: 0,
      },
      {
        kind: "case_regression",
        message: "a regressed pass -> partial",
        caseId: "a",
        bucket: "reference",
        severity: "critical",
        baseline: "pass",
        candidate: "partial",
      },
      {
        kind: "case_regression",
        message: "b regressed pass -> error",
        caseId: "b",
        bucket: "must_clarify",
        severity: "high",
        baseline: "pass",
        candidate: "error",
      },
    ])
  })

  test("regression output exposes dedicated pass/fail authority", () => {
    const runId = "same-run"
    const records: EvalRecord[] = [
      record(runId, payload({ caseId: "raw", pairId: "pair-1", pairRole: "raw", severity: "critical" })),
      record(
        runId,
        payload({
          caseId: "summary",
          pairId: "pair-1",
          pairRole: "summary",
          bucket: "summary_equivalence",
          severity: "critical",
        }),
      ),
    ]
    const baseline = buildGroundingReport(
      records,
      runId,
      summary(
        runId,
        { pass: 2, partial: 0, fail: 0, error: 0, skipped: 0 },
        {
          suite: "canary",
          harnessFingerprint: "harness-1",
          routeFingerprint: "route-1",
          caseSetFingerprint: "cases-1",
        },
      ),
    ).report
    const candidate = buildGroundingReport(
      records,
      runId,
      summary(
        runId,
        { pass: 2, partial: 0, fail: 0, error: 0, skipped: 0 },
        {
          suite: "canary",
          harnessFingerprint: "harness-1",
          routeFingerprint: "route-1",
          caseSetFingerprint: "cases-1",
        },
      ),
    ).report
    const comparison = buildGroundingComparison(baseline, candidate)
    const regression = buildGroundingRegressionResult(comparison.comparison, "strict")
    expect(regression.result).toEqual({
      baselineRunId: runId,
      candidateRunId: runId,
      profile: "strict",
      passed: true,
      comparable: true,
      comparability: {
        suite: "match",
        harness: "match",
        route: "match",
        caseSet: "match",
        baselineHarnessFingerprint: "harness-1",
        candidateHarnessFingerprint: "harness-1",
        baselineRouteFingerprint: "route-1",
        candidateRouteFingerprint: "route-1",
        baselineCaseSetFingerprint: "cases-1",
        candidateCaseSetFingerprint: "cases-1",
      },
      failures: [],
    })
    expect(regression.markdown).toContain("# Grounding Regression Gate")
    expect(regression.markdown).toContain("Status: PASS")
    expect(regression.markdown).toContain("## Failures")
  })

  test("strict regression gate fails on case-set mismatch", () => {
    const baselineRunId = "baseline-missing"
    const candidateRunId = "candidate-missing"
    const records: EvalRecord[] = [
      record(baselineRunId, payload({ caseId: "only-baseline" })),
      record(candidateRunId, payload({ caseId: "only-candidate" })),
    ]
    const out = buildGroundingComparison(
      buildGroundingReport(
        records,
        baselineRunId,
        summary(
          baselineRunId,
          { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
          {
            suite: "canary",
            harnessFingerprint: "harness-1",
            routeFingerprint: "route-1",
            caseSetFingerprint: "cases-1",
          },
        ),
      ).report,
      buildGroundingReport(
        records,
        candidateRunId,
        summary(
          candidateRunId,
          { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
          {
            suite: "canary",
            harnessFingerprint: "harness-1",
            routeFingerprint: "route-1",
            caseSetFingerprint: "cases-1",
          },
        ),
      ).report,
    )
    expect(out.comparison.comparable).toBe(false)
    expect(evaluateGroundingRegression(out.comparison, "strict")).toEqual([
      {
        kind: "case_set_mismatch",
        message: "only-baseline is missing in candidate",
        caseId: "only-baseline",
        bucket: "reference",
        severity: "high",
      },
      {
        kind: "case_set_mismatch",
        message: "only-candidate is new in candidate",
        caseId: "only-candidate",
        bucket: "reference",
        severity: "high",
      },
    ])
  })

  test("strict regression gate fails on route or case fingerprint mismatch", () => {
    const baselineRunId = "baseline-fingerprint"
    const candidateRunId = "candidate-fingerprint"
    const records: EvalRecord[] = [
      record(baselineRunId, payload({ caseId: "shared" })),
      record(candidateRunId, payload({ caseId: "shared" })),
    ]
    const out = buildGroundingComparison(
      buildGroundingReport(
        records,
        baselineRunId,
        summary(
          baselineRunId,
          { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
          {
            suite: "canary",
            harnessFingerprint: "harness-a",
            routeFingerprint: "route-a",
            caseSetFingerprint: "cases-a",
          },
        ),
      ).report,
      buildGroundingReport(
        records,
        candidateRunId,
        summary(
          candidateRunId,
          { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
          {
            suite: "canary",
            harnessFingerprint: "harness-b",
            routeFingerprint: "route-b",
            caseSetFingerprint: "cases-b",
          },
        ),
      ).report,
    )
    expect(out.comparison.comparable).toBe(false)
    expect(evaluateGroundingRegression(out.comparison, "strict")).toEqual([
      {
        kind: "harness_mismatch",
        message: "baseline and candidate harness fingerprints differ",
        baseline: "harness-a",
        candidate: "harness-b",
      },
      {
        kind: "route_mismatch",
        message: "baseline and candidate route fingerprints differ",
        baseline: "route-a",
        candidate: "route-b",
      },
      {
        kind: "case_fingerprint_mismatch",
        message: "baseline and candidate case-set fingerprints differ",
        baseline: "cases-a",
        candidate: "cases-b",
      },
    ])
  })

  test("strict regression gate fails closed when fingerprints are missing", () => {
    const baselineRunId = "baseline-unverified"
    const candidateRunId = "candidate-unverified"
    const records: EvalRecord[] = [
      record(baselineRunId, payload({ caseId: "shared" })),
      record(candidateRunId, payload({ caseId: "shared" })),
    ]
    const out = buildGroundingComparison(
      buildGroundingReport(records, baselineRunId).report,
      buildGroundingReport(records, candidateRunId).report,
    )
    expect(out.comparison.comparable).toBe(false)
    expect(evaluateGroundingRegression(out.comparison, "strict")).toEqual([
      {
        kind: "harness_unverified",
        message: "missing harness fingerprints; comparison is not structurally verifiable",
        baseline: "unknown",
        candidate: "unknown",
      },
      {
        kind: "route_unverified",
        message: "missing route fingerprints; comparison is not structurally verifiable",
        baseline: "unknown",
        candidate: "unknown",
      },
      {
        kind: "case_fingerprint_unverified",
        message: "missing case-set fingerprints; comparison is not structurally verifiable",
        baseline: "unknown",
        candidate: "unknown",
      },
    ])
  })
})
