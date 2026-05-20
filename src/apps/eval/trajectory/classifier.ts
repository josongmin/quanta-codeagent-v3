/**
 * Tier 3 session classifier. Reads sessions from `inputDir`, classifies each
 * by its authoritative `meta.userPrompt`, persists one `TrajectoryPayload`
 * per session.
 *
 * NO HEURISTIC FALLBACK: sessions without a `meta` sidecar are recorded with
 * `usecase:"unclassified"` and `confidence: 0` so the operator can either
 * (a) backfill metadata via `eval trajectory freeze`, or (b) decide the
 * session is genuinely opaque. Inferring the prompt from the trajectory body
 * was the prior approach and it is intentionally removed.
 */
import type { LLMPort } from "@/llm"
import { logger } from "@/shared"
import { makeRunId, ResultStore } from "../storage"
import { classifyQuery } from "../taxonomy"
import type { Verdict } from "../types"
import { listSessions, loadSession, type SessionView } from "./source"

export interface ClassifyTrajectoryOpts {
  /** Classifier LLM (cheap model OK). */
  llm: LLMPort
  /** Directory with JSONL sessions. */
  inputDir: string
  /** Override store dir. */
  storeDir?: string
  /** Inject for tests. */
  now?: () => number
}

export interface ClassifyTrajectorySummary {
  runId: string
  total: number
  classified: number
  /** Sessions where the MODEL legitimately picked `id:null` (none-of-above). */
  unrecognised: number
  /** Sessions without a `meta` sidecar — NOT classified. */
  noMeta: number
  /** Sessions where the classifier LLM ITSELF errored (stream failure, no
   *  JSON) — distinct from `unrecognised` so infra issues are observable. */
  classifierErrors: number
  durationMs: number
}

const recordUnclassified = (
  store: ResultStore,
  runId: string,
  file: string,
  session: SessionView,
  confidence: number,
): Promise<void> =>
  store.append(runId, {
    tier: "trajectory",
    usecase: "unclassified",
    payload: {
      kind: "trajectory",
      source: file,
      sessionId: session.sessionId,
      confidence,
      turns: session.turns,
    },
  })

export const classifyTrajectories = async (
  opts: ClassifyTrajectoryOpts,
): Promise<ClassifyTrajectorySummary> => {
  const start = Date.now()
  const store = new ResultStore({
    ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const runId = makeRunId("trajectory", opts.now)
  const files = listSessions(opts.inputDir)
  let classified = 0
  let unrecognised = 0
  let noMeta = 0
  let classifierErrors = 0
  for (const f of files) {
    let session: SessionView
    try {
      session = loadSession(f)
    } catch (e) {
      logger.warn("eval.trajectory: load failed", {
        file: f,
        error: e instanceof Error ? e.message : String(e),
      })
      noMeta += 1
      continue
    }
    if (session.meta === null) {
      const reason =
        session.metaResult.kind === "malformed"
          ? `meta_malformed: ${session.metaResult.error}`
          : "no_meta_sidecar"
      logger.warn("eval.trajectory: skipping session", { file: f, reason })
      await recordUnclassified(store, runId, f, session, 0)
      noMeta += 1
      continue
    }
    const result = await classifyQuery(session.meta.userPrompt, { llm: opts.llm })
    if (result.error !== undefined) {
      // INFRA failure — distinct from "model said id:null". Surface as its
      // own counter so an overloaded provider doesn't silently inflate
      // `unrecognised`.
      logger.warn("eval.trajectory: classifier infra error", {
        file: f,
        error: result.error,
      })
      classifierErrors += 1
      await recordUnclassified(store, runId, f, session, 0)
      continue
    }
    if (result.id === null) {
      await recordUnclassified(store, runId, f, session, result.confidence)
      unrecognised += 1
      continue
    }
    classified += 1
    await store.append(runId, {
      tier: "trajectory",
      usecase: result.id,
      payload: {
        kind: "trajectory",
        source: f,
        sessionId: session.sessionId,
        confidence: result.confidence,
        turns: session.turns,
      },
    })
  }
  const durationMs = Date.now() - start
  const counts: Record<Verdict, number> = {
    pass: classified,
    partial: 0,
    fail: 0,
    error: classifierErrors,
    skipped: unrecognised + noMeta,
  }
  await store.finish({
    runId,
    tier: "trajectory",
    argv: process.argv.slice(2),
    counts,
    durationMs,
  })
  return {
    runId,
    total: files.length,
    classified,
    unrecognised,
    noMeta,
    classifierErrors,
    durationMs,
  }
}
