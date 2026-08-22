/**
 * Leaf helpers lifted VERBATIM out of `run-main.ts` to keep that composition
 * root under the god-MODULE line gate. Two cohesive, downward-closed clusters
 * of pure/leaf scaffolding — none of these call back into the run-main pipeline
 * or read its module-private `exitFn`, so the move introduces no value cycle:
 *
 *  - observe / artifact I/O plumbing: `resolveObserve`, `attemptObs`,
 *    `withObserve`, `finalizeObserve`, `writeArtifacts`
 *  - SWE-bench dataset-task prep: `readSwebenchTasks`, `filterSwebenchTasks`,
 *    `runPrepareImages`
 *
 * `ObserveCtx` / `RunCfg` live in `run-main.ts` and are pulled in here as
 * TYPE-ONLY imports (erased at runtime → no cycle).
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { withActiveSpanScope } from "@/agent/session-resources"
import {
  attrs,
  endSpan,
  getSpanSink,
  QUANTA_ATTRS,
  QUANTA_SPAN_NAMES,
  type Span,
  type SpanName,
  startSpan,
} from "@/observability"
import { matchesInstanceFilter, writeArtifacts as writeBatchArtifacts } from "@/runner/batch/core"
import type { AggregateOfficialGradeInput, RunHealthSummary } from "@/runner/batch/report"
import { logger } from "@/shared"
import { benchRunDir, benchRunId } from "./corpus"
import type { DatasetFamily } from "./dataset-family"
import { finalizeRun } from "./eval"
import { prepareImages, resolveHarnessConfig } from "./harness"
import type { AttemptObservation } from "./observe"
import { resolveOfficialGradeReportInput } from "./official-grade-ingest-source"
import { readFamilyCorpusText } from "./profiles/corpus-read"
import { type FamilyCorpusRow, type FamilyCorpusTask, runnableTasksOf } from "./profiles/corpus-row"
import { applySelectionOrder, resolveFamilySelectedInstanceIds } from "./profiles/selection"
import { argValue } from "./run-args"
import type { ObserveCtx, RunCfg } from "./run-main"
import type { InstanceResult } from "./types"

/** Resolve the observe root. Defaults to the PERSISTENT bench runs dir so
 *  trajectories survive across sessions (override with `--observe-dir` /
 *  `QUANTA_OBSERVE_DIR`). Always returns a handle (observe is on by default). */
export const resolveObserve = (): ObserveCtx | undefined => {
  const runId = benchRunId()
  const flag = argValue("--observe-dir") ?? process.env.QUANTA_OBSERVE_DIR
  const dir = flag ? resolve(process.cwd(), flag) : join(benchRunDir(runId), "observe")
  return { dir, runId }
}

/** Per-attempt observe handle for one instance (one file per attempt). */
export const attemptObs = (
  obs: ObserveCtx | undefined,
  attempt: number,
): AttemptObservation | undefined =>
  obs === undefined ? undefined : { dir: obs.dir, runId: obs.runId, attempt }

export const withObserve = (base: RunCfg, o: AttemptObservation | undefined): RunCfg =>
  o === undefined ? base : { ...base, observe: o }

/**
 * C5 — Bench-attempt ROOT span. Today the OUTERMOST span of a bench instance is
 * the agent-level `session_loop` (opened INSIDE `runInstance` by `runAgent`), so
 * the whole sandbox-prep → localize → agent → verify pipeline runs OUTSIDE any
 * span and the trace begins mid-solve. This opens a `quanta.bench.instance`
 * INTERNAL root per instance ATTEMPT that wraps the ENTIRE `runInstance` call, so
 * sandbox/localize/verify sit inside a trace and every attempt gets its OWN root.
 *
 * Identity: stamps `quanta.instance.id` + (when known) the 0-based
 * `quanta.instance.attempt` — the SAME `{instanceId, attempt}` the driver stamps
 * on `session_loop` (config-build `spanIdentity`) and that names the
 * `<runId>/<instanceId>.<attempt>.jsonl` trajectory file, so the root, the loop
 * span, and the trajectory all carry one join key.
 *
 * Trace-per-attempt: the root is opened through the EXPORT sink
 * (`startSpan`/`endSpan`), which mints a FRESH trace id per call (no enclosing
 * active ref at the bench top level), so two Best-of-N attempts of one instance
 * get DISTINCT trace ids (never merged). `withActiveSpanScope(true, …)` then
 * installs the EXPORTER-ISSUED id as the active `TraceRef` for the whole async
 * subtree — the seam `runAgent`'s `session_loop` (+ the C3 OBSERVE recorder /
 * C4 cassette) read via `getActiveTraceRef()`, so `session_loop.parentSpanId`
 * points at a root span that is ACTUALLY exported (no dangling parent), and the
 * `quanta.instance.{id,attempt}` attrs on this root reach the collector.
 *
 * EXPORT-path (not `contextTracer`): the earlier seam opened the root through
 * the NO-EXPORT `contextTracer`, which installed a valid active ref but POSTed
 * no span — so `session_loop` parented under a non-existent root and the
 * instance attrs never left the process. Routing through `startSpan` (the flat
 * export sink) both EXPORTS the root and, via `withActiveSpanScope`, installs
 * the exporter's issued id — one exportable trace per attempt, filterable by
 * `quanta.instance.id`. Kind is INTERNAL (agent-orchestration, not an LLM call)
 * — the exporter defaults an unset kind to INTERNAL, matching the C5 intent.
 *
 * Default-OFF byte-identical: GATED on a live span sink (`getSpanSink()`). With
 * NO sink (the shipped default, and the whole OFF path) this installs NO span,
 * NO async-context frame, and NO id allocation — `startSpan` returns the no-op
 * sentinel and `withActiveSpanScope` calls `run()` directly, so the bench loop
 * is byte-identical to the pre-C5 path.
 */
export const withBenchInstanceRoot = async <T>(
  identity: { readonly instanceId: string; readonly attempt?: number },
  run: () => Promise<T>,
): Promise<T> => {
  if (getSpanSink() === null) return run()
  // Canonical vocabulary keys (NOT raw string literals — the vocabulary-orphan
  // scan enforces this). These now ride the EXPORTED root span (via `attrs()`),
  // so they actually reach the OTLP collector — the previous `contextTracer`
  // attrs never exported.
  const rootAttrs = attrs({
    [QUANTA_ATTRS.instance.id]: identity.instanceId,
    ...(identity.attempt !== undefined
      ? { [QUANTA_ATTRS.instance.attempt]: identity.attempt }
      : {}),
  })
  // `startSpan` narrows `name` to the loop's 4-literal `SpanName` union; the
  // bench-instance name lives in `QUANTA_SPAN_NAMES` (its own vocabulary axis)
  // and is written verbatim into the exported span's `string` name — cast only
  // bridges the compile-time union, no runtime effect.
  const span: Span = startSpan(QUANTA_SPAN_NAMES.benchInstance as SpanName, rootAttrs)
  let status: "ok" | "error" = "ok"
  try {
    // `isRoot = true` ⇒ fresh trace (no parent), and the EXPORTER-issued id is
    // installed as the active ref so every child (`session_loop`, `chat`,
    // `execute_tool`) inherits it and parents under a span that IS exported.
    return await withActiveSpanScope(true, span, run)
  } catch (e) {
    status = "error"
    throw e
  } finally {
    endSpan(span, status, attrs({}))
  }
}

/** `--prepare-images` worker: warm the Docker image pool for `instanceIds`
 *  via the official `prepare_images` harness, log the outcome, and return the
 *  process exit code (0 ok / 1 fail). The SOTA win: per-repo env image built
 *  once here, reused by every later instance of that repo. */
export const runPrepareImages = async (instanceIds: string[]): Promise<number> => {
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

// REGRESSION FIX (jun-30): the god-MODULE split (11adab597) dropped the family-aware
// parse — Pro rows MUST be normalized (lowercase fail_to_pass + extra fields) or they
// degrade to the `testCmd:"true"` no-op. Verified/Live are the standard schema.
//
// HIGH-1 (aug-22): `family` is a REQUIRED TYPED parameter. This used to call a
// local `datasetFamily()` helper that re-resolved `--dataset-family` + ambient
// `process.env` on every call — a second, independent authority that could (and
// did, for whitespace-padded selectors) disagree with the typed `BenchRunConfig`
// the composition root had already admitted, silently parsing Pro rows with the
// Verified identity parse and degrading them to `testCmd:"true"`.
//
// PMX-02: the reader is the FAMILY's, not this module's. `readFamilyCorpusText`
// resolves `DatasetFamilyProfile.readCorpus`, so a family whose corpus is an
// official JSON array is decoded here by the same reader the remote preflight and
// the pool chunk slicer use. Only RUNNABLE rows are returned, which is exactly
// what `parseSwebenchJsonl` used to yield.
export type SwebenchRunnableRow = FamilyCorpusRow & { readonly task: FamilyCorpusTask }

export const readSwebenchTasks = (
  datasetFile: string,
  family: DatasetFamily,
): SwebenchRunnableRow[] => [
  ...runnableTasksOf(readFamilyCorpusText(readFileSync(datasetFile, "utf8"), family)),
]

/**
 * Resolve WHICH already-parsed tasks a run executes.
 *
 * Two authorities, in this order:
 *  1. the FAMILY's selection port (PMX-06 / aug-22 G4) — a sealed sample
 *     manifest, when the operator named one. Its ORDER is authoritative.
 *  2. the historical `--instance <substr>` filter.
 *
 * Byte-identical when no family declares a selection authority (the port is
 * absent for verified/live/pro, and `resolveFamilySelectedInstanceIds` then
 * returns `undefined`) — this stays the same substring filter it always was.
 *
 * `selection` is REQUIRED, deliberately: an optional parameter would let the one
 * composition-root call site silently drop the family authority and leave the
 * whole manifest lane inert, which is exactly the shape of the bug this closes.
 * The compiler now enforces the binding.
 */
export const filterSwebenchTasks = (
  parsed: readonly SwebenchRunnableRow[],
  selection: { readonly family: DatasetFamily; readonly env: NodeJS.ProcessEnv },
): SwebenchRunnableRow[] => {
  const instanceFilter = argValue("--instance")
  const ids = resolveFamilySelectedInstanceIds({
    family: selection.family,
    rows: parsed,
    env: selection.env,
    surface: "local-run",
    ...(instanceFilter !== undefined ? { instanceFilter } : {}),
  })
  if (ids !== undefined) return applySelectionOrder(parsed, ids, "local-run")
  return instanceFilter !== undefined && instanceFilter !== ""
    ? parsed.filter((t) => matchesInstanceFilter(t.instanceId, instanceFilter))
    : [...parsed]
}

/** D-fix: shared `--predictions` / `--report` writer for both bench modes.
 *  Pure-by-signature (paths + results + meta are explicit args, no argv reads)
 *  so the contract is unit-testable without spawning the CLI. */
export const writeArtifacts = async (
  predictionsFile: string,
  reportFile: string,
  results: InstanceResult[],
  meta: {
    provider: string
    model: string
    n: number
    /** BFND-02 — the resolved dataset family. This seam previously DROPPED it,
     *  so every locally-written report lost its family discriminator and a Pro
     *  resolved-rate was averaged into the Verified one by the leaderboard SSOT.
     *  Absent / verified ⇒ omitted from the report (byte-identical legacy shape). */
    datasetFamily?: DatasetFamily
    runHealth?: RunHealthSummary
    /** PMX-05 residual #3 — the official grader's campaign receipt.
     *
     * This parameter's shape used to be a HAND-NARROWED list of five fields, so
     * `BatchArtifactMeta.officialGrade` — which `buildReport` already knew how to
     * aggregate and persist — was structurally unreachable from the bench
     * composition root: the section had a reader, a dashboard view and a
     * covering-partition guard, and no possible writer. Absent ⇒ no section ⇒
     * byte-identical report. */
    officialGrade?: AggregateOfficialGradeInput
  },
): Promise<void> => {
  await writeBatchArtifacts(predictionsFile, reportFile, results, meta)
  logger.info(`wrote ${predictionsFile} (${results.length} prediction(s)) and ${reportFile}`)
}

/**
 * The SWE-bench run's ARTIFACT META, composed in one place.
 *
 * Extracted from the `run-main.ts` composition root (which is at the god-module
 * line gate) so the composition is a testable value rather than an inline object
 * literal — and so residual #3's ingress has an owner: an official grader's
 * campaign receipt is read HERE, at the root, from the env the caller passes in,
 * and threaded into the report the same way `runHealth` is.
 *
 * Every optional field stays OMITTED when absent, so a run with no official
 * grader and no health verdict produces byte-identical meta to before.
 */
export const buildSwebenchArtifactMeta = (args: {
  readonly provider: string
  readonly model: string
  readonly n: number
  readonly datasetFamily: DatasetFamily
  readonly runHealth?: RunHealthSummary | undefined
  /** The env the composition root resolved from — never a fresh ambient read. */
  readonly env: NodeJS.ProcessEnv
}): {
  provider: string
  model: string
  n: number
  datasetFamily: DatasetFamily
  runHealth?: RunHealthSummary
  officialGrade?: AggregateOfficialGradeInput
} => {
  // FAIL-CLOSED: a named-but-broken grader document THROWS here rather than
  // publishing a report that silently omits the verdict it claims to have.
  const officialGrade = resolveOfficialGradeReportInput(args.env)
  return {
    provider: args.provider,
    model: args.model,
    n: args.n,
    // BFND-02 — carry the resolved family into the report. The SAME typed field
    // the corpus parse and the grade verifier were threaded (aug-22 HIGH-1), so
    // the artifact can never disagree with the run that produced it. Verified ⇒
    // omitted at serialization ⇒ byte-identical legacy report.
    datasetFamily: args.datasetFamily,
    ...(args.runHealth !== undefined ? { runHealth: args.runHealth } : {}),
    ...(officialGrade !== undefined ? { officialGrade } : {}),
  }
}

/** Run end (RFC §8): write `<observeDir>/<runId>/{metrics,summary}.json` and
 *  log passed/total plus the official-harness split. No-op when observe is OFF. */
export const finalizeObserve = async (
  obs: ObserveCtx | undefined,
  results: InstanceResult[],
): Promise<void> => {
  if (obs === undefined) return
  const summary = await finalizeRun(obs, results)
  logger.info(
    `observe: ${join(obs.dir, obs.runId)} — passed ${summary.resolved}/${summary.total}` +
      ` | official_harness ${summary.score.officialHarness}/${summary.total}` +
      ` (${summary.degraded} degraded)`,
  )
}
