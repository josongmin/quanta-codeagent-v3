/**
 * `bun run bench` — SWE-bench Verified harness skeleton + Best-of-N.
 *
 * Composition only (RFC §4 apps/bench): wires the corpus adapter, the runner,
 * and the Best-of-N sampler around a real agent. Targets RFC §1.1 (single
 * trajectory 50% → Best-of-N 70%); the real Python swebench integration is the
 * documented seam in swebench.ts and intentionally out of scope here.
 *
 * Env / argv:
 *   --swebench <file> | QUANTA_SWEBENCH_DATASET    official dataset JSONL
 *                                                  (takes precedence over --corpus)
 *   --predictions <path>                           predictions out (default ./predictions.jsonl)
 *   --report <path>                                report out (default ./bench-report.json)
 *   --corpus <dir> | QUANTA_SWEBENCH_CORPUS_ROOT   corpus root
 *   --n <int>                                      Best-of-N (default 1)
 *   --limit <int>                                  cap instances
 *   --instance <substr>                            select by id substring
 *                                                  (applied before --limit)
 *   --dry-run                                      load+count+print plan, NO LLM
 *   --model <id> | QUANTA_MODEL                    model id
 *   QUANTA_PROVIDER / ANTHROPIC_API_KEY / OPENAI_API_KEY  provider pick
 *   QUANTA_SWEBENCH_PYTHON=1                        grade via official Python
 *                                                  harness when available
 *   --dataset-name <id|jsonl> |                    grading dataset for the
 *     QUANTA_SWEBENCH_DATASET_NAME                  Python harness. Default:
 *                                                   princeton-nlp/SWE-bench_Verified
 *                                                   (decoupled from --swebench,
 *                                                   which is the tasks input)
 * Never crashes when keys are absent — prints guidance and exits 0.
 */
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { AnthropicAdapter, type LLMPort, OpenAIAdapter } from "@/llm"
import { logger } from "@/shared"
import { buildDryRunPlan, formatDryRunPlan } from "./dry-run"
import { aggregate, classify } from "./failure-classifier"
import type { AttemptObservation } from "./observe"
import { resolvedTotals } from "./observe"
import { benchRunDir, benchRunId, benchWorkRoot } from "./paths"
import { isPythonSwebenchAvailable } from "./python-swebench"
import { buildReport, writeReport } from "./report"
import { finalizeRun, runInstance } from "./runner"
import { patchVote, sampleBestOfN } from "./sampler"
import { loadCorpus } from "./swebench"
import {
  defaultExec,
  type Prediction,
  parseSwebenchJsonl,
  prepareTaskRepo,
  type SwebenchTask,
  toInstance,
  writePredictions,
} from "./swebench-dataset"
import type { BenchSummary, Instance, InstanceResult } from "./types"

// ── tiny dotenv (no dependency, first-wins; apps/cli has its own copy) ──────
const unquote = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v

/** Parse one `KEY=VALUE` line into a pair, or null for blanks/comments. */
const parseEnvLine = (raw: string): [string, string] | null => {
  const line = raw.trim()
  if (line === "" || line.startsWith("#")) return null
  const eq = line.indexOf("=")
  if (eq <= 0) return null
  return [line.slice(0, eq).trim(), unquote(line.slice(eq + 1).trim())]
}

const loadEnv = (files: string[]): void => {
  for (const f of files) {
    const p = resolve(process.cwd(), f)
    if (!existsSync(p)) continue
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const pair = parseEnvLine(raw)
      if (pair && process.env[pair[0]] === undefined) process.env[pair[0]] = pair[1]
    }
  }
}

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const argFlag = (flag: string): boolean => process.argv.includes(flag)

type Provider = "anthropic" | "openai"

// Local provider pick — duplicated from apps/cli on purpose (no cross-app import).
const pickProvider = (): Provider => {
  const explicit = process.env.QUANTA_PROVIDER as Provider | undefined
  if (explicit === "anthropic" || explicit === "openai") return explicit
  if (process.env.ANTHROPIC_API_KEY) return "anthropic"
  if (process.env.OPENAI_API_KEY) return "openai"
  return "anthropic"
}

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
}

/** Build the LLM, or null when the provider's key is absent. */
const buildLLM = (provider: Provider, model: string): LLMPort | null => {
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return null
    return new OpenAIAdapter({
      apiKey,
      model,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    })
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  return new AnthropicAdapter({ apiKey, model })
}

/** Compact failure tag for the console FAIL line. Returns "" when the
 *  classification is `passed`. Examples:
 *    `[FAIL][hung_stream:dirty_cache_leak]`
 *    `[FAIL][completed_unresolved:verify_loop_stuck]`
 *    `[FAIL][max_turns_exhausted]` (no signals) */
const failureTag = (r: InstanceResult): string => {
  if (r.passed) return ""
  const c = classify(r)
  if (c.termination === "passed") return ""
  const tail = c.signals.length > 0 ? `:${c.signals.join("+")}` : ""
  return `[${c.termination}${tail}]`
}

const printSummary = (summary: BenchSummary): void => {
  for (const r of summary.results) {
    const verdict = (r.verdict ?? "ok") === "degraded" ? " DEGRADED" : ""
    const mark = r.passed ? "PASS" : "FAIL"
    const tag = failureTag(r)
    const extra = r.error ? ` (${r.error})` : ""
    logger.info(`  [${mark}${verdict}]${tag} ${r.id} (turns=${r.turns})${extra}`)
  }
  // C8: the operator-visible headline uses the SAME degraded-excluding
  // denominator as observe.summarize / summary.json — never results.length.
  const { resolved, total, degraded } = resolvedTotals(summary.results)
  const pct = total === 0 ? 0 : Math.round((resolved / total) * 100)
  const deg = degraded > 0 ? ` (${degraded} degraded)` : ""
  logger.info(`resolved ${resolved}/${total} (${pct}%)${deg}`)
  // Failure-pattern rollup — one line per axis, suppressed when 0 failed.
  const failed = summary.results.filter((r) => !r.passed).map((r) => classify(r))
  if (failed.length === 0) return
  const bd = aggregate(failed)
  const fmt = (obj: Record<string, number>): string =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")
  const termLine = fmt(bd.byTermination)
  if (termLine !== "") logger.info(`failures: ${termLine}`)
  const sigLine = fmt(bd.bySignal)
  if (sigLine !== "") logger.info(`signals: ${sigLine}`)
}

/** Per-run config common to single & Best-of-N. `pythonSwebench` is present
 *  only when `QUANTA_SWEBENCH_PYTHON=1` and the harness is importable. */
type RunCfg = Parameters<typeof runInstance>[1]

/**
 * Run-level observe handle (RFC §8). Resolved ONCE from `--observe-dir` /
 * `QUANTA_OBSERVE_DIR`; undefined ⇒ default-OFF, byte-identical behavior.
 */
interface ObserveCtx {
  dir: string
  runId: string
}

/** Resolve the observe root. Defaults to the PERSISTENT bench runs dir so
 *  trajectories survive across sessions (override with `--observe-dir` /
 *  `QUANTA_OBSERVE_DIR`). */
const resolveObserve = (): ObserveCtx | undefined => {
  const runId = benchRunId()
  const flag = argValue("--observe-dir") ?? process.env.QUANTA_OBSERVE_DIR
  const dir = flag ? resolve(process.cwd(), flag) : join(benchRunDir(runId), "observe")
  return { dir, runId }
}

/** Per-attempt observe handle for one instance (one file per attempt). */
const attemptObs = (
  obs: ObserveCtx | undefined,
  attempt: number,
): AttemptObservation | undefined =>
  obs === undefined ? undefined : { dir: obs.dir, runId: obs.runId, attempt }

const withObserve = (base: RunCfg, o: AttemptObservation | undefined): RunCfg =>
  o === undefined ? base : { ...base, observe: o }

/** Run one instance n times via Best-of-N; pick passing run, then majority
 *  patch vote as a tiebreak among equally-scored runs. Each attempt gets its
 *  own 0-based observe file (RFC §8 Best-of-N: one file per attempt). */
const resolveInstance = async (
  instance: Instance,
  base: Omit<RunCfg, never>,
  n: number,
  obs?: ObserveCtx,
): Promise<InstanceResult> => {
  if (n <= 1) return runInstance(instance, withObserve(base, attemptObs(obs, 0)))

  let attempt = 0
  const out = await sampleBestOfN<InstanceResult>({
    n,
    makeAttempt: () => runInstance(instance, withObserve(base, attemptObs(obs, attempt++))),
    score: (r) => (r.passed ? 1 : 0),
  })

  const passing = out.attempts.filter((a) => a.value?.passed)
  if (passing.length > 1) {
    const vote = patchVote(
      passing.map((a) => ({
        index: a.index,
        score: a.score,
        value: { patch: a.value?.patch ?? "" },
      })),
    )
    const winner = out.attempts.find((a) => a.index === vote.representative.index)
    if (winner?.value) return winner.value
  }
  return out.best.value ?? { id: instance.id, passed: false, patch: "", turns: 0 }
}

/**
 * Official-dataset mode: parse the SWE-bench JSONL, clone+checkout each task's
 * real repo, run the EXISTING `resolveInstance` (Best-of-N unchanged) against
 * it, then emit official predictions.jsonl + a baseline report. A
 * `prepareTaskRepo` failure becomes a failed InstanceResult — the batch is
 * never aborted. Reuses runInstance/Best-of-N verbatim; no run logic is
 * duplicated here.
 */
/** Per-task driver extracted from `runDatasetMode` so the outer function's
 *  cognitive complexity stays under the Biome ceiling. Each task gets a fresh
 *  tmp workdir; a `prepareTaskRepo` failure degrades to a failed result rather
 *  than aborting the batch. */
type SwebenchTaskDeps = {
  llm: LLMPort
  cfg: { n: number; limit?: number; maxTurns: number; timeoutMs: number }
  pythonSwebench: Awaited<ReturnType<typeof buildPythonSwebench>>
  repair: { maxRounds: number } | undefined
  obs: ObserveCtx | undefined
  repoBaseUrl: string
}

const runSwebenchTask = async (
  task: SwebenchTask,
  deps: SwebenchTaskDeps,
): Promise<InstanceResult> => {
  const work = await mkdtemp(join(benchWorkRoot(), `swebench-${task.instanceId}-`))
  const dest = join(work, "repo")
  try {
    await prepareTaskRepo(task, dest, defaultExec, deps.repoBaseUrl, deps.cfg.timeoutMs)
    const instance = toInstance(task, dest)
    return await resolveInstance(
      instance,
      {
        llm: deps.llm,
        maxTurns: deps.cfg.maxTurns,
        timeoutMs: deps.cfg.timeoutMs,
        ...(deps.pythonSwebench !== undefined ? { pythonSwebench: deps.pythonSwebench } : {}),
        ...(deps.repair !== undefined ? { repair: deps.repair } : {}),
      },
      deps.cfg.n,
      deps.obs,
    )
  } catch (e) {
    return {
      id: task.instanceId,
      passed: false,
      patch: "",
      turns: 0,
      error: (e as Error).message,
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

const runDatasetMode = async (
  datasetFile: string,
  llm: LLMPort,
  meta: { provider: string; model: string },
  cfg: { n: number; limit?: number; maxTurns: number; timeoutMs: number },
  obs?: ObserveCtx,
): Promise<void> => {
  const parsed: SwebenchTask[] = parseSwebenchJsonl(readFileSync(datasetFile, "utf8"))
  if (parsed.length === 0) {
    logger.info(
      `No usable tasks parsed from "${datasetFile}". Expecting official SWE-bench JSONL. Nothing to run.`,
    )
    process.exit(0)
  }
  // `--instance <substr>` filters by instance id before the limit slice.
  const instanceFilter = argValue("--instance")
  const tasks =
    instanceFilter !== undefined && instanceFilter !== ""
      ? parsed.filter((t) => t.instanceId.includes(instanceFilter))
      : parsed
  const selected = cfg.limit ? tasks.slice(0, cfg.limit) : tasks

  logger.info(
    `bench(swebench): ${selected.length} task(s), provider=${meta.provider}, model=${meta.model}, n=${cfg.n}`,
  )

  // Official-dataset path MUST wire the Python harness too (the custom-corpus
  // path does at :396). Without this, `deps.pythonSwebench` is always
  // undefined here and runner.verify() silently falls back to the no-op local
  // `testCmd:"true"` — i.e. `--swebench` could never reach real grading.
  const pythonSwebench = await buildPythonSwebench()
  // b2 external repair rounds (ADR-0014). Default-OFF byte-identical: absent
  // ⇒ key omitted from deps ⇒ runner takes single-pass path (G2 gating). Set
  // either via `--repair-rounds <int>` or `QUANTA_REPAIR_ROUNDS`.
  const repairArg = argValue("--repair-rounds") ?? process.env.QUANTA_REPAIR_ROUNDS
  const repair =
    repairArg !== undefined && repairArg !== ""
      ? { maxRounds: Math.max(0, Number(repairArg)) }
      : undefined
  if (repair !== undefined) {
    logger.info(`bench: repair rounds enabled (maxRounds=${repair.maxRounds})`)
  }

  const results: InstanceResult[] = []
  const repoBaseUrl = process.env.QUANTA_SWEBENCH_REPO_BASE_URL ?? "https://github.com/"
  const taskDeps = { llm, cfg, pythonSwebench, repair, obs, repoBaseUrl }
  for (const task of selected) {
    results.push(await runSwebenchTask(task, taskDeps))
  }

  await writeArtifacts(
    argValue("--predictions") ?? join(benchRunDir(benchRunId()), "predictions.jsonl"),
    argValue("--report") ?? join(benchRunDir(benchRunId()), "report.json"),
    results,
    { provider: meta.provider, model: meta.model, n: cfg.n },
  )
  printSummary({ ...resolvedTotals(results), results })
  await finalizeObserve(obs, results)
}

/** D-fix: shared `--predictions` / `--report` writer for both bench modes.
 *  Pure-by-signature (paths + results + meta are explicit args, no argv reads)
 *  so the contract is unit-testable without spawning the CLI. */
export const writeArtifacts = async (
  predictionsFile: string,
  reportFile: string,
  results: InstanceResult[],
  meta: { provider: string; model: string; n: number },
): Promise<void> => {
  const predictions: Prediction[] = results.map((r) => ({
    instance_id: r.id,
    model_name_or_path: meta.model,
    model_patch: r.patch,
  }))
  await writePredictions(predictionsFile, predictions)
  await writeReport(reportFile, buildReport(meta, results))
  logger.info(`wrote ${predictionsFile} (${predictions.length} prediction(s)) and ${reportFile}`)
}

/** Run end (RFC §8): write `<observeDir>/<runId>/{metrics,summary}.json` and
 *  log resolved/total/degraded. No-op when observe is OFF. */
const finalizeObserve = async (
  obs: ObserveCtx | undefined,
  results: InstanceResult[],
): Promise<void> => {
  if (obs === undefined) return
  const summary = await finalizeRun(obs, results)
  logger.info(
    `observe: ${join(obs.dir, obs.runId)} — resolved ${summary.resolved}/${summary.total}` +
      ` (${summary.degraded} degraded)`,
  )
}

/** Resolve provider/model/LLM; exits 0 with guidance when the key is absent
 *  (shared by both modes). `noun` tailors the message. */
const resolveLLM = (noun: string): { provider: Provider; model: string; llm: LLMPort } => {
  const provider = pickProvider()
  const model = argValue("--model") ?? process.env.QUANTA_MODEL ?? DEFAULT_MODEL[provider]
  const llm = buildLLM(provider, model)
  if (!llm) {
    logger.info(
      `Found ${noun} but no API key for provider "${provider}". Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run. Exiting.`,
    )
    process.exit(0)
  }
  return { provider, model, llm }
}

/** Official-dataset entrypoint. Returns true when it handled the run (so main
 *  skips the custom-corpus path entirely). */
const maybeRunDatasetMode = async (
  cfg: {
    n: number
    limitArg?: string
    maxTurns: number
    timeoutMs: number
  },
  obs?: ObserveCtx,
): Promise<boolean> => {
  const datasetFile = argValue("--swebench") ?? process.env.QUANTA_SWEBENCH_DATASET ?? ""
  if (!datasetFile) return false
  if (!existsSync(datasetFile)) {
    logger.info(
      `No SWE-bench dataset at "${datasetFile}". Pass --swebench <dataset.jsonl> or set QUANTA_SWEBENCH_DATASET. Nothing to run.`,
    )
    process.exit(0)
  }
  const { provider, model, llm } = resolveLLM("a dataset")
  await runDatasetMode(
    datasetFile,
    llm,
    { provider, model },
    {
      n: cfg.n,
      ...(cfg.limitArg ? { limit: Number(cfg.limitArg) } : {}),
      maxTurns: cfg.maxTurns,
      timeoutMs: cfg.timeoutMs,
    },
    obs,
  )
  return true
}

/** Build the optional Python-harness wiring for the runner. Returns undefined
 *  unless `QUANTA_SWEBENCH_PYTHON=1` AND the official harness is importable
 *  (probe is real here). Default-off ⇒ the local testCmd path is unchanged. */
const buildPythonSwebench = async (): Promise<RunCfg["pythonSwebench"]> => {
  if (process.env.QUANTA_SWEBENCH_PYTHON !== "1") return undefined
  if (!(await isPythonSwebenchAvailable())) {
    logger.info(
      'QUANTA_SWEBENCH_PYTHON=1 but `python -c "import swebench"` failed — falling back to local testCmd verifier.',
    )
    return undefined
  }
  const datasetName =
    argValue("--dataset-name") ?? process.env.QUANTA_SWEBENCH_DATASET_NAME ?? undefined
  logger.info(
    `using official Python swebench harness for grading (dataset=${datasetName ?? "princeton-nlp/SWE-bench_Verified (default)"})`,
  )
  return datasetName !== undefined ? { opts: { datasetName } } : {}
}

/** Custom-corpus entrypoint (the path when no --swebench dataset is given).
 *  Handles --dry-run (no LLM), empty-corpus + no-key guidance, then runs. */
const runCustomCorpusMode = async (
  cfg: {
    corpusRoot: string
    n: number
    limit: number | null
    maxTurns: number
    timeoutMs: number
  },
  obs?: ObserveCtx,
): Promise<void> => {
  const loaded = await loadCorpus(cfg.corpusRoot)
  // `--instance <substr>` selects by id substring BEFORE the limit slice, so a
  // single repo (e.g. django) can be run without scanning the alphabetical head.
  const instanceFilter = argValue("--instance")
  const all =
    instanceFilter !== undefined && instanceFilter !== ""
      ? loaded.filter((i) => i.id.includes(instanceFilter))
      : loaded
  const pythonHarness = process.env.QUANTA_SWEBENCH_PYTHON === "1"

  // `--dry-run`: load + count + print the plan; NEVER build an LLM or run.
  if (argFlag("--dry-run")) {
    const plan = buildDryRunPlan(cfg.corpusRoot, all, {
      n: cfg.n,
      limit: cfg.limit,
      pythonHarness,
    })
    for (const line of formatDryRunPlan(plan)) logger.info(line)
    process.exit(0)
  }

  if (all.length === 0) {
    logger.info(
      `No corpus found at "${cfg.corpusRoot || "(unset)"}". Set QUANTA_SWEBENCH_CORPUS_ROOT or pass --corpus <dir>. Nothing to run.`,
    )
    process.exit(0)
  }
  const instances = cfg.limit === null ? all : all.slice(0, cfg.limit)

  const { provider, model, llm } = resolveLLM(`${instances.length} instance(s)`)
  const pythonSwebench = await buildPythonSwebench()
  logger.info(
    `bench: ${instances.length} instance(s), provider=${provider}, model=${model}, n=${cfg.n}`,
  )

  const base: RunCfg = {
    llm,
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    ...(pythonSwebench !== undefined ? { pythonSwebench } : {}),
  }
  const results: InstanceResult[] = []
  for (const instance of instances) {
    results.push(await resolveInstance(instance, base, cfg.n, obs))
  }
  // D-fix: write `--predictions` / `--report` from BOTH bench modes.
  await writeArtifacts(
    argValue("--predictions") ?? join(benchRunDir(benchRunId()), "predictions.jsonl"),
    argValue("--report") ?? join(benchRunDir(benchRunId()), "report.json"),
    results,
    { provider, model, n: cfg.n },
  )
  printSummary({ ...resolvedTotals(results), results })
  await finalizeObserve(obs, results)
}

const main = async (): Promise<void> => {
  loadEnv([".env.dev", ".env.local", ".env"])

  const corpusRoot = argValue("--corpus") ?? process.env.QUANTA_SWEBENCH_CORPUS_ROOT ?? ""
  const n = Math.max(1, Number(argValue("--n") ?? "1"))
  const limitArg = argValue("--limit")
  const limit = limitArg ? Number(limitArg) : null
  const maxTurns = Number(process.env.QUANTA_MAX_TURNS ?? "30")
  const timeoutMs = Number(process.env.QUANTA_BENCH_TIMEOUT_MS ?? "120000")
  // Pin the run id ONCE so observe + predictions + report all group under the
  // same persistent `<benchHome>/runs/<runId>/` dir (no per-call Date.now drift).
  process.env.QUANTA_RUN_ID ??= benchRunId()
  // Trajectories persist by default now (the prior tmp default reaped them);
  // pass `--observe-dir`/`QUANTA_OBSERVE_DIR` to override the location.
  const obs = resolveObserve()

  // Official-dataset mode takes precedence; when its flag/env is unset the
  // custom-corpus path is byte-for-byte unchanged.
  if (
    await maybeRunDatasetMode({ n, ...(limitArg ? { limitArg } : {}), maxTurns, timeoutMs }, obs)
  ) {
    return
  }
  await runCustomCorpusMode({ corpusRoot, n, limit, maxTurns, timeoutMs }, obs)
}

main().catch((e) => {
  logger.error(`bench fatal: ${(e as Error).message}`)
  process.exit(1)
})
