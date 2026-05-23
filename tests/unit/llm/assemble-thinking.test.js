/**
 * ADR-0076 Gap-2 — `assembleFromEvents` thinking/signature accumulation.
 *
 * Pins the contract that turns a `thinking_delta` / `signature_delta` stream
 * into a {@link ThinkingBlock} on the assembled assistant message, ordered
 * exactly as the provider emitted (thinking BEFORE the text / tool_use it
 * precedes), and stays byte-identical to the pre-feature shape whenever the
 * stream carries no thinking deltas.
 */
import { describe, expect, test } from "bun:test";
import { assembleFromEvents } from "@/llm";
describe("ADR-0076 Gap-2 — assembleFromEvents thinking accumulation", () => {
    test("consecutive thinking_delta events fold into one ThinkingBlock", () => {
        const events = [
            { type: "thinking_delta", text: "Let " },
            { type: "thinking_delta", text: "me " },
            { type: "thinking_delta", text: "think." },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([{ type: "thinking", thinking: "Let me think." }]);
    });
    test("signature_delta accumulates into ThinkingBlock.signature", () => {
        const events = [
            { type: "thinking_delta", text: "reason" },
            { type: "signature_delta", signature: "abc" },
            { type: "signature_delta", signature: "def" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([{ type: "thinking", thinking: "reason", signature: "abcdef" }]);
    });
    test("ThinkingBlock precedes TextBlock when streamed in that order", () => {
        const events = [
            { type: "thinking_delta", text: "first I think" },
            { type: "signature_delta", signature: "sig1" },
            { type: "text_delta", delta: "then I speak" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([
            { type: "thinking", thinking: "first I think", signature: "sig1" },
            { type: "text", text: "then I speak", phase: "final_answer" },
        ]);
    });
    test("ThinkingBlock precedes ToolUseBlock when streamed in that order", () => {
        const events = [
            { type: "thinking_delta", text: "decide tool" },
            { type: "signature_delta", signature: "sig" },
            { type: "tool_use_start", id: "t1", name: "read" },
            { type: "tool_use_end", id: "t1", input: { path: "a.ts" } },
            { type: "message_stop", stop_reason: "tool_use" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([
            { type: "thinking", thinking: "decide tool", signature: "sig" },
            { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
        ]);
    });
    test("no thinking_delta → no ThinkingBlock created (byte-identical)", () => {
        const events = [
            { type: "text_delta", delta: "hi" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([{ type: "text", text: "hi", phase: "final_answer" }]);
        expect(message.content.some((b) => b.type === "thinking")).toBe(false);
    });
    test("signature_delta with no preceding thinking_delta is dropped (no synthetic block)", () => {
        const events = [
            { type: "signature_delta", signature: "orphan" },
            { type: "text_delta", delta: "hi" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([{ type: "text", text: "hi", phase: "final_answer" }]);
    });
    test("redacted:true preserved on the ThinkingBlock and never merges with plaintext", () => {
        const events = [
            { type: "thinking_delta", text: "ENCRYPTED", redacted: true },
            { type: "thinking_delta", text: "plain reasoning" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([
            { type: "thinking", thinking: "ENCRYPTED", redacted: true },
            { type: "thinking", thinking: "plain reasoning" },
        ]);
    });
    test("multiple consecutive redacted deltas with same flag fold together", () => {
        const events = [
            { type: "thinking_delta", text: "ENC1", redacted: true },
            { type: "thinking_delta", text: "ENC2", redacted: true },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([{ type: "thinking", thinking: "ENC1ENC2", redacted: true }]);
    });
    test("two thinking blocks separated by text → two distinct ThinkingBlocks in order", () => {
        const events = [
            { type: "thinking_delta", text: "round 1" },
            { type: "signature_delta", signature: "s1" },
            { type: "text_delta", delta: "interlude" },
            { type: "thinking_delta", text: "round 2" },
            { type: "signature_delta", signature: "s2" },
            { type: "text_delta", delta: "final" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([
            { type: "thinking", thinking: "round 1", signature: "s1" },
            { type: "text", text: "interlude", phase: "final_answer" },
            { type: "thinking", thinking: "round 2", signature: "s2" },
            { type: "text", text: "final", phase: "final_answer" },
        ]);
    });
    test("signature_delta after second thinking block attaches to the LAST block", () => {
        const events = [
            { type: "thinking_delta", text: "a" },
            { type: "signature_delta", signature: "sigA" },
            { type: "text_delta", delta: "between" },
            { type: "thinking_delta", text: "b" },
            { type: "signature_delta", signature: "sigB" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        const thinkingBlocks = message.content.filter((b) => b.type === "thinking");
        expect(thinkingBlocks).toEqual([
            { type: "thinking", thinking: "a", signature: "sigA" },
            { type: "thinking", thinking: "b", signature: "sigB" },
        ]);
    });
    test("stream_reset drops accumulated thinking and starts fresh", () => {
        const events = [
            { type: "thinking_delta", text: "dead reasoning" },
            { type: "signature_delta", signature: "deadsig" },
            { type: "stream_reset" },
            { type: "thinking_delta", text: "live reasoning" },
            { type: "signature_delta", signature: "livesig" },
            { type: "text_delta", delta: "alive" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([
            { type: "thinking", thinking: "live reasoning", signature: "livesig" },
            { type: "text", text: "alive", phase: "final_answer" },
        ]);
    });
    test("empty thinking_delta delta still opens a ThinkingBlock (sticky once started)", () => {
        const events = [
            { type: "thinking_delta", text: "" },
            { type: "signature_delta", signature: "sig" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([{ type: "thinking", thinking: "", signature: "sig" }]);
    });
    test("response_in_progress heartbeat is ignored even when thinking is active", () => {
        const events = [
            { type: "thinking_delta", text: "real" },
            { type: "response_in_progress", message: "thinking..." },
            { type: "thinking_delta", text: " thinking" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const { message } = assembleFromEvents(events);
        expect(message.content).toEqual([{ type: "thinking", thinking: "real thinking" }]);
    });
    test("stopReason from message_stop preserved alongside ThinkingBlock", () => {
        const events = [
            { type: "thinking_delta", text: "x" },
            { type: "message_stop", stop_reason: "max_tokens" },
        ];
        const { stopReason } = assembleFromEvents(events);
        expect(stopReason).toBe("max_tokens");
    });
});
