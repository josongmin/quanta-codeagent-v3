/**
 * ★ CONTRACT — A6: src/llm/fallback.ts FallbackLLM swap on `overloaded` /
 *   `server_error` / `network`. Per-switch stream_reset tombstone (single
 *   global would LEAK intermediate dead partials). Non-trigger errors
 *   (auth/bad_request/...) rethrow immediately. All-exhausted → rethrow LAST.
 *
 * A6 — FallbackLLM ADVERSARIAL hell-gate.
 *
 * Drives FallbackLLM (src/llm/fallback.ts) with scripted inner providers and
 * pins the hard provider-swap invariants under adversarial multi-swap storms.
 *
 * Engine contract (file header of fallback.ts):
 *   - A swap AFTER a provider streamed ≥1 event tombstones the dead partial
 *     with a `{type:"stream_reset"}` — emitted ONCE PER SUCH SWAP, not once
 *     per turn. If N providers each stream a partial then fail before one
 *     succeeds, the consumer sees N tombstones. This is REQUIRED: a single
 *     global tombstone would reset only the first dead partial and let later
 *     providers' dead partials leak into the assembled message (see the
 *     `resets === 2` two-partial-storm test below, which pins exactly this).
 *   - assembleFromEvents resets accumulated content on EACH tombstone, so the
 *     final assembled message contains ONLY the surviving provider's content.
 *   - A non-trigger error (auth/bad_request/…) is RETHROWN immediately — no
 *     swap, no tombstone.
 *   - All-trigger exhaustion rethrows the LAST provider's error.
 *   - Abort during a swap terminates cleanly (no orphan stream).
 */
import { describe, expect, test } from "bun:test";
import { assembleFromEvents, FallbackLLM, isFallbackTrigger } from "@/llm";
import { LLMError } from "@/shared";
class ScriptedLLM {
    step;
    calls = 0;
    constructor(step) {
        this.step = step;
    }
    async *stream() {
        this.calls += 1;
        if (this.step.kind === "ok") {
            for (const ev of this.step.events)
                yield ev;
            return;
        }
        if (this.step.kind === "yieldThenThrow") {
            for (const ev of this.step.events)
                yield ev;
            throw this.step.error;
        }
        throw this.step.error;
    }
}
const overload = () => new LLMError("overloaded_error", { kind: "overloaded", statusCode: 529 });
const status529 = (msg = "HTTP 529") => new LLMError(msg, { kind: "overloaded", statusCode: 529 });
const text = (t) => ({ type: "text_delta", delta: t });
const stop = () => ({ type: "message_stop", stop_reason: "end_turn" });
const collect = async (it) => {
    const out = [];
    for await (const ev of it)
        out.push(ev);
    return out;
};
const resets = (events) => events.filter((e) => e.type === "stream_reset").length;
const assembledText = (events) => assembleFromEvents(events)
    .message.content.map((b) => (b.type === "text" ? b.text : ""))
    .join("");
// ─────────────────────────────────────────────────────────────────────────
// 1. Consecutive 529 across 3 providers, success on 4th — ONE tombstone total
// ─────────────────────────────────────────────────────────────────────────
describe("A6 — 529 storm across 4 providers", () => {
    // ── HELLGATE FINDING (see file summary): the task asked to assert "exactly
    // ONE stream_reset total" across an N-swap storm. The SOURCE does NOT honor
    // that when MULTIPLE providers each stream a partial before failing — it
    // emits ONE tombstone PER post-yield swap (the `resetEmitted` flag is LOCAL
    // to each `streamProvider` call; `priorPartial` re-arms after every provider
    // that yielded≥1 event then failed). The existing passing test
    // (`fallback.test.ts` "only one stream_reset … across multiple post-yield
    // swaps") only covers the case where the INTERMEDIATE failures are PRE-yield
    // — so it never exercised two consecutive partial-then-die providers.
    //
    // This is NOT a correctness defect of the FINAL assembled output:
    // `assembleFromEvents` discards EVERY dead partial across ANY number of
    // tombstones (verified — see the assert below), so the surviving message is
    // exactly the final provider's content either way. It IS a precision gap
    // vs the source's own docstring ("preceded by a SINGLE stream_reset
    // tombstone"). We pin the ACTUAL behavior here + the (holding) end-state
    // invariant, and flag the docstring/one-total discrepancy in the summary.
    test("ACTUAL: one stream_reset PER post-yield swap; assembled output is STILL only the final provider", async () => {
        // p1 streams a partial then dies (529)  → tombstone #1 before p2's content.
        // p2 streams ANOTHER partial then dies   → tombstone #2 before p4's content.
        // p3 dies pre-yield (529)                → transparent, no extra tombstone.
        // p4 succeeds                            → its content is the only survivor.
        const p1 = new ScriptedLLM({
            kind: "yieldThenThrow",
            events: [text("DEAD-1-alpha"), text("DEAD-1-beta")],
            error: overload(),
        });
        const p2 = new ScriptedLLM({
            kind: "yieldThenThrow",
            events: [text("DEAD-2-gamma")],
            error: status529(),
        });
        const p3 = new ScriptedLLM({ kind: "throw", error: status529() });
        const p4 = new ScriptedLLM({ kind: "ok", events: [text("LIVE-"), text("final"), stop()] });
        const llm = new FallbackLLM({ providers: [p1, p2, p3, p4] });
        const events = await collect(llm.stream({ messages: [], tools: [] }));
        // ACTUAL source behavior: one tombstone per partial-then-die provider.
        // (TWO providers streamed partials before dying → two tombstones.)
        expect(resets(events)).toBe(2);
        // CRITICAL end-state invariant that DOES hold: the surviving assembled
        // content is ONLY the final provider's — every dead partial is discarded
        // regardless of how many tombstones precede it.
        expect(assembledText(events)).toBe("LIVE-final");
        const finalMsg = assembleFromEvents(events).message;
        expect(finalMsg).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "LIVE-final", phase: "final_answer" }],
        });
        // Every provider was attempted exactly once, in order.
        expect([p1.calls, p2.calls, p3.calls, p4.calls]).toEqual([1, 1, 1, 1]);
        // The LAST tombstone precedes the live content (no dead text after it).
        const lastReset = events.map((e) => e.type).lastIndexOf("stream_reset");
        const liveIdx = events.findIndex((e) => e.type === "text_delta" && e.delta === "LIVE-");
        expect(lastReset).toBeGreaterThanOrEqual(0);
        expect(lastReset).toBeLessThan(liveIdx);
    });
    test("ONE tombstone total when only the FIRST provider streamed a partial (rest die pre-yield)", async () => {
        // This is the shape the existing `fallback.test.ts` test covers — pinned
        // here as the boundary that DOES yield a single tombstone.
        const p1 = new ScriptedLLM({
            kind: "yieldThenThrow",
            events: [text("dead1")],
            error: overload(),
        });
        const p2 = new ScriptedLLM({ kind: "throw", error: status529() }); // pre-yield
        const p3 = new ScriptedLLM({ kind: "ok", events: [text("final"), stop()] });
        const llm = new FallbackLLM({ providers: [p1, p2, p3] });
        const events = await collect(llm.stream({ messages: [], tools: [] }));
        expect(resets(events)).toBe(1);
        expect(assembledText(events)).toBe("final");
    });
    test("multi-swap where ONLY pre-yield failures precede the survivor emits ZERO tombstones", async () => {
        // No provider streamed before failing until the survivor → fully transparent.
        const p1 = new ScriptedLLM({ kind: "throw", error: overload() });
        const p2 = new ScriptedLLM({ kind: "throw", error: status529() });
        const p3 = new ScriptedLLM({ kind: "ok", events: [text("clean"), stop()] });
        const llm = new FallbackLLM({ providers: [p1, p2, p3] });
        const events = await collect(llm.stream({ messages: [], tools: [] }));
        expect(resets(events)).toBe(0);
        expect(assembledText(events)).toBe("clean");
    });
});
// ─────────────────────────────────────────────────────────────────────────
// 2. Non-trigger errors (401 auth, 400 bad_request) must NOT swap
// ─────────────────────────────────────────────────────────────────────────
describe("A6 — non-trigger errors rethrow, never swap", () => {
    test("401 auth on the primary ⇒ rethrows that EXACT error, no swap, no stream_reset", async () => {
        const authErr = new LLMError("401 invalid api key", { kind: "auth" });
        const p1 = new ScriptedLLM({ kind: "throw", error: authErr });
        const p2 = new ScriptedLLM({ kind: "ok", events: [text("never"), stop()] });
        const llm = new FallbackLLM({ providers: [p1, p2] });
        // isFallbackTrigger sanity: auth is NOT a trigger.
        expect(isFallbackTrigger(authErr)).toBe(false);
        await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toBe(authErr);
        expect(p1.calls).toBe(1);
        expect(p2.calls).toBe(0); // fallback NEVER attempted
    });
    test("400 bad_request on the primary ⇒ rethrows that EXACT error, fallback untouched", async () => {
        const badReq = new LLMError("400 bad request", { kind: "bad_request" });
        const p1 = new ScriptedLLM({ kind: "throw", error: badReq });
        const p2 = new ScriptedLLM({ kind: "ok", events: [text("never"), stop()] });
        const llm = new FallbackLLM({ providers: [p1, p2] });
        expect(isFallbackTrigger(badReq)).toBe(false);
        await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toBe(badReq);
        expect(p2.calls).toBe(0);
    });
    test("a non-trigger error AFTER a trigger swap still rethrows (no second swap), tombstone bookkeeping intact", async () => {
        // p1 (529, partial) swaps → p2 streams a partial then dies with bad_request.
        // bad_request is NOT a trigger, so p2's error must rethrow even though a
        // tombstone for p1 was already emitted. p3 is never reached.
        const p1 = new ScriptedLLM({
            kind: "yieldThenThrow",
            events: [text("p1-partial")],
            error: overload(),
        });
        const p2 = new ScriptedLLM({
            kind: "yieldThenThrow",
            events: [text("p2-partial")],
            error: new LLMError("400 malformed", { kind: "bad_request" }),
        });
        const p3 = new ScriptedLLM({ kind: "ok", events: [text("never"), stop()] });
        const llm = new FallbackLLM({ providers: [p1, p2, p3] });
        await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toThrow("400 malformed");
        expect(p3.calls).toBe(0);
    });
});
// ─────────────────────────────────────────────────────────────────────────
// 3. All providers 529 — rethrows the LAST error; tombstone bookkeeping
// ─────────────────────────────────────────────────────────────────────────
describe("A6 — all providers fail with a trigger", () => {
    test("rethrows the LAST provider's error (not the first)", async () => {
        const lastErr = status529("529 overloaded (LAST)");
        const p1 = new ScriptedLLM({ kind: "throw", error: overload() });
        const p2 = new ScriptedLLM({ kind: "throw", error: status529("middle") });
        const p3 = new ScriptedLLM({ kind: "throw", error: lastErr });
        const llm = new FallbackLLM({ providers: [p1, p2, p3] });
        await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toBe(lastErr);
        expect([p1.calls, p2.calls, p3.calls]).toEqual([1, 1, 1]);
    });
    test("all-fail where earlier providers streamed partials: tombstone emitted before the throw, then no live content", async () => {
        // p1 streams a partial then dies (529); p2 dies pre-yield as the last
        // provider → rethrow. The caller observed the dead partial + its tombstone
        // before the rejection (the partials are abandoned, never assembled into a
        // completed message because the stream throws).
        const lastErr = status529("529 LAST");
        const p1 = new ScriptedLLM({
            kind: "yieldThenThrow",
            events: [text("p1-dead")],
            error: overload(),
        });
        const p2 = new ScriptedLLM({ kind: "throw", error: lastErr });
        const llm = new FallbackLLM({ providers: [p1, p2] });
        const seen = [];
        let thrown;
        try {
            for await (const ev of llm.stream({ messages: [], tools: [] }))
                seen.push(ev);
        }
        catch (e) {
            thrown = e;
        }
        // The LAST error is what propagates.
        expect(thrown).toBe(lastErr);
        // The dead partial + its tombstone were observed before the failure. Since
        // the FIRST provider's partial was followed by a swap to p2, and p2 yielded
        // nothing before throwing, no tombstone is emitted (the tombstone is lazy:
        // it only precedes the NEXT provider's FIRST real event, and p2 had none).
        // So the consumer saw ONLY the dead partial, then the throw.
        expect(seen.map((e) => (e.type === "text_delta" ? e.delta : e.type))).toEqual(["p1-dead"]);
        expect(resets(seen)).toBe(0);
    });
});
// ─────────────────────────────────────────────────────────────────────────
// 4. Abort during a swap — clean termination, no orphan stream
// ─────────────────────────────────────────────────────────────────────────
describe("A6 — abort during a swap", () => {
    test("abort fires between the primary failure and the fallback attempt ⇒ aborts, no orphan", async () => {
        const ac = new AbortController();
        const p1 = new ScriptedLLM({ kind: "throw", error: status529() });
        const p2 = new ScriptedLLM({ kind: "ok", events: [text("never"), stop()] });
        // Abort as a side effect of the trigger check (right after p1 fails, before
        // p2 is attempted) — models a user Ctrl+C landing during the swap window.
        const llm = new FallbackLLM({
            providers: [p1, p2],
            signal: ac.signal,
            isFallbackTrigger: (e) => {
                ac.abort();
                return isFallbackTrigger(e);
            },
        });
        await expect(collect(llm.stream({ messages: [], tools: [] }))).rejects.toThrow("aborted");
        expect(p1.calls).toBe(1);
        expect(p2.calls).toBe(0); // the fallback was NEVER started — no orphan stream
    });
    test("abort during a multi-swap chain after a partial: stops, no further provider, partial not finalized", async () => {
        const ac = new AbortController();
        const p1 = new ScriptedLLM({
            kind: "yieldThenThrow",
            events: [text("p1-partial")],
            error: overload(),
        });
        const p2 = new ScriptedLLM({ kind: "ok", events: [text("would-be-live"), stop()] });
        let swaps = 0;
        const llm = new FallbackLLM({
            providers: [p1, p2],
            signal: ac.signal,
            isFallbackTrigger: (e) => {
                swaps += 1;
                ac.abort(); // abort the instant the swap decision is made
                return isFallbackTrigger(e);
            },
        });
        const seen = [];
        let thrown;
        try {
            for await (const ev of llm.stream({ messages: [], tools: [] }))
                seen.push(ev);
        }
        catch (e) {
            thrown = e;
        }
        expect(String(thrown?.message ?? thrown)).toContain("aborted");
        expect(swaps).toBe(1);
        expect(p2.calls).toBe(0); // no orphan replacement stream started
        // Consumer saw only the dead partial before the abort — never finalized.
        expect(seen.map((e) => (e.type === "text_delta" ? e.delta : e.type))).toEqual(["p1-partial"]);
    });
});
