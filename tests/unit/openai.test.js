import { describe, expect, test } from "bun:test";
import { assembleFromEvents } from "@/llm";
import { finalizeCalls, mapToolCallDeltas, OpenAIAdapter, STOP_REASON, toChatMessages, } from "@/llm/adapters/openai";
import { LLMError } from "@/shared";
describe("toChatMessages", () => {
    test("system is prepended", () => {
        const out = toChatMessages("sys", [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
        expect(out[0]).toEqual({ role: "system", content: "sys" });
        expect(out[1]).toEqual({ role: "user", content: "hi" });
    });
    test("no system ⇒ no system message", () => {
        const out = toChatMessages(undefined, [
            { role: "user", content: [{ type: "text", text: "hi" }] },
        ]);
        expect(out).toEqual([{ role: "user", content: "hi" }]);
    });
    test("user message with tool_result blocks expands into N role:tool messages", () => {
        const msgs = [
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "tu_1", content: "out1" },
                    { type: "tool_result", tool_use_id: "tu_2", content: "out2", is_error: true },
                ],
            },
        ];
        const out = toChatMessages(undefined, msgs);
        expect(out).toEqual([
            { role: "tool", tool_call_id: "tu_1", content: "out1" },
            { role: "tool", tool_call_id: "tu_2", content: "out2" },
        ]);
    });
    test("user text + tool_result ⇒ user message then tool messages", () => {
        const out = toChatMessages(undefined, [
            {
                role: "user",
                content: [
                    { type: "text", text: "here" },
                    { type: "tool_result", tool_use_id: "tu_3", content: "r" },
                ],
            },
        ]);
        expect(out).toEqual([
            { role: "user", content: "here" },
            { role: "tool", tool_call_id: "tu_3", content: "r" },
        ]);
    });
    test("assistant text + tool_use ⇒ content + tool_calls with JSON.stringify(input)", () => {
        const out = toChatMessages(undefined, [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "thinking out loud" },
                    { type: "tool_use", id: "tu_4", name: "read", input: { path: "a.ts" } },
                ],
            },
        ]);
        expect(out).toEqual([
            {
                role: "assistant",
                content: "thinking out loud",
                tool_calls: [
                    {
                        id: "tu_4",
                        type: "function",
                        function: { name: "read", arguments: '{"path":"a.ts"}' },
                    },
                ],
            },
        ]);
    });
    test("assistant text-only ⇒ content string, no tool_calls", () => {
        const out = toChatMessages(undefined, [
            { role: "assistant", content: [{ type: "text", text: "just text" }] },
        ]);
        expect(out).toEqual([{ role: "assistant", content: "just text" }]);
    });
    test("assistant tool-only ⇒ content null", () => {
        const out = toChatMessages(undefined, [
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "tu_5", name: "ls", input: {} }],
            },
        ]);
        expect(out).toEqual([
            {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "tu_5", type: "function", function: { name: "ls", arguments: "{}" } }],
            },
        ]);
    });
    test("assistant tool_use with nullish input ⇒ arguments {}", () => {
        const out = toChatMessages(undefined, [
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "tu_6", name: "ls", input: null }],
            },
        ]);
        expect(out[0]).toEqual({
            role: "assistant",
            content: null,
            tool_calls: [{ id: "tu_6", type: "function", function: { name: "ls", arguments: "{}" } }],
        });
    });
});
/** Feed chunks through `mapToolCallDeltas` with a shared pending map, mirroring
 *  `OpenAIAdapter.stream`, then flush via `finalizeCalls`. */
const driveCalls = (chunks) => {
    const pending = new Map();
    const streamed = [];
    for (const c of chunks) {
        for (const ev of mapToolCallDeltas(c, pending))
            streamed.push(ev);
    }
    const final = [];
    for (const ev of finalizeCalls(pending))
        final.push(ev);
    return { streamed, final };
};
const toolChunk = (index, parts) => ({
    choices: [
        {
            delta: {
                tool_calls: [
                    {
                        index,
                        ...(parts.id ? { id: parts.id } : {}),
                        ...(parts.name !== undefined || parts.arguments !== undefined
                            ? {
                                function: {
                                    ...(parts.name !== undefined ? { name: parts.name } : {}),
                                    ...(parts.arguments !== undefined ? { arguments: parts.arguments } : {}),
                                },
                            }
                            : {}),
                    },
                ],
            },
            finish_reason: null,
        },
    ],
});
describe("mapToolCallDeltas + finalizeCalls", () => {
    test("id+name first chunk, args fragmented across later chunks", () => {
        const { streamed, final } = driveCalls([
            toolChunk(0, { id: "tu_1", name: "read" }),
            toolChunk(0, { arguments: '{"pa' }),
            toolChunk(0, { arguments: 'th":"a' }),
            toolChunk(0, { arguments: '.ts"}' }),
        ]);
        expect(streamed).toEqual([
            { type: "tool_use_start", id: "tu_1", name: "read" },
            { type: "tool_use_delta", id: "tu_1", delta: '{"pa' },
            { type: "tool_use_delta", id: "tu_1", delta: 'th":"a' },
            { type: "tool_use_delta", id: "tu_1", delta: '.ts"}' },
        ]);
        expect(final).toEqual([{ type: "tool_use_end", id: "tu_1", input: { path: "a.ts" } }]);
    });
    test("two interleaved indexes ⇒ start once per index, end in index order", () => {
        const { streamed, final } = driveCalls([
            toolChunk(0, { id: "tu_a", name: "x" }),
            toolChunk(1, { id: "tu_b", name: "y" }),
            toolChunk(1, { arguments: '{"b":2}' }),
            toolChunk(0, { arguments: '{"a":1}' }),
        ]);
        expect(streamed).toEqual([
            { type: "tool_use_start", id: "tu_a", name: "x" },
            { type: "tool_use_start", id: "tu_b", name: "y" },
            { type: "tool_use_delta", id: "tu_b", delta: '{"b":2}' },
            { type: "tool_use_delta", id: "tu_a", delta: '{"a":1}' },
        ]);
        expect(final).toEqual([
            { type: "tool_use_end", id: "tu_a", input: { a: 1 } },
            { type: "tool_use_end", id: "tu_b", input: { b: 2 } },
        ]);
    });
    test("args arriving before id/name are buffered, not lost", () => {
        const { streamed, final } = driveCalls([
            toolChunk(0, { arguments: '{"k":' }),
            toolChunk(0, { id: "tu_late", name: "f" }),
            toolChunk(0, { arguments: "1}" }),
        ]);
        expect(streamed).toEqual([
            { type: "tool_use_start", id: "tu_late", name: "f" },
            { type: "tool_use_delta", id: "tu_late", delta: "1}" },
        ]);
        expect(final).toEqual([{ type: "tool_use_end", id: "tu_late", input: { k: 1 } }]);
    });
    test("empty args ⇒ input {}", () => {
        const { final } = driveCalls([toolChunk(0, { id: "tu_e", name: "noargs" })]);
        expect(final).toEqual([{ type: "tool_use_end", id: "tu_e", input: {} }]);
    });
    test("malformed args ⇒ LLMError naming the id", () => {
        const pending = new Map();
        for (const _ of mapToolCallDeltas(toolChunk(0, { id: "tu_m", name: "f" }), pending)) {
            // drain
        }
        for (const _ of mapToolCallDeltas(toolChunk(0, { arguments: "{oops" }), pending)) {
            // drain
        }
        expect(() => {
            for (const _ of finalizeCalls(pending)) {
                // drain
            }
        }).toThrow(LLMError);
        try {
            for (const _ of finalizeCalls(pending)) {
                // drain
            }
        }
        catch (e) {
            expect(e).toBeInstanceOf(LLMError);
            expect(e.message).toContain("tu_m");
        }
    });
    test("chunk without tool_calls is a no-op", () => {
        const pending = new Map();
        const out = [];
        for (const ev of mapToolCallDeltas({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }, pending)) {
            out.push(ev);
        }
        expect(out).toEqual([]);
        expect(pending.size).toBe(0);
    });
});
describe("STOP_REASON mapping", () => {
    test("known reasons map correctly", () => {
        expect(STOP_REASON.tool_calls).toBe("tool_use");
        expect(STOP_REASON.stop).toBe("end_turn");
        expect(STOP_REASON.length).toBe("max_tokens");
    });
    test("unknown reason is not in the table (passthrough at call site)", () => {
        expect(STOP_REASON.content_filter).toBeUndefined();
        const reason = "content_filter";
        expect(STOP_REASON[reason] ?? reason).toBe("content_filter");
    });
});
describe("mapping ↔ assembly contract", () => {
    test("a representative stream assembles into the expected Message", () => {
        const pending = new Map();
        const events = [];
        events.push({ type: "text_delta", delta: "Let me " });
        events.push({ type: "text_delta", delta: "check." });
        for (const ev of mapToolCallDeltas(toolChunk(0, { id: "tu_x", name: "read" }), pending)) {
            events.push(ev);
        }
        for (const ev of mapToolCallDeltas(toolChunk(0, { arguments: '{"path":"x.ts"}' }), pending)) {
            events.push(ev);
        }
        for (const ev of finalizeCalls(pending))
            events.push(ev);
        events.push({ type: "message_stop", stop_reason: STOP_REASON.tool_calls ?? "end_turn" });
        const { message, stopReason } = assembleFromEvents(events);
        expect(stopReason).toBe("tool_use");
        expect(message).toEqual({
            role: "assistant",
            content: [
                { type: "text", text: "Let me check.", phase: "commentary" },
                { type: "tool_use", id: "tu_x", name: "read", input: { path: "x.ts" } },
            ],
        });
    });
});
describe("OpenAIAdapter — LLMPort.model", () => {
    test("exposes the configured model id as a readable .model", () => {
        const adapter = new OpenAIAdapter({ apiKey: "test-key", model: "gpt-4o" });
        expect(adapter.model).toBe("gpt-4o");
    });
    test("instance is assignable to LLMPort with .model readable", () => {
        const port = new OpenAIAdapter({ apiKey: "test-key", model: "gpt-4o-mini" });
        expect(port.model).toBe("gpt-4o-mini");
    });
});
