/**
 * Best-of-N sampler.
 *
 * DESIGN DECISION (RFC §13 Q4 — "Best-of-N 구현 위치"):
 * Best-of-N lives here as a MODULE INSIDE apps/bench, NOT a new top-level
 * slice and NOT inside agent/. Rationale:
 *   - It is a pure app-composition concern: run N independent agent
 *     trajectories and pick one. The agent loop itself stays single-trajectory
 *     and ignorant of sampling (RFC §1.2: no closed-alphabet / orchestration
 *     creep in the core).
 *   - RFC §3.1 minimalism: a new slice is only justified by a domain with its
 *     own ports/adapters. Sampling has neither — it is a small generic
 *     combinator (`makeAttempt`/`score`) the bench app parameterises.
 *   - RFC §8 puts Best-of-N under "apps/bench (N=5 sampling, voting)" in
 *     Phase 3. Keeping it in apps/bench matches the planned location.
 * Promotion trigger: if a second consumer outside apps/bench needs it, extract
 * to a `sampler/` slice then (and only then) per RFC §5.2 약식→풀 rule.
 *
 * The sampler is generic over a `T` attempt payload so it does not depend on
 * the bench runner types; the bench CLI specialises it to InstanceResult.
 */
const runOne = async (index, input) => {
    try {
        const value = await input.makeAttempt(index);
        return { index, value, score: input.score(value, index) };
    }
    catch (e) {
        return { index, score: Number.NEGATIVE_INFINITY, error: e.message };
    }
};
/** Run `n` attempts with a fixed-size worker pool (bounded concurrency), then
 *  pick the highest score with a stable tie-break by ascending index. A thrown
 *  attempt becomes a failed SampledAttempt (score -Infinity) and never aborts
 *  the batch. Deterministic given deterministic makeAttempt/score. */
export const sampleBestOfN = async (input) => {
    const n = Math.max(1, Math.trunc(input.n));
    const limit = Math.max(1, Math.min(input.concurrency ?? Math.min(n, 4), n));
    const attempts = new Array(n);
    let next = 0;
    const worker = async () => {
        while (next < n) {
            const i = next;
            next += 1;
            attempts[i] = await runOne(i, input);
        }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
    let best = attempts[0];
    for (let i = 1; i < n; i++) {
        const a = attempts[i];
        if (a.score > best.score)
            best = a;
    }
    return { best, attempts };
};
/** Selection strategy: highest score, stable tie-break (just reads `best`). */
export const selectByScore = (out) => out.best;
/** Normalize a diff for voting: drop blank lines and surrounding whitespace so
 *  cosmetically-different but semantically-identical patches cluster. */
const normalizePatch = (patch) => patch
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n")
    .trim();
/** Bucket attempts by normalized patch, skipping undefined/empty patches. */
const groupByPatch = (attempts) => {
    const groups = new Map();
    for (const a of attempts) {
        const patch = a.value?.patch;
        if (patch === undefined)
            continue;
        const key = normalizePatch(patch);
        if (key === "")
            continue;
        const bucket = groups.get(key);
        if (bucket)
            bucket.push(a.index);
        else
            groups.set(key, [a.index]);
    }
    return groups;
};
/** Largest group; ties → group with the lowest member index (deterministic). */
const winningGroup = (groups) => {
    let best = [];
    for (const members of groups.values()) {
        const sameSizeButEarlier = members.length === best.length &&
            Math.min(...members) < Math.min(...(best.length ? best : [Infinity]));
        if (members.length > best.length || sameSizeButEarlier)
            best = members;
    }
    return best;
};
/**
 * Majority-vote selection for code tasks. Groups attempts by normalized patch
 * string and returns the representative of the largest group (consensus).
 * Empty patches are NOT a consensus signal — they are excluded from voting;
 * if every attempt is empty the lowest-index attempt is returned. Ties between
 * non-empty groups break toward the group whose representative has the lowest
 * attempt index (stable, deterministic).
 */
export const patchVote = (attempts) => {
    const groups = groupByPatch(attempts);
    const members = winningGroup(groups);
    const first = attempts[0];
    if (members.length === 0) {
        const fallback = [...attempts].sort((x, y) => x.index - y.index)[0];
        return { representative: fallback ?? first, votes: 0, groups };
    }
    const repIndex = Math.min(...members);
    const representative = attempts.find((a) => a.index === repIndex) ?? first;
    return { representative, votes: members.length, groups };
};
