/**
 * Tier 1 — synthetic micro-bench orchestrator. Discovers scenario files for a
 * target use case (or all), runs each through `runScenario`, judges with
 * `judge`, persists `SyntheticPayload` records, and returns a summary.
 *
 * Scenario discovery is filesystem-driven: `scenarios/<usecase-id>/*.json`.
 * Use cases with no directory are silently skipped — Tier 1 is opt-in per
 * leaf. `eval audit` is the source of truth for absent coverage.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { LLMPort } from "@/llm"
import { errMessage, logger } from "@/shared"
import { DEFAULT_RUNS_DIR, makeRunId, ResultStore } from "../storage"
import type { UseCaseId, Verdict } from "../types"
import { type JudgeVerdict, judge as runJudge } from "./judge"
import { type RunResult, runScenario } from "./runner"
import { loadScenarioFile, type Scenario } from "./scenario"

export { type GenerateOpts, type GenerateResult, generateScenarios } from "./generator"
export type { JudgeVerdict, RunResult, Scenario }
export { runJudge, runScenario }

export interface SyntheticRunOpts {
  /** LLM that drives the agent under test. */
  agent: LLMPort
  /** LLM used as judge (can be the same; usually cheaper). */
  judge: LLMPort
  /** Optional scenarios root override. Default `src/apps/eval/synthetic/scenarios`. */
  scenariosRoot?: string
  /** Restrict to one use case. Absent ⇒ all leaves with a scenarios dir. */
  usecase?: UseCaseId
  /** Override store dir. */
  storeDir?: string
  /** Inject for tests. */
  now?: () => number
  /** Cap per-scenario time. */
  timeoutMs?: number
  /** When true (default), persist a JSONL trajectory + meta sidecar for each
   *  scenario at `<storeDir>/<runId>/<scenarioId>.jsonl`. Tier 3 replay reads
   *  these. Set false to skip the disk write entirely. */
  recordTrajectories?: boolean
}

export interface SyntheticSummary {
  runId: string
  total: number
  counts: Record<Verdict, number>
  durationMs: number
}

const DEFAULT_ROOT = "src/apps/eval/synthetic/scenarios"

const listScenariosForUsecase = (root: string, usecase: UseCaseId): readonly string[] => {
  const dir = join(root, usecase)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .sort()
}

const listAllScenarios = (root: string): readonly string[] => {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const usecase of readdirSync(root).sort()) {
    const full = join(root, usecase)
    if (!statSync(full).isDirectory()) continue
    out.push(...listScenariosForUsecase(root, usecase))
  }
  return out
}

const verdictFor = (run: RunResult, judge: JudgeVerdict): Verdict => {
  // Infrastructure / safety failures are `error`, NOT `fail` — the agent
  // didn't get a fair shot at the rubric.
  if (run.stopReason === "aborted" || run.stopReason === "timeout") return "error"
  if (run.stopReason === "error") return "error"
  // A judge that crashed (stream errored, garbage JSON, partial rubric) sets
  // `judge.error` — record as `error` rather than letting an all-false rubric
  // tank a potentially correct run.
  if (judge.error !== undefined) return "error"
  if (run.forbiddenHit !== undefined) return "fail"
  const passes = judge.rubric.filter((r) => r.pass).length
  if (judge.rubric.length === 0) return "error"
  if (passes === judge.rubric.length) return "pass"
  if (passes > 0) return "partial"
  return "fail"
}

const emptyCounts = (): Record<Verdict, number> => ({
  pass: 0,
  partial: 0,
  fail: 0,
  error: 0,
  skipped: 0,
})

/** Load one scenario file, converting a parse failure into a logged skip.
 *  A unit because the parse try/catch was the outer of TWO stacked try/catches
 *  inside the `for` body — biome charges the nesting, and the `continue` it
 *  needed is what forced them to be stacked rather than sequential. */
const loadScenarioOrWarn = (file: string): Scenario | undefined => {
  try {
    return loadScenarioFile(file)
  } catch (e) {
    logger.warn("eval.synthetic: scenario parse failed", { file, error: errMessage(e) })
    return undefined
  }
}

/** The `runScenario` option bag. A unit because it is nothing but the
 *  `x !== undefined ? { x } : {}` spread cluster that `exactOptionalPropertyTypes`
 *  forces on every optional passthrough; three of them in a row cost more than
 *  the logic around them. */
const buildRunOpts = (
  opts: SyntheticRunOpts,
  recordTo: string | undefined,
): Parameters<typeof runScenario>[1] => ({
  llm: opts.agent,
  ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  ...(recordTo !== undefined ? { recordTo } : {}),
})

/** The persisted synthetic payload for a scenario that actually ran.
 *  Same reason as `buildRunOpts`: a run of optional-field spreads, not logic.
 *  ADR-0087 — fill the additive token/cost fields when the run captured usage.
 *  `costUsd` is dropped for null (unknown model) so the payload stays
 *  byte-identical to the pre-feature path when there's no price. */
const buildSyntheticPayload = (
  scenario: Scenario,
  run: RunResult,
  judged: JudgeVerdict,
  verdict: Verdict,
) => ({
  kind: "synthetic" as const,
  scenarioId: scenario.id,
  verdict,
  score: judged.score,
  rubric: judged.rubric,
  toolsUsed: run.toolsUsed,
  ...(run.forbiddenHit !== undefined ? { forbiddenHit: run.forbiddenHit } : {}),
  durationMs: run.durationMs,
  ...(run.tokens ? { tokens: run.tokens } : {}),
  ...(typeof run.costUsd === "number" ? { costUsd: run.costUsd } : {}),
})

/** Run + judge + persist ONE already-parsed scenario, tallying into `counts`.
 *  A unit because it is the inner try/catch of the loop: everything here is at
 *  the same nesting depth and shares one failure policy (log, count `error`,
 *  still persist a record so the matrix has a row).
 *
 *  `counts` is mutated in place rather than returned so the double-count on a
 *  failing `store.append` (verdict counted, THEN `error` counted) is preserved
 *  exactly as the pre-split loop behaved. */
const runAndRecordScenario = async (
  file: string,
  scenario: Scenario,
  ctx: {
    opts: SyntheticRunOpts
    store: ResultStore
    runId: string
    counts: Record<Verdict, number>
    recordTo: string | undefined
  },
): Promise<void> => {
  const { opts, store, runId, counts } = ctx
  try {
    const run = await runScenario(scenario, buildRunOpts(opts, ctx.recordTo))
    const judged = await runJudge(
      {
        scenario,
        assistantText: run.assistantText,
        toolsUsed: run.toolsUsed,
        turns: run.turns,
        stopReason: run.stopReason,
      },
      { llm: opts.judge },
    )
    const v = verdictFor(run, judged)
    counts[v] += 1
    await store.append(runId, {
      tier: "synthetic",
      usecase: scenario.usecase,
      payload: buildSyntheticPayload(scenario, run, judged, v),
    })
  } catch (e) {
    logger.warn("eval.synthetic: scenario run failed", { file, error: errMessage(e) })
    counts.error += 1
    await store.append(runId, {
      tier: "synthetic",
      usecase: scenario.usecase,
      payload: {
        kind: "synthetic",
        scenarioId: scenario.id,
        verdict: "error",
        rubric: [],
        toolsUsed: [],
        durationMs: 0,
      },
    })
  }
}

/** Run all (or one usecase's) scenarios end-to-end. Returns a summary; full
 *  per-scenario records are in the store under `runId`. */
export const runSynthetic = async (opts: SyntheticRunOpts): Promise<SyntheticSummary> => {
  const start = Date.now()
  const root = opts.scenariosRoot ?? DEFAULT_ROOT
  const files =
    opts.usecase !== undefined
      ? listScenariosForUsecase(root, opts.usecase)
      : listAllScenarios(root)
  const store = new ResultStore({
    ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const runId = makeRunId("synthetic", opts.now)
  const counts = emptyCounts()
  const recordEnabled = opts.recordTrajectories ?? true
  const trajectoryDir = join(opts.storeDir ?? DEFAULT_RUNS_DIR, runId)
  if (recordEnabled) mkdirSync(trajectoryDir, { recursive: true })
  for (const f of files) {
    const scenario = loadScenarioOrWarn(f)
    if (scenario === undefined) continue
    await runAndRecordScenario(f, scenario, {
      opts,
      store,
      runId,
      counts,
      recordTo: recordEnabled ? join(trajectoryDir, `${scenario.id}.jsonl`) : undefined,
    })
  }
  const durationMs = Date.now() - start
  // ADR-0087 — run-level status + reproduction params. `params.model` is the
  // agent LLM id when the port reports one (omitted otherwise so the field stays
  // absent for a model-less double). `status:"finished"` marks the terminal
  // state; the catch-per-scenario above keeps the run itself from throwing.
  const model = opts.agent.model
  await store.finish({
    runId,
    tier: "synthetic",
    argv: process.argv.slice(2),
    counts,
    durationMs,
    status: "finished",
    ...(model !== undefined ? { params: { model } } : {}),
  })
  return { runId, total: files.length, counts, durationMs }
}
