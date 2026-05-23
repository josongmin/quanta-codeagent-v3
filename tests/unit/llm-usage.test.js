import { describe, expect, test } from "bun:test";
import { AnthropicAdapter, assembleFromEvents } from "@/llm";
import { mapRawEvent } from "@/llm/adapters/anthropic";
import { OpenAIAdapter } from "@/llm/adapters/openai";
/** Collect an async stream into an array. */
const collect = async (it) => {
    const out = [];
    for await (const ev of it)
        out.push(ev);
    return out;
};
const baseInput = (over = {}) => ({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...over,
});
// ── Anthropic: usage extraction via mapRawEvent + shared accumulator ──────────
/** Drive raw events through `mapRawEvent` with the shared open-slots map AND a
 *  shared usage accumulator, exactly as `AnthropicAdapter.stream` does. */
const drive = (events) => {
    const open = new Map();
    const usage = {};
    const out = [];
    for (const ev of events) {
        for (const mapped of mapRawEvent(ev, open, usage))
            out.push(mapped);
    }
    return out;
};
describe("Anthropic adapter — usage emission (RFC-0002 §5.3)", () => {
    test("message_start usage + message_delta output + message_stop ⇒ one usage event before message_stop", () => {
        const out = drive([
            {
                type: "message_start",
                message: {
                    model: "claude-sonnet-4-5",
                    usage: { input_tokens: 120, cache_read_input_tokens: 40 },
                },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 57 } },
            { type: "message_stop" },
        ]);
        // Content events unchanged.
        expect(out.filter((e) => e.type === "text_delta")).toEqual([
            { type: "text_delta", delta: "Hi" },
        ]);
        const usageEvents = out.filter((e) => e.type === "usage");
        expect(usageEvents).toEqual([
            {
                type: "usage",
                inputTokens: 120,
                outputTokens: 57,
                cacheReadTokens: 40,
                model: "claude-sonnet-4-5",
            },
        ]);
        // The stop_reason StreamEvent rides on the raw `message_delta`; usage MUST
        // be emitted immediately before that terminal message_stop StreamEvent.
        const usageIdx = out.findIndex((e) => e.type === "usage");
        const stopIdx = out.findIndex((e) => e.type === "message_stop");
        expect(usageIdx).toBeGreaterThanOrEqual(0);
        expect(stopIdx).toBeGreaterThan(usageIdx);
        expect(out.at(-1)).toEqual({ type: "message_stop", stop_reason: "end_turn" });
    });
    test("no cache_read_input_tokens ⇒ usage event omits cacheReadTokens entirely (no zero)", () => {
        const out = drive([
            { type: "message_start", message: { model: "claude-x", usage: { input_tokens: 10 } } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
            { type: "message_stop" },
        ]);
        const usageEvents = out.filter((e) => e.type === "usage");
        expect(usageEvents).toHaveLength(1);
        const u = usageEvents[0];
        expect(u).toEqual({ type: "usage", inputTokens: 10, outputTokens: 5, model: "claude-x" });
        expect(u && "cacheReadTokens" in u).toBe(false);
    });
    test("stream() integration: usage emitted exactly once, right before message_stop", async () => {
        const adapter = new AnthropicAdapter({ apiKey: "k", model: "claude-fallback" });
        const raw = [
            {
                type: "message_start",
                message: { model: "claude-sonnet-4-5", usage: { input_tokens: 200 } },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 11 } },
            { type: "message_stop" },
        ];
        const client = adapter.client;
        client.messages.create = () => Promise.resolve({
            async *[Symbol.asyncIterator]() {
                for (const e of raw)
                    yield e;
            },
        });
        const events = await collect(adapter.stream(baseInput()));
        const usageEvents = events.filter((e) => e.type === "usage");
        expect(usageEvents).toEqual([
            { type: "usage", inputTokens: 200, outputTokens: 11, model: "claude-sonnet-4-5" },
        ]);
        const usageIdx = events.findIndex((e) => e.type === "usage");
        const stopIdx = events.findIndex((e) => e.type === "message_stop");
        expect(usageIdx).toBeGreaterThanOrEqual(0);
        expect(stopIdx).toBeGreaterThan(usageIdx);
    });
});
class FakeOpenAI {
    chunks;
    requests = [];
    constructor(chunks) {
        this.chunks = chunks;
    }
    chat = {
        completions: {
            create: async (req) => {
                this.requests.push(req);
                const chunks = this.chunks;
                return {
                    async *[Symbol.asyncIterator]() {
                        for (const c of chunks)
                            yield c;
                    },
                };
            },
        },
    };
}
const adapterWith = (fake) => {
    const a = new OpenAIAdapter({ apiKey: "test", model: "gpt-x" });
    a.client = fake;
    return a;
};
const textChunk = (delta) => ({
    choices: [{ delta: { content: delta }, finish_reason: null }],
});
const stopChunk = (finish) => ({
    choices: [{ delta: {}, finish_reason: finish }],
});
const usageChunk = (model, usage) => ({ choices: [], model, usage });
describe("OpenAI adapter — usage emission (RFC-0002 §5.3)", () => {
    test("sets stream_options.include_usage on the request", async () => {
        const fake = new FakeOpenAI([textChunk("x"), stopChunk("stop")]);
        await collect(adapterWith(fake).stream(baseInput()));
        expect(fake.requests[0]?.stream_options).toEqual({ include_usage: true });
    });
    test("usage-bearing final chunk ⇒ one usage event mapped incl. cached_tokens, before message_stop", async () => {
        const fake = new FakeOpenAI([
            textChunk("hello"),
            stopChunk("stop"),
            usageChunk("gpt-4o-2024", {
                prompt_tokens: 300,
                completion_tokens: 42,
                prompt_tokens_details: { cached_tokens: 128 },
            }),
        ]);
        const events = await collect(adapterWith(fake).stream(baseInput()));
        const usageEvents = events.filter((e) => e.type === "usage");
        expect(usageEvents).toEqual([
            {
                type: "usage",
                inputTokens: 300,
                outputTokens: 42,
                cacheReadTokens: 128,
                model: "gpt-4o-2024",
            },
        ]);
        const usageIdx = events.findIndex((e) => e.type === "usage");
        const stopIdx = events.findIndex((e) => e.type === "message_stop");
        expect(usageIdx).toBeGreaterThanOrEqual(0);
        expect(stopIdx).toBeGreaterThan(usageIdx);
    });
    test("usage without cached_tokens ⇒ no cacheReadTokens key (no zero)", async () => {
        const fake = new FakeOpenAI([
            textChunk("y"),
            stopChunk("stop"),
            usageChunk("gpt-x", { prompt_tokens: 7, completion_tokens: 3 }),
        ]);
        const events = await collect(adapterWith(fake).stream(baseInput()));
        const u = events.find((e) => e.type === "usage");
        expect(u).toEqual({ type: "usage", inputTokens: 7, outputTokens: 3, model: "gpt-x" });
        expect(u && "cacheReadTokens" in u).toBe(false);
    });
    test("stream with NO usage (older model) ⇒ NO usage event emitted (no zeros)", async () => {
        const fake = new FakeOpenAI([textChunk("only text"), stopChunk("stop")]);
        const events = await collect(adapterWith(fake).stream(baseInput()));
        expect(events.some((e) => e.type === "usage")).toBe(false);
        // Existing semantics intact.
        expect(events).toEqual([
            { type: "text_delta", delta: "only text" },
            { type: "message_stop", stop_reason: "end_turn" },
        ]);
    });
});
// ── assembleFromEvents compatibility ─────────────────────────────────────────
describe("assembleFromEvents — usage event is non-content and ignored", () => {
    test("a usage event passing through does not throw and does not affect the message", () => {
        const withUsage = [
            { type: "text_delta", delta: "Result" },
            { type: "usage", inputTokens: 9, outputTokens: 4, cacheReadTokens: 1, model: "m" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const withoutUsage = [
            { type: "text_delta", delta: "Result" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const a = assembleFromEvents(withUsage);
        const b = assembleFromEvents(withoutUsage);
        expect(a).toEqual(b);
        expect(a.message).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "Result", phase: "final_answer" }],
        });
        expect(a.stopReason).toBe("end_turn");
    });
});
