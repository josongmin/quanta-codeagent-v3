/**
 * Streaming-dispatch rejection regression — pins R-Phase1 P0-1 fixes.
 *
 * Background: `streamingTurn` (src/agent/streaming-dispatch.ts) interleaves
 * tool dispatch with the model stream. Three phases follow the stream end:
 *
 *   Phase 2 — settle early-started (concurrency-safe, in-flight) dispatches
 *   Phase 3 — drainDeferredSlots: run barrier + post-barrier calls serially
 *   Phase 4 — collectResultBlocks: assemble result blocks in model-call order
 *
 * BEFORE P0-1 (the bug): a rejection in ANY slot's dispatch promise would
 *   • Phase 2 — `Promise.all([rejected])` throws ⇒ Phase 3 + Phase 4 skipped
 *   • Phase 3 — bare `await slot.promise` throws ⇒ later deferred calls skipped
 *   • Phase 4 — `await rejected` throws ⇒ partial result block array
 * The whole `streamingTurn` call throws instead of returning {kind:"assembled"},
 * silently breaking the documented "one block per scheduled call, in original
 * model order" ordering invariant.
 *
 * AFTER P0-1: `Promise.allSettled` (Phase 2, Phase 4) + try/catch in Phase 3.
 * A single rejection becomes a synthetic `dispatchFailedBlock` (is_error:true,
 * tool_use_id matched) in the slot's position. The other scheduled calls still
 * dispatch; result blocks remain in model-call order; the loop receives an
 * `{kind:"assembled"}` outcome it can finish on.
 *
 * The test bypasses the harness's `runAgent` indirection and exercises the
 * pure `streamingTurn` engine directly — that's the only way to inject a
 * pathological `dispatch` that REJECTS instead of returning an ok:false
 * outcome (the loop's real `dispatchTool` is contractually no-throw).
 */
import { describe, expect, test } from "bun:test";
import { streamingTurn } from "@/agent/streaming-dispatch";
const okBlock = (id, name) => ({
    type: "tool_result",
    tool_use_id: id,
    content: `ok-${name}`,
    is_error: false,
});
const okOutcome = (id, name) => ({
    block: okBlock(id, name),
    ok: true,
    preview: `ok-${name}`,
});
/** Produce a stream that schedules `calls` as concurrency-safe tool_uses
 *  (early-started by the engine) and then a `message_stop`. */
const streamFromCalls = async function* (calls) {
    for (const c of calls) {
        yield { type: "tool_use_start", id: c.id, name: c.name };
        yield { type: "tool_use_end", id: c.id, input: {} };
    }
    yield { type: "message_stop", stop_reason: "tool_use" };
};
describe("streamingTurn — Phase 2/3/4 rejection paths (R-Phase1 P0-1)", () => {
    test("Phase 2: early-started rejection → dispatchFailedBlock surfaces, ordering preserved, no throw", async () => {
        // Three SAFE tools, all early-started in Phase 1 (no barrier engaged).
        // The second one's dispatch throws BEFORE the engine reaches Phase 2.
        const seen = [];
        const result = await streamingTurn({
            events: streamFromCalls([
                { id: "a", name: "alpha" },
                { id: "b", name: "boom" },
                { id: "c", name: "charlie" },
            ]),
            isConcurrencySafe: () => true,
            dispatch: async (call) => {
                seen.push(call.id);
                if (call.id === "b")
                    throw new Error("synthetic-dispatch-throw");
                return okOutcome(call.id, call.name);
            },
        });
        expect(result.kind).toBe("assembled");
        if (result.kind !== "assembled")
            return;
        // All three slots were dispatched (no short-circuit).
        expect(seen.sort()).toEqual(["a", "b", "c"]);
        // Ordering invariant: 3 blocks, in original model-call order.
        expect(result.resultBlocks).toHaveLength(3);
        const ids = result.resultBlocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : "?"));
        expect(ids).toEqual(["a", "b", "c"]);
        // The thrown slot becomes a synthesized is_error:true block, matched by id.
        const failed = result.resultBlocks[1];
        expect(failed?.type).toBe("tool_result");
        if (failed?.type === "tool_result") {
            expect(failed.is_error).toBe(true);
            expect(failed.tool_use_id).toBe("b");
            expect(failed.content).toContain("synthetic-dispatch-throw");
        }
    });
    test("Phase 3: deferred (post-barrier) rejection → next deferred still dispatches", async () => {
        // First call is UNSAFE → engages head-of-line barrier (deferred to Phase 3).
        // Second is also unsafe (deferred). The first's dispatch throws.
        // Pre-fix: bare `await slot.promise` in drainDeferredSlots would throw,
        // skipping the second deferred call.
        const seen = [];
        const result = await streamingTurn({
            events: streamFromCalls([
                { id: "u1", name: "unsafe1" },
                { id: "u2", name: "unsafe2" },
            ]),
            isConcurrencySafe: () => false,
            dispatch: async (call) => {
                seen.push(call.id);
                if (call.id === "u1")
                    throw new Error("deferred-1-throw");
                return okOutcome(call.id, call.name);
            },
        });
        expect(result.kind).toBe("assembled");
        if (result.kind !== "assembled")
            return;
        // Both deferred calls ran in model-call order despite the first throwing.
        expect(seen).toEqual(["u1", "u2"]);
        expect(result.resultBlocks).toHaveLength(2);
        const ids = result.resultBlocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : "?"));
        expect(ids).toEqual(["u1", "u2"]);
        const failed = result.resultBlocks[0];
        if (failed?.type === "tool_result") {
            expect(failed.is_error).toBe(true);
            expect(failed.content).toContain("deferred-1-throw");
        }
        // Second is the genuine success outcome's block — untouched by the throw.
        const ok = result.resultBlocks[1];
        if (ok?.type === "tool_result") {
            expect(ok.is_error).toBe(false);
            expect(ok.content).toBe("ok-unsafe2");
        }
    });
    test("Mixed safe + unsafe + multiple rejections — still one block per scheduled call", async () => {
        // Stress: safe1 (early) succeeds, safe2 (early) rejects, then UNSAFE
        // engages the barrier; defer3 (safe behind barrier) rejects, defer4
        // (unsafe) succeeds. Final: 5 scheduled calls → 5 blocks in order.
        const result = await streamingTurn({
            events: streamFromCalls([
                { id: "s1", name: "safe1" },
                { id: "s2", name: "safe2-boom" },
                { id: "u3", name: "unsafe3" },
                { id: "s4", name: "safe-deferred-boom" },
                { id: "u5", name: "unsafe5" },
            ]),
            isConcurrencySafe: (name) => !name.startsWith("unsafe"),
            dispatch: async (call) => {
                if (call.id === "s2")
                    throw new Error("s2-throw");
                if (call.id === "s4")
                    throw new Error("s4-throw");
                return okOutcome(call.id, call.name);
            },
        });
        expect(result.kind).toBe("assembled");
        if (result.kind !== "assembled")
            return;
        expect(result.resultBlocks).toHaveLength(5);
        const seq = result.resultBlocks.map((b) => b.type === "tool_result"
            ? { id: b.tool_use_id, err: b.is_error === true }
            : { id: "?", err: false });
        expect(seq).toEqual([
            { id: "s1", err: false },
            { id: "s2", err: true },
            { id: "u3", err: false },
            { id: "s4", err: true },
            { id: "u5", err: false },
        ]);
    });
    test("stream_reset on in-flight rejected promise — no unhandledRejection (P1-2)", async () => {
        // The tombstone path is the ONLY place where a rejected in-flight promise
        // is not later awaited (its slot is dropped). If we don't attach a noop
        // .catch, Bun/Node will warn unhandledRejection. The handler is registered
        // process-wide; for this test we just exercise the path and ensure the
        // engine still produces an assembled result.
        const rejected = [];
        const result = await streamingTurn({
            events: (async function* () {
                // Pre-reset: start two safe tools (they'll be discarded by tombstone).
                yield { type: "tool_use_start", id: "pre1", name: "discarded1" };
                yield { type: "tool_use_end", id: "pre1", input: {} };
                yield { type: "tool_use_start", id: "pre2", name: "discarded2" };
                yield { type: "tool_use_end", id: "pre2", input: {} };
                // Tombstone — pre-reset slots are abandoned (their promises orphaned).
                yield { type: "stream_reset" };
                // Post-reset: one safe tool that we DO collect.
                yield { type: "tool_use_start", id: "post1", name: "kept" };
                yield { type: "tool_use_end", id: "post1", input: {} };
                yield { type: "message_stop", stop_reason: "tool_use" };
            })(),
            isConcurrencySafe: () => true,
            dispatch: async (call) => {
                if (call.id.startsWith("pre")) {
                    // Pre-reset dispatches will be orphaned. They reject deliberately;
                    // the engine's `resetForTombstone` MUST attach .catch (P1-2) so this
                    // late rejection does not surface as unhandledRejection.
                    const p = Promise.reject(new Error(`orphaned-${call.id}`));
                    rejected.push(p);
                    return p;
                }
                return okOutcome(call.id, call.name);
            },
        });
        expect(result.kind).toBe("assembled");
        if (result.kind !== "assembled")
            return;
        // Only the post-reset slot survives.
        expect(result.resultBlocks).toHaveLength(1);
        const kept = result.resultBlocks[0];
        if (kept?.type === "tool_result") {
            expect(kept.tool_use_id).toBe("post1");
            expect(kept.is_error).toBe(false);
        }
        // Drain the orphaned rejections so the harness's own unhandledRejection
        // hook sees they're observed (defensive — the engine already .catch'd).
        await Promise.allSettled(rejected);
    });
});
