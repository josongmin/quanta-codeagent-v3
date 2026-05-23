/**
 * ADR-0049 side-conversation seam — e2e wiring tests.
 *
 * Covers (2 tests):
 *   1. dispatchSideConversation() resolves a question through the router
 *      WITHOUT touching the parent agent loop (parallel invocation, parent
 *      completes its own turn unmodified).
 *   2. parent abort cancels the side-conversation (cancellation propagation).
 */
import { describe, expect, it } from "bun:test";
import { dispatchSideConversation, runAgent, SideConversationAbortedError, } from "@/agent";
import { baseConfig, FakeLLM, text } from "./_harness";
/** A side-conv LLM that always answers `text` plus a usage block. */
class SideLlm {
    answer;
    model = "fake-side";
    calls = 0;
    constructor(answer) {
        this.answer = answer;
    }
    async *stream(_input) {
        this.calls += 1;
        yield { type: "text_delta", delta: this.answer };
        yield {
            type: "usage",
            inputTokens: 10,
            outputTokens: 5,
            model: this.model,
        };
        yield { type: "message_stop", stop_reason: "end_turn" };
    }
}
/** A blocking side-conv LLM that yields nothing until the abort fires. */
class BlockingLlm {
    model = "blocking-side";
    async *stream(_input) {
        // Yield-style wait loop honoring the AbortSignal on `input.messages` is
        // not directly visible; we instead spin on a deferred promise that the
        // test's abort triggers via the global `signal` plumbed into the stream
        // (the runner re-checks the parent signal between events).
        //
        // To keep this deterministic without depending on signal threading
        // through the StreamInput, we drop a single empty text event and then
        // wait long enough that the controller can abort. The runSideConversation
        // signal check happens on `for await` resumption.
        yield { type: "text_delta", delta: "" };
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { type: "text_delta", delta: "should-be-discarded" };
        yield { type: "message_stop", stop_reason: "end_turn" };
    }
}
describe("side-conversation e2e", () => {
    it("1. dispatches a question in parallel with the parent loop without disturbing it", async () => {
        const sideLlm = new SideLlm("42");
        const resolver = {
            resolveLlm: () => sideLlm,
        };
        // Parent agent runs a one-turn script; we await it AFTER kicking off the
        // side-conv to assert ordering, but the agent's own LLM is independent
        // of the side-conv LLM (different instance), so the side-conv cannot
        // contaminate the parent's message buffer.
        const parentLlm = new FakeLLM([text("parent-done")]);
        const cfg = baseConfig({ llm: parentLlm, maxTurns: 2 });
        // Fire side-conv concurrently.
        const sidePromise = dispatchSideConversation({ parentSessionId: "parent-session", question: "What is the answer?" }, resolver);
        const [outcome, sideResp] = await Promise.all([runAgent(cfg), sidePromise]);
        expect(outcome.reason).toBe("completed");
        expect(sideResp.answer).toBe("42");
        expect(sideResp.tokens).toEqual({ input: 10, output: 5 });
        // Parent received NO trace of the side-conv (its message history is
        // its own seed + one assistant turn).
        const parentAssistantMessages = outcome.messages.filter((m) => m.role === "assistant");
        expect(parentAssistantMessages.length).toBe(1);
        const parentText = parentAssistantMessages[0]?.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
        expect(parentText).toBe("parent-done");
        expect(parentText).not.toContain("42");
    });
    it("2. parent abort cancels the side-conversation in flight", async () => {
        const ac = new AbortController();
        const blockingLlm = new BlockingLlm();
        const resolver = {
            resolveLlm: () => blockingLlm,
            signal: ac.signal,
        };
        // Kick off the dispatch, then abort while it's mid-stream.
        const promise = dispatchSideConversation({ parentSessionId: "p", question: "long" }, resolver);
        // Abort slightly before the BlockingLlm's setTimeout returns.
        setTimeout(() => ac.abort(), 10);
        await expect(promise).rejects.toBeInstanceOf(SideConversationAbortedError);
    });
});
