import { describe, expect, test } from "bun:test";
import { arbitrateConsolidation } from "@/agent/memory-consolidate";
const entry = (id, text, importance = 0.5) => ({
    id,
    kind: "fact",
    text,
    tags: [],
    createdAt: 0,
    importance,
});
/** Build an async-iterable stream from a precomputed event list (or throw). */
const stream = (out) => {
    const events = typeof out === "string"
        ? [
            { type: "text_delta", delta: out },
            { type: "message_stop", stop_reason: "end_turn" },
        ]
        : [];
    return {
        async *[Symbol.asyncIterator]() {
            if (typeof out !== "string")
                throw new Error("llm down");
            yield* events;
        },
    };
};
const fakeLLM = (out) => ({
    stream: () => stream(out),
});
const neverLLM = {
    stream() {
        throw new Error("should not be called");
    },
};
describe("arbitrateConsolidation short-circuits (no LLM)", () => {
    test("no dupes → insert", async () => {
        expect(await arbitrateConsolidation(neverLLM, entry("c", "hi"), [])).toEqual({
            action: "insert",
        });
    });
    test("exact case-insensitive text match → skip", async () => {
        const op = await arbitrateConsolidation(neverLLM, entry("c", " Hello World "), [
            entry("d", "hello world"),
        ]);
        expect(op).toEqual({ action: "skip" });
    });
});
describe("arbitrateConsolidation LLM ops", () => {
    const cand = entry("c", "the cat sat on a warm mat");
    const dupes = [entry("d1", "totally unrelated text about ships"), entry("d2", "a dog ran")];
    test("insert", async () => {
        expect(await arbitrateConsolidation(fakeLLM('{"action":"insert"}'), cand, dupes)).toEqual({
            action: "insert",
        });
    });
    test("skip (from LLM, not exact match)", async () => {
        expect(await arbitrateConsolidation(fakeLLM('{"action":"skip"}'), cand, dupes)).toEqual({
            action: "skip",
        });
    });
    test("merge with valid id, importance clamped, fenced+prose tolerated", async () => {
        const out = 'Reasoning...\n```json\n{"action":"merge","intoId":"d1","text":"merged","tags":["a"],"importance":5}\n```';
        expect(await arbitrateConsolidation(fakeLLM(out), cand, dupes)).toEqual({
            action: "merge",
            intoId: "d1",
            text: "merged",
            tags: ["a"],
            importance: 1,
        });
    });
    test("supersede with valid id", async () => {
        expect(await arbitrateConsolidation(fakeLLM('{"action":"supersede","oldId":"d2"}'), cand, dupes)).toEqual({ action: "supersede", oldId: "d2" });
    });
    test("merge with out-of-set intoId → heuristic", async () => {
        // cand vs dupes are all low Jaccard → heuristic returns insert
        expect(await arbitrateConsolidation(fakeLLM('{"action":"merge","intoId":"ghost","text":"x","tags":[],"importance":0.5}'), cand, dupes)).toEqual({ action: "insert" });
    });
    test("supersede with out-of-set oldId → heuristic", async () => {
        expect(await arbitrateConsolidation(fakeLLM('{"action":"supersede","oldId":"ghost"}'), cand, dupes)).toEqual({ action: "insert" });
    });
});
describe("arbitrateConsolidation heuristic fallback", () => {
    test("llm throws + high Jaccard → supersede best dupe", async () => {
        const cand = entry("c", "the quick brown fox jumps over the lazy dog");
        const dupes = [
            entry("d1", "completely different sentence"),
            entry("d2", "the quick brown fox jumps over the lazy dog now"),
        ];
        expect(await arbitrateConsolidation(fakeLLM({ throw: true }), cand, dupes)).toEqual({
            action: "supersede",
            oldId: "d2",
        });
    });
    test("llm throws + low Jaccard → insert", async () => {
        const cand = entry("c", "alpha beta gamma");
        const dupes = [entry("d1", "delta epsilon zeta")];
        expect(await arbitrateConsolidation(fakeLLM({ throw: true }), cand, dupes)).toEqual({
            action: "insert",
        });
    });
    test("unparseable JSON → heuristic", async () => {
        const cand = entry("c", "shared words here repeated shared words here");
        const dupes = [entry("d1", "shared words here repeated shared words here extra")];
        expect(await arbitrateConsolidation(fakeLLM("{ not json"), cand, dupes)).toEqual({
            action: "supersede",
            oldId: "d1",
        });
    });
    test("pre-aborted signal → heuristic, no llm call", async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const cand = entry("c", "alpha beta gamma");
        const dupes = [entry("d1", "delta epsilon zeta")];
        expect(await arbitrateConsolidation(neverLLM, cand, dupes, { signal: ctrl.signal })).toEqual({
            action: "insert",
        });
    });
});
