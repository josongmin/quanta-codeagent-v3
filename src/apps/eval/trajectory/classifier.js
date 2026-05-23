import { errMessage, logger } from "@/shared";
import { makeRunId, ResultStore } from "../storage";
import { classifyQuery } from "../taxonomy";
import { listSessions, loadSession } from "./source";
const recordUnclassified = (store, runId, file, session, confidence) => store.append(runId, {
    tier: "trajectory",
    usecase: "unclassified",
    payload: {
        kind: "trajectory",
        source: file,
        sessionId: session.sessionId,
        confidence,
        turns: session.turns,
    },
});
export const classifyTrajectories = async (opts) => {
    const start = Date.now();
    const store = new ResultStore({
        ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    const runId = makeRunId("trajectory", opts.now);
    const files = listSessions(opts.inputDir);
    let classified = 0;
    let unrecognised = 0;
    let noMeta = 0;
    let classifierErrors = 0;
    for (const f of files) {
        let session;
        try {
            session = loadSession(f);
        }
        catch (e) {
            logger.warn("eval.trajectory: load failed", {
                file: f,
                error: errMessage(e),
            });
            noMeta += 1;
            continue;
        }
        if (session.meta === null) {
            const reason = session.metaResult.kind === "malformed"
                ? `meta_malformed: ${session.metaResult.error}`
                : "no_meta_sidecar";
            logger.warn("eval.trajectory: skipping session", { file: f, reason });
            await recordUnclassified(store, runId, f, session, 0);
            noMeta += 1;
            continue;
        }
        const result = await classifyQuery(session.meta.userPrompt, { llm: opts.llm });
        if (result.error !== undefined) {
            // INFRA failure — distinct from "model said id:null". Surface as its
            // own counter so an overloaded provider doesn't silently inflate
            // `unrecognised`.
            logger.warn("eval.trajectory: classifier infra error", {
                file: f,
                error: result.error,
            });
            classifierErrors += 1;
            await recordUnclassified(store, runId, f, session, 0);
            continue;
        }
        if (result.id === null) {
            await recordUnclassified(store, runId, f, session, result.confidence);
            unrecognised += 1;
            continue;
        }
        classified += 1;
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
        });
    }
    const durationMs = Date.now() - start;
    const counts = {
        pass: classified,
        partial: 0,
        fail: 0,
        error: classifierErrors,
        skipped: unrecognised + noMeta,
    };
    await store.finish({
        runId,
        tier: "trajectory",
        argv: process.argv.slice(2),
        counts,
        durationMs,
    });
    return {
        runId,
        total: files.length,
        classified,
        unrecognised,
        noMeta,
        classifierErrors,
        durationMs,
    };
};
