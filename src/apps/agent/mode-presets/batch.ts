/**
 * Mode-preset runner — BATCH.
 *
 * RFC may-22-unified-agent-runtime / Phase 4+. The `mode === "batch"` cell:
 * SWE-bench-style evaluation over a corpus of instances. The bench eval
 * driver (`apps/bench/eval/runInstance`) already owns per-instance sandbox
 * lifecycle, agent invocation, verdict scoring, and observation; this preset
 * is the THIN orchestrator that loads the corpus, iterates instances, and
 * aggregates verdicts → predictions/report → exit code.
 *
 * Levers bound by the `batch` preset:
 *   permission = auto/acceptEdits, termination = verdict,
 *   sandbox = per-instance, externalDeps = hermetic, toolSurface = bench,
 *   network = denied, gitWrite = snapshot-only, observation = full-trajectory.
 *
 * Required `AssembleRequest` extras: `req.batch.corpus` (path).
 * Optional: `instance` (id substring filter), `limit`, `predictionsPath`,
 * `reportPath`.
 *
 * Default-OFF byte-identical: when invoked via Track A with the same corpus
 * + same dials, results match `bun run bench --corpus ...` instance-for-
 * instance (bytes of `predictions.jsonl` are the same because we reuse the
 * same `runInstance` + `writePredictions` helpers).
 *
 * Slice boundary: this file may import `@/agent`, `@/llm`, `@/permission`,
 * `@/shared`, `@/tool`, `@/stream`, the sibling assemble.ts, AND
 * `apps/bench` (the deliberate cross-app delegate — the bench eval driver
 * is the single source of truth for instance evaluation). NO imports from
 * other mode-preset siblings.
 */

import type { AgentConfig } from "@/agent"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { logger, runtimeConfig } from "@/shared"
import type { StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import {
  loadCorpus as defaultLoadCorpus,
  type Prediction,
  writePredictions,
} from "../../bench/corpus"
import { runInstance as defaultRunInstance } from "../../bench/eval"
import { buildReport, writeReport } from "../../bench/report"
import type { Instance, InstanceResult } from "../../bench/types"
import { type AssembleRequest, assembleAgentConfig, type RunOutcome } from "../assemble"

/** A minimal AgentConfig.base built ONLY to satisfy `assembleAgentConfig`'s
 *  matrix validation. The real per-instance config is constructed inside the
 *  bench `runInstance` driver — this stub is never consumed by `runAgent`. */
/** Default per-instance turn budget when neither `AgentConfig.maxTurns` nor
 *  `runtimeConfig.maxTurnsBatch` is set. 60 turns is the empirical sweet spot
 *  from gpt-5-mini × SWE-bench Verified: median resolve at 12-20 turns,
 *  thrash detection trips earlier; >60 produces diminishing returns
 *  (see docs/analysis/may-21-coding-agent-query-usecase.md). */
const BATCH_DEFAULT_MAX_TURNS = 60
/** Default per-instance wall-clock cap when `runtimeConfig.benchTimeoutMs`
 *  is unset. 120s covers the slowest observed `pytest` collection + tool
 *  loop; instances exceeding this consistently fail anyway (test runner
 *  hang or pathological compaction). */
const BATCH_DEFAULT_TIMEOUT_MS = 120_000

const stubBase = (req: AssembleRequest): Omit<AgentConfig, "modePolicy" | "budgetMeter"> => {
  const llm: LLMPort = req.base.llm
  const stream: StreamPort = req.base.stream
  // batch must use `auto` permission per the matrix (`narrow#assertBatch`).
  const permission: PermissionContext = req.base.permission ?? { mode: "acceptEdits" }
  // DIP factory call; batch's real registry is built per-instance by the bench
  // driver (with its own fs/diagnostics ports as added). This stub is only for
  // matrix validation in `assembleAgentConfig`.
  const registry =
    req.base.registry instanceof ToolRegistry
      ? req.base.registry
      : new ToolRegistry(buildDefaultTools())
  return {
    ...req.base,
    llm,
    registry,
    stream,
    permission,
    messages: req.base.messages ?? [],
    system: req.base.system ?? "",
    cwd: req.base.cwd ?? process.cwd(),
    maxTurns: req.base.maxTurns ?? 60,
    signal: req.base.signal ?? new AbortController().signal,
  }
}

/** Apply the optional id-substring filter + the limit slice. Filter runs
 *  BEFORE limit (same order as `apps/bench/index.ts` to keep byte-identical
 *  selection). */
const selectInstances = (
  all: Instance[],
  filter: string | undefined,
  limit: number | null | undefined,
): Instance[] => {
  const filtered =
    filter !== undefined && filter !== "" ? all.filter((i) => i.id.includes(filter)) : all
  if (limit === null || limit === undefined) return filtered
  return filtered.slice(0, limit)
}

/** Cast the seam-provided runInstance (typed `unknown` on AssembleRequestSeams
 *  so assemble.ts stays slice-isolated from `apps/bench`) back to its real
 *  shape inside this preset. */
const resolveRunInstance = (
  req: AssembleRequest,
): ((instance: Instance) => Promise<InstanceResult>) => {
  if (req.seams?.runInstance) {
    return req.seams.runInstance as (instance: Instance) => Promise<InstanceResult>
  }
  // The real runInstance requires `deps` (llm, maxTurns, timeoutMs). Build
  // those from req.base + dials so a production call wires identically to
  // `bun run bench`.
  const cfg = runtimeConfig()
  // Operator overrides flow through runtime-config (frozen at startup); the
  // mode preset default (60 turns / 120s per instance) is the structural fall-
  // back when neither the AgentConfig nor env is set.
  const maxTurns = req.base.maxTurns ?? cfg.maxTurnsBatch ?? BATCH_DEFAULT_MAX_TURNS
  const timeoutMs = cfg.benchTimeoutMs ?? BATCH_DEFAULT_TIMEOUT_MS
  return (instance: Instance) =>
    defaultRunInstance(instance, { llm: req.base.llm, maxTurns, timeoutMs })
}

/** Cast the seam-provided loadCorpus (typed `unknown[]` on the seams bag) back
 *  to its real shape inside this preset. */
const resolveLoadCorpus = (req: AssembleRequest): ((root: string) => Promise<Instance[]>) => {
  if (req.seams?.loadCorpus) {
    return req.seams.loadCorpus as (root: string) => Promise<Instance[]>
  }
  return defaultLoadCorpus
}

/** Compute the batch exit code: 0 iff ALL instances resolved (passed and not
 *  degraded / env_prep_failed); 1 if ANY failed. Mirrors the legacy bench
 *  behavior where the operator sees non-zero whenever a regression slipped. */
const computeExitCode = (results: InstanceResult[]): number => {
  if (results.length === 0) return 0
  for (const r of results) {
    if (!r.passed) return 1
    if (r.verdict === "degraded" || r.verdict === "env_prep_failed") return 1
  }
  return 0
}

/** Optional artifacts writer. Skipped when neither path is set (so a test
 *  driving a synthetic corpus doesn't litter the cwd). */
const maybeWriteArtifacts = async (
  results: InstanceResult[],
  meta: { model: string },
  predictionsPath: string | undefined,
  reportPath: string | undefined,
): Promise<void> => {
  if (predictionsPath !== undefined && predictionsPath !== "") {
    const predictions: Prediction[] = results.map((r) => ({
      instance_id: r.id,
      model_name_or_path: meta.model,
      model_patch: r.patch,
    }))
    await writePredictions(predictionsPath, predictions)
  }
  if (reportPath !== undefined && reportPath !== "") {
    // `buildReport` accepts {provider, model, n}; n=1 for the default batch
    // path (Best-of-N stays a bench-only knob until a future ADR adds it here).
    await writeReport(
      reportPath,
      buildReport({ provider: "unknown", model: meta.model, n: 1 }, results),
    )
  }
}

/**
 * BATCH runner.
 *
 * Required: `req.batch.corpus` (path). Loads the corpus, runs each instance
 * through the bench eval driver (the SINGLE source of truth for per-instance
 * sandbox + verdict), and writes predictions/report when paths are provided.
 *
 * Hermetic: when `req.seams.runInstance` is set, the real bench driver is
 * bypassed — the test stub returns synthetic InstanceResults and aggregation
 * still runs. When `req.seams.loadCorpus` is set, the synthetic corpus is
 * served without touching the filesystem.
 */
export const runMode = async (req: AssembleRequest): Promise<RunOutcome> => {
  if (req.mode !== "batch") {
    throw new Error(`batch.runMode: req.mode must be "batch", got "${req.mode}"`)
  }
  const corpus = req.batch?.corpus
  if (typeof corpus !== "string" || corpus === "") {
    throw new Error("batch.runMode: req.batch.corpus is required (non-empty string)")
  }

  // Run assemble for matrix validation + budget meter wiring; the resulting
  // cfg is informational here (the bench driver builds its own).
  assembleAgentConfig({ ...req, base: stubBase(req) })

  const load = resolveLoadCorpus(req)
  const runOne = resolveRunInstance(req)

  const all = await load(corpus)
  const instances = selectInstances(all, req.batch?.instance, req.batch?.limit)

  if (instances.length === 0) {
    logger.info(`batch: no instances matched (corpus=${corpus})`)
    return { exitCode: 0 }
  }

  const results: InstanceResult[] = []
  for (const inst of instances) {
    results.push(await runOne(inst))
  }

  // `req.base.llm.model` is the only model id assemble has access to here.
  // Falls back to the stable string `"unknown"` so the prediction file is
  // still valid when the LLM adapter doesn't carry one (rare).
  const llmModel = (req.base.llm as { model?: string }).model ?? "unknown"
  await maybeWriteArtifacts(
    results,
    { model: llmModel },
    req.batch?.predictionsPath,
    req.batch?.reportPath,
  )

  return { exitCode: computeExitCode(results) }
}
