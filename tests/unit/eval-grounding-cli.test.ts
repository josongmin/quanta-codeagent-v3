import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ResultStore } from "@/../src/apps/eval/storage"
import type { GroundingPayload } from "@/../src/apps/eval/storage"

const runEval = (...args: string[]) =>
  spawnSync(process.execPath, ["run", "src/apps/eval/index.ts", ...args], {
    cwd: "/Users/songmin/quanta-codeagent-v3",
    encoding: "utf8",
  })

const payload = (over: Partial<GroundingPayload> = {}): GroundingPayload => ({
  kind: "grounding",
  suite: "canary",
  caseId: "case",
  verdict: "pass",
  bucket: "reference",
  severity: "critical",
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

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))

describe("eval grounding CLI", () => {
  test("--help includes the grounding subcommands", () => {
    const out = runEval("--help")
    expect(out.status).toBe(0)
    expect(out.stdout).toContain("grounding run --suite canary|nightly")
    expect(out.stdout).toContain("grounding preflight")
    expect(out.stdout).toContain("grounding report --run-id ID")
    expect(out.stdout).toContain("grounding baseline --candidate ID")
    expect(out.stdout).toContain("grounding compare --baseline ID --candidate ID")
    expect(out.stdout).toContain("grounding regress --baseline ID --candidate ID --profile strict")
  })

  test("grounding requires a valid subcommand", () => {
    const out = runEval("grounding")
    expect(out.status).toBe(1)
    expect(out.stderr).toContain(
      "eval grounding: subcommand must be one of: run, preflight, report, baseline, gate, compare, regress",
    )
  })

  test("grounding run rejects invalid suites and report/gate validate required args", () => {
    const badSuite = runEval("grounding", "run", "--suite", "bogus")
    expect(badSuite.status).toBe(1)
    expect(badSuite.stderr).toContain("--suite must be canary or nightly")

    const missingRunId = runEval("grounding", "report")
    expect(missingRunId.status).toBe(1)
    expect(missingRunId.stderr).toContain("--run-id <id> is required")

    const missingCandidate = runEval("grounding", "baseline")
    expect(missingCandidate.status).toBe(1)
    expect(missingCandidate.stderr).toContain("--candidate <id> is required")

    const missingGateRunId = runEval("grounding", "gate", "--profile", "canary")
    expect(missingGateRunId.status).toBe(1)
    expect(missingGateRunId.stderr).toContain("--run-id <id> is required")

    const badProfile = runEval("grounding", "gate", "--run-id", "x", "--profile", "nightly")
    expect(badProfile.status).toBe(1)
    expect(badProfile.stderr).toContain("--profile must be one of canary")

    const missingCompare = runEval("grounding", "compare", "--baseline", "a")
    expect(missingCompare.status).toBe(1)
    expect(missingCompare.stderr).toContain("--baseline <id> and --candidate <id> are required")

    const badRegressionProfile = runEval(
      "grounding",
      "regress",
      "--baseline",
      "a",
      "--candidate",
      "b",
      "--profile",
      "loose",
    )
    expect(badRegressionProfile.status).toBe(1)
    expect(badRegressionProfile.stderr).toContain("--profile must be one of strict")
  })

  test("grounding run rejects invalid concurrency", () => {
    const out = runEval("grounding", "run", "--suite", "canary", "--concurrency", "0")
    expect(out.status).toBe(1)
    expect(out.stderr).toContain("invalid --concurrency 0")
  })

  test("grounding CLI honors --store-dir and writes structured artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-cli-store-"))
    const storeDir = join(root, "runs")
    const artifactsDir = join(root, "artifacts")
    mkdirSync(artifactsDir, { recursive: true })
    let nowTick = 1_700_000_000_000
    const store = new ResultStore({ dir: storeDir, now: () => nowTick++ })
    try {
      for (const runId of ["baseline-run", "candidate-run"]) {
        await store.append(runId, {
          tier: "grounding",
          usecase: "persistent-context.conversation-state.thread-grounding",
          payload: payload({ caseId: "raw", pairId: "pair-1", pairRole: "raw" }),
        })
        await store.append(runId, {
          tier: "grounding",
          usecase: "persistent-context.conversation-state.thread-grounding",
          payload: payload({
            caseId: "summary",
            bucket: "summary_equivalence",
            pairId: "pair-1",
            pairRole: "summary",
          }),
        })
        await store.append(runId, {
          tier: "grounding",
          usecase: "persistent-context.conversation-state.thread-grounding",
          payload: payload({
            caseId: "clarify",
            bucket: "must_clarify",
            gold: {
              activeThreadId: "prompt_rules",
              referentId: null,
              intent: "clarify_request",
              scope: "current_workstream",
              shouldClarify: true,
              confidence: "high",
            },
            actual: {
              activeThreadId: "prompt_rules",
              referentId: null,
              intent: "clarify_request",
              scope: "current_workstream",
              shouldClarify: true,
              confidence: "high",
            },
          }),
        })
        await store.finish({
          runId,
          tier: "grounding",
          argv: ["grounding", "run", "--suite", "canary"],
          counts: { pass: 3, partial: 0, fail: 0, error: 0, skipped: 0 },
          durationMs: 30,
          status: "finished",
          params: {
            suite: "canary",
            provider: "openai",
            model: "gpt-4.1",
            surfaceId: "openai-responses",
            transportId: "public",
            harnessFingerprint: "harness-1",
            routeFingerprint: "route-1",
            caseSetFingerprint: "cases-1",
          },
        })
      }
      await store.drain()

      const baselineJson = join(artifactsDir, "baseline.json")
      const baseline = runEval(
        "grounding",
        "baseline",
        "--candidate",
        "candidate-run",
        "--store-dir",
        storeDir,
        "--json-out",
        baselineJson,
      )
      expect(baseline.status).toBe(0)
      expect(readJson(baselineJson)).toEqual({
        status: "resolved",
        candidateRunId: "candidate-run",
        baselineRunId: "baseline-run",
        reason: "resolved latest prior finished comparable grounding run",
        suite: "canary",
        harnessFingerprint: "harness-1",
        routeFingerprint: "route-1",
        caseSetFingerprint: "cases-1",
      })

      const reportJson = join(artifactsDir, "report.json")
      const report = runEval(
        "grounding",
        "report",
        "--run-id",
        "candidate-run",
        "--store-dir",
        storeDir,
        "--json-out",
        reportJson,
      )
      expect(report.status).toBe(0)
      expect(readJson(reportJson)).toMatchObject({
        runId: "candidate-run",
        suite: "canary",
        counts: { pass: 3, partial: 0, fail: 0, error: 0, skipped: 0 },
      })

      const gateJson = join(artifactsDir, "gate.json")
      const gate = runEval(
        "grounding",
        "gate",
        "--run-id",
        "candidate-run",
        "--profile",
        "canary",
        "--store-dir",
        storeDir,
        "--json-out",
        gateJson,
      )
      expect(gate.status).toBe(0)
      expect(readJson(gateJson)).toEqual({
        runId: "candidate-run",
        suite: "canary",
        profile: "canary",
        passed: true,
        route: {
          provider: "openai",
          model: "gpt-4.1",
          surfaceId: "openai-responses",
          transportId: "public",
        },
        counts: { pass: 3, partial: 0, fail: 0, error: 0, skipped: 0 },
        failures: [],
      })

      const compareJson = join(artifactsDir, "compare.json")
      const compare = runEval(
        "grounding",
        "compare",
        "--baseline",
        "baseline-run",
        "--candidate",
        "candidate-run",
        "--store-dir",
        storeDir,
        "--json-out",
        compareJson,
      )
      expect(compare.status).toBe(0)
      expect(readJson(compareJson)).toMatchObject({
        baselineRunId: "baseline-run",
        candidateRunId: "candidate-run",
        comparable: true,
      })

      const regressJson = join(artifactsDir, "regress.json")
      const regress = runEval(
        "grounding",
        "regress",
        "--baseline",
        "baseline-run",
        "--candidate",
        "candidate-run",
        "--profile",
        "strict",
        "--store-dir",
        storeDir,
        "--json-out",
        regressJson,
      )
      expect(regress.status).toBe(0)
      expect(readJson(regressJson)).toEqual({
        baselineRunId: "baseline-run",
        candidateRunId: "candidate-run",
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
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
