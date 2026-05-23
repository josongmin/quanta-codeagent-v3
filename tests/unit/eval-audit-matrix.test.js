/**
 * Audit matrix shape invariants — pins the report aggregation contract.
 *
 *   1. Empty findings ⇒ all majors present, zero counts.
 *   2. A single `ok` finding rolls into the correct major row.
 *   3. Unknown usecase ids are silently dropped (defensive).
 */
import { describe, expect, test } from "bun:test";
import { buildMatrix } from "@/../src/apps/eval/audit/matrix";
import { TAXONOMY } from "@/../src/apps/eval/taxonomy";
describe("audit matrix", () => {
    test("empty findings → every major present with zero counts", () => {
        const m = buildMatrix([]);
        expect(m.rows.length).toBe(TAXONOMY.length);
        expect(m.totals.total).toBe(0);
        for (const r of m.rows) {
            expect(r.total).toBe(0);
            expect(r.counts.ok).toBe(0);
            expect(r.counts.partial).toBe(0);
            expect(r.counts.no).toBe(0);
            expect(r.counts.tbd).toBe(0);
        }
    });
    test("single ok finding rolls into the right major row", () => {
        const finding = {
            usecase: "software-quality.debugging.error-message-paste",
            coverage: "ok",
            evidence: ["src/agent/loop.ts"],
        };
        const m = buildMatrix([finding]);
        const sq = m.rows.find((r) => r.majorId === "software-quality");
        expect(sq).toBeDefined();
        expect(sq?.counts.ok).toBe(1);
        expect(sq?.total).toBe(1);
        expect(m.totals.counts.ok).toBe(1);
    });
    test("unknown usecase ids are dropped", () => {
        const m = buildMatrix([{ usecase: "no-such.thing.here", coverage: "ok", evidence: [] }]);
        expect(m.totals.total).toBe(0);
    });
});
