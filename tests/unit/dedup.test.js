import { describe, expect, test } from "bun:test";
import { DEFAULT_DUPE_THRESHOLDS, findNearDuplicates } from "@/memory/dedup";
import { EMBED_DIM } from "@/memory/types";
const NOW = 1_000_000_000_000;
/** Embedding pointing along `axis` (cosine 1 with itself, ~0 with others). */
const vec = (axis) => {
    const v = new Array(EMBED_DIM).fill(0);
    v[axis] = 1;
    return v;
};
const entry = (over) => ({
    kind: "fact",
    text: "",
    tags: [],
    createdAt: NOW,
    ...over,
});
const ids = (r) => r.map((e) => e.id);
describe("dedup — constants", () => {
    test("default thresholds", () => {
        expect(DEFAULT_DUPE_THRESHOLDS).toEqual({ cosine: 0.86, lexical: 0.6 });
    });
});
describe("dedup — cosine only", () => {
    test("matches on embedding alone (text completely different)", () => {
        const cand = entry({ id: "c", text: "alpha beta gamma", embedding: vec(5) });
        const pool = [
            entry({ id: "near", text: "nothing in common here", embedding: vec(5) }),
            entry({ id: "far", text: "alpha beta gamma", embedding: vec(9) }),
        ];
        // near: cosine 1 >= 0.86 (text jaccard 0); far: cosine 0, text identical
        // → both match (far via lexical), near has higher sim
        const out = findNearDuplicates(cand, pool);
        expect(ids(out)).toEqual(["near", "far"]);
    });
    test("below cosine threshold and no lexical → no match", () => {
        const cand = entry({ id: "c", text: "one two three", embedding: vec(1) });
        const pool = [entry({ id: "x", text: "four five six", embedding: vec(2) })];
        expect(findNearDuplicates(cand, pool)).toEqual([]);
    });
});
describe("dedup — lexical only", () => {
    test("token-Jaccard match with no embeddings", () => {
        const cand = entry({ id: "c", text: "the quick brown fox jumps" });
        const pool = [
            entry({ id: "dup", text: "the quick brown fox jumps" }),
            entry({ id: "diff", text: "completely different sentence words" }),
        ];
        expect(ids(findNearDuplicates(cand, pool))).toEqual(["dup"]);
    });
    test("tokenization is lowercased \\w+ set (punctuation/case ignored)", () => {
        const cand = entry({ id: "c", text: "Hello, WORLD!" });
        const pool = [entry({ id: "d", text: "hello world" })];
        expect(ids(findNearDuplicates(cand, pool))).toEqual(["d"]);
    });
});
describe("dedup — neither matches", () => {
    test("no embedding overlap and low jaccard → empty", () => {
        const cand = entry({ id: "c", text: "apples" });
        const pool = [entry({ id: "x", text: "oranges bananas grapes" })];
        expect(findNearDuplicates(cand, pool)).toEqual([]);
    });
});
describe("dedup — exclusions", () => {
    test("candidate self-excluded by id", () => {
        const cand = entry({ id: "self", text: "identical text here" });
        const pool = [entry({ id: "self", text: "identical text here" })];
        expect(findNearDuplicates(cand, pool)).toEqual([]);
    });
    test("superseded entries excluded even if identical", () => {
        const cand = entry({ id: "c", text: "same words same words" });
        const pool = [entry({ id: "sup", text: "same words same words", supersededBy: "z" })];
        expect(findNearDuplicates(cand, pool)).toEqual([]);
    });
});
describe("dedup — ordering & purity", () => {
    test("sorted by best similarity desc, then createdAt desc, then id desc", () => {
        const cand = entry({ id: "c", text: "alpha beta", embedding: vec(3) });
        const pool = [
            entry({ id: "low", text: "alpha beta", embedding: vec(8), createdAt: NOW }),
            entry({ id: "hi", text: "x y z", embedding: vec(3), createdAt: NOW }),
            entry({ id: "low2", text: "alpha beta", embedding: vec(7), createdAt: NOW }),
        ];
        // hi: cosine 1 → sim 1. low/low2: lexical jaccard 1 → sim 1 too.
        // tie on sim=1, equal createdAt → id desc: low2, low, hi? No: all sim 1,
        // createdAt equal → id desc → "low2","low","hi"
        expect(ids(findNearDuplicates(cand, pool))).toEqual(["low2", "low", "hi"]);
    });
    test("custom thresholds override", () => {
        const cand = entry({ id: "c", text: "a b c d e" });
        const pool = [entry({ id: "p", text: "a b c x y" })]; // jaccard = 3/7 ≈ 0.43
        expect(findNearDuplicates(cand, pool)).toEqual([]);
        expect(ids(findNearDuplicates(cand, pool, { lexical: 0.4 }))).toEqual(["p"]);
    });
    test("pure: repeated calls equal", () => {
        const cand = entry({ id: "c", text: "stable input text" });
        const pool = [entry({ id: "p", text: "stable input text" })];
        expect(findNearDuplicates(cand, pool)).toEqual(findNearDuplicates(cand, pool));
    });
});
