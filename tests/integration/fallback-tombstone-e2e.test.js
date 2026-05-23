import { describe, expect, test } from "bun:test";
import { runAgent } from "@/agent";
import { FallbackLLM } from "@/llm";
import { LLMError } from "@/shared";
import { cfg, RecordingStream, withTimeout } from "./_harness";
/**
 * GAP 4 — `FallbackLLM` driven through the REAL `runAgent`, including the
 * streaming-dispatch tombstone discard.
 *
 * The PRIMARY provider yields a chunk of assistant text, THEN throws an
 * overload (LLMError with status 529). `isFallbackTrigger` matches it, so
 * FallbackLLM advances to the fallback provider. Because the primary already
 * yielded ≥1 event (`yielded.value === true`), FallbackLLM prefixes the
 * fallback's output with a single `{ type: "stream_reset" }` tombstone.
 *
 * `streamingTurn` (the real loop's stream consumer) handles `stream_reset` by
 * discarding ALL accumulated events and re-accumulating only the post-reset
 * stream — so the assembled assistant message must contain ONLY the fallback's
 * text, never the dead primary partial. This proves the tombstone discard
 * happens end-to-end through the loop, not just in a unit of FallbackLLM.
 */
/** Yields the given events, then throws (a mid-stream provider death). */
class PartialThenThrow {
    partial;
    error;
    model = "primary-model";
    calls = 0;
    constructor(partial, error) {
        this.partial = partial;
        this.error = error;
    }
    async *stream() {
        this.calls += 1;
        for (const e of this.partial)
            yield e;
        throw this.error;
    }
}
/** Plain scripted fallback provider. */
class Fallback {
    events;
    model = "fallback-model";
    calls = 0;
    constructor(events) {
        this.events = events;
    }
    async *stream() {
        this.calls += 1;
        for (const e of this.events)
            yield e;
    }
}
describe("GAP 4 — FallbackLLM + tombstone through runAgent", () => {
    test("primary partial then 529 ⇒ fallback completes; only post-reset text kept", async () => {
        const overload = new LLMError("529 Overloaded", { kind: "overloaded", statusCode: 529 });
        overload.status = 529;
        const primary = new PartialThenThrow([{ type: "text_delta", delta: "DEAD-PARTIAL from the primary that must be discarded" }], overload);
        const fallback = new Fallback([
            { type: "text_delta", delta: "FALLBACK answer kept" },
            { type: "message_stop", stop_reason: "end_turn" },
        ]);
        const llm = new FallbackLLM({ providers: [primary, fallback] });
        const stream = new RecordingStream();
        const out = await withTimeout(runAgent(cfg({ llm, stream, maxTurns: 1 })), 15_000, "fallback-tombstone");
        expect(out.reason).toBe("completed");
        expect(primary.calls).toBe(1);
        expect(fallback.calls).toBe(1);
        const finalAssistant = out.messages.findLast((m) => m.role === "assistant");
        expect(finalAssistant).toBeDefined();
        const assembledText = (finalAssistant?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
        // Only the post-stream_reset (fallback) content survived assembly.
        expect(assembledText).toContain("FALLBACK answer kept");
        expect(assembledText).not.toContain("DEAD-PARTIAL");
        // FallbackLLM mirrors the PRIMARY's model id on the pre-stream marker.
        const reqEvt = stream.events.find((e) => e.type === "llm_request");
        expect(reqEvt).toBeDefined();
        if (reqEvt?.type === "llm_request")
            expect(reqEvt.model).toBe("primary-model");
    });
});
