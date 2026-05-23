import { errMessage } from "@/shared";
const safeTrace = (onTrace, e) => {
    if (onTrace === undefined)
        return;
    try {
        onTrace(e);
    }
    catch {
        // Trace sink must never break the search.
    }
};
/** Run one candidate end-to-end with a per-branch timeout. Always resolves to
 *  a `{ cand, cleanup }` pair — failures become `outcome.kind:"failed"`, never
 *  a rejection (so `Promise.allSettled` always has a usable value). */
const oneCandidate = async (i, req) => {
    const id = `cand-${i}`;
    const seed = req.seeds[i] ?? {};
    const acquired = await req.isolator.acquire(i);
    const controller = new AbortController();
    let timer;
    safeTrace(req.onTrace, { kind: "candidate-started", id, seed });
    const startedAt = Date.now();
    try {
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
                controller.abort();
                resolve({ kind: "failed", reason: `timeout after ${req.timeoutPerBranchMs}ms` });
            }, req.timeoutPerBranchMs);
        });
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
            kind: "failed",
            reason: errMessage(e),
        }));
        const outcome = await Promise.race([run, timeout]);
        if (outcome.kind === "completed") {
            safeTrace(req.onTrace, {
                kind: "candidate-finished",
                id,
                turns: outcome.turns,
                durationMs: Date.now() - startedAt,
            });
        }
        else {
            safeTrace(req.onTrace, { kind: "candidate-failed", id, reason: outcome.reason });
        }
        const cand = { id, seed, workspace: acquired.workspace, outcome };
        return { cand, cleanup: acquired.cleanup };
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
};
/**
 * Spawn N candidates in parallel. `seeds` shorter than N ⇒ missing seeds
 * inherit `{}` (parent config). Returns ALL candidates (incl. failed) so the
 * orchestrator can score survivors and surface losers.
 */
export const parallelPropose = async (req) => {
    const settled = await Promise.allSettled(Array.from({ length: req.N }, (_, i) => oneCandidate(i, req)));
    const candidates = [];
    const cleanups = [];
    for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s?.status === "fulfilled") {
            candidates.push(s.value.cand);
            cleanups.push(s.value.cleanup);
        }
        else {
            // `oneCandidate` is contractually no-throw; this only fires if
            // `isolator.acquire` itself rejected. Surface a failed candidate with a
            // no-op cleanup so indices stay aligned.
            const reason = errMessage(s?.reason);
            candidates.push({
                id: `cand-${i}`,
                seed: req.seeds[i] ?? {},
                workspace: "",
                outcome: { kind: "failed", reason: `isolation failed: ${reason}` },
            });
            cleanups.push(async () => { });
            safeTrace(req.onTrace, { kind: "candidate-failed", id: `cand-${i}`, reason });
        }
    }
    return { candidates, cleanups };
};
