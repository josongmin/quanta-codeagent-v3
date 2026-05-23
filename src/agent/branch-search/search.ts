/**
 * Branch-search orchestrator (ADR-0084) — composes propose → verify → score →
 * select → release. The single public entry the `branch_search` tool calls.
 *
 * Flow:
 *   1. `parallelPropose(N)` — concurrent candidates in isolated workspaces.
 *   2. For each candidate, run the verifier pipeline (failed candidates skip
 *      straight to score 0 — a failed run can't have a valid patch).
 *   3. `scorer` folds each candidate's signals; `selector` picks the winner.
 *   4. Release EVERY candidate's workspace (after scoring — verifiers needed
 *      them alive). The winner's diff is the caller's responsibility to apply
 *      in the parent workspace (the orchestrator returns the winner; it does
 *      NOT touch the parent — negative invariant).
 *
 * The orchestrator is verifier/scorer/selector/isolator-agnostic (all ports),
 * so it is fully unit-testable with fakes and composes per-mode.
 */

import type { BranchSearchAnchor, DeltaMeasurement } from "./anchor"
import { parallelPropose, type RunCandidate } from "./propose"
import type {
  BranchCandidate,
  BranchSearchRequest,
  BranchSearchResult,
  BranchTraceEvent,
  CandidateScore,
} from "./types"

const FAILED_SCORE: CandidateScore = { total: 0, breakdown: [] }

const safeTrace = (
  onTrace: ((e: BranchTraceEvent) => void) | undefined,
  e: BranchTraceEvent,
): void => {
  if (onTrace === undefined) return
  try {
    onTrace(e)
  } catch {
    /* trace sink must never break the search */
  }
}

/** Score one candidate: failed run ⇒ FAILED_SCORE; else run the verifier
 *  pipeline and fold. Isolated so the per-candidate scoring is independently
 *  testable + so a verifier crash on ONE candidate (already swallowed inside
 *  `combineVerifiers`) cannot poison the batch. */
const scoreCandidate = async (
  cand: BranchCandidate,
  req: BranchSearchRequest,
): Promise<{ cand: BranchCandidate; score: CandidateScore }> => {
  if (cand.outcome.kind === "failed") {
    safeTrace(req.onTrace, { kind: "candidate-scored", id: cand.id, total: 0, signals: [] })
    return { cand, score: FAILED_SCORE }
  }
  const signals = await req.verifier(cand)
  const score = req.scorer(signals)
  safeTrace(req.onTrace, {
    kind: "candidate-scored",
    id: cand.id,
    total: score.total,
    signals,
  })
  return { cand, score }
}

/**
 * `runBranchSearch` — the orchestrator. `runCandidate` is injected (the
 * `branch_search` tool binds it to a candidate-scoped `runAgent`; tests inject
 * a fake). Always releases every workspace, even on a thrown verifier/scorer.
 */
export const runBranchSearch = async (
  req: BranchSearchRequest & { runCandidate: RunCandidate },
): Promise<BranchSearchResult> => {
  if (req.N < 2) throw new Error(`runBranchSearch: N must be >= 2 (got ${req.N})`)
  if (req.N > 8) throw new Error(`runBranchSearch: N capped at 8 (got ${req.N})`)
  const startedAt = Date.now()

  // ADR-0116: anchor registration runs BEFORE parallelPropose so the snapshot
  // captures the workspace state the candidates fork from. Failure surfaces
  // as a `candidate-failed` trace under the synthetic id "anchor" — we reuse
  // the existing variant rather than expand the trace union for a single
  // start-failure case. The search proceeds regardless (fail-open: no
  // anchor ⇒ no delta measurement on any candidate).
  let anchorReady = false
  if (req.anchor !== undefined) {
    const start = await req.anchor.registerStart()
    if (start.ok) {
      anchorReady = true
    } else {
      safeTrace(req.onTrace, { kind: "candidate-failed", id: "anchor", reason: start.reason })
    }
  }

  const { candidates, cleanups } = await parallelPropose({
    N: req.N,
    seeds: req.seeds,
    baseLlm: req.baseLlm,
    task: req.task,
    timeoutPerBranchMs: req.timeoutPerBranchMs,
    isolator: req.isolator,
    runCandidate: req.runCandidate,
    ...(req.onTrace ? { onTrace: req.onTrace } : {}),
  })

  try {
    // allSettled (not all): a verifier/scorer that THROWS on ONE candidate must
    // not discard the sibling scores (matches propose.ts's per-candidate
    // isolation invariant). `scoreCandidate` swallows the default verifier's
    // crashes internally, but `req.verifier`/`req.scorer` are injected ports —
    // a custom one may reject. A rejected candidate folds to FAILED_SCORE so it
    // simply loses, never poisons the batch or the selection.
    const settled = await Promise.allSettled(candidates.map((c) => scoreCandidate(c, req)))
    const scoredRaw = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value
      // `candidates` and `settled` are index-aligned (allSettled preserves
      // order), so `cand` is always defined.
      const cand = candidates[i] as (typeof candidates)[number]
      safeTrace(req.onTrace, { kind: "candidate-scored", id: cand.id, total: 0, signals: [] })
      return { cand, score: FAILED_SCORE }
    })
    // ADR-0116 per-candidate delta attach. Only completed candidates are
    // measured (a failed run has no meaningful workspace state). On a
    // non-null measurement we produce a NEW BranchCandidate with `delta`
    // condition-spread in (exactOptionalPropertyTypes — never set to
    // undefined). On null OR no anchor, the candidate passes through
    // unchanged so `"delta" in cand === false` (byte-identical to the
    // pre-ADR-0116 shape).
    const anchor: BranchSearchAnchor | undefined = anchorReady ? req.anchor : undefined
    const allScored = await Promise.all(
      scoredRaw.map(async (entry) => {
        if (anchor === undefined) return entry
        if (entry.cand.outcome.kind !== "completed") return entry
        const delta: DeltaMeasurement | null = await anchor.measureDelta(entry.cand.workspace)
        if (delta === null) return entry
        safeTrace(req.onTrace, { kind: "candidate-delta", id: entry.cand.id, delta })
        // Condition-spread `delta` onto a NEW candidate; never mutate the
        // input (it is `readonly`-typed and shared with the trace events).
        const withDelta: BranchCandidate = { ...entry.cand, delta }
        return { cand: withDelta, score: entry.score }
      }),
    )
    const winner = req.selector(allScored)
    const winnerScore = allScored.find((s) => s.cand.id === winner.id)?.score ?? FAILED_SCORE
    safeTrace(req.onTrace, {
      kind: "winner-selected",
      winnerId: winner.id,
      total: winnerScore.total,
    })
    return {
      winner,
      winnerScore,
      allScored,
      totalWallMs: Date.now() - startedAt,
    }
  } finally {
    // Release every workspace — best-effort, never throws past here.
    await Promise.allSettled(cleanups.map((c) => c()))
  }
}
