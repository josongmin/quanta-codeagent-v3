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
 *   --prepare-images                               pre-build SWE-bench env
 *                                                  images for selected
 *                                                  instances and EXIT (warm
 *                                                  cache for the next run;
 *                                                  requires --swebench)
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
 *
 * Official-harness tuning (only used when QUANTA_SWEBENCH_PYTHON=1; flow
 * through `harness/config.ts → resolveHarnessConfig()`):
 *   QUANTA_SWEBENCH_CACHE_LEVEL    none|base|env|instance — image tiers that
 *                                  survive the run. Default: env (keep base+
 *                                  per-repo env images warm; reused by
 *                                  subsequent instances).
 *   QUANTA_SWEBENCH_CLEAN          true|false — remove images above cache
 *                                  level after the run. Default: false.
 *   QUANTA_SWEBENCH_MAX_WORKERS    positive int — instance-eval parallelism.
 *                                  Default: min(4, 75%cores). Override on
 *                                  beefy hosts (e.g. =8) for larger batches.
 *   QUANTA_SWEBENCH_NAMESPACE      swebench|none|<other> — image registry
 *                                  namespace. Default: arch-aware (arm64 ⇒
 *                                  "swebench" pull, x64 ⇒ "none" local
 *                                  build). Set "none" to force local build,
 *                                  "swebench" to force prebuilt pull.
 *   QUANTA_SWEBENCH_FORCE_REBUILD  true|false — ignore cached images and
 *                                  rebuild. Default: false.
 *   QUANTA_SWEBENCH_PYTHON_BIN     explicit python interpreter path (e.g.
 *                                  /opt/homebrew/bin/python3.11). Default:
 *                                  probe `python` then `python3` on PATH.
 *
 * Never crashes when keys are absent — prints guidance and exits 0.
 */
// Side-effect: register all 12 knobs into the framework registry. MUST come
// before any code path that calls resolveKnobs/knobsForSurface — without
// this import the registry is empty and report/telemetry record nothing.
import "@/runner/knobs/knobs"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { BUDGET_PRESETS } from "@/agent"
import { DEFAULT_MODEL, type LLMPort, type Provider, pickProvider, tryCreateLLM } from "@/llm"
import {
  loadSelectedInstances,
  runBatch,
  selectInstances,
  writeArtifacts as writeBatchArtifacts,
} from "@/runner/batch/core"
import { byteCompare, errMessage, logger, runtimeConfig, setTerminalIo } from "@/shared"
import {
  aggregate,
  benchRunDir,
  benchRunId,
  benchWorkRoot,
  classify,
  defaultExec,
  parseSwebenchJsonl,
  prepareTaskRepo,
  type SwebenchTask,
  toInstance,
} from "./corpus"
import { buildDryRunPlan, formatDryRunPlan } from "./dry-run"
import { finalizeRun, runInstance } from "./eval"
import { isPythonSwebenchAvailable, prepareImages, resolveHarnessConfig } from "./harness"
import type { AttemptObservation } from "./observe"
import { resolvedTotals } from "./observe"
import { evaluateWithPythonSwebench } from "./python-swebench"
import { patchVote, sampleBestOfN } from "./sampler"
import type { BenchSummary, Instance, InstanceResult } from "./types"

setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
})

// ── tiny dotenv (no dependency, first-wins; apps/cli has its own copy) ──────
const unquote = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v

/** Parse one `KEY=VALUE` line into a pair, or null for blanks/comments. A
 *  leading `export ` prefix is stripped (matches apps/cli dotenv). */
const parseEnvLine = (raw: string): [string, string] | null => {
  let line = raw.trim()
  if (line === "" || line.startsWith("#")) return null
  if (line.startsWith("export ")) line = line.slice("export ".length).trimStart()
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

/** Parse a `--flag <int>` argv value as a positive integer. `Number()` returns
 *  NaN on garbage (e.g. `--n abc`) and `Number("")`===0; both used to slip
 *  through the raw `Math.max(1, Number(...))` parses. Returns `fallback` when
 *  the flag is absent OR its value is not a positive integer. */
const argPositiveInt = (flag: string, fallback: number): number => {
  const raw = argValue(flag)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw.trim())) {
    logger.warn(`ignoring invalid ${flag}="${raw}" — must be a positive integer`)
    return fallback
  }
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
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

const logInstanceSummary = (result: InstanceResult): void => {
  const verdictValue = result.verdict ?? "ok"
  const verdict =
    verdictValue === "degraded"
      ? " DEGRADED"
      : verdictValue === "env_prep_failed"
        ? " ENV_PREP_FAILED"
        : ""
  const mark = result.passed ? "PASS" : "FAIL"
  const tag = failureTag(result)
  const extra = result.error ? ` (${result.error})` : ""
  logger.info(`  [${mark}${verdict}]${tag} ${result.id} (turns=${result.turns})${extra}`)
}

const printSummary = (summary: BenchSummary): void => {
  for (const result of summary.results) logInstanceSummary(result)
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
      .sort((a, b) => b[1] - a[1] || byteCompare(a[0], b[0]))
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

/** Injectable exit. Mirrors `apps/agent/index.ts` MainDeps so unit tests can
 *  observe early-exit codes without forking the process. Defaults to
 *  `process.exit` when callers don't provide one. Returns `never` so call
 *  sites can chain `exit(N); return` (a no-op injected exit still falls
 *  through to the `return`, matching agent/index.ts semantics). */
export type ExitFn = (code: number) => never
const defaultExitFn: ExitFn = (code: number): never => {
  process.exit(code)
}

/** Module-private exit binding set by `runMain` at entry. Helpers (resolveLLM /
 *  runDatasetMode / runCustomCorpusMode / maybeRunDatasetMode) read this
 *  instead of calling `process.exit` directly so a single injection point
 *  reaches every site without growing every helper's signature. */
let exitFn: ExitFn = defaultExitFn

/** Test seam — restore the default `process.exit`-backed exit binding between
 *  tests so an injected no-op from one test doesn't leak into the next. */
export const __resetBenchExitForTest = (): void => {
  exitFn = defaultExitFn
}

/** `runMain` deps. `argv` is read straight from `process.argv` today; the
 *  injection seam is here so future tests can pin it without forking. */
export interface MainDeps {
  exit?: ExitFn
}

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
      error: errMessage(e),
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** `--prepare-images` worker: warm the Docker image pool for `instanceIds`
 *  via the official `prepare_images` harness, log the outcome, and return the
 *  process exit code (0 ok / 1 fail). The SOTA win: per-repo env image built
 *  once here, reused by every later instance of that repo. */
const runPrepareImages = async (instanceIds: string[]): Promise<number> => {
  const result = await prepareImages({
    predictionsPath:
      argValue("--predictions") ?? join(benchRunDir(benchRunId()), "predictions.jsonl"),
    runId: benchRunId(),
    instanceIds,
    datasetName: argValue("--dataset-name") ?? "princeton-nlp/SWE-bench_Verified",
    config: resolveHarnessConfig(),
  })
  logger.info(
    `bench: prepare-images ${result.ok ? "OK" : "FAIL"} (preexisting env images: ${result.preexistingEnvImages})`,
  )
  if (!result.ok) logger.info(`prepare log tail:\n${result.log}`)
  return result.ok ? 0 : 1
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
    exitFn(0)
    return
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

  // `--prepare-images`: warm the Docker image pool for the selected instances
  // then EXIT — no LLM, no agent. Exits BEFORE any LLM/agent work below.
  if (argFlag("--prepare-images")) {
    exitFn(await runPrepareImages(selected.map((t) => t.instanceId)))
    return
  }

  // Official-dataset path MUST wire the Python harness too (the custom-corpus
  // path does at :396). Without this, `deps.pythonSwebench` is always
  // undefined here and runner.verify() silently falls back to the no-op local
  // `testCmd:"true"` — i.e. `--swebench` could never reach real grading.
  const pythonSwebench = await buildPythonSwebench()
  // b2 external repair rounds (ADR-0014). Default-OFF byte-identical: absent
  // ⇒ key omitted from deps ⇒ runner takes single-pass path (G2 gating). Set
  // either via `--repair-rounds <int>` or `QUANTA_REPAIR_ROUNDS`.
  const repairArg = argValue("--repair-rounds") ?? process.env.QUANTA_REPAIR_ROUNDS
  // Strict non-negative-int parse: a garbage value (NaN) previously flowed into
  // `Math.max(0, NaN)` === NaN and reached `maxRounds`, silently breaking the
  // repair-round comparison. NaN/negative ⇒ 0 (no repair).
  const repairRounds =
    repairArg !== undefined && /^\d+$/.test(repairArg.trim())
      ? Number.parseInt(repairArg.trim(), 10)
      : 0
  const repair =
    repairArg !== undefined && repairArg !== "" ? { maxRounds: repairRounds } : undefined
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
  await writeBatchArtifacts(predictionsFile, reportFile, results, meta)
  logger.info(`wrote ${predictionsFile} (${results.length} prediction(s)) and ${reportFile}`)
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
 *  (shared by both modes). `noun` tailors the message. The exit is routed
 *  through the injectable `exitFn`; in production this is `process.exit`
 *  (truly `never`) so the post-exit code is unreachable. A test that injects
 *  a no-op exit gets `null` back and the caller bails. */
const resolveLLM = (noun: string): { provider: Provider; model: string; llm: LLMPort } | null => {
  const provider = pickProvider(process.env)
  // `--model` > `QUANTA_MODEL` > canonical DEFAULT_MODEL[provider] (the factory
  // fills the default when `model` is omitted). Provider pick, key lookup, and
  // OPENAI_BASE_URL handling all live in the shared factory now (OCP/DIP).
  const modelArg = argValue("--model") ?? process.env.QUANTA_MODEL
  const llm = tryCreateLLM(provider, modelArg !== undefined ? { model: modelArg } : {}, process.env)
  if (!llm) {
    logger.info(
      `Found ${noun} but no API key for provider "${provider}". Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run. Exiting.`,
    )
    exitFn(0)
    return null
  }
  const model = modelArg ?? DEFAULT_MODEL[provider]
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
    exitFn(0)
    return true
  }
  const resolved = resolveLLM("a dataset")
  if (resolved === null) return true
  const { provider, model, llm } = resolved
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
  return datasetName !== undefined
    ? {
        evaluate: (instance, prediction, opts) =>
          evaluateWithPythonSwebench(
            instance,
            prediction,
            opts as Parameters<typeof evaluateWithPythonSwebench>[2],
          ),
        opts: { datasetName },
      }
    : {
        evaluate: (instance, prediction, opts) =>
          evaluateWithPythonSwebench(
            instance,
            prediction,
            opts as Parameters<typeof evaluateWithPythonSwebench>[2],
          ),
      }
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
  const instanceFilter = argValue("--instance")
  const selection = await loadSelectedInstances({
    corpus: cfg.corpusRoot,
    ...(instanceFilter !== undefined ? { filter: instanceFilter } : {}),
    ...(cfg.limit !== null ? { limit: cfg.limit } : {}),
  })
  // `--instance <substr>` selects by id substring BEFORE the limit slice, so a
  // single repo (e.g. django) can be run without scanning the alphabetical head.
  const all = selectInstances(selection.all, instanceFilter, null)
  const pythonHarness = process.env.QUANTA_SWEBENCH_PYTHON === "1"

  // `--dry-run`: load + count + print the plan; NEVER build an LLM or run.
  if (argFlag("--dry-run")) {
    const plan = buildDryRunPlan(cfg.corpusRoot, all, {
      n: cfg.n,
      limit: cfg.limit,
      pythonHarness,
    })
    for (const line of formatDryRunPlan(plan)) logger.info(line)
    exitFn(0)
    return
  }

  if (all.length === 0) {
    logger.info(
      `No corpus found at "${cfg.corpusRoot || "(unset)"}". Set QUANTA_SWEBENCH_CORPUS_ROOT or pass --corpus <dir>. Nothing to run.`,
    )
    exitFn(0)
    return
  }
  const instances = selection.instances

  const resolved = resolveLLM(`${instances.length} instance(s)`)
  if (resolved === null) return
  const { provider, model, llm } = resolved
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
  const { results } = await runBatch({
    instances,
    runInstance: (instance) => resolveInstance(instance, base, cfg.n, obs),
  })
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

/** Default per-instance wall-clock cap (2 min). Overridable via the
 *  `QUANTA_BENCH_TIMEOUT_MS` runtime-config field (`cfg.benchTimeoutMs`). */
const DEFAULT_BENCH_TIMEOUT_MS = 120_000

/**
 * Test seam — `runMain` accepts an injectable `exit` so unit tests can
 * observe early-exit codes without forking the process. The injection
 * targets the module-private `exitFn` so every nested helper site (4 modes
 * × 7 sites) routes through the same indirection without growing every
 * signature. Defaults to `process.exit` so the CLI entry below is
 * byte-identical to the prior shape.
 *
 * Mirrors `apps/agent/index.ts`'s `runMain(deps: MainDeps)` pattern.
 */
export const runMain = async (deps: MainDeps = {}): Promise<void> => {
  exitFn = deps.exit ?? defaultExitFn
  loadEnv([".env.dev", ".env.local", ".env"])

  const corpusRoot = argValue("--corpus") ?? process.env.QUANTA_SWEBENCH_CORPUS_ROOT ?? ""
  const n = argPositiveInt("--n", 1)
  const limitArg = argValue("--limit")
  // `--limit` is an optional positive-int cap; absent ⇒ no cap. A garbage value
  // (NaN) previously slid through `Number(limitArg)` and produced `slice(0, NaN)`
  // === `slice(0, 0)` (silently selecting ZERO instances). Use the strict parse;
  // `0` (no valid value) ⇒ no cap.
  const limitParsed = limitArg !== undefined ? argPositiveInt("--limit", 0) : 0
  const limit = limitParsed > 0 ? limitParsed : null
  // Pin the run id ONCE so observe + predictions + report all group under the
  // same persistent `<benchHome>/runs/<runId>/` dir (no per-call Date.now
  // drift). MUST be written into env BEFORE the first `runtimeConfig()` read
  // (which freezes `runId`): `benchRunId()` resolves `runtimeConfig().runId`,
  // so we seed env here when unset, then every later `benchRunId()` returns the
  // same pinned id from the frozen config.
  process.env.QUANTA_RUN_ID ??= `run-${Date.now()}`
  // maxTurns / timeoutMs flow through the runtime-config SSOT parser, which
  // rejects NaN-on-garbage (a raw `Number("abc")` used to yield NaN and silently
  // disable the turn cap). Default converges to the canonical batch preset
  // (BUDGET_PRESETS.batch.maxTurns = 60) instead of the prior local `30` drift.
  const cfg = runtimeConfig()
  const maxTurns = cfg.maxTurnsBatch ?? BUDGET_PRESETS.batch.maxTurns ?? 60
  const timeoutMs = cfg.benchTimeoutMs ?? DEFAULT_BENCH_TIMEOUT_MS
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

// Gate the top-level `runMain()` so importing this module (e.g. from
// `tests/unit/bench-write-artifacts.test.ts` for `writeArtifacts`) does NOT
// trigger the CLI entry point. Bun sets `import.meta.main` only for the file
// the runtime started from; unit tests start from `bun test` and never match.
if (import.meta.main) {
  runMain().catch((e) => {
    logger.error(`bench fatal: ${errMessage(e)}`)
    // Top-level fatal still goes through the injectable exit binding so a
    // test that started the CLI with a no-op exit observes the failing code.
    exitFn(1)
  })
}
