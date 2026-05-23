/**
 * Observability error-event regression — pins R-Phase1 P0-2 / P0-3 and
 * R-Phase2 P1-1 fixes.
 *
 * Two prior silent-failure paths in `prepareTurnContext`:
 *
 *   P0-2: proactive `maybeCompact` ⇒ if the summarizer LLM rejects (overloaded
 *         rate-limit, network failure, etc.) the exception propagated UNCAUGHT
 *         through `prepareTurnContext` and the turn aborted with NO `error`
 *         AgentEvent emitted. Probe/triage saw the turn just stop.
 *   P0-3: `resolveMemoryContext` ⇒ same shape — a failing embedder or store
 *         threw out of `recallContext`, the turn died with no observability.
 *
 * AFTER the fix: both sites convert their throw into a structured
 * `{type:"error", message: ...}` AgentEvent and degrade gracefully:
 *   - Compaction: skip this turn's proactive pass (reactive PTL remains the
 *     safety net for actual budget overruns).
 *   - Memory recall: degrade to "no memory context", same observable as a
 *     configured-but-empty store.
 *
 * P1-1: a SUCCESSFUL proactive compaction now also emits
 *   `{type:"recovery", reason:"compact", detail:"proactive"}` so trajectory
 *   consumers can distinguish proactive (top-of-turn threshold-driven) from
 *   reactive (PTL-driven) compactions. The reactive site already emits the
 *   `compact` reason; this closes the symmetry.
 *
 * The test uses real `runAgent` with a ScriptedLLM (mocks the model stream),
 * a `compactIfNeeded`-triggering token threshold of 0 (forces a compaction
 * attempt every turn), and an injected summarizer LLM that throws — driving
 * the P0-2 path. A separate test injects a memory store + embedder that throws
 * on `recall` for P0-3. P1-1 uses a "happy" summarizer LLM that returns a
 * shorter transcript.
 */
import { describe, expect, test } from "bun:test";
import { runAgent } from "@/agent";
import { cfg, ev, RecordingStream, ScriptedLLM, text, withTimeout } from "./_harness";
/** Summarizer LLM that always throws — drives the P0-2 error path. */
class ThrowingSummarizer {
    model = "throwing-summarizer";
    // biome-ignore lint/correctness/useYield: the throwing summarizer never yields events
    async *stream() {
        throw new Error("summarizer-llm-unavailable");
    }
}
/** Summarizer LLM that emits a successful (very short) summary text — drives
 *  the P1-1 path where compaction succeeds and the proactive recovery event
 *  must fire. */
class HappySummarizer {
    model = "happy-summarizer";
    async *stream() {
        yield { type: "text_delta", delta: "compact-summary" };
        yield { type: "message_stop", stop_reason: "end_turn" };
    }
}
/** Minimal store + embedder that throw on the very first recall — drives the
 *  P0-3 error path. We satisfy the interface stubs but the recall path is the
 *  only one the loop calls in this test. */
const throwingStore = {
    save: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    all: async () => [],
    recall: async () => {
        throw new Error("store-recall-unavailable");
    },
};
const noopEmbedder = {
    async embed(text) {
        return text.map(() => [0.1, 0.2, 0.3]);
    },
};
const findErrorEvent = (events, substring) => events.find((e) => e.type === "error" && e.message.includes(substring));
const findRecoveryEvent = (events, reason, detail) => events.find((e) => e.type === "recovery" && e.reason === reason && (detail === undefined || e.detail === detail));
describe("Observability — proactive compaction failure surfaces as error event (P0-2)", () => {
    test("summarizer LLM throws → `error` AgentEvent emitted, loop continues to completion", async () => {
        const llm = new ScriptedLLM([ev(text("done"))]);
        const stream = new RecordingStream();
        // thresholdTokens:0 forces compaction to attempt on every turn. The
        // summarizer throws → before P0-2 fix the throw would bubble out and the
        // turn would abort; after the fix the error becomes a stream event and
        // the loop proceeds.
        // Need ≥ 2 assistant turns + a leading user/assistant pair for
        // `findBoundary(messages, keepTurns:1)` to return a boundary > 0 (i.e.
        // there's actually something to summarize). Threshold:0 forces the LLM
        // call so the throwing summarizer fires.
        const config = cfg({
            llm,
            stream,
            messages: [
                { role: "user", content: [{ type: "text", text: "seed turn 1" }] },
                { role: "assistant", content: [{ type: "text", text: "ack-1" }] },
                { role: "user", content: [{ type: "text", text: "seed turn 2" }] },
                { role: "assistant", content: [{ type: "text", text: "ack-2" }] },
                { role: "user", content: [{ type: "text", text: "continue please" }] },
            ],
            compaction: {
                thresholdTokens: 0,
                keepRecentTurns: 1,
                summarizerLlm: new ThrowingSummarizer(),
            },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "compaction-fail");
        // Loop reaches its terminal completion — the throw did NOT abort the run.
        expect(outcome.reason).toBe("completed");
        // Error event surfaces the failure for trajectory/probe consumption.
        const err = findErrorEvent(stream.events, "proactive compaction failed");
        expect(err).toBeDefined();
        if (err && err.type === "error") {
            expect(err.message).toContain("summarizer-llm-unavailable");
        }
    }, 15_000);
});
describe("Observability — memory recall failure surfaces as error event (P0-3)", () => {
    test("store.recall throws → `error` event emitted, turn continues without memory context", async () => {
        const llm = new ScriptedLLM([ev(text("done"))]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            stream,
            messages: [
                { role: "user", content: [{ type: "text", text: "what did we discuss last time?" }] },
            ],
            store: throwingStore,
            embedder: noopEmbedder,
            memory: { recallLimit: 5 },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "recall-fail");
        expect(outcome.reason).toBe("completed");
        const err = findErrorEvent(stream.events, "memory recall failed");
        expect(err).toBeDefined();
        if (err && err.type === "error") {
            expect(err.message).toContain("store-recall-unavailable");
        }
        // Loop produced its assistant text — the broken recall did NOT block it.
        const text0 = stream.events.find((e) => e.type === "assistant_text");
        expect(text0).toBeDefined();
    }, 15_000);
});
describe("Observability — successful proactive compaction emits recovery event (P1-1)", () => {
    test("happy summarizer + threshold:0 → recovery{reason:'compact',detail:'proactive'} fires", async () => {
        const llm = new ScriptedLLM([ev(text("done"))]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            stream,
            messages: [
                { role: "user", content: [{ type: "text", text: "long context turn 1" }] },
                { role: "assistant", content: [{ type: "text", text: "ack-1" }] },
                { role: "user", content: [{ type: "text", text: "another turn" }] },
                { role: "assistant", content: [{ type: "text", text: "ack-2" }] },
                { role: "user", content: [{ type: "text", text: "and one more" }] },
            ],
            compaction: {
                thresholdTokens: 0,
                keepRecentTurns: 1,
                summarizerLlm: new HappySummarizer(),
            },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "compaction-success");
        expect(outcome.reason).toBe("completed");
        // The proactive recovery event must surface so probe/triage can tell
        // proactive (threshold-driven) from reactive (PTL-driven) compactions.
        const rec = findRecoveryEvent(stream.events, "compact", "proactive");
        expect(rec).toBeDefined();
        if (rec && rec.type === "recovery") {
            expect(rec.reason).toBe("compact");
            expect(rec.detail).toBe("proactive");
        }
    }, 15_000);
});
describe("Observability — default-OFF byte-identical contract preserved", () => {
    test("no compaction config + no store → no error event, no recovery event (legacy path)", async () => {
        const llm = new ScriptedLLM([ev(text("clean run"))]);
        const stream = new RecordingStream();
        const config = cfg({ llm, stream });
        const outcome = await withTimeout(runAgent(config), 10_000, "legacy-baseline");
        expect(outcome.reason).toBe("completed");
        // Neither the error-mapping nor the proactive-recovery branch fires when
        // their respective features are unconfigured.
        expect(stream.events.some((e) => e.type === "error")).toBe(false);
        expect(stream.events.some((e) => e.type === "recovery" && e.reason === "compact")).toBe(false);
    }, 15_000);
});
