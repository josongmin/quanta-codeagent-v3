/**
 * ADR-0076 Gap-5 — `streamingTurn` Phase 3 short-circuit on refusal stop.
 *
 * When the stream ends with `stop_reason: "refusal"` and a `tool_use_end`
 * resolved mid-stream onto an UNSAFE (concurrency-unsafe / barrier-engaged)
 * slot, the deferred dispatch in Phase 3 MUST NOT execute — the model
 * refused to continue, and running the speculative tool would carry out
 * the refused intent. The mid-stream in-flight (overlap-safe) calls that
 * already started before the refusal arrived in the stream are awaited
 * (they cannot be un-started) and their results are collected.
 *
 * Negative invariants this file pins:
 *   NI-1  bash (concurrency-unsafe) tool_use_end + refusal stop ⇒ dispatch
 *         is NEVER called for that slot (Phase 3 is skipped entirely).
 *   NI-2  resultBlocks is empty when ALL tool calls were deferred (no
 *         in-flight survivors).
 *   NI-3  byte-identical for non-refusal: the same input with a
 *         `tool_use` stop reason DOES dispatch (Phase 3 unchanged).
 *   NI-4  An overlap-safe (read-only) call already in flight at the time
 *         of refusal RESOLVES — its dispatch was started in Phase 1 and
 *         cannot be cancelled by the post-stream short-circuit.
 *   NI-5  `tool_use` blocks remain on `message.content` even after the
 *         short-circuit (the assembler does not strip them); it is the
 *         loop's terminal `error` return that prevents wm.append so the
 *         orphan blocks never carry to the next turn.
 *
 * Tests use the same mock harness style as streaming-dispatch.test.ts —
 * a recording dispatch that logs `start:<id>` / `end:<id>` per call. The
 * dispatch is asserted to NEVER fire for deferred slots when refusal
 * arrives.
 */
import { describe, expect, test } from "bun:test";
import { streamingTurn } from "@/agent/streaming-dispatch";
async function* gen(events) {
    for (const ev of events) {
        yield ev;
        await Promise.resolve();
    }
}
const toolUse = (id, name, input) => [
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, input },
];
const okBlock = (id, content) => ({
    block: { type: "tool_result", tool_use_id: id, content },
    ok: true,
    preview: content,
});
const makeHarness = (safeNames) => {
    const dispatchCalls = [];
    return {
        dispatchCalls,
        isConcurrencySafe: (name) => safeNames.includes(name),
        dispatch: async (call) => {
            dispatchCalls.push(call.id);
            await new Promise((r) => setTimeout(r, 5));
            return okBlock(call.id, `out-${call.id}`);
        },
    };
};
describe("ADR-0076 Gap-5 — refusal short-circuits Phase 3 deferred dispatch", () => {
    test("NI-1: bash (unsafe) tool_use_end + refusal ⇒ dispatch NEVER called", async () => {
        const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness([]); // bash = unsafe
        const events = [
            ...toolUse("t1", "bash", { command: "echo malicious" }),
            { type: "text_delta", delta: "On reflection, I refuse." },
            { type: "message_stop", stop_reason: "refusal" },
        ];
        const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
        expect(res.kind).toBe("assembled");
        if (res.kind !== "assembled")
            return;
        expect(res.stopReason).toBe("refusal");
        // The critical invariant — dispatch was NEVER called.
        expect(dispatchCalls).toEqual([]);
    });
    test("NI-2: resultBlocks is EMPTY when all calls were deferred on refusal", async () => {
        const { isConcurrencySafe, dispatch } = makeHarness([]);
        const events = [
            ...toolUse("t1", "bash", { command: "x" }),
            ...toolUse("t2", "bash", { command: "y" }),
            { type: "message_stop", stop_reason: "refusal" },
        ];
        const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
        expect(res.kind).toBe("assembled");
        if (res.kind !== "assembled")
            return;
        expect(res.resultBlocks).toEqual([]);
    });
    test("NI-3: byte-identical for tool_use stop — Phase 3 STILL runs (regression guard)", async () => {
        const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness([]);
        const events = [
            ...toolUse("t1", "bash", { command: "ls" }),
            { type: "message_stop", stop_reason: "tool_use" },
        ];
        const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
        expect(res.kind).toBe("assembled");
        if (res.kind !== "assembled")
            return;
        expect(res.stopReason).toBe("tool_use");
        // Phase 3 fired for the deferred unsafe slot — normal path unchanged.
        expect(dispatchCalls).toEqual(["t1"]);
        expect(res.resultBlocks).toHaveLength(1);
    });
    test("NI-4: overlap-safe call already in flight RESOLVES even on refusal", async () => {
        // `read` is concurrency-safe → starts in flight in Phase 1. The refusal
        // arrives AFTER the call started; the post-stream short-circuit can only
        // skip Phase 3, not un-start an already-running dispatch. Phase 2 awaits
        // it; Phase 4 collects its result.
        const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness(["read"]);
        const events = [
            ...toolUse("safe1", "read", { path: "/a" }),
            { type: "text_delta", delta: "Decided to refuse" },
            { type: "message_stop", stop_reason: "refusal" },
        ];
        const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
        expect(res.kind).toBe("assembled");
        if (res.kind !== "assembled")
            return;
        expect(res.stopReason).toBe("refusal");
        expect(dispatchCalls).toEqual(["safe1"]);
        expect(res.resultBlocks).toHaveLength(1);
        expect(res.resultBlocks[0]).toMatchObject({
            type: "tool_result",
            tool_use_id: "safe1",
        });
    });
    test("NI-4b: mixed in-flight safe + deferred unsafe — only the safe survivor produces a block", async () => {
        // First call is safe (starts immediately). Second call is unsafe — engages
        // the barrier. On refusal, the safe call resolves and the unsafe deferred
        // call NEVER dispatches.
        const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness(["read"]);
        const events = [
            ...toolUse("safe1", "read", { path: "/a" }),
            ...toolUse("unsafe2", "bash", { command: "rm -rf" }),
            { type: "message_stop", stop_reason: "refusal" },
        ];
        const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
        expect(res.kind).toBe("assembled");
        if (res.kind !== "assembled")
            return;
        expect(dispatchCalls).toEqual(["safe1"]);
        expect(res.resultBlocks).toHaveLength(1);
        expect(res.resultBlocks[0]).toMatchObject({ tool_use_id: "safe1" });
    });
    test("NI-5: assembled message STILL carries the orphan tool_use blocks (assembler unchanged)", async () => {
        // The short-circuit is at dispatch/Phase 3 only — the assembler is not
        // touched, so message.content keeps the tool_use block. The loop's
        // terminal `error` branch prevents wm.append so this orphan never
        // pollutes the next turn (verified at the loop level, not here).
        const { isConcurrencySafe, dispatch } = makeHarness([]);
        const events = [
            ...toolUse("t1", "bash", { command: "echo x" }),
            { type: "message_stop", stop_reason: "refusal" },
        ];
        const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
        expect(res.kind).toBe("assembled");
        if (res.kind !== "assembled")
            return;
        const toolBlocks = res.message.content.filter((b) => b.type === "tool_use");
        expect(toolBlocks).toHaveLength(1);
    });
    test("NI-1b: refusal with zero tool calls — empty result, no dispatch (sanity)", async () => {
        const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness([]);
        const events = [
            { type: "text_delta", delta: "I refuse." },
            { type: "message_stop", stop_reason: "refusal" },
        ];
        const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
        expect(res.kind).toBe("assembled");
        if (res.kind !== "assembled")
            return;
        expect(dispatchCalls).toEqual([]);
        expect(res.resultBlocks).toEqual([]);
    });
    test("NI-3b: byte-identical for end_turn stop — Phase 3 STILL runs", async () => {
        // The only triggering stop_reason is "refusal". Every other stop reason
        // (including end_turn which has no tools to run; tool_use which does;
        // max_tokens; etc.) keeps the pre-Gap-5 control flow verbatim.
        const { dispatchCalls, isConcurrencySafe, dispatch } = makeHarness([]);
        const events = [
            ...toolUse("t1", "bash", { command: "ls" }),
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch });
        if (res.kind !== "assembled")
            throw new Error("expected assembled");
        expect(dispatchCalls).toEqual(["t1"]);
    });
});
