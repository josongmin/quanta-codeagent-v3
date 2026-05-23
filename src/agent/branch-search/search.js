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
import { parallelPropose } from "./propose";
const FAILED_SCORE = { total: 0, breakdown: [] };
const safeTrace = (onTrace, e) => {
    if (onTrace === undefined)
        return;
    try {
        onTrace(e);
    }
    catch {
        /* trace sink must never break the search */
    }
};
/** Score one candidate: failed run ⇒ FAILED_SCORE; else run the verifier
 *  pipeline and fold. Isolated so the per-candidate scoring is independently
 *  testable + so a verifier crash on ONE candidate (already swallowed inside
 *  `combineVerifiers`) cannot poison the batch. */
const scoreCandidate = async (cand, req) => {
    if (cand.outcome.kind === "failed") {
        safeTrace(req.onTrace, { kind: "candidate-scored", id: cand.id, total: 0, signals: [] });
        return { cand, score: FAILED_SCORE };
    }
    const signals = await req.verifier(cand);
    const score = req.scorer(signals);
    safeTrace(req.onTrace, {
        kind: "candidate-scored",
        id: cand.id,
        total: score.total,
        signals,
    });
    return { cand, score };
};
/**
 * `runBranchSearch` — the orchestrator. `runCandidate` is injected (the
 * `branch_search` tool binds it to a candidate-scoped `runAgent`; tests inject
 * a fake). Always releases every workspace, even on a thrown verifier/scorer.
 */
export const runBranchSearch = async (req) => {
    if (req.N < 2)
        throw new Error(`runBranchSearch: N must be >= 2 (got ${req.N})`);
    if (req.N > 8)
        throw new Error(`runBranchSearch: N capped at 8 (got ${req.N})`);
    const startedAt = Date.now();
    const { candidates, cleanups } = await parallelPropose({
        N: req.N,
        seeds: req.seeds,
        baseLlm: req.baseLlm,
        task: req.task,
        timeoutPerBranchMs: req.timeoutPerBranchMs,
        isolator: req.isolator,
        runCandidate: req.runCandidate,
        ...(req.onTrace ? { onTrace: req.onTrace } : {}),
    });
    try {
        // allSettled (not all): a verifier/scorer that THROWS on ONE candidate must
        // not discard the sibling scores (matches propose.ts's per-candidate
        // isolation invariant). `scoreCandidate` swallows the default verifier's
        // crashes internally, but `req.verifier`/`req.scorer` are injected ports —
        // a custom one may reject. A rejected candidate folds to FAILED_SCORE so it
        // simply loses, never poisons the batch or the selection.
        const settled = await Promise.allSettled(candidates.map((c) => scoreCandidate(c, req)));
        const allScored = settled.map((s, i) => {
            if (s.status === "fulfilled")
                return s.value;
            // `candidates` and `settled` are index-aligned (allSettled preserves
            // order), so `cand` is always defined.
            const cand = candidates[i];
            safeTrace(req.onTrace, { kind: "candidate-scored", id: cand.id, total: 0, signals: [] });
            return { cand, score: FAILED_SCORE };
        });
        const winner = req.selector(allScored);
        const winnerScore = allScored.find((s) => s.cand.id === winner.id)?.score ?? FAILED_SCORE;
        safeTrace(req.onTrace, {
            kind: "winner-selected",
            winnerId: winner.id,
            total: winnerScore.total,
        });
        return {
            winner,
            winnerScore,
            allScored,
            totalWallMs: Date.now() - startedAt,
        };
    }
    finally {
        // Release every workspace — best-effort, never throws past here.
        await Promise.allSettled(cleanups.map((c) => c()));
    }
};
