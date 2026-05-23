import { Phase1DistillError, runPhase1, } from "@/memory";
import { errMessage } from "@/shared";
/** Run the consolidator hook. ALL failure paths return an outcome — the
 *  function never throws (its no-throw contract is what lets `runAgent`'s
 *  finally call it without a defensive try/catch). */
export const runMemoryConsolidatorHook = async (input, log) => {
    const result = await runMemoryConsolidatorHookInner(input);
    log?.(result);
    return result;
};
const runMemoryConsolidatorHookInner = async (input) => {
    const cfg = input.consolidator;
    // Opt-in: consolidator must be configured AND either `enabled` true OR
    // `forceSummarization` true (SOTA Cursor — explicit manual trigger).
    if (cfg === undefined) {
        return { kind: "skipped", reason: "consolidator_disabled" };
    }
    if (cfg.enabled !== true && cfg.forceSummarization !== true) {
        return { kind: "skipped", reason: "consolidator_disabled" };
    }
    // Session-error skip: a session that ended in error should not have
    // its tainted rollout fed to the distill (RolloutTaintedError semantics
    // at the consolidator layer would still catch a malicious payload, but
    // we skip earlier to save the LLM call). `forceSummarization` does NOT
    // override this — a force is intent-to-distill on success, not on a
    // failed run.
    if (!input.sessionOk) {
        return { kind: "skipped", reason: "session_errored" };
    }
    // Required ports/store: absent ⇒ structured skip (no throw). A host
    // that sets `enabled: true` but forgets the port/store learns via the
    // log, the session still finishes cleanly.
    if (cfg.port === undefined) {
        return { kind: "skipped", reason: "port_missing" };
    }
    if (cfg.store === undefined) {
        return { kind: "skipped", reason: "store_missing" };
    }
    const threadId = cfg.threadId ?? input.sessionId;
    if (threadId === undefined || threadId.length === 0) {
        return { kind: "skipped", reason: "thread_id_missing" };
    }
    const phase1Input = {
        threadId,
        sessionId: input.sessionId ?? threadId,
        rolloutMessages: input.rolloutMessages.map((m) => ({ role: m.role, content: m.content })),
        turnCount: input.turnCount,
        // SOTA Cursor `force_summarization` — bypass the host's opt-in by
        // forcing memoryMode=enabled. The MIN_TURN_THRESHOLD cap still
        // applies in the consolidator itself (force does not over-ride the
        // "no signal in tiny conversations" floor).
        memoryMode: cfg.forceSummarization === true || cfg.enabled === true ? "enabled" : "disabled",
        now: input.now ?? Date.now,
    };
    let outcome;
    try {
        outcome = await runPhase1(phase1Input, cfg.port, cfg.store);
    }
    catch (e) {
        if (e instanceof Phase1DistillError) {
            return { kind: "error", message: `Phase1DistillError: ${e.message}` };
        }
        const message = errMessage(e);
        return { kind: "error", message };
    }
    if (outcome.kind === "skipped") {
        return { kind: "skipped", reason: outcome.reason };
    }
    return { kind: "distilled", durationMs: outcome.durationMs, threadId };
};
