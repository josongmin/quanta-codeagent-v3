import { errMessage } from "@/shared"
/**
 * Parallel candidate proposal for speculative branch search (ADR-0084).
 *
 * Spawns N candidates CONCURRENTLY, each in its own isolated workspace, each
 * running a `RunCandidate` port (the orchestrator wires the real `runAgent`;
 * tests inject a deterministic fake). `Promise.allSettled` ⇒ one candidate's
 * timeout/crash NEVER cancels the others (negative invariant). Each candidate
 * is wrapped in a timeout race so a wedged branch fails THAT candidate only.
 *
 * This file owns NO scoring — it returns raw `BranchCandidate`s plus their
 * cleanups, which the orchestrator (`search.ts`) verifies, scores, selects,
 * THEN releases (verifiers need the workspace alive).
 */

import type { LLMPort } from "@/llm"
import type { BranchCandidate, BranchSeed, BranchTraceEvent, Isolator } from "./types"

/** The per-candidate agent run, abstracted as a port so `propose` is unit-
 *  testable without a real loop. The orchestrator binds this to `runAgent`
 *  with a candidate-scoped `AgentConfig` (cwd = workspace, depth+1, seeded
 *  llm/temperature/promptHint). */
export type RunCandidate = (args: {
  id: string
  seed: BranchSeed
  workspace: string
  task: string
  baseLlm: LLMPort
  signal: AbortSignal
}) => Promise<{ kind: "completed"; turns: number; llmSelfConfidence?: number }>

export interface ProposeRequest {
  N: number
  seeds: ReadonlyArray<BranchSeed>
  baseLlm: LLMPort
  task: string
  timeoutPerBranchMs: number
  isolator: Isolator
  runCandidate: RunCandidate
  onTrace?: (e: BranchTraceEvent) => void
}

export interface ProposeResult {
  candidates: ReadonlyArray<BranchCandidate>
  /** Idempotent cleanups, one per candidate, in candidate order. The
   *  orchestrator calls these AFTER verify/score (the verifiers read the
   *  workspace). */
  cleanups: ReadonlyArray<() => Promise<void>>
}

const safeTrace = (
  onTrace: ((e: BranchTraceEvent) => void) | undefined,
  e: BranchTraceEvent,
): void => {
  if (onTrace === undefined) return
  try {
    onTrace(e)
  } catch {
    // Trace sink must never break the search.
  }
}

/** Run one candidate end-to-end with a per-branch timeout. Always resolves to
 *  a `{ cand, cleanup }` pair — failures become `outcome.kind:"failed"`, never
 *  a rejection (so `Promise.allSettled` always has a usable value). */
const oneCandidate = async (
  i: number,
  req: ProposeRequest,
): Promise<{ cand: BranchCandidate; cleanup: () => Promise<void> }> => {
  const id = `cand-${i}`
  const seed = req.seeds[i] ?? {}
  const acquired = await req.isolator.acquire(i)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  safeTrace(req.onTrace, { kind: "candidate-started", id, seed })
  const startedAt = Date.now()
  try {
    const timeout = new Promise<{ kind: "failed"; reason: string }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ kind: "failed", reason: `timeout after ${req.timeoutPerBranchMs}ms` })
      }, req.timeoutPerBranchMs)
    })
    const run = req
      .runCandidate({
        id,
        seed,
        workspace: acquired.workspace,
        task: req.task,
        baseLlm: req.baseLlm,
        signal: controller.signal,
      })
      .catch((e) => ({
        kind: "failed" as const,
        reason: errMessage(e),
      }))
    const outcome = await Promise.race([run, timeout])
    if (outcome.kind === "completed") {
      safeTrace(req.onTrace, {
        kind: "candidate-finished",
        id,
        turns: outcome.turns,
        durationMs: Date.now() - startedAt,
      })
    } else {
      safeTrace(req.onTrace, { kind: "candidate-failed", id, reason: outcome.reason })
    }
    const cand: BranchCandidate = { id, seed, workspace: acquired.workspace, outcome }
    return { cand, cleanup: acquired.cleanup }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Spawn N candidates in parallel. `seeds` shorter than N ⇒ missing seeds
 * inherit `{}` (parent config). Returns ALL candidates (incl. failed) so the
 * orchestrator can score survivors and surface losers.
 */
export const parallelPropose = async (req: ProposeRequest): Promise<ProposeResult> => {
  const settled = await Promise.allSettled(
    Array.from({ length: req.N }, (_, i) => oneCandidate(i, req)),
  )
  const candidates: BranchCandidate[] = []
  const cleanups: Array<() => Promise<void>> = []
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s?.status === "fulfilled") {
      candidates.push(s.value.cand)
      cleanups.push(s.value.cleanup)
    } else {
      // `oneCandidate` is contractually no-throw; this only fires if
      // `isolator.acquire` itself rejected. Surface a failed candidate with a
      // no-op cleanup so indices stay aligned.
      const reason = s?.reason instanceof Error ? s.reason.message : String(s?.reason)
      candidates.push({
        id: `cand-${i}`,
        seed: req.seeds[i] ?? {},
        workspace: "",
        outcome: { kind: "failed", reason: `isolation failed: ${reason}` },
      })
      cleanups.push(async () => {})
      safeTrace(req.onTrace, { kind: "candidate-failed", id: `cand-${i}`, reason })
    }
  }
  return { candidates, cleanups }
}
