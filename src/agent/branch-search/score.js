/**
 * Pure scorer + selector for speculative branch search (ADR-0084). No IO, no
 * clock — given verifier signals, fold to a 0..1 total and pick argmax.
 * Deterministic for a fixed signal set (non-determinism lives in propose).
 */
/** Default per-kind weights. Sum need NOT be 1 — `scoreWith` normalizes by the
 *  weight mass of NON-penalty kinds present. `patch_size` is a PENALTY
 *  (subtracted, scaled by its magnitude). */
export const DEFAULT_WEIGHTS = Object.freeze({
    tsc: 0.4,
    test: 0.4,
    lint: 0.1,
    lsp_diag: 0.2,
    llm_judge: 0.2,
    patch_size: 0.1,
});
const PENALTY_KINDS = new Set(["patch_size"]);
const signalValue = (s) => {
    if (s.magnitude !== undefined)
        return Math.max(0, Math.min(1, s.magnitude));
    return s.pass ? 1 : 0;
};
export const makeScorer = (overrides) => {
    const weights = { ...DEFAULT_WEIGHTS, ...overrides };
    return (signals) => scoreWith(weights, signals);
};
export const defaultScorer = makeScorer();
const scoreWith = (weights, signals) => {
    if (signals.length === 0)
        return { total: 0, breakdown: [] };
    let rewardNum = 0;
    let rewardDen = 0;
    let penalty = 0;
    for (const s of signals) {
        const w = weights[s.kind] ?? 0;
        if (PENALTY_KINDS.has(s.kind)) {
            penalty += w * signalValue(s);
            continue;
        }
        rewardNum += w * signalValue(s);
        rewardDen += w;
    }
    const reward = rewardDen > 0 ? rewardNum / rewardDen : 0;
    const total = Math.max(0, Math.min(1, reward - penalty));
    return { total, breakdown: [...signals] };
};
const totalMs = (signals) => signals.reduce((acc, s) => acc + s.durationMs, 0);
/**
 * Argmax selector with deterministic tie-break: total ↓, then verifier-ms ↑
 * (faster = simpler proxy), then lexicographic id (stable replay). Throws on
 * empty input — the orchestrator guarantees ≥1 candidate.
 */
export const argmaxSelector = (scored) => {
    if (scored.length === 0)
        throw new Error("argmaxSelector: no candidates to select from");
    const sorted = [...scored].sort((a, b) => {
        if (b.score.total !== a.score.total)
            return b.score.total - a.score.total;
        const aMs = totalMs(a.score.breakdown);
        const bMs = totalMs(b.score.breakdown);
        if (aMs !== bMs)
            return aMs - bMs;
        return a.cand.id < b.cand.id ? -1 : a.cand.id > b.cand.id ? 1 : 0;
    });
    return sorted[0].cand;
};
