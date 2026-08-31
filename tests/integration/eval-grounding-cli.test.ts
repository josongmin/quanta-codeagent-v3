import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GroundingPayload } from "@/../src/apps/eval/storage"
import { ResultStore } from "@/../src/apps/eval/storage"

/** The eval CLI imports the full harness even for argument validation. Bound
 * each hermetic child so a contended full-suite worker cannot leave a blocking
 * `spawnSync` child alive indefinitely; callers receive a diagnostic instead of
 * an opaque `status === null`. */
const EVAL_CLI_CHILD_TIMEOUT_MS = 30_000
const REPO_ROOT = join(import.meta.dir, "..", "..")
const runEval = (...args: string[]) => {
  const out = spawnSync(process.execPath, ["run", "src/apps/eval/index.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: EVAL_CLI_CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  })
  if (out.error !== undefined) {
    throw new Error(
      `eval CLI child failed for ${args.join(" ") || "--help"}: ${out.error.message}\n${out.stderr}`,
    )
  }
  return out
}

const payload = (over: Partial<GroundingPayload> = {}): GroundingPayload => {
  const actual = over.actual ?? {
    activeThreadId: "prompt_rules",
    referentId: "prompt_rules",
    intent: "status_check",
    scope: "current_workstream",
    shouldClarify: false,
    confidence: "high",
  }
  return {
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
    actual,
    scoredActual: over.scoredActual ?? actual,
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
    structuredOutputValid: true,
    durationMs: 10,
    provider: "openai",
    model: "gpt-4.1",
    surfaceId: "openai-responses",
    transportId: "public",
    ...over,
  }
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))

const INVALID_ARGUMENT_CASES = [
  {
    name: "run rejects an invalid suite",
    args: ["grounding", "run", "--suite", "bogus"],
    error: "--suite must be canary or nightly",
  },
  {
    name: "run rejects an invalid corpus",
    args: ["grounding", "run", "--corpus", "bogus"],
    error: "--corpus must be one of",
  },
  {
    name: "run rejects an invalid mode",
    args: ["grounding", "run", "--mode", "bogus"],
    error: "--mode must be one of",
  },
  {
    name: "report requires a run id",
    args: ["grounding", "report"],
    error: "--run-id <id> is required",
  },
  {
    name: "baseline requires a candidate id",
    args: ["grounding", "baseline"],
    error: "--candidate <id> is required",
  },
  {
    name: "gate requires a run id",
    args: ["grounding", "gate", "--profile", "canary"],
    error: "--run-id <id> is required",
  },
  {
    name: "gate rejects an invalid profile",
    args: ["grounding", "gate", "--run-id", "x", "--profile", "nightly"],
    error: "--profile must be one of canary",
  },
  {
    name: "route-matrix gate requires run ids",
    args: ["grounding", "gate", "--route-matrix", "primary-openai", "--profile", "canary"],
    error: "--run-ids <id1,id2,...> is required",
  },
  {
    name: "compare requires both run ids",
    args: ["grounding", "compare", "--baseline", "a"],
    error: "--baseline <id> and --candidate <id> are required",
  },
  {
    name: "scaffold-replay requires its complete input",
    args: ["grounding", "scaffold-replay", "--source", "x"],
    error: "--source, --id, --target-utterance, --bucket, --severity, --out are required",
  },
  {
    name: "promote-replay requires its complete input",
    args: ["grounding", "promote-replay", "--draft", "x"],
    error: "--draft, --gold-json, --corpus, --out are required",
  },
  {
    name: "regress rejects an invalid profile",
    args: ["grounding", "regress", "--baseline", "a", "--candidate", "b", "--profile", "loose"],
    error: "--profile must be one of strict",
  },
  {
    name: "promote-replay rejects an invalid corpus",
    args: [
      "grounding",
      "promote-replay",
      "--draft",
      "x",
      "--gold-json",
      "y",
      "--corpus",
      "bogus",
      "--out",
      "z",
    ],
    error: "--corpus must be replay_critical or replay_nightly",
  },
] as const

describe("eval grounding CLI", () => {
  test(
    "--help includes the grounding subcommands",
    () => {
      const out = runEval("--help")
      expect(out.status).toBe(0)
      expect(out.stdout).toContain("grounding run [--mode raw|engine|assisted]")
      expect(out.stdout).toContain("grounding preflight")
      expect(out.stdout).toContain("grounding report --run-id ID")
      expect(out.stdout).toContain("grounding baseline --candidate ID")
      expect(out.stdout).toContain("grounding gate --route-matrix primary-openai")
      expect(out.stdout).toContain("grounding compare --baseline ID --candidate ID")
      expect(out.stdout).toContain(
        "grounding regress --baseline ID --candidate ID --profile strict",
      )
      expect(out.stdout).toContain("grounding scaffold-replay --source JSONL --out PATH")
      expect(out.stdout).toContain(
        "grounding promote-replay --draft PATH --gold-json PATH --corpus replay_critical|replay_nightly --out PATH",
      )
    },
    EVAL_CLI_CHILD_TIMEOUT_MS,
  )

  test(
    "grounding requires a valid subcommand",
    () => {
      const out = runEval("grounding")
      expect(out.status).toBe(1)
      expect(out.stderr).toContain(
        "eval grounding: subcommand must be one of: run, preflight, report, baseline, gate, compare, regress, scaffold-replay, promote-replay",
      )
    },
    EVAL_CLI_CHILD_TIMEOUT_MS,
  )

  for (const invalid of INVALID_ARGUMENT_CASES) {
    test(
      invalid.name,
      () => {
        const out = runEval(...invalid.args)
        expect(out.status).toBe(1)
        expect(out.stderr).toContain(invalid.error)
      },
      EVAL_CLI_CHILD_TIMEOUT_MS,
    )
  }

  test(
    "grounding run rejects invalid concurrency",
    () => {
      const out = runEval("grounding", "run", "--suite", "canary", "--concurrency", "0")
      expect(out.status).toBe(1)
      expect(out.stderr).toContain("invalid --concurrency 0")
    },
    EVAL_CLI_CHILD_TIMEOUT_MS,
  )

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
            corpus: "canary",
            mode: "engine",
            probeProfile: "runtime_parity",
            normalizationProfile: "structural",
            provider: "openai",
            model: "gpt-4.1",
            surfaceId: "openai-responses",
            transportId: "public",
            harnessFingerprint: "harness-1",
            routeFingerprint: "route-1",
            executionContractFingerprint: "exec-1",
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
        corpus: "canary",
        mode: "engine",
        probeProfile: "runtime_parity",
        normalizationProfile: "structural",
        harnessFingerprint: "harness-1",
        routeFingerprint: "route-1",
        executionContractFingerprint: "exec-1",
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
        corpus: "canary",
        mode: "engine",
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
        corpus: "canary",
        mode: "engine",
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
          corpus: "match",
          mode: "match",
          probeProfile: "match",
          normalizationProfile: "match",
          harness: "match",
          route: "match",
          executionContract: "match",
          caseSet: "match",
          baselineCorpus: "canary",
          candidateCorpus: "canary",
          baselineMode: "engine",
          candidateMode: "engine",
          baselineProbeProfile: "runtime_parity",
          candidateProbeProfile: "runtime_parity",
          baselineNormalizationProfile: "structural",
          candidateNormalizationProfile: "structural",
          baselineHarnessFingerprint: "harness-1",
          candidateHarnessFingerprint: "harness-1",
          baselineRouteFingerprint: "route-1",
          candidateRouteFingerprint: "route-1",
          baselineExecutionContractFingerprint: "exec-1",
          candidateExecutionContractFingerprint: "exec-1",
          baselineCaseSetFingerprint: "cases-1",
          candidateCaseSetFingerprint: "cases-1",
        },
        failures: [],
      })

      const matrixJson = join(artifactsDir, "matrix.json")
      const matrixGate = runEval(
        "grounding",
        "gate",
        "--route-matrix",
        "primary-openai",
        "--run-ids",
        "candidate-run",
        "--profile",
        "canary",
        "--store-dir",
        storeDir,
        "--json-out",
        matrixJson,
      )
      expect(matrixGate.status).toBe(1)
      expect(readJson(matrixJson)).toMatchObject({
        matrix: "primary-openai",
        profile: "canary",
        passed: false,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // Cold-spawns the eval CLI (~13s load) multiple times (baseline→candidate→
    // compare); 5s default timeout is structurally too tight → flaky. Generous bound.
  }, 60_000)
})
