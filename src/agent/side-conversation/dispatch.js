/**
 * Side-conversation dispatch router seam (ADR-0049 R5 follow-up).
 *
 * Split out of `side-conversation.ts` (#10): the DISPATCH indirection layer
 * decouples external (UI/CLI/RPC) callers from the executor's
 * {@link SideConversationOptions} surface. Callers describe WHAT they want
 * ({@link SideConversationRequest}); the host-supplied {@link SideConversationResolver}
 * decides which LLM port + tool list to use; {@link dispatchSideConversation}
 * wires the two together and delegates to `runSideConversation` in `./run.ts`.
 */
import { assertSideConversationEffort, runSideConversation, } from "./run";
/**
 * Public router. UI surfaces (composer sub-thread input, CLI slash-command,
 * desktop sidebar) call this; the host injects the resolver and the parent
 * abort signal. Parent agent loop is NEVER interrupted — this function does
 * not touch any shared state, mutex, or message buffer.
 */
export const dispatchSideConversation = async (req, resolver) => {
    // Re-validate effort here too: the request shape arrives from an external
    // boundary (RPC/UI), so we cannot trust the type system alone.
    if (req.effort !== undefined)
        assertSideConversationEffort(req.effort);
    // Build the options object via spreads so `exactOptionalPropertyTypes` is
    // honored — never assign `undefined` to a non-`undefined` optional slot.
    const tools = resolver.resolveTools?.(req);
    const opts = {
        parentSessionId: req.parentSessionId,
        question: req.question,
        llm: resolver.resolveLlm(req),
        ...(tools !== undefined ? { tools } : {}),
        ...(req.effort !== undefined ? { effort: req.effort } : {}),
        ...(resolver.signal !== undefined ? { signal: resolver.signal } : {}),
        ...(resolver.observe !== undefined ? { observe: resolver.observe } : {}),
    };
    const result = await runSideConversation(opts);
    return {
        answer: result.answer,
        tokens: result.tokens,
        durationMs: result.durationMs,
    };
};
