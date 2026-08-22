/**
 * Bench local-run composition root — the `runMain` pipeline extracted verbatim
 * from `apps/bench/index.ts` (which now re-exports the public surface and keeps
 * only the dotenv shim + the `import.meta.main` OTel boot entry).
 *
 * Owns: CLI-arg parsing, env defaulting, run-id seeding, runtimeConfig
 * resolution, observe-path wiring, dataset-vs-custom mode selection, and the
 * per-instance run composition (Best-of-N, fork branches, Python harness
 * wiring, artifact + observe finalization).
 *
 * See `index.ts` for the full env/argv contract documentation.
 */
// Side-effect: register all 12 knobs into the framework registry. MUST come
// before any code path that calls resolveKnobs/knobsForSurface — without
// this import the registry is empty and report/telemetry record nothing.
import "@/runner/knobs/knobs"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { BUDGET_PRESETS } from "@/agent"
import { DEFAULT_MODEL, type LLMPort, type Provider, pickProvider, tryCreateLLM } from "@/llm"
import {
  loadSelectedInstances,
  mapWithConcurrency,
  runBatch,
  selectInstances,
} from "@/runner/batch/core"
import { writeClosureSidecar } from "@/runner/batch/eval/closure-diagnostics-io"
import { makeReproArtifactFsSink } from "@/runner/batch/eval/repro-artifacts-fs"
import { runBatchWithHealth } from "@/runner/batch/eval/run-health"
import type { RunHealthSummary } from "@/runner/batch/report"
import { errMessage, gateOn, logger, runtimeConfig } from "@/shared"
import { resolveBenchmarkRunConfig } from "./benchmark-suite"
import {
  benchInstanceWorkSlug,
  benchRunDir,
  benchRunId,
  benchWorkRoot,
  defaultExec,
  prepareTaskRepo,
} from "./corpus"
import type { DatasetFamily } from "./dataset-family-token"
import { buildDatasetDryRunPlan, buildDryRunPlan, formatDryRunPlan } from "./dry-run"
import { runInstance } from "./eval"
import { type ForkBranchOutcome, formatForkBranchReport } from "./eval/fork-branch-report"
import { type ForkExperiment, resolveForkExperiments } from "./eval/fork-experiments"
import { startHostResourceSampler } from "./host-resource-sampler"
import { startLaneProgressRenderer } from "./lane-progress-renderer"
import { resolveModelLanes } from "./model-lanes"
import { resolvedTotals } from "./observe"
import { seedBenchExecutionPreset } from "./preset"
import { resolveDatasetFamilyProfile } from "./profiles/registry"
import { buildPythonSwebench } from "./python-verifier-wiring"
import {
  resolveBenchReasoningSummary,
  resolveBenchReasoningSummaryDetail,
} from "./reasoning-summary"
import {
  argFlag,
  argPositiveInt,
  argValue,
  loadEnv,
  repairConfigFromArg,
  resolveConcurrency,
} from "./run-args"
import { datasetFamilyOrDefault, readDatasetFamilySelector } from "./run-config"
import {
  attemptObs,
  buildSwebenchArtifactMeta,
  filterSwebenchTasks,
  finalizeObserve,
  readSwebenchTasks,
  resolveObserve,
  runPrepareImages,
  type SwebenchRunnableRow,
  withBenchInstanceRoot,
  withObserve,
  writeArtifacts,
} from "./run-main-helpers"
import { printHelp, printPresetList, printSummary } from "./run-report"
import { patchVote, sampleBestOfN } from "./sampler"
import {
  applyBenchTrajectoryMode,
  replayTrajectoryPort,
  resolveBenchTrajectoryMode,
} from "./trajectory"
import type { Instance, InstanceResult } from "./types"

export { repairConfigFromArg } from "./run-args"
export { writeArtifacts } from "./run-main-helpers"

/** Per-run config common to single & Best-of-N. `pythonSwebench` is present
 *  only when `QUANTA_SWEBENCH_PYTHON=1` and the harness is importable. */
export type RunCfg = Parameters<typeof runInstance>[1]

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

/** Accessor so the `index.ts` `import.meta.main` boot block routes its
 *  top-level fatal through the SAME (possibly injected) exit binding that
 *  `runMain` set — preserving the prior single-module behavior. */
export const currentBenchExitFn = (): ExitFn => exitFn

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
 * `QUANTA_OBSERVE_DIR`.
 *
 * NOTE (audit 2026-07): observe is effectively DEFAULT-ON — `resolveObserve`
 * always returns a handle (falls back to `<benchRunDir>/observe`), it never
 * returns undefined. The old "undefined ⇒ default-OFF, byte-identical" contract
 * no longer holds; the `| undefined` return type is kept only for the type seam.
 */
export interface ObserveCtx {
  dir: string
  runId: string
}

/** Run one instance n times via Best-of-N; pick passing run, then majority
 *  patch vote as a tiebreak among equally-scored runs. Each attempt gets its
 *  own 0-based observe file (RFC §8 Best-of-N: one file per attempt). */
/** Fork-experiment fan-out (RFC jun-23): run each named experiment as its own
 *  branch over the SAME instance, each with a FRESH llm port (replay isolation)
 *  and its own `turnContextMutator`, then print a comparison table. Returns the
 *  baseline (first) branch's result so the surrounding pipeline keeps one result
 *  per instance. Branches run sequentially — replay branches are ~free and live
 *  branches must not fan out concurrently (throttle). */
const runForkBranches = async (
  instance: Instance,
  base: Omit<RunCfg, never>,
  experiments: readonly ForkExperiment[],
  freshLlm: () => LLMPort,
  obs?: ObserveCtx,
): Promise<InstanceResult> => {
  // Footgun guard: fan-out is a TROUBLESHOOTING mode. The pipeline keeps ONE
  // result per instance (the baseline branch), so predictions.jsonl / report.json
  // reflect ONLY the baseline — the other branches live in the printed table.
  // Say so loudly so a fan-out run is never mistaken for a real benchmark number.
  logger.info(
    `[fork] ${instance.id}: ${experiments.length}-branch experiment (${experiments
      .map((e) => e.name)
      .join(", ")}) — predictions/report record the BASELINE branch only; see the table below.`,
  )
  const outcomes: ForkBranchOutcome[] = []
  let baseline: InstanceResult | undefined
  let attempt = 0
  for (const exp of experiments) {
    const branchBase: RunCfg = { ...base, llm: freshLlm(), turnContextMutator: exp.mutator }
    const a = attempt++
    // C5 bench-attempt root: one root span (fresh trace) per fork branch, so each
    // branch's sandbox→agent→verify sits under its own `quanta.bench.instance`.
    const result = await withBenchInstanceRoot({ instanceId: instance.id, attempt: a }, () =>
      runInstance(instance, withObserve(branchBase, attemptObs(obs, a))),
    )
    if (baseline === undefined) baseline = result
    outcomes.push({
      name: exp.name,
      passed: result.passed,
      patchBytes: Buffer.byteLength(result.patch ?? "", "utf8"),
      turns: result.turns,
    })
  }
  logger.info(`\n${formatForkBranchReport(instance.id, outcomes)}`)
  return baseline ?? { id: instance.id, passed: false, patch: "", turns: 0 }
}

const resolveInstance = async (
  instance: Instance,
  base: Omit<RunCfg, never>,
  n: number,
  obs?: ObserveCtx,
  freshLlm?: (attempt?: number) => LLMPort,
): Promise<InstanceResult> => {
  // Fork-experiment seam (DEFAULT-OFF: QUANTA_FORK_EXPERIMENT unset ⇒ [] ⇒
  // byte-identical). ≥2 names ⇒ branch fan-out; exactly 1 ⇒ single run with that
  // mutator wired onto the config.
  const experiments = resolveForkExperiments(process.env)
  if (experiments.length >= 2) {
    return runForkBranches(instance, base, experiments, freshLlm ?? (() => base.llm), obs)
  }
  const only = experiments[0]
  // When a freshLlm factory is provided (e.g. instance-bound trajectory port),
  // swap base.llm so every runInstance call uses the bound port. For n=1,
  // no attempt suffix (attempt=undefined). For n>1, each makeAttempt passes
  // its own 0-based index so trajectory files get a -aN suffix.
  const effBase: Omit<RunCfg, never> =
    only !== undefined ? { ...base, turnContextMutator: only.mutator } : base

  if (n <= 1) {
    const cfg = freshLlm !== undefined ? { ...effBase, llm: freshLlm() } : effBase
    // C5 bench-attempt root: single-pass ⇒ attempt 0 (the `.0.jsonl` file).
    return withBenchInstanceRoot({ instanceId: instance.id, attempt: 0 }, () =>
      runInstance(instance, withObserve(cfg, attemptObs(obs, 0))),
    )
  }

  let attempt = 0
  const out = await sampleBestOfN<InstanceResult>({
    n,
    makeAttempt: () => {
      const a = attempt++
      // C5 bench-attempt root: one root span (FRESH trace) per Best-of-N attempt,
      // so N attempts of one instance carry DISTINCT trace ids (never merged) and
      // each attempt's `quanta.instance.attempt` matches its `.<a>.jsonl` file.
      return withBenchInstanceRoot({ instanceId: instance.id, attempt: a }, () =>
        runInstance(
          instance,
          withObserve(
            freshLlm !== undefined ? { ...effBase, llm: freshLlm(a) } : effBase,
            attemptObs(obs, a),
          ),
        ),
      )
    },
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
  /** Fresh-port factory for fork-branch replay isolation (RFC jun-23 §4.1).
   *  Accepts an optional ctx so trajectory recordings are labeled with the
   *  instance/run that produced them. */
  freshLlm: (ctx?: { instanceId?: string; runId?: string }) => LLMPort
  /** G1 — verify-select model lanes (≥2 distinct-model ports) or undefined.
   *  Threaded onto the per-instance `RunInstanceDeps.llmLanes`. Undefined ⇒
   *  byte-identical single-port path. */
  llmLanes?: readonly LLMPort[]
  cfg: { n: number; limit?: number; maxTurns: number; timeoutMs: number; family: DatasetFamily }
  pythonSwebench: Awaited<ReturnType<typeof buildPythonSwebench>>
  repair: { maxRounds: number } | undefined
  obs: ObserveCtx | undefined
  repoBaseUrl: string
}

const prepareSwebenchWorkDir = async (
  task: SwebenchRunnableRow,
): Promise<{ readonly work: string; readonly dest: string }> => {
  const opaqueInstance = benchInstanceWorkSlug(task.instanceId)
  if (!gateOn(process.env, "QUANTA_BENCH_RESUME")) {
    const work = await mkdtemp(join(benchWorkRoot(), `swebench-${opaqueInstance}-`))
    return { work, dest: join(work, "repo") }
  }
  const work = join(benchWorkRoot(), opaqueInstance)
  const dest = join(work, "repo")
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  return { work, dest }
}

const runSwebenchTask = async (
  task: SwebenchRunnableRow,
  deps: SwebenchTaskDeps,
): Promise<InstanceResult> => {
  // B1 (jun-27-bench-spot-resume-s3.md): when resume is ON, mint a
  // DETERMINISTIC instance-scoped checkout path so a partial cassette recorded
  // on box A replays HIT on box B (the random mkdtemp suffix otherwise embeds in
  // the agent cwd → prompt → content-hash mismatch → replay MISS). Pre-existing
  // path (local re-run) is wiped first so resume re-executes against a CLEAN
  // checkout. Read the env gate inline with the canonical truthy vocab so
  // ""/"0"/"off" = OFF; default OFF is byte-identical (random mkdtemp). Resume
  // assumes workers=1 / chunk-size=1 (Tier-0 default) — a deterministic path
  // loses mkdtemp's uniqueness, so concurrent same-instance runs would collide;
  // no locking is added.
  // The `work` parent is removed in finally so checkout + wrapper disappear.
  const { work, dest } = await prepareSwebenchWorkDir(task)
  // Live progress to run.log: under concurrency the per-instance result line is
  // emitted only at the END of the batch (all in-flight at once → ~15min silence
  // mid-run). A START line + an inline DONE line make each instance's lifecycle
  // visible via `tail -f ~/run.log` while the box is working.
  const startedAt = Date.now()
  logger.info(`▶ ${task.instanceId} — repo prep → patch-gen → grade …`)
  // Bind instanceId + runId into freshLlm so every trajectory turn recorded
  // for this task carries its instance/run label in metadata. The ctx is
  // metadata-only — does not affect the cassette hash or replay semantics.
  const instanceFreshLlm = (attempt?: number): LLMPort =>
    deps.freshLlm({
      instanceId: task.instanceId,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(deps.obs?.runId !== undefined ? { runId: deps.obs.runId } : {}),
    })
  try {
    // PMX-02: repository preparation gets the NARROW checkout spec and the
    // Instance is built by the FAMILY's own closure — so a family whose corpus
    // ships gold inline has no route from the dataset file to `Instance`.
    await prepareTaskRepo(
      task.task.checkout,
      dest,
      defaultExec,
      deps.repoBaseUrl,
      deps.cfg.timeoutMs,
    )
    const instance = task.task.toInstance(dest)
    // A1 (jun-28): persist per-candidate repro artifacts UNDER the observe dir so
    // they ride the full-remote observe tarball. Rides the EXISTING observe opt-in
    // (no new knob): no observe handle ⇒ no sink ⇒ no-op (default-OFF).
    const reproArtifactSink =
      deps.obs !== undefined
        ? makeReproArtifactFsSink(join(deps.obs.dir, deps.obs.runId))
        : undefined
    const reproArtifactRootPath =
      deps.obs !== undefined ? join(deps.obs.dir, deps.obs.runId) : undefined
    const result = await resolveInstance(
      instance,
      {
        // Bind the instance's PRIMARY port to `instanceFreshLlm()` (not the
        // shared `deps.llm`) so EVERY phase of this run — localize / repro /
        // repair — records into ONE per-instance cassette
        // (`trajectories/<ts>-<instanceId>.jsonl` + `.meta.json`) with its
        // instanceId stamped in each record's metadata. This makes one FILE =
        // one SESSION (SWE-agent-style), instead of every instance appending to
        // a single shared blob the viewer then has to heuristically re-split.
        // Off/replay modes ignore the ctx ⇒ byte-identical to `deps.llm` there.
        llm: instanceFreshLlm(),
        maxTurns: deps.cfg.maxTurns,
        timeoutMs: deps.cfg.timeoutMs,
        ...(reproArtifactSink !== undefined ? { reproArtifactSink } : {}),
        ...(reproArtifactRootPath !== undefined ? { reproArtifactRootPath } : {}),
        // G1 — present ONLY when ≥2 distinct-model lanes resolved (knob ON +
        // credentialed). Omitted ⇒ key absent ⇒ byte-identical single-port path.
        ...(deps.llmLanes !== undefined ? { llmLanes: deps.llmLanes } : {}),
        ...(deps.pythonSwebench !== undefined ? { pythonSwebench: deps.pythonSwebench } : {}),
        ...(deps.pythonSwebench !== undefined && instance.goldPatch !== undefined
          ? { goldSanity: { mode: "on-fail" } }
          : {}),
        ...(deps.repair !== undefined ? { repair: deps.repair } : {}),
      },
      deps.cfg.n,
      deps.obs,
      instanceFreshLlm,
    )
    const secs = Math.round((Date.now() - startedAt) / 1000)
    const mark = result.passed ? "PASS" : "FAIL"
    const bytes = result.patch?.length ?? 0
    logger.info(
      `■ ${task.instanceId} ${mark} — patch=${bytes}B turns=${result.turns} ${secs}s${result.error ? ` (${result.error.slice(0, 60)})` : ""}`,
    )
    return result
  } catch (e) {
    const secs = Math.round((Date.now() - startedAt) / 1000)
    logger.info(`■ ${task.instanceId} ERROR ${secs}s — ${errMessage(e).slice(0, 80)}`)
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

const executeSwebenchTasks = async (
  selected: readonly SwebenchRunnableRow[],
  concurrency: number,
  taskDeps: SwebenchTaskDeps,
): Promise<{ readonly results: InstanceResult[]; readonly runHealth?: RunHealthSummary }> => {
  const stopLaneProgress = startLaneProgressRenderer()
  try {
    if (concurrency > 1) {
      return {
        results: await mapWithConcurrency(selected, concurrency, (task) =>
          runSwebenchTask(task, taskDeps),
        ),
      }
    }
    const out = await runBatchWithHealth({
      instances: selected,
      env: process.env,
      runInstance: (task) => runSwebenchTask(task, taskDeps),
      idOf: (task) => task.instanceId,
    })
    return {
      results: out.results,
      runHealth: {
        aborted: out.runHealth.aborted,
        verdict: out.runHealth.verdict,
        reason: out.runHealth.reason,
        attempted: out.runHealth.attempted,
        total: out.runHealth.total,
      },
    }
  } finally {
    stopLaneProgress()
  }
}

const logRepairConfig = (repair: { maxRounds: number } | undefined): void => {
  if (repair !== undefined) {
    logger.info(`bench: repair rounds enabled (maxRounds=${repair.maxRounds})`)
  }
}

const runDatasetMode = async (
  datasetFile: string,
  llm: LLMPort,
  /** Builds a fresh, independent llm port — used by the fork-branch fan-out for
   *  per-branch replay isolation (RFC jun-23 §4.1). Accepts optional ctx so
   *  recorded turns carry instance/run labels in metadata. */
  freshLlm: (ctx?: { instanceId?: string; runId?: string }) => LLMPort,
  meta: { provider: string; model: string },
  // HIGH-1 (aug-22): `family` is the TYPED family resolved ONCE at the
  // composition root and threaded here. Nothing below re-resolves it from argv
  // or ambient env, so the corpus parse, the grade verifier, the dry-run label
  // and the report stamp cannot disagree with the run that was admitted.
  cfg: { n: number; limit?: number; maxTurns: number; timeoutMs: number; family: DatasetFamily },
  // Pre-parsed by the single caller (`maybeRunDatasetMode`) so the dataset file
  // is read + parsed ONCE per run: `parsed` is the raw corpus (drives the empty
  // check), `filtered` already has the `--instance` filter applied.
  tasks: { parsed: readonly SwebenchRunnableRow[]; filtered: SwebenchRunnableRow[] },
  obs?: ObserveCtx,
  /** G1 — verify-select model lanes (≥2 distinct-model ports) or undefined.
   *  Undefined ⇒ byte-identical single-port path. */
  llmLanes?: readonly LLMPort[],
): Promise<void> => {
  if (tasks.parsed.length === 0) {
    logger.info(
      `No usable tasks parsed from "${datasetFile}". Expecting official SWE-bench JSONL. Nothing to run.`,
    )
    exitFn(0)
    return
  }
  const selected = cfg.limit ? tasks.filtered.slice(0, cfg.limit) : tasks.filtered

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
  const pythonSwebench = await buildPythonSwebench(cfg.family, exitFn)
  // b2 external repair rounds (ADR-0014). Default-OFF byte-identical: absent
  // ⇒ key omitted from deps ⇒ runner takes single-pass path (G2 gating). Set
  // either via `--repair-rounds <int>` or `QUANTA_REPAIR_ROUNDS`.
  const repairArg = argValue("--repair-rounds") ?? process.env.QUANTA_REPAIR_ROUNDS
  // Strict non-negative-int parse: a garbage value (NaN) previously flowed into
  // `Math.max(0, NaN)` === NaN and reached `maxRounds`, silently breaking the
  // repair-round comparison. NaN/negative ⇒ 0 (no repair).
  const repair = repairConfigFromArg(repairArg)
  logRepairConfig(repair)

  const repoBaseUrl = process.env.QUANTA_SWEBENCH_REPO_BASE_URL ?? "https://github.com/"
  const taskDeps = {
    llm,
    freshLlm,
    cfg,
    pythonSwebench,
    repair,
    obs,
    repoBaseUrl,
    ...(llmLanes !== undefined ? { llmLanes } : {}),
  }
  // Concurrency>1 overlaps patch-gen across tasks. Docker grading is ALWAYS
  // SERIAL (python-swebench withGradingLock mutex) — concurrent grading
  // false-negatives correct patches (2026-06-19).
  const concurrency = resolveConcurrency()
  if (concurrency > 1) {
    logger.info(`bench: patch-gen concurrency=${concurrency} (grading serialised)`)
  }
  // Serial path (concurrency<=1 — the full-remote default where the 0/N
  // burn-the-whole-run pain occurs): run through the RUN-HEALTH detector so a
  // systemic auth/infra failure aborts FAST instead of attempting all N. For a
  // HEALTHY run this is byte-identical (every instance attempted, no abort) — the
  // gate only fires on systemic failure. Concurrency>1 keeps the plain parallel
  // map (health-abort is a serial-path optimisation).
  // Live view of parallel candidate lanes (repair-breadth / verify-select) is
  // owned by the extracted executor and stays inert when nothing emits.
  const { results, runHealth } = await executeSwebenchTasks(selected, concurrency, taskDeps)

  const reportPath = argValue("--report") ?? join(benchRunDir(benchRunId()), "report.json")
  await writeArtifacts(
    argValue("--predictions") ?? join(benchRunDir(benchRunId()), "predictions.jsonl"),
    reportPath,
    results,
    buildSwebenchArtifactMeta({
      provider: meta.provider,
      model: meta.model,
      n: cfg.n,
      datasetFamily: cfg.family,
      ...(runHealth !== undefined ? { runHealth } : {}),
      env: process.env,
    }),
  )
  // T-101 closure diagnostics — OFFLINE sibling artifact. EVAL-ONLY: the oracle
  // (dataset gold/F2P) is read here post-run, never threaded into the agent loop.
  // AUTO-ENABLED whenever the run actually produced closure telemetry (a closure
  // posture was active — primary-rail / verification-plan), so a `--preset
  // agentless-v2` run captures its OWN measurement (false_red / gate_enter /
  // verify_rounds) without the operator having to remember a separate
  // QUANTA_BENCH_CLOSURE_DIAG flag. The flag still force-enables; a non-closure run
  // produces no closure fields ⇒ no sidecar ⇒ byte-identical. Best-effort.
  const closureTelemetryPresent = results.some(
    (r) =>
      r.primaryRailPresent !== undefined ||
      r.verificationPlan !== undefined ||
      r.gateEntered !== undefined,
  )
  if (gateOn(process.env, "QUANTA_BENCH_CLOSURE_DIAG") || closureTelemetryPresent) {
    try {
      const dataset = argValue("--swebench") ?? process.env.QUANTA_SWEBENCH_DATASET
      const sc = writeClosureSidecar(reportPath, results, dataset)
      logger.info(`closure diagnostics: ${sc}`)
    } catch (e) {
      logger.info(`closure diagnostics skipped: ${errMessage(e)}`)
    }
  }
  printSummary({ ...resolvedTotals(results), results })
  await finalizeObserve(obs, results)
}

/** Resolve provider/model/LLM; exits 0 with guidance when the key is absent
 *  (shared by both modes). `noun` tailors the message. The exit is routed
 *  through the injectable `exitFn`; in production this is `process.exit`
 *  (truly `never`) so the post-exit code is unreachable. A test that injects
 *  a no-op exit gets `null` back and the caller bails. */
const resolveLLM = (
  noun: string,
): {
  provider: Provider
  model: string
  llm: LLMPort
  freshLlm: (ctx?: { instanceId?: string; runId?: string }) => LLMPort
} | null => {
  const provider = pickProvider(process.env)
  // `--model` > `QUANTA_MODEL` > canonical DEFAULT_MODEL[provider] (the factory
  // fills the default when `model` is omitted). Provider pick, key lookup, and
  // OPENAI_BASE_URL handling all live in the shared factory now (OCP/DIP).
  const modelArg = argValue("--model") ?? process.env.QUANTA_MODEL
  const model = modelArg ?? DEFAULT_MODEL[provider]
  const trajectory = resolveBenchTrajectoryMode()
  if (trajectory.kind === "replay" && trajectory.onMiss === "throw") {
    // `freshLlm` builds an INDEPENDENT replay port (fresh `used` set) per call —
    // the fork-branch fan-out needs this so each branch re-replays the full
    // prefix instead of sharing a consumed cassette (RFC jun-23 §4.1).
    const freshLlm = (_ctx?: { instanceId?: string; runId?: string }): LLMPort =>
      replayTrajectoryPort({
        path: trajectory.path,
        onMiss: trajectory.onMiss,
        ...(trajectory.limit !== undefined ? { limit: trajectory.limit } : {}),
        provider,
        model,
      })
    return { provider, model, llm: freshLlm(), freshLlm }
  }
  // Bench defaults reasoning-summary ON (a CODE default, no env forwarding) so
  // reasoning models (gpt-5.5) STREAM their reasoning instead of thinking
  // silently and tripping the LLM idle-timeout → silent-retry stall loop. An
  // explicit `QUANTA_REASONING_SUMMARY=0`/off still wins (operator override).
  const reasoningSummary = resolveBenchReasoningSummary(process.env)
  const reasoningSummaryDetail = resolveBenchReasoningSummaryDetail(process.env)
  const llm = tryCreateLLM(
    provider,
    {
      ...(modelArg !== undefined ? { model: modelArg } : {}),
      reasoningSummary,
      reasoningSummaryDetail,
    },
    process.env,
  )
  if (!llm) {
    logger.info(
      `Found ${noun} but no API key for provider "${provider}". Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run. Exiting.`,
    )
    exitFn(0)
    return null
  }
  // Bench records the FULL LLM trajectory by DEFAULT (industry-SOTA opt-OUT;
  // QUANTA_BENCH_RECORD_TRAJECTORY=0 opts out). Log where it lands so the
  // operator can find the cassette without grepping the source for the default.
  if (trajectory.kind === "record") {
    logger.info(
      `bench: recording LLM trajectory → ${trajectory.path} (set QUANTA_BENCH_RECORD_TRAJECTORY=0 to opt out)`,
    )
  }
  // Live LLM is stateless across calls, so off/live mode can share it; replay
  // mode re-wraps a fresh store each call (applyBenchTrajectoryMode → fresh
  // replayTrajectoryPort) so branches stay isolated.
  const freshLlm = (ctx?: { instanceId?: string; runId?: string }): LLMPort =>
    applyBenchTrajectoryMode(llm, trajectory, { provider, model }, ctx)
  return { provider, model, llm: freshLlm(), freshLlm }
}

/** Official-dataset entrypoint. Returns true when it handled the run (so main
 *  skips the custom-corpus path entirely). */
const maybeRunDatasetMode = async (
  cfg: {
    n: number
    limit: number | null
    maxTurns: number
    timeoutMs: number
    /** The composition root's TYPED resolved family. REQUIRED (aug-22 HIGH-1):
     *  every SWE parse / grade / label / report site below reads THIS field.
     *  It used to be an optional declaration while those sites still called
     *  `datasetFamily()` — a fresh argv+ambient-env re-resolution that could
     *  disagree with the config the root had already admitted. */
    family: DatasetFamily
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
  // Parse the dataset file ONCE per run; the raw corpus + the `--instance`
  // filtered view are then threaded through the dry-run plan AND the run path
  // (no more 3× re-read/re-parse of the same JSONL).
  const parsed = readSwebenchTasks(datasetFile, cfg.family)
  // PMX-06 / aug-22 G4 — selection resolves through the FAMILY (a sealed sample
  // manifest, when one is named), then the historical `--instance` filter. The
  // resolved family + env are passed IN; no family string is compared here.
  const filtered = filterSwebenchTasks(parsed, { family: cfg.family, env: process.env })
  if (argFlag("--dry-run")) {
    const plan = buildDatasetDryRunPlan(datasetFile, filtered, {
      n: cfg.n,
      limit: cfg.limit,
      pythonHarness: gateOn(process.env, "QUANTA_SWEBENCH_PYTHON"),
      ...((label) => (label !== undefined ? { verifierLabel: label } : {}))(
        resolveDatasetFamilyProfile(cfg.family).verifierLabel,
      ),
      preset: process.env.QUANTA_BENCH_PRESET ?? "(unset)",
      datasetFamily: cfg.family, // LOW-10: the root's RESOLVED family, stated
    })
    for (const line of formatDryRunPlan(plan)) logger.info(line)
    exitFn(0)
    return true
  }
  const resolved = resolveLLM("a dataset")
  if (resolved === null) return true
  const { provider, model, llm, freshLlm } = resolved
  // G1 — verify-select model lanes. Undefined unless QUANTA_BENCH_MODEL_LANES
  // names ≥2 distinct models that EACH build a real port for `provider`. The
  // primary model (`model`) reuses the already-built `llm` so lane-0 is never a
  // duplicate port; other ids are pinned via the factory (null ⇒ dropped).
  const llmLanes = resolveModelLanes({
    env: process.env,
    buildLanePort: (modelId) =>
      modelId === model
        ? llm
        : tryCreateLLM(
            provider,
            {
              model: modelId,
              reasoningSummary: resolveBenchReasoningSummary(process.env),
              reasoningSummaryDetail: resolveBenchReasoningSummaryDetail(process.env),
            },
            process.env,
          ),
  })
  if (llmLanes !== undefined) {
    logger.info(`bench: model-lane diversity ON (${llmLanes.length} lanes)`)
  }
  // Host resource telemetry: periodic memory + process-count lines into the run
  // log so a runaway (fork-storm / OOM climb) is visible AS IT HAPPENS instead of
  // reverse-engineered from a dead box. Default-ON; no-op off Linux (no /proc);
  // opt out with QUANTA_BENCH_HOST_MONITOR=0. (jun-28: a uv fork-storm OOM-killed
  // an xarray box with no in-log signal — this makes that self-evident.)
  const hostMonitor =
    process.env.QUANTA_BENCH_HOST_MONITOR !== "0"
      ? startHostResourceSampler({
          intervalMs: 15_000,
          log: (level, msg) => (level === "warn" ? logger.warn(msg) : logger.info(msg)),
        })
      : { stop: () => {} }
  try {
    await runDatasetMode(
      datasetFile,
      llm,
      freshLlm,
      { provider, model },
      {
        n: cfg.n,
        ...(cfg.limit !== null ? { limit: cfg.limit } : {}),
        maxTurns: cfg.maxTurns,
        timeoutMs: cfg.timeoutMs,
        family: cfg.family,
      },
      { parsed, filtered },
      obs,
      llmLanes,
    )
  } finally {
    hostMonitor.stop()
  }
  return true
}

const exitCustomDryRunIfRequested = (
  cfg: { corpusRoot: string; n: number; limit: number | null },
  all: Instance[],
  pythonHarness: boolean,
): boolean => {
  if (!argFlag("--dry-run")) return false
  const plan = buildDryRunPlan(cfg.corpusRoot, all, {
    n: cfg.n,
    limit: cfg.limit,
    pythonHarness,
    preset: process.env.QUANTA_BENCH_PRESET ?? "(unset)",
  })
  for (const line of formatDryRunPlan(plan)) logger.info(line)
  exitFn(0)
  return true
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
    /** The composition root's TYPED resolved family. REQUIRED (aug-22 HIGH-1):
     *  every SWE parse / grade / label / report site below reads THIS field.
     *  It used to be an optional declaration while those sites still called
     *  `datasetFamily()` — a fresh argv+ambient-env re-resolution that could
     *  disagree with the config the root had already admitted. */
    family: DatasetFamily
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
  const pythonHarness = gateOn(process.env, "QUANTA_SWEBENCH_PYTHON")

  // `--dry-run`: load + count + print the plan; NEVER build an LLM or run.
  if (exitCustomDryRunIfRequested(cfg, all, pythonHarness)) return

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
  const pythonSwebench = await buildPythonSwebench(cfg.family, exitFn)
  logger.info(
    `bench: ${instances.length} instance(s), provider=${provider}, model=${model}, n=${cfg.n}`,
  )

  // A1 (jun-28): per-candidate repro artifacts under the observe dir (rides the
  // observe opt-in; no handle ⇒ no sink ⇒ no-op).
  const reproArtifactSink =
    obs !== undefined ? makeReproArtifactFsSink(join(obs.dir, obs.runId)) : undefined
  const reproArtifactRootPath = obs !== undefined ? join(obs.dir, obs.runId) : undefined
  const base: RunCfg = {
    llm,
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    ...(pythonSwebench !== undefined ? { pythonSwebench } : {}),
    ...(reproArtifactSink !== undefined ? { reproArtifactSink } : {}),
    ...(reproArtifactRootPath !== undefined ? { reproArtifactRootPath } : {}),
  }
  const { results } = await runBatch({
    instances,
    runInstance: (instance) =>
      resolveInstance(instance, base, cfg.n, obs, () => resolved.freshLlm()),
    concurrency: resolveConcurrency(),
  })
  // D-fix: write `--predictions` / `--report` from BOTH bench modes.
  await writeArtifacts(
    argValue("--predictions") ?? join(benchRunDir(benchRunId()), "predictions.jsonl"),
    argValue("--report") ?? join(benchRunDir(benchRunId()), "report.json"),
    results,
    // BFND-02: NO datasetFamily here on purpose. This is the CUSTOM-CORPUS mode —
    // it never reads a SWE dataset, so `--dataset-family` has no meaning for it and
    // stamping one would fabricate identity for a corpus the family never selected.
    { provider, model, n: cfg.n },
  )
  printSummary({ ...resolvedTotals(results), results })
  await finalizeObserve(obs, results)
}

/** Default per-instance wall-clock cap for the AGENT SOLVE (20 min). This is a
 *  runaway BACKSTOP, not the real budget — `maxTurns` (60) is the agent's turn
 *  budget. The old 2-min value was a tight solve budget that, combined with the
 *  pre-fix timer placement (which also counted env setup), aborted ~68% of
 *  instances mid-work under concurrency. jun-25: raised 10→20 min — the hard
 *  multi-file/wide-coordination cases (django-11138/14315) were CONVERGING
 *  (f2pFail 9→2, p2pFail 6→2) but `term=timeout` cut them off at ~290 turns
 *  under low concurrency; only the churning cases use the extra headroom (fast
 *  cases finish well under it). Overridable via `QUANTA_BENCH_TIMEOUT_MS`
 *  (`cfg.benchTimeoutMs`); forwarded to the box (QUANTA_BENCH_ prefix). */
const DEFAULT_BENCH_TIMEOUT_MS = 1_200_000

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
/** Bench runs ONE agent in an isolated per-instance sandbox — there is no other
 *  writer, so the stale-read freshness guard (a multi-writer safety control)
 *  only fires spuriously on the agent's OWN sequential edits (observed: ~50
 *  `stale_precondition` rejections wasting turns + blocking corrections). Default
 *  it OFF for bench; an operator who sets `QUANTA_STALE_READ_GUARD` explicitly
 *  (to anything) keeps their choice. The same composition root also seeds the
 *  current base preset for live runs when no explicit preset selector is set.
 *  Pure + injectable so the contract is unit-testable without spawning the
 *  CLI. */
export const applyBenchEnvDefaults = (
  env: Record<string, string | undefined>,
  opts: {
    argvPreset?: string | undefined
    /** TYPED resolved family from the composition root's `BenchRunConfig`
     *  (aug-22 HIGH-1). The preset seeder used to read this back out of
     *  `env.QUANTA_SWEBENCH_DATASET_FAMILY`, which the composition root had just
     *  written from argv — argv→env→preset was a pure in-process round-trip
     *  through ambient env. Defaults to "verified" for the legacy callers that
     *  never had a family axis (byte-identical). */
    datasetFamily?: DatasetFamily
  } = {},
): void => {
  if (env.QUANTA_STALE_READ_GUARD === undefined) env.QUANTA_STALE_READ_GUARD = "off"
  seedBenchExecutionPreset(env, opts.argvPreset, datasetFamilyOrDefault(opts.datasetFamily))
}

export const runMain = async (deps: MainDeps = {}): Promise<void> => {
  exitFn = deps.exit ?? defaultExitFn
  loadEnv([".env.dev", ".env.local", ".env"])
  // T2 — resolve the ONE typed run config at the composition root. Parses the
  // family selector (argv `--dataset-family` wins, then env) EXACTLY ONCE and
  // FAILS CLOSED on an explicit-but-unknown selector (a typo now errors instead
  // of silently grading as Verified). ABSENT selector ⇒ verified (byte-identical
  // legacy default). After .env load so the flag/env are populated.
  //
  // HIGH-1 (aug-22): the resolved family is NOT written back into `process.env`.
  // The old bridge (and its renamed successor) mutated the ambient env here and
  // the very next statement read it back through `preset.ts` — an argv→env→preset
  // in-process round-trip. Every in-process consumer below now takes the TYPED
  // `runConfig.datasetFamily`; env is written only into a per-call envelope handed
  // to a real subprocess/SSH child (see `buildSubprocessFamilyEnv`).
  // BFND-01 — resolve the ONE typed BenchRunConfig via the suite discriminator.
  // The `run`/no-subcommand entry is the SWE suite (byte-compat); the nested
  // swe branch carries the fail-closed typed datasetFamily. `terminal` never
  // reaches here (cli.ts routes it to its own handler).
  const benchConfig = resolveBenchmarkRunConfig({
    subcommand: process.argv[2],
    argvFamily: readDatasetFamilySelector(process.argv),
    env: process.env,
  })
  if (benchConfig.benchmarkSuite !== "swe-bench") {
    throw new Error("runMain is the swe-bench composition root; terminal-bench routes elsewhere")
  }
  const family = benchConfig.swe.datasetFamily
  // Pro spans Python, Go, JS, and TS, so family selection must reach the preset
  // seeder — as a TYPED argument. Explicit preset selectors retain precedence.
  applyBenchEnvDefaults(process.env, {
    argvPreset: argValue("--preset"),
    datasetFamily: family,
  })

  if (argFlag("--help") || argFlag("-h")) {
    printHelp()
    exitFn(0)
    return
  }

  if (argFlag("--list-presets")) {
    printPresetList()
    exitFn(0)
    return
  }

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
  //
  // C5 run-id unification: when a trace sink is active (or an id was explicitly
  // pinned), the `import.meta.main` boot wire (`bootBenchOtelExport`, which runs
  // BEFORE this) has ALREADY seeded `QUANTA_RUN_ID` to the SAME value it fed the
  // OTLP resource (`QUANTA_OTEL_RUN_ID`), so this `??=` is a no-op and the
  // observe `ctx.runId` == the span `quanta.run.id` (one joinable id). With no
  // sink and no explicit pin the boot wire left `QUANTA_RUN_ID` untouched, so
  // this mints `run-<ts>` exactly as before (byte-identical Default-OFF).
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
  if (await maybeRunDatasetMode({ n, limit, maxTurns, timeoutMs, family }, obs)) {
    return
  }
  await runCustomCorpusMode({ corpusRoot, n, limit, maxTurns, timeoutMs, family }, obs)
}
