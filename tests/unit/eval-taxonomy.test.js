/**
 * Taxonomy invariants — pins the SSOT contract.
 *
 *   1. Every leaf id is `<major>.<mid>.<leaf>` and unique.
 *   2. Every leaf carries ≥1 trigger example AND ≥1 evidence key.
 *   3. Every mid is non-empty (≥1 leaf).
 *   4. Every major's `mids` array is non-empty.
 *   5. `allLeaves()` length equals the sum of declared leaves (cache integrity).
 *   6. `leafById` round-trips every leaf.
 *   7. `parseId` returns three non-empty segments for every leaf id.
 *
 * If any of these fail the taxonomy is broken and downstream tier outputs
 * (audit matrix, scenario discovery, classifier prompt) will silently drift.
 */
import { describe, expect, test } from "bun:test";
import { allLeaves, formatLeafLine, leafById, leafCount, parseId, TAXONOMY, } from "@/../src/apps/eval/taxonomy";
describe("eval taxonomy SSOT", () => {
    test("every major has ≥1 mid; every mid has ≥1 leaf", () => {
        for (const maj of TAXONOMY) {
            expect(maj.mids.length).toBeGreaterThan(0);
            for (const m of maj.mids) {
                expect(m.leaves.length).toBeGreaterThan(0);
            }
        }
    });
    test("leaf ids are unique and well-formed", () => {
        const seen = new Set();
        for (const l of allLeaves()) {
            expect(seen.has(l.id)).toBe(false);
            seen.add(l.id);
            const parts = parseId(l.id);
            expect(parts).not.toBeNull();
            expect(parts?.major.length).toBeGreaterThan(0);
            expect(parts?.mid.length).toBeGreaterThan(0);
            expect(parts?.leaf.length).toBeGreaterThan(0);
        }
    });
    test("every leaf carries ≥1 example and ≥1 evidence key", () => {
        for (const l of allLeaves()) {
            expect(l.examples.length).toBeGreaterThan(0);
            expect(l.evidence.length).toBeGreaterThan(0);
        }
    });
    test("leafById round-trips every leaf", () => {
        for (const l of allLeaves()) {
            expect(leafById(l.id)).toBe(l);
        }
    });
    test("leafCount matches the flat list", () => {
        let declared = 0;
        for (const maj of TAXONOMY)
            for (const m of maj.mids)
                declared += m.leaves.length;
        expect(leafCount()).toBe(declared);
    });
    test("formatLeafLine yields stable structure", () => {
        const sample = allLeaves()[0];
        expect(sample).toBeDefined();
        if (sample === undefined)
            return;
        const line = formatLeafLine(sample);
        expect(line.startsWith(`${sample.id}: `)).toBe(true);
    });
    test("parseId rejects malformed ids", () => {
        expect(parseId("a.b")).toBeNull();
        expect(parseId("a.b.c.d")).toBeNull();
        expect(parseId(".b.c")).toBeNull();
        expect(parseId("a..c")).toBeNull();
    });
});
