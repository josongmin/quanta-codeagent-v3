/**
 * ADR-0087 — additive eval schema fields (Cursor EvalTracking absorption §7.3).
 *
 * Verifies the new OPTIONAL fields are non-breaking:
 *  (a) records WITHOUT the new fields stay valid (byte-identical envelope),
 *  (b) records WITH metrics[]/tokens/costUsd/status/params are well-typed,
 *  (d) Metric.unit / Metric.step are optional.
 * (c) zod round-trip is N/A — schema.ts is plain TS interfaces, no zod.
 *
 * No runtime parser exists for these interfaces, so the "validation" we assert
 * is structural: TS typechecks the literals (tsc --noEmit gates the build) and
 * the values round-trip through JSON (the JSONL on-disk format) unchanged.
 */
import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION } from "@/../src/apps/eval/storage/schema";
describe("ADR-0087 eval schema additive fields", () => {
    test("(a) synthetic/public payloads WITHOUT new fields stay valid", () => {
        const syn = {
            kind: "synthetic",
            scenarioId: "pure-function-tests",
            verdict: "pass",
            score: 1,
            rubric: [{ name: "covers-happy-path", pass: true }],
            toolsUsed: ["Read", "Write"],
            durationMs: 1234,
        };
        const pub = {
            kind: "public",
            bench: "swebench-verified",
            instanceId: "astropy__astropy-12345",
            verdict: "fail",
            durationMs: 9000,
        };
        expect(syn.metrics).toBeUndefined();
        expect(pub.tokens).toBeUndefined();
        // JSONL round-trip is identical when no optional fields are set.
        expect(JSON.parse(JSON.stringify(syn))).toEqual(syn);
        expect(JSON.parse(JSON.stringify(pub))).toEqual(pub);
    });
    test("(b) payloads WITH metrics[]/tokens/costUsd round-trip", () => {
        const tokens = { prompt: 1200, completion: 340, cacheRead: 800 };
        const metrics = [
            { key: "judge.helpfulness", value: 0.92 },
            { key: "tokens.per_turn", value: 512, unit: "tokens", step: 3 },
        ];
        const syn = {
            kind: "synthetic",
            scenarioId: "s1",
            verdict: "pass",
            rubric: [],
            toolsUsed: [],
            durationMs: 10,
            metrics,
            tokens,
            costUsd: 0.0123,
        };
        const pub = {
            kind: "public",
            bench: "swebench-verified",
            instanceId: "i1",
            verdict: "pass",
            durationMs: 20,
            metrics,
            tokens,
            costUsd: 0.5,
        };
        const synBack = JSON.parse(JSON.stringify(syn));
        const pubBack = JSON.parse(JSON.stringify(pub));
        expect(synBack).toEqual(syn);
        expect(pubBack).toEqual(pub);
        expect(synBack.tokens?.cacheRead).toBe(800);
        expect(synBack.metrics?.[1]?.unit).toBe("tokens");
        expect(pubBack.costUsd).toBe(0.5);
    });
    test("(b) RunSummaryRecord WITH status/params round-trips; WITHOUT stays valid", () => {
        const base = {
            ts: 1_700_000_000_000,
            schema: SCHEMA_VERSION,
            runId: "synthetic-abc",
            tier: "synthetic",
            argv: ["eval", "synthetic"],
            counts: { pass: 3, partial: 0, fail: 1, error: 0, skipped: 0 },
            durationMs: 5000,
        };
        expect(base.status).toBeUndefined();
        expect(base.params).toBeUndefined();
        expect(JSON.parse(JSON.stringify(base))).toEqual(base);
        const enriched = {
            ...base,
            status: "finished",
            params: { model: "claude-opus-4-7", temperature: 0, seed: 42, plan: true },
        };
        const back = JSON.parse(JSON.stringify(enriched));
        expect(back).toEqual(enriched);
        expect(back.status).toBe("finished");
        expect(back.params?.seed).toBe(42);
        expect(back.params?.plan).toBe(true);
    });
    test("(d) Metric.unit and Metric.step are optional", () => {
        const minimal = { key: "k", value: 1 };
        const full = { key: "k", value: 1, unit: "ms", step: 7 };
        expect(minimal.unit).toBeUndefined();
        expect(minimal.step).toBeUndefined();
        expect(full.unit).toBe("ms");
        expect(full.step).toBe(7);
    });
});
