/**
 * Tier 4 — A/B compare entry. Resolves a scenario by id (under the same
 * `scenarios/<usecase-id>/` tree Tier 1 uses), constructs the requested
 * adapters, runs each in parallel, then has a pairwise judge score every
 * pair (with bias-swap). One `ComparePayload` per matchup is persisted.
 *
 * Default adapter list is `["quanta", "claude-code"]` — the most useful
 * head-to-head while we shake the tier out. Pass `--agents quanta,aider` to
 * include any subset of {quanta, claude-code, cursor, aider}; unknown names
 * are refused at resolve time (no silent skips).
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { LLMPort } from "@/llm"
import { errMessage, logger } from "@/shared"
import { makeRunId, ResultStore } from "../storage"
import { loadScenarioFile, type Scenario } from "../synthetic/scenario"
import type { UseCaseId, Verdict } from "../types"
import type { AgentAdapter, CompareRunResult } from "./adapter"
import { buildAiderAdapter } from "./adapters/aider"
import { buildClaudeCodeAdapter } from "./adapters/claude-code"
import { buildCursorAdapter } from "./adapters/cursor"
import { QuantaAdapter } from "./adapters/quanta"
import { type PairwiseVerdict, pairwiseJudge } from "./pairwise-judge"

export type { AgentAdapter, CompareRunResult, PairwiseVerdict }

const DEFAULT_ROOT = "src/apps/eval/synthetic/scenarios"

export interface CompareRunOpts {
  /** LLM the in-process Quanta adapter uses. */
  quantaLlm: LLMPort
  /** LLM the pairwise judge uses (usually = quantaLlm, can be cheaper). */
  judgeLlm: LLMPort
  /** Scenario id (filename stem). MUST exist under `<root>/<usecase>/`. */
  scenarioId: string
  /** Use case id. */
  usecase: UseCaseId
  /** Adapter names to participate. Order matters — first one is "us". */
  agents: readonly string[]
  /** Scenarios root override. */
  scenariosRoot?: string
  /** Override store dir (tests). */
  storeDir?: string
  /** Inject for tests. */
  now?: () => number
}

export interface CompareSummary {
  runId: string
  /** Adapters that actually ran (vs skipped due to unavailability). */
  agentsRan: readonly string[]
  /** Adapters refused (CLI missing, etc.) with reasons. */
  agentsSkipped: readonly { agent: string; reason: string }[]
  /** Pairwise verdicts. */
  matchups: readonly {
    a: string
    b: string
    winnerIndex: number
    note: string
  }[]
  /** Winner counts per agent across all matchups (-1 means the matchup tied). */
  counts: Record<Verdict, number>
  durationMs: number
}

/** Set of every adapter id this build knows about. The CLI parser MUST
 *  validate `--agents` tokens against this set BEFORE calling `runCompare`
 *  so an operator typo (`claude-cdoe`) fails loud instead of silently
 *  shrinking the matchup list. */
export const KNOWN_ADAPTERS = ["quanta", "claude-code", "cursor", "aider"] as const
export type KnownAdapter = (typeof KNOWN_ADAPTERS)[number]
const KNOWN_ADAPTER_SET: ReadonlySet<string> = new Set(KNOWN_ADAPTERS)

export const isKnownAdapter = (n: string): n is KnownAdapter => KNOWN_ADAPTER_SET.has(n)

/** Throws on unknown adapter name — silent skip was the bug. */
const buildAdapter = (name: string, quantaLlm: LLMPort): AgentAdapter => {
  switch (name) {
    case "quanta":
      return new QuantaAdapter({ llm: quantaLlm })
    case "claude-code":
      return buildClaudeCodeAdapter()
    case "cursor":
      return buildCursorAdapter()
    case "aider":
      return buildAiderAdapter()
    default:
      throw new Error(`compare: unknown adapter "${name}" — known: ${KNOWN_ADAPTERS.join(", ")}`)
  }
}

const resolveScenario = (root: string, usecase: UseCaseId, scenarioId: string): Scenario | null => {
  const dir = join(root, usecase)
  if (!existsSync(dir)) return null
  const file = readdirSync(dir).find((f) => f === `${scenarioId}.json`)
  if (file === undefined) return null
  try {
    return loadScenarioFile(join(dir, file))
  } catch (e) {
    logger.warn("eval.compare: scenario parse failed", {
      file,
      error: errMessage(e),
    })
    return null
  }
}

/** `exactOptionalPropertyTypes` forbids handing `{ dir: undefined }` to the
 *  store, so the two test-injection knobs must be conditionally SPREAD rather
 *  than assigned. Hoisted out of the pipeline so `new ResultStore(...)` reads
 *  as one step instead of two ternaries. */
const storeOptsFrom = (opts: CompareRunOpts): { dir?: string; now?: () => number } => ({
  ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
  ...(opts.now !== undefined ? { now: opts.now } : {}),
})

/** Build every named adapter IN DECLARATION ORDER and probe it. A unit
 *  because this is the single place that turns the caller's string list into
 *  the two lists the rest of the run needs — the ones that ran, and the ones
 *  that refused with a reason. Unknown names THROW here (silent skip was the
 *  bug); `available()` is awaited serially so probes cannot interleave their
 *  spawns. */
const probeAdapters = async (
  agents: readonly string[],
  quantaLlm: LLMPort,
): Promise<{
  adapters: readonly AgentAdapter[]
  skipped: readonly { agent: string; reason: string }[]
}> => {
  const adapters: AgentAdapter[] = []
  const skipped: { agent: string; reason: string }[] = []
  for (const name of agents) {
    const built = buildAdapter(name, quantaLlm)
    const probe = await built.available()
    if (!probe.ok) {
      skipped.push({ agent: name, reason: probe.reason ?? "unavailable" })
      continue
    }
    adapters.push(built)
  }
  return { adapters, skipped }
}

/** Every unordered pair `(i, j)` with `i < j`, in index order — the matchup
 *  list. A unit because the index double-loop plus the `undefined` guard was
 *  pure `noUncheckedIndexedAccess` ceremony that had nothing to do with
 *  scoring; the guard is KEPT verbatim so a sparse `runs` array still skips
 *  rather than judging a hole. */
const pairsOf = <T>(items: readonly T[]): readonly (readonly [T, T])[] => {
  const out: (readonly [T, T])[] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a === undefined || b === undefined) continue
      out.push([a, b])
    }
  }
  return out
}

/** Which counter one pairwise verdict bumps. Its own unit so the ORDER of the
 *  three-way test is stated once: a parse failure is an INFRA error and is
 *  tested FIRST — counting it as `partial` (the tie bucket) would silently
 *  pollute the success-rate report with provider outages. */
const verdictBucket = (verdict: PairwiseVerdict): "pass" | "partial" | "error" => {
  if (verdict.parseFailed) return "error"
  if (verdict.winnerIndex === -1) return "partial"
  return "pass"
}

export const runCompare = async (opts: CompareRunOpts): Promise<CompareSummary> => {
  const start = Date.now()
  const store = new ResultStore(storeOptsFrom(opts))
  const runId = makeRunId("compare", opts.now)
  const root = opts.scenariosRoot ?? DEFAULT_ROOT
  const scenario = resolveScenario(root, opts.usecase, opts.scenarioId)
  if (scenario === null) {
    throw new Error(`compare: scenario not found: ${root}/${opts.usecase}/${opts.scenarioId}.json`)
  }
  const { adapters, skipped } = await probeAdapters(opts.agents, opts.quantaLlm)
  // Run each adapter on the scenario IN PARALLEL — each writes into its own
  // throwaway sandbox so they cannot collide. `runOne` never throws.
  const runs: CompareRunResult[] = await Promise.all(adapters.map((a) => a.runOne(scenario)))
  // Pairwise score every (a, b) where a is earlier than b in the agent list.
  const matchups: { a: string; b: string; winnerIndex: number; note: string }[] = []
  const counts: Record<Verdict, number> = {
    pass: 0,
    partial: 0,
    fail: 0,
    error: 0,
    skipped: skipped.length,
  }
  for (const [a, b] of pairsOf(runs)) {
    const verdict = await pairwiseJudge(scenario, a, b, { llm: opts.judgeLlm })
    matchups.push({
      a: a.agent,
      b: b.agent,
      winnerIndex: verdict.winnerIndex,
      note: verdict.note,
    })
    counts[verdictBucket(verdict)] += 1
    await store.append(runId, {
      tier: "compare",
      usecase: opts.usecase,
      payload: {
        kind: "compare",
        scenarioId: scenario.id,
        agents: [a.agent, b.agent],
        winner: verdict.winnerIndex,
        ...(verdict.note !== "" ? { note: verdict.note } : {}),
      },
    })
  }
  const durationMs = Date.now() - start
  await store.finish({
    runId,
    tier: "compare",
    argv: process.argv.slice(2),
    counts,
    durationMs,
  })
  return {
    runId,
    agentsRan: adapters.map((a) => a.name),
    agentsSkipped: skipped,
    matchups,
    counts,
    durationMs,
  }
}
