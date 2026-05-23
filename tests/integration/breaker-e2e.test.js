import { describe, expect, test } from "bun:test";
import { runAgent } from "@/agent";
import { LLMError } from "@/shared";
import { cfg, ev, RecordingStream, ScriptedLLM, text, thr, withTimeout } from "./_harness";
/**
 * GAP 1 — the session `CompactionBreaker` trips through the REAL `runAgent`.
 *
 * We script a repeating PTL ("prompt is too long"): each PTL routes to the
 * `compact` recovery action, which (a) consults `breaker.check()` BEFORE the
 * squeeze, then (b) runs `reactiveCompact` and feeds `recordReactive(before,
 * after)`. The transcript is deliberately SMALL (well under
 * REACTIVE_MIN_INPUT_TOKENS ≈ 4000 ⇒ <16000 chars) so `reactiveCompact`'s
 * fail-fast drop-ratio branch never fires — it returns ok:true every time —
 * but the squeeze frees no meaningful space (the synthetic continuation header
 * is ~as big as the tiny summarized prefix), so each reactive compaction is a
 * NO-PROGRESS strike.
 *
 * With `compactionBreaker.caps.maxConsecutiveReactive = 1`, the 1st PTL takes
 * one no-progress reactive strike and the 2nd PTL's pre-squeeze
 * `breaker.check()` returns `abort:true`, so the loop terminates with the
 * `rapid_refill_breaker` error reason — NOT an infinite loop, NOT maxTurns.
 * (Cap 1 also keeps the assertion robust: a deeper cap would require the tiny
 * transcript to survive multiple structural compactions, which is a separate
 * concern from the breaker contract under test here.)
 */
describe("GAP 1 — CompactionBreaker trips through runAgent", () => {
    test("repeated PTL with no real shrink ⇒ rapid_refill_breaker error, not a spin", async () => {
        // >2 assistant turns so findBoundary(keepTurns=2) leaves a summarizable
        // prefix (boundary > 0). Kept tiny so estimateTokens < 4000.
        const history = [
            { role: "user", content: [{ type: "text", text: "u1" }] },
            { role: "assistant", content: [{ type: "text", text: "a1" }] },
            { role: "user", content: [{ type: "text", text: "u2" }] },
            { role: "assistant", content: [{ type: "text", text: "a2" }] },
            { role: "user", content: [{ type: "text", text: "u3" }] },
            { role: "assistant", content: [{ type: "text", text: "a3" }] },
            { role: "user", content: [{ type: "text", text: "u4 current" }] },
        ];
        const ptl = () => thr(new LLMError("400 prompt is too long for this model"));
        // A short non-empty continuation summary so reactiveCompact returns ok:true
        // (a non-empty summary + boundary>0) but does NOT meaningfully shrink the
        // already-tiny transcript.
        const summary = () => ev(text("<summary>resume</summary>"));
        // PTL#1: throw → compact (check ok, strike=0) → summary call → strike=1.
        // PTL#2: throw → compact → check() aborts (strike=1>=1). NO summary call.
        const llm = new ScriptedLLM([ptl(), summary(), ptl(), ev(text("should never be reached"))]);
        const stream = new RecordingStream();
        const out = await withTimeout(runAgent(cfg({
            llm,
            stream,
            messages: history,
            maxTurns: 1,
            compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        })), 15_000, "breaker-trip");
        expect(out.reason).toBe("error");
        // Exactly: ptl, summary, ptl → 3 stream calls, then aborts pre-squeeze.
        expect(llm.calls).toBe(3);
        const errEvt = stream.events.find((e) => e.type === "error");
        expect(errEvt).toBeDefined();
        if (errEvt?.type === "error") {
            expect(errEvt.message).toContain("rapid_refill_breaker");
            expect(errEvt.message.toLowerCase()).toContain("reactive compaction");
        }
        // No-work error reports turn-1 (loop's C11 accounting), proving it did
        // NOT exhaust maxTurns and did NOT spin.
        expect(out.turns).toBe(0);
    });
});
