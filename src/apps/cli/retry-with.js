/**
 * ADR-0065 model-swap retry — CLI `/retry-with [<model-id>]` slash command.
 *
 * Wire-up of {@link resolveRetryModel} + {@link streamWithModel}
 * (`src/llm/model-swap.ts`) as a SESSION-time slash command:
 *
 *  - `/retry-with` (no arg)            → escalate to the next candidate after
 *                                        the current model in the configured
 *                                        ordered list.
 *  - `/retry-with <model-id>`          → request that specific candidate;
 *                                        `NoAlternateModelError` if unknown or
 *                                        identical to the current model.
 *
 * On a successful resolve we DROP the most-recent assistant message from the
 * transcript (keyed by `Message.id`) and re-stream the prior turn against the
 * chosen candidate via {@link streamWithModel}. The leading `stream_reset`
 * tombstone propagates so any consumer that had accumulated the prior partial
 * MUST discard it and assemble fresh from the new stream (semantics documented
 * on {@link StreamEvent} `stream_reset`).
 *
 * Default OFF posture (RFC §1.2): without an injected
 * {@link RetryWithSessionState} on the {@link SlashContext}, this command
 * prints "no model candidates configured" and is a no-op — byte-identical to
 * the surface NOT registering the command at all. NEVER silently succeeds when
 * unconfigured.
 *
 * Slice contract: lives in `src/apps/cli/**` — allowed to import `@/llm`
 * (`ModelCandidate`, `resolveRetryModel`, `streamWithModel`, etc.) per the
 * CLI's position at the top of the slice DAG. ADR-0059's
 * "slash dispatch MUST NOT invoke the LLM" invariant applied to the surface-
 * only Tier-2 set; `/retry-with` is a SESSION-time command (it needs the live
 * transcript) and is excluded from that surface invariant by design.
 */
import { NoAlternateModelError, resolveRetryModel, streamWithModel, } from "@/llm";
/** Parse `/retry-with` arguments. Accepts zero args (escalate) or exactly one
 *  positional `<model-id>`. Throws on shape errors so the dispatch surface can
 *  print a user-visible message. */
export const parseRetryWithArgs = (args) => {
    if (args.length === 0)
        return { requested: undefined };
    if (args.length > 1) {
        throw new Error("/retry-with: expected at most one argument (model id); got " + String(args.length));
    }
    const requested = args[0];
    if (requested === undefined || requested.length === 0) {
        throw new Error("/retry-with: model id cannot be empty");
    }
    return { requested };
};
/** Drop the LAST assistant message from `messages` (keyed by `Message.id` when
 *  present, falling back to "last by role" for legacy id-less messages). The
 *  array is mutated in place. Returns the dropped message, or `undefined` if
 *  none was found (no assistant turn to retry). */
export const dropLastAssistantMessage = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m !== undefined && m.role === "assistant") {
            messages.splice(i, 1);
            return m;
        }
    }
    return undefined;
};
const formatCandidateList = (candidates) => candidates.length === 0 ? "(none)" : candidates.map((c) => c.id).join(", ");
/**
 * The slash command itself. Mirrors the table-driven shape of the five Tier-2
 * commands; the SESSION state arrives via {@link SlashContext.retry}. With no
 * session state OR empty candidates ⇒ user-visible "no model candidates
 * configured" + return 1 (NEVER silently succeeds when unconfigured).
 */
export const retryWithCmd = {
    name: "/retry-with",
    describe: "Re-stream the last assistant turn against an alternate model",
    async run(args, ctx) {
        // Parse first so a shape error doesn't depend on session state.
        let parsed;
        try {
            parsed = parseRetryWithArgs(args);
        }
        catch (e) {
            ctx.err(`${e.message}\n`);
            return 1;
        }
        const state = ctx.retry;
        if (state === undefined) {
            ctx.out("no model candidates configured\n");
            return 1;
        }
        if (state.candidates.length === 0) {
            ctx.out("no model candidates configured\n");
            return 1;
        }
        // Resolve the alternate. NoAlternateModelError is the only QuantaError this
        // path raises by design — surface it with a clear message and DO NOT crash.
        let chosen;
        try {
            chosen = resolveRetryModel({
                current: state.currentModelId,
                candidates: state.candidates,
                ...(parsed.requested !== undefined ? { requested: parsed.requested } : {}),
            });
        }
        catch (e) {
            if (e instanceof NoAlternateModelError) {
                ctx.err(`no alternate model available; configured: ${formatCandidateList(state.candidates)}\n`);
                return 1;
            }
            throw e;
        }
        // Drop the prior assistant message BEFORE re-streaming so the re-stream
        // doesn't observe a half-replaced transcript.
        dropLastAssistantMessage(state.messages);
        // Re-stream. The leading `stream_reset` tombstone is emitted by
        // streamWithModel — propagate every event (including stream_reset) to the
        // consumer. ANY error in the new stream surfaces normally (we do NOT
        // swallow). Cooperative cancel: if the signal aborts mid-loop, the for-
        // await rejection bubbles up to the caller.
        for await (const ev of streamWithModel(chosen, state.streamInput)) {
            if (state.signal?.aborted) {
                // Cooperative: stop forwarding events and surface the abort reason.
                throw state.signal.reason instanceof Error
                    ? state.signal.reason
                    : new Error("retry-with: aborted");
            }
            await state.onEvent(ev);
        }
        ctx.out(`re-streamed against ${chosen.id}\n`);
        return 0;
    },
};
