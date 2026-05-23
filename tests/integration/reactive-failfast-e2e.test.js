import { describe, expect, test } from "bun:test";
import { estimateTokens, runAgent } from "@/agent";
import { LLMError } from "@/shared";
import { cfg, ev, RecordingStream, ScriptedLLM, text, thr, withTimeout } from "./_harness";
/**
 * GAP 2 — `reactiveCompact`'s fail-fast drop-ratio branch, driven through the
 * REAL `runAgent` loop.
 *
 * compaction.ts (read for the exact constants):
 *   REACTIVE_MIN_INPUT_TOKENS = 4_000
 *   REACTIVE_MIN_DROP_RATIO   = 0.15
 * The NEW branch only fires when `estimateTokens(input) >= 4000` AND the built
 * `[synthetic, ...suffix]` is < 15% smaller than the input — i.e. the limiting
 * payload lives in the orphan-safe RETAINED suffix, not the summarized prefix.
 *
 * We build a transcript whose last two assistant turns (which findBoundary
 * keeps verbatim, REACTIVE_KEEP_TURNS = 2) carry two ~60k-char payloads, while
 * the summarizable prefix is trivially small. Estimated input ≈ 30k tokens
 * (well over 4000); compacting can only summarize the tiny prefix, so the
 * squeeze frees ≪ 15%. One PTL routes to `compact`; `reactiveCompact` returns
 * `{ ok:false, reason }` and the loop ends in `error` with that exact reason.
 *
 * The CompactionBreaker is disabled here so this test isolates the
 * `reactiveCompact` fail-fast branch specifically (GAP 1 covers the breaker).
 */
describe("GAP 2 — reactive fail-fast drop-ratio branch through runAgent", () => {
    test("oversized retained suffix ⇒ ok:false fail-fast error, loop ends error", async () => {
        const big = "X".repeat(60_000);
        const history = [
            { role: "user", content: [{ type: "text", text: "small task prefix" }] },
            { role: "assistant", content: [{ type: "text", text: "tiny prefix turn" }] },
            { role: "user", content: [{ type: "text", text: "u2 small" }] },
            { role: "assistant", content: [{ type: "text", text: `bigA ${big}` }] },
            { role: "user", content: [{ type: "text", text: "u3 small" }] },
            { role: "assistant", content: [{ type: "text", text: `bigB ${big}` }] },
            { role: "user", content: [{ type: "text", text: "current request small" }] },
        ];
        // Precondition for the NEW branch: estimate must clear the 4000 floor.
        expect(estimateTokens(history)).toBeGreaterThanOrEqual(4_000);
        const llm = new ScriptedLLM([
            thr(new LLMError("400 prompt is too long for this model")),
            // The continuation-summary call: non-empty so reactiveCompact does NOT
            // bail on the empty-summary guard — it must reach the drop-ratio guard.
            ev(text("<summary>tiny summary of the small prefix</summary>")),
            ev(text("unreachable")),
        ]);
        const stream = new RecordingStream();
        const out = await withTimeout(runAgent(cfg({
            llm,
            stream,
            messages: history,
            maxTurns: 2,
            compactionBreaker: { disabled: true },
        })), 15_000, "reactive-failfast");
        expect(out.reason).toBe("error");
        // PTL throw (1) + the continuation-summary stream (2). The summary IS
        // produced, then the drop-ratio guard rejects the result → no 3rd call.
        expect(llm.calls).toBe(2);
        expect(out.turns).toBe(0);
        const errEvt = stream.events.find((e) => e.type === "error");
        expect(errEvt).toBeDefined();
        if (errEvt?.type === "error") {
            // The exact NEW-branch wording from compaction.ts (proves the
            // drop-ratio guard fired, not the boundary<=0 / empty-summary guards).
            expect(errEvt.message).toContain("reactive compaction freed no meaningful context");
            expect(errEvt.message).toContain("< 15% drop");
            expect(errEvt.message).toContain("retained suffix");
        }
    });
});
