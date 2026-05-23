import { describe, expect, test } from "bun:test";
import { rankEntries } from "@/memory/ranking";
import { DEFAULT_RECALL_LIMIT, EMBED_DIM } from "@/memory/types";
const NOW = 1_000_000_000_000;
/** A unit-ish embedding of the requested dim, dominated by `axis`. */
const vec = (axis, len = EMBED_DIM) => {
    const v = new Array(len).fill(0);
    v[axis % len] = 1;
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
describe("rankEntries — vector dominance", () => {
    test("a strong vector hit outranks a pure lexical hit", () => {
        const cand = [
            entry({ id: "lex", text: "exact query string", createdAt: NOW }),
            entry({
                id: "vecmatch",
                text: "totally unrelated wording",
                embedding: vec(3),
                createdAt: NOW,
            }),
        ];
        const q = { text: "exact query string", embedding: vec(3) };
        expect(ids(rankEntries(cand, q, NOW))).toEqual(["vecmatch", "lex"]);
    });
    test("wrong-length query embedding contributes no vector score", () => {
        const cand = [entry({ id: "a", embedding: vec(1) })];
        const q = { embedding: vec(1, 8) };
        // still recalled (no hard filter), just no vector points
        expect(ids(rankEntries(cand, q, NOW))).toEqual(["a"]);
    });
});
describe("rankEntries — paraphrase robustness", () => {
    test("text miss but vector hit is still recalled (no hard text filter)", () => {
        const cand = [entry({ id: "p", text: "the cat sat on the mat", embedding: vec(7) })];
        const q = { text: "feline rested on a rug", embedding: vec(7) };
        expect(ids(rankEntries(cand, q, NOW))).toEqual(["p"]);
    });
    test("text miss and no embedding still recalled (text never excludes)", () => {
        const cand = [entry({ id: "p", text: "alpha" }), entry({ id: "q", text: "beta" })];
        const out = rankEntries(cand, { text: "zzz" }, NOW);
        expect(ids(out).sort()).toEqual(["p", "q"]);
    });
});
describe("rankEntries — hard filters", () => {
    test("tags is a hard filter (requires >=1 overlap, case-insensitive)", () => {
        const cand = [entry({ id: "hit", tags: ["WORK"] }), entry({ id: "miss", tags: ["home"] })];
        expect(ids(rankEntries(cand, { tags: ["work"] }, NOW))).toEqual(["hit"]);
    });
    test("kinds / tiers filter", () => {
        const cand = [
            entry({ id: "f", kind: "fact" }),
            entry({ id: "d", kind: "decision" }),
            entry({ id: "ep", kind: "fact", tier: "episodic" }),
        ];
        expect(ids(rankEntries(cand, { kinds: ["decision"] }, NOW))).toEqual(["d"]);
        expect(ids(rankEntries(cand, { tiers: ["episodic"] }, NOW))).toEqual(["ep"]);
    });
    test("query.tiers still hard-filters (tier weight does not leak past it)", () => {
        const cand = [entry({ id: "sem", tier: "semantic" }), entry({ id: "epi", tier: "episodic" })];
        expect(ids(rankEntries(cand, { tiers: ["episodic"] }, NOW))).toEqual(["epi"]);
        expect(ids(rankEntries(cand, { tiers: ["semantic"] }, NOW))).toEqual(["sem"]);
    });
    test("freshness filter via bucketOf(now-createdAt)", () => {
        const cand = [
            entry({ id: "fresh", createdAt: NOW }),
            entry({ id: "archived", createdAt: NOW - 40 * 24 * 60 * 60 * 1000 }),
        ];
        expect(ids(rankEntries(cand, { freshness: ["archived"] }, NOW))).toEqual(["archived"]);
    });
    test("minImportance drops below-threshold (default importance 0.5)", () => {
        const cand = [
            entry({ id: "lo", importance: 0.2 }),
            entry({ id: "hi", importance: 0.9 }),
            entry({ id: "def" }),
        ];
        expect(ids(rankEntries(cand, { minImportance: 0.5 }, NOW)).sort()).toEqual(["def", "hi"]);
    });
    test("superseded excluded by default, included with flag", () => {
        const cand = [entry({ id: "live" }), entry({ id: "old", supersededBy: "live" })];
        expect(ids(rankEntries(cand, {}, NOW))).toEqual(["live"]);
        expect(ids(rankEntries(cand, { includeSuperseded: true }, NOW)).sort()).toEqual(["live", "old"]);
    });
});
describe("rankEntries — scoring components", () => {
    test("tag overlap count scales score", () => {
        const cand = [entry({ id: "one", tags: ["a"] }), entry({ id: "two", tags: ["a", "b"] })];
        expect(ids(rankEntries(cand, { tags: ["a", "b"] }, NOW))).toEqual(["two", "one"]);
    });
    test("exact whole-string text match beats substring match", () => {
        const cand = [
            entry({ id: "sub", text: "hello world foo", createdAt: NOW }),
            entry({ id: "exact", text: "hello world", createdAt: NOW }),
        ];
        expect(ids(rankEntries(cand, { text: "hello world" }, NOW))).toEqual(["exact", "sub"]);
    });
    test("access reinforcement is capped (huge accessCount bounded)", () => {
        const cand = [
            entry({ id: "hot", accessCount: 1_000_000, createdAt: NOW }),
            entry({ id: "cold", accessCount: 0, importance: 1, createdAt: NOW }),
        ];
        // cap = 3; importance contributes 0.5*4=2 vs 1*4=4 plus log cap 3 → hot wins
        expect(ids(rankEntries(cand, {}, NOW))[0]).toBe("hot");
    });
    test("semantic outranks episodic when all other signals tie", () => {
        const cand = [
            entry({ id: "epi", tier: "episodic", createdAt: NOW }),
            entry({ id: "sem", tier: "semantic", createdAt: NOW }),
        ];
        // identical text/tags/vec/freshness/importance/access → tier term decides
        expect(ids(rankEntries(cand, {}, NOW))).toEqual(["sem", "epi"]);
    });
    test("freshness contributes (fresher ranks higher, all else equal)", () => {
        const cand = [
            entry({ id: "old", createdAt: NOW - 2 * 60 * 60 * 1000 }),
            entry({ id: "new", createdAt: NOW }),
        ];
        expect(ids(rankEntries(cand, {}, NOW))).toEqual(["new", "old"]);
    });
});
describe("rankEntries — determinism & limit", () => {
    test("full tie-break chain: importance, updatedAt, createdAt, id desc", () => {
        const base = { tags: [], kind: "fact" };
        const cand = [
            { ...base, id: "a", text: "", importance: 0.5, createdAt: NOW, updatedAt: NOW },
            { ...base, id: "b", text: "", importance: 0.5, createdAt: NOW, updatedAt: NOW },
            { ...base, id: "c", text: "", importance: 0.9, createdAt: NOW, updatedAt: NOW },
        ];
        // c first (importance), then b before a (id desc on full tie)
        expect(ids(rankEntries(cand, {}, NOW))).toEqual(["c", "b", "a"]);
    });
    test("updatedAt tie-break before createdAt", () => {
        const cand = [
            entry({ id: "x", createdAt: NOW, updatedAt: NOW }),
            entry({ id: "y", createdAt: NOW, updatedAt: NOW + 1000 }),
        ];
        expect(ids(rankEntries(cand, {}, NOW))).toEqual(["y", "x"]);
    });
    test("limit slices; <=0 returns []; default applies", () => {
        const cand = Array.from({ length: 30 }, (_, i) => entry({ id: `e${String(i).padStart(2, "0")}` }));
        expect(rankEntries(cand, { limit: 0 }, NOW)).toEqual([]);
        expect(rankEntries(cand, { limit: -5 }, NOW)).toEqual([]);
        expect(rankEntries(cand, { limit: 3 }, NOW).length).toBe(3);
        expect(rankEntries(cand, {}, NOW).length).toBe(DEFAULT_RECALL_LIMIT);
    });
    test("output entries are normalized (defaults present)", () => {
        const [n] = rankEntries([entry({ id: "n" })], {}, NOW);
        expect(n?.tier).toBe("semantic");
        expect(n?.importance).toBe(0.5);
        expect(n?.accessCount).toBe(0);
        expect(n?.updatedAt).toBe(NOW);
    });
});
