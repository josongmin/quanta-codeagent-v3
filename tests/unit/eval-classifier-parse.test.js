/**
 * Classifier parser — pins tolerant JSON extraction and id validation.
 *
 * The parser is the entire surface that decides whether a real-session label
 * is trustworthy; a regression here silently degrades Tier 3 coverage.
 *
 * Uses a ScriptedLLM that yields a single message_stop event so we can drive
 * the classifier without an API key. We exercise four cases:
 *   1. Clean valid JSON       → id round-trips, confidence preserved.
 *   2. JSON inside prose      → still extracted.
 *   3. Unknown id             → coerced to null.
 *   4. Non-JSON garbage       → id=null, confidence=0.
 */
import { describe, expect, test } from "bun:test";
import { allLeaves } from "@/../src/apps/eval/taxonomy";
import { classifyQuery } from "@/../src/apps/eval/taxonomy/classifier";
const knownLeafId = allLeaves()[0]?.id ?? "software-quality.debugging.error-message-paste";
const makeLLM = (assistantText) => ({
    model: "test",
    // biome-ignore lint/correctness/useYield: scripted; iterates a fixed sequence
    async *stream(_input) {
        yield { type: "text_delta", delta: assistantText };
        yield { type: "message_stop", stop_reason: "end_turn" };
    },
});
describe("classifier parser", () => {
    test("clean JSON → id, confidence preserved", async () => {
        const llm = makeLLM(`{"id":"${knownLeafId}","confidence":0.91,"alt":[]}`);
        const r = await classifyQuery("any query", { llm });
        expect(r.id).toBe(knownLeafId);
        expect(r.confidence).toBeCloseTo(0.91, 2);
    });
    test("JSON inside prose → extracted", async () => {
        const llm = makeLLM(`Sure, my pick: {"id": "${knownLeafId}", "confidence": 0.7, "alt": []} — done.`);
        const r = await classifyQuery("any query", { llm });
        expect(r.id).toBe(knownLeafId);
    });
    test("unknown id → null", async () => {
        const llm = makeLLM(`{"id":"no.such.leaf","confidence":0.5,"alt":[]}`);
        const r = await classifyQuery("any query", { llm });
        expect(r.id).toBeNull();
    });
    test("non-JSON garbage → id=null, confidence=0", async () => {
        const llm = makeLLM("I cannot answer this question with structure.");
        const r = await classifyQuery("any query", { llm });
        expect(r.id).toBeNull();
        expect(r.confidence).toBe(0);
    });
});
