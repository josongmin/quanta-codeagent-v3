/**
 * Tier 3 trajectory replay — re-execute a fixture session against the CURRENT
 * agent and compare event streams structurally.
 *
 * Pre-condition: the fixture has a `*.meta.json` sidecar with `userPrompt`.
 * Sessions without meta are refused with `verdict:"skipped"`. The sidecar's
 * declared `usecase` is VALIDATED against `taxonomy.leafById` — an unknown
 * leaf id (renamed/removed) ⇒ recorded under `"unclassified"` with a note so
 * the operator notices the fixture is stale, instead of silently storing it
 * under an invalid id that breaks matrix grouping.
 *
 * Timeout posture: when the wall-clock budget cuts the run short, the verdict
 * is `error` (not pass/partial/fail) — relying on `runAgent.outcome.reason`
 * alone would silently classify a timed-out run as a normal completion.
 *
 * Replay-trajectory output: written under the eval STORE directory, NOT next
 * to the source fixture. The prior behaviour (`<fixture>.replay.jsonl` sibling)
 * polluted source-controlled fixture dirs and overwrote priors on re-run.
 *
 * Diff semantics live in `./diff.ts`. We persist `matched` + `divergedEvents`
 * in `TrajectoryPayload.replay` so reports surface regressions at the
 * use-case granularity. The pass/partial/fail ladder is SCALED to the
 * original projection length (not a magic `<=2` cliff) so a 200-event
 * trajectory with 3 diverged events is correctly "partial" and a 5-event
 * one with 3 diverged is correctly "fail".
 */
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { buildSystemPrompt, runAgent, wireOptionalAgentPorts } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import { errMessage, logger, type RunContext } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { JsonlRecorder, TeeStream } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import { DEFAULT_RUNS_DIR, makeRunId, ResultStore } from "../storage"
import { leafById } from "../taxonomy"
import type { UseCaseId, Verdict } from "../types"
import { type DiffSummary, diffStreams } from "./diff"
import { loadSession, type SessionView } from "./source"

/** Capture+replay use the same in-memory stream type as `synthetic/runner`,
 *  but we keep the class local so a refactor of one does not change the other. */
class CapturingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** Tuning constants — extracted so a regression test pins them. The verdict
 *  thresholds are documented in `verdictFromDiff` below; the timeout default
 *  is intentionally larger than `synthetic/runner.DEFAULT_RUN_TIMEOUT_MS`
 *  because a replay re-walks the same path with cold caches. */
export const DEFAULT_REPLAY_TIMEOUT_MS = 180_000
export const DEFAULT_MIN_REPLAY_TURNS = 6
/** Diverged-events ratio at which `partial` becomes `fail`. 10% is loose
 *  enough that a single tool-input shape change in a long trajectory is
 *  forgiven; tighten via the env var below if you want stricter replay. */
export const REPLAY_PARTIAL_RATIO = 0.1

export interface ReplayOpts {
  /** LLM driving the replay agent. Should be the SAME model class as the
   *  original to keep the diff meaningful (we don't enforce it — provider
   *  drift is the whole point of replay). */
  llm: LLMPort
  /** Path to the JSONL fixture (the `.meta.json` sidecar is read implicitly). */
  fixture: string
  /** Max turns; defaults to `max(original.turns + 2, DEFAULT_MIN_REPLAY_TURNS)`. */
  maxTurns?: number
  /** Wall-clock budget. Default `DEFAULT_REPLAY_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Override store dir (tests). The replay JSONL is written under
   *  `<storeDir>/<runId>/<fixtureId>.replay.jsonl`, NOT next to the fixture. */
  storeDir?: string
  now?: () => number
}

export interface ReplayResult {
  runId: string
  /** Fixture id (the JSONL basename without extension). */
  fixtureId: string
  /** Use case the fixture's meta declared (validated against taxonomy), or
   *  `"unclassified"` when absent / unknown. */
  usecase: UseCaseId | "unclassified"
  verdict: Verdict
  /** Present only on a real replay (skipped/error runs omit it). */
  diff?: DiffSummary
  /** Original turn count (from `SessionView.turns`). */
  originalTurns: number
  /** Replay turn count. */
  replayTurns: number
  durationMs: number
  /** Set on `verdict:"error"` or `"skipped"` — concise human-readable cause. */
  reason?: string
}

const safeRm = async (path: string): Promise<void> => {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (e) {
    logger.warn("eval.replay: sandbox cleanup failed", {
      path,
      error: errMessage(e),
    })
  }
}

const fixtureIdOf = (path: string): string => basename(path, ".jsonl")

const skippedResult = (
  runId: string,
  fixtureId: string,
  start: number,
  reason: string,
  originalTurns: number,
  verdict: "skipped" | "error" = "skipped",
): ReplayResult => {
  logger.warn("eval.replay: refused", { fixtureId, reason, verdict })
  return {
    runId,
    fixtureId,
    usecase: "unclassified",
    verdict,
    originalTurns,
    replayTurns: 0,
    durationMs: Date.now() - start,
    reason,
  }
}

/** Verdict ladder. `matched` → pass; few diverged events relative to original
 *  length → partial; otherwise fail. NEVER returns "pass" for an aborted /
 *  timed-out run — callers thread `timedOut`/`runFailed` separately. */
export const verdictFromDiff = (diff: DiffSummary): Verdict => {
  if (diff.matched) return "pass"
  const ratio = diff.divergedEvents / Math.max(diff.originalLength, 1)
  return ratio <= REPLAY_PARTIAL_RATIO ? "partial" : "fail"
}

/** Why a fixture has no usable metadata — the sidecar was unreadable, or it
 *  was never there. A unit because the two are the same outcome (skip) but must
 *  stay distinguishable in the record: "malformed" is an authoring bug an
 *  operator can fix, "missing" is just an un-annotated fixture. */
const missingMetaReason = (metaResult: SessionView["metaResult"]): string =>
  metaResult.kind === "malformed" ? `meta_malformed: ${metaResult.error}` : "no_meta_sidecar"

/** The fixture's declared use case, checked against the LIVE taxonomy.
 *
 *  A unit because the check is the point: a leaf that was renamed or removed
 *  since the fixture was authored must fall back to `unclassified` rather than
 *  silently landing the record in a bucket that no longer exists. */
const resolveFixtureUsecase = (declared: unknown): UseCaseId | "unclassified" =>
  typeof declared === "string" && leafById(declared) !== undefined ? declared : "unclassified"

/** Run ONE fixture and append a `TrajectoryPayload.replay` record. */
export const replayFixture = async (opts: ReplayOpts): Promise<ReplayResult> => {
  const start = Date.now()
  const store = new ResultStore({
    ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const runId = makeRunId("trajectory", opts.now)
  const fixtureId = fixtureIdOf(opts.fixture)
  let original: SessionView
  try {
    original = loadSession(opts.fixture)
  } catch (e) {
    const r = skippedResult(runId, fixtureId, start, `load_failed: ${errMessage(e)}`, 0)
    await persistResult(store, runId, opts.fixture, r)
    return r
  }
  if (original.meta === null) {
    const r = skippedResult(
      runId,
      fixtureId,
      start,
      missingMetaReason(original.metaResult),
      original.turns,
    )
    await persistResult(store, runId, opts.fixture, r)
    return r
  }
  const usecase = resolveFixtureUsecase(original.meta.usecase)
  // Write the replay trajectory under the eval store dir — never adjacent to
  // a checked-in fixture (would pollute the repo + overwrite priors).
  const replayDir = join(opts.storeDir ?? DEFAULT_RUNS_DIR, runId)
  mkdirSync(replayDir, { recursive: true })
  const replayJsonl = join(replayDir, `${fixtureId}.replay.jsonl`)
  const sandbox = await mkdtemp(join(tmpdir(), "quanta-replay-"))
  try {
    const capture = new CapturingStream()
    const ctx: RunContext = {
      runId: `replay-${fixtureId}-${Date.now()}-${randomBytes(3).toString("hex")}`,
    }
    const stream: StreamPort = new TeeStream([
      capture,
      new JsonlRecorder(replayJsonl, {
        ctx,
        strict: true,
        producer: { name: "eval.replay", version: "1" },
      }),
    ])
    const permission: PermissionContext = { mode: "bypass" }
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: original.meta.userPrompt }] },
    ]
    const controller = new AbortController()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    let replayTurns = 0
    let runError: string | undefined
    try {
      const outcome = await runAgent(
        wireOptionalAgentPorts(
          {
            llm: opts.llm,
            // DIP factory: trajectory replay runs against the SAME default port
            // surface as production (no replay-specific fs/diagnostics ports),
            // byte-identical to the prior singleton.
            registry: new ToolRegistry(buildDefaultTools()),
            stream,
            permission,
            messages,
            system: buildSystemPrompt(sandbox),
            cwd: sandbox,
            maxTurns: opts.maxTurns ?? Math.max(original.turns + 2, DEFAULT_MIN_REPLAY_TURNS),
            signal: controller.signal,
          },
          process.env,
        ),
      )
      replayTurns = outcome.turns
      if (outcome.reason === "error") runError = "runAgent reported error"
    } catch (e) {
      runError = errMessage(e)
    } finally {
      clearTimeout(timer)
    }
    if (timedOut) {
      const r: ReplayResult = {
        runId,
        fixtureId,
        usecase,
        verdict: "error",
        originalTurns: original.turns,
        replayTurns,
        durationMs: Date.now() - start,
        reason: `timeout after ${timeoutMs}ms`,
      }
      await persistResult(store, runId, opts.fixture, r)
      return r
    }
    if (runError !== undefined) {
      const r: ReplayResult = {
        runId,
        fixtureId,
        usecase,
        verdict: "error",
        originalTurns: original.turns,
        replayTurns,
        durationMs: Date.now() - start,
        reason: `runAgent: ${runError}`,
      }
      await persistResult(store, runId, opts.fixture, r)
      return r
    }
    const replaySession = loadSession(replayJsonl)
    const diff = diffStreams(original.events, replaySession.events)
    const result: ReplayResult = {
      runId,
      fixtureId,
      usecase,
      verdict: verdictFromDiff(diff),
      diff,
      originalTurns: original.turns,
      replayTurns,
      durationMs: Date.now() - start,
    }
    await persistResult(store, runId, opts.fixture, result)
    return result
  } finally {
    await safeRm(sandbox)
  }
}

const persistResult = async (
  store: ResultStore,
  runId: string,
  source: string,
  r: ReplayResult,
): Promise<void> => {
  await store.append(runId, {
    tier: "trajectory",
    usecase: r.usecase === "unclassified" ? "unclassified" : r.usecase,
    payload: {
      kind: "trajectory",
      source,
      sessionId: r.fixtureId,
      confidence: 1,
      turns: r.originalTurns,
      ...(r.diff !== undefined
        ? { replay: { matched: r.diff.matched, divergedEvents: r.diff.divergedEvents } }
        : {}),
    },
  })
  const counts: Record<Verdict, number> = {
    pass: r.verdict === "pass" ? 1 : 0,
    partial: r.verdict === "partial" ? 1 : 0,
    fail: r.verdict === "fail" ? 1 : 0,
    error: r.verdict === "error" ? 1 : 0,
    skipped: r.verdict === "skipped" ? 1 : 0,
  }
  await store.finish({
    runId,
    tier: "trajectory",
    argv: process.argv.slice(2),
    counts,
    durationMs: r.durationMs,
  })
}
