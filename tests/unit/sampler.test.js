import { describe, expect, test } from "bun:test";
import { patchVote, sampleBestOfN } from "../../src/apps/bench/sampler";
describe("sampleBestOfN", () => {
    test("picks the highest score", async () => {
        const out = await sampleBestOfN({
            n: 5,
            makeAttempt: async (i) => i,
            score: (v) => v,
        });
        expect(out.best.value).toBe(4);
        expect(out.best.score).toBe(4);
        expect(out.attempts).toHaveLength(5);
        expect(out.attempts.map((a) => a.index)).toEqual([0, 1, 2, 3, 4]);
    });
    test("stable tie-break by ascending index", async () => {
        const out = await sampleBestOfN({
            n: 4,
            makeAttempt: async (i) => i,
            score: () => 7, // all equal
        });
        expect(out.best.index).toBe(0);
    });
    test("a thrown attempt becomes a failed attempt, never aborts the batch", async () => {
        const out = await sampleBestOfN({
            n: 4,
            makeAttempt: async (i) => {
                if (i === 2)
                    throw new Error("boom");
                return i;
            },
            score: (v) => v,
        });
        expect(out.attempts).toHaveLength(4);
        const failed = out.attempts[2];
        expect(failed?.value).toBeUndefined();
        expect(failed?.error).toBe("boom");
        expect(failed?.score).toBe(Number.NEGATIVE_INFINITY);
        // highest non-failed still wins
        expect(out.best.value).toBe(3);
    });
    test("respects the concurrency cap", async () => {
        let inFlight = 0;
        let peak = 0;
        const out = await sampleBestOfN({
            n: 8,
            concurrency: 3,
            makeAttempt: async (i) => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight -= 1;
                return i;
            },
            score: (v) => v,
        });
        expect(peak).toBeLessThanOrEqual(3);
        expect(out.attempts).toHaveLength(8);
    });
    test("default concurrency is min(n, 4)", async () => {
        let inFlight = 0;
        let peak = 0;
        await sampleBestOfN({
            n: 10,
            makeAttempt: async (i) => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight -= 1;
                return i;
            },
            score: (v) => v,
        });
        expect(peak).toBeLessThanOrEqual(4);
    });
});
describe("patchVote", () => {
    const mk = (index, patch) => ({ index, score: 0, value: { patch } });
    test("returns the majority consensus representative", () => {
        const r = patchVote([mk(0, "diff A"), mk(1, "diff B"), mk(2, "diff A"), mk(3, "diff A")]);
        expect(r.votes).toBe(3);
        expect(r.representative.index).toBe(0);
        expect(r.representative.value?.patch).toBe("diff A");
    });
    test("normalizes whitespace/blank lines when grouping", () => {
        const r = patchVote([
            mk(0, "line1\n\nline2"),
            mk(1, "line1\nline2\n"),
            mk(2, "totally different"),
        ]);
        expect(r.votes).toBe(2);
    });
    test("ignores empty patches; falls back to lowest index when all empty", () => {
        const r = patchVote([mk(2, ""), mk(0, "   "), mk(1, "\n")]);
        expect(r.votes).toBe(0);
        expect(r.representative.index).toBe(0);
    });
    test("tie between non-empty groups breaks to lowest representative index", () => {
        const r = patchVote([mk(3, "X"), mk(1, "Y"), mk(0, "Y"), mk(2, "X")]);
        // groups Y={1,0} and X={3,2} both size 2 → min index 0 (group Y) wins
        expect(r.votes).toBe(2);
        expect(r.representative.index).toBe(0);
        expect(r.representative.value?.patch).toBe("Y");
    });
});
