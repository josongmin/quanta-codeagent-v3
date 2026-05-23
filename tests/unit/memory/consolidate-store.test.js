import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Stage1Store } from "../../../src/memory/consolidate/store";
/**
 * ADR-0068 Wave A — `Stage1Store` SQLite adapter conformance.
 *
 * Each test opens a fresh `:memory:` DB so the watermark singleton is
 * seeded by the constructor's `ensureConsolidateSchema` call and no
 * row leaks between tests.
 */
const makeStore = () => new Stage1Store(new Database(":memory:"));
const baseOutput = (over = {}) => ({
    threadId: "thr-1",
    rolloutSlug: "20260521-120000-feat-foo",
    rolloutSummary: "did some work on foo",
    rawMemory: "- decided to use bun\n- prefers terse summaries",
    preferenceSignals: ["uses bun", "terse"],
    sourceUpdatedAt: 1_000_000,
    selectedForPhase2: true,
    selectedForPhase2SourceUpdatedAt: 1_000_000,
    lastUsage: null,
    usageCount: 0,
    ...over,
});
describe("Stage1Store — schema bootstrap", () => {
    test("constructor seeds the watermark singleton row (id=1)", async () => {
        const store = makeStore();
        const w = await store.getWatermark();
        expect(w.lastSuccessAt).toBeNull();
        expect(w.lastInitAt).toBeNull();
        expect(w.lastConsolidatedCount).toBe(0);
    });
    test("constructor is idempotent — second instance over the same db reuses tables", async () => {
        const db = new Database(":memory:");
        const _a = new Stage1Store(db);
        // A second wrap must not throw (CREATE TABLE IF NOT EXISTS) and must
        // continue to see the seeded watermark row.
        const b = new Stage1Store(db);
        const w = await b.getWatermark();
        expect(w.lastSuccessAt).toBeNull();
        expect(w.lastConsolidatedCount).toBe(0);
    });
    test("stage1_outputs starts empty (fetchSince(null) returns [])", async () => {
        const store = makeStore();
        const rows = await store.fetchSince(null);
        expect(rows).toEqual([]);
    });
    test("countSince(null) on empty table returns 0", async () => {
        const store = makeStore();
        expect(await store.countSince(null)).toBe(0);
    });
});
describe("Stage1Store — upsert JSON roundtrip", () => {
    test("upsert + fetch preserves all scalar fields", async () => {
        const store = makeStore();
        const out = baseOutput({
            threadId: "thr-scalar",
            rolloutSlug: "slug-x",
            rolloutSummary: "summary X",
            rawMemory: "raw X",
            preferenceSignals: ["a"],
            sourceUpdatedAt: 12345,
            selectedForPhase2: true,
            selectedForPhase2SourceUpdatedAt: 12345,
            lastUsage: 67890,
            usageCount: 3,
        });
        await store.upsert(out);
        const rows = await store.fetchSince(null);
        expect(rows).toHaveLength(1);
        const r = rows[0];
        expect(r.threadId).toBe("thr-scalar");
        expect(r.rolloutSlug).toBe("slug-x");
        expect(r.rolloutSummary).toBe("summary X");
        expect(r.rawMemory).toBe("raw X");
        expect(r.sourceUpdatedAt).toBe(12345);
        expect(r.selectedForPhase2).toBe(true);
        expect(r.selectedForPhase2SourceUpdatedAt).toBe(12345);
        expect(r.lastUsage).toBe(67890);
        expect(r.usageCount).toBe(3);
    });
    test("preferenceSignals: empty array roundtrips as []", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-empty", preferenceSignals: [] }));
        const r = (await store.fetchSince(null))[0];
        expect(r.preferenceSignals).toEqual([]);
    });
    test("preferenceSignals: single element roundtrips", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-one", preferenceSignals: ["uses bun"] }));
        const r = (await store.fetchSince(null))[0];
        expect(r.preferenceSignals).toEqual(["uses bun"]);
    });
    test("preferenceSignals: multiple elements preserve order", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({
            threadId: "thr-many",
            preferenceSignals: ["uses bun", "terse", "prefers TS strict"],
        }));
        const r = (await store.fetchSince(null))[0];
        expect(r.preferenceSignals).toEqual(["uses bun", "terse", "prefers TS strict"]);
    });
    test("preferenceSignals: strings with quotes and newlines survive JSON encode", async () => {
        const store = makeStore();
        const tricky = ['has "quotes"', "has\nnewline", "has\\backslash"];
        await store.upsert(baseOutput({ threadId: "thr-tricky", preferenceSignals: tricky }));
        const r = (await store.fetchSince(null))[0];
        expect(r.preferenceSignals).toEqual(tricky);
    });
    test("selectedForPhase2=false stored as 0 and read back as false", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({
            threadId: "thr-unsel",
            selectedForPhase2: false,
            selectedForPhase2SourceUpdatedAt: null,
        }));
        const r = (await store.fetchSince(null))[0];
        expect(r.selectedForPhase2).toBe(false);
        expect(r.selectedForPhase2SourceUpdatedAt).toBeNull();
    });
    test("lastUsage=null roundtrips as null (no coercion to 0)", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-nulluse", lastUsage: null }));
        const r = (await store.fetchSince(null))[0];
        expect(r.lastUsage).toBeNull();
    });
    test("rolloutSummary preserves multibyte UTF-8 (Korean, emoji)", async () => {
        const store = makeStore();
        const text = "한국어 + emoji works";
        await store.upsert(baseOutput({ threadId: "thr-utf", rolloutSummary: text }));
        const r = (await store.fetchSince(null))[0];
        expect(r.rolloutSummary).toBe(text);
    });
    test("rawMemory with embedded NUL and tab survives", async () => {
        const store = makeStore();
        const txt = "line1\tcol\nline2";
        await store.upsert(baseOutput({ threadId: "thr-ws", rawMemory: txt }));
        const r = (await store.fetchSince(null))[0];
        expect(r.rawMemory).toBe(txt);
    });
});
describe("Stage1Store — upsert REPLACE semantics", () => {
    test("same threadId upserted twice → row count stays 1", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-dup", rolloutSummary: "v1" }));
        await store.upsert(baseOutput({ threadId: "thr-dup", rolloutSummary: "v2" }));
        expect(await store.countSince(null)).toBe(1);
    });
    test("REPLACE overwrites ALL fields with the latest values", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({
            threadId: "thr-r",
            rolloutSummary: "old",
            rawMemory: "old-raw",
            preferenceSignals: ["old"],
            sourceUpdatedAt: 100,
            usageCount: 5,
        }));
        await store.upsert(baseOutput({
            threadId: "thr-r",
            rolloutSummary: "new",
            rawMemory: "new-raw",
            preferenceSignals: ["new"],
            sourceUpdatedAt: 200,
            usageCount: 0,
        }));
        const r = (await store.fetchSince(null))[0];
        expect(r.rolloutSummary).toBe("new");
        expect(r.rawMemory).toBe("new-raw");
        expect(r.preferenceSignals).toEqual(["new"]);
        expect(r.sourceUpdatedAt).toBe(200);
        expect(r.usageCount).toBe(0);
    });
    test("disjoint threadIds coexist as independent rows", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-a", sourceUpdatedAt: 100 }));
        await store.upsert(baseOutput({ threadId: "thr-b", sourceUpdatedAt: 200 }));
        expect(await store.countSince(null)).toBe(2);
        const rows = await store.fetchSince(null);
        const ids = rows.map((r) => r.threadId).sort();
        expect(ids).toEqual(["thr-a", "thr-b"]);
    });
});
describe("Stage1Store — fetchSince ordering + watermark filtering", () => {
    test("fetchSince(null) returns rows ORDER BY source_updated_at DESC", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-old", sourceUpdatedAt: 100 }));
        await store.upsert(baseOutput({ threadId: "thr-new", sourceUpdatedAt: 300 }));
        await store.upsert(baseOutput({ threadId: "thr-mid", sourceUpdatedAt: 200 }));
        const rows = await store.fetchSince(null);
        expect(rows.map((r) => r.threadId)).toEqual(["thr-new", "thr-mid", "thr-old"]);
    });
    test("fetchSince(watermark) excludes rows at or below the watermark (> strict)", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-100", sourceUpdatedAt: 100 }));
        await store.upsert(baseOutput({ threadId: "thr-200", sourceUpdatedAt: 200 }));
        await store.upsert(baseOutput({ threadId: "thr-300", sourceUpdatedAt: 300 }));
        const rows = await store.fetchSince(150);
        expect(rows.map((r) => r.threadId)).toEqual(["thr-300", "thr-200"]);
    });
    test("fetchSince(exactBoundary) is strictly greater than (excludes equal)", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-eq", sourceUpdatedAt: 200 }));
        await store.upsert(baseOutput({ threadId: "thr-gt", sourceUpdatedAt: 201 }));
        const rows = await store.fetchSince(200);
        expect(rows.map((r) => r.threadId)).toEqual(["thr-gt"]);
    });
    test("fetchSince — same sourceUpdatedAt → secondary ORDER BY thread_id DESC", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-a", sourceUpdatedAt: 100 }));
        await store.upsert(baseOutput({ threadId: "thr-c", sourceUpdatedAt: 100 }));
        await store.upsert(baseOutput({ threadId: "thr-b", sourceUpdatedAt: 100 }));
        const rows = await store.fetchSince(null);
        expect(rows.map((r) => r.threadId)).toEqual(["thr-c", "thr-b", "thr-a"]);
    });
    test("fetchSince(null, limit=2) caps result size", async () => {
        const store = makeStore();
        for (let i = 1; i <= 5; i++) {
            await store.upsert(baseOutput({ threadId: `thr-${i}`, sourceUpdatedAt: i * 100 }));
        }
        const rows = await store.fetchSince(null, 2);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.threadId)).toEqual(["thr-5", "thr-4"]);
    });
    test("fetchSince(watermark, limit) applies both filter and cap", async () => {
        const store = makeStore();
        for (let i = 1; i <= 5; i++) {
            await store.upsert(baseOutput({ threadId: `thr-${i}`, sourceUpdatedAt: i * 100 }));
        }
        const rows = await store.fetchSince(200, 2);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.threadId)).toEqual(["thr-5", "thr-4"]);
    });
    test("countSince(null) matches fetchSince(null).length", async () => {
        const store = makeStore();
        for (let i = 1; i <= 4; i++) {
            await store.upsert(baseOutput({ threadId: `thr-${i}`, sourceUpdatedAt: i * 100 }));
        }
        expect(await store.countSince(null)).toBe(4);
        expect((await store.fetchSince(null)).length).toBe(4);
    });
    test("countSince(watermark) matches fetchSince(watermark).length", async () => {
        const store = makeStore();
        for (let i = 1; i <= 4; i++) {
            await store.upsert(baseOutput({ threadId: `thr-${i}`, sourceUpdatedAt: i * 100 }));
        }
        expect(await store.countSince(200)).toBe(2);
        expect((await store.fetchSince(200)).length).toBe(2);
    });
    test("countSince ignores the safety limit (counts ALL matching rows)", async () => {
        const store = makeStore();
        for (let i = 1; i <= 10; i++) {
            await store.upsert(baseOutput({ threadId: `thr-${i}`, sourceUpdatedAt: i * 100 }));
        }
        // fetch caps at 3 but count should report the true 10.
        expect((await store.fetchSince(null, 3)).length).toBe(3);
        expect(await store.countSince(null)).toBe(10);
    });
});
describe("Stage1Store — watermark roundtrip", () => {
    test("setWatermark + getWatermark preserves all three fields", async () => {
        const store = makeStore();
        const next = {
            lastSuccessAt: 12345,
            lastInitAt: 9999,
            lastConsolidatedCount: 7,
        };
        await store.setWatermark(next);
        const w = await store.getWatermark();
        expect(w.lastSuccessAt).toBe(12345);
        expect(w.lastInitAt).toBe(9999);
        expect(w.lastConsolidatedCount).toBe(7);
    });
    test("setWatermark with null lastInitAt is persisted as null", async () => {
        const store = makeStore();
        await store.setWatermark({
            lastSuccessAt: 1000,
            lastInitAt: null,
            lastConsolidatedCount: 2,
        });
        const w = await store.getWatermark();
        expect(w.lastSuccessAt).toBe(1000);
        expect(w.lastInitAt).toBeNull();
        expect(w.lastConsolidatedCount).toBe(2);
    });
    test("setWatermark twice — the second overwrites the first", async () => {
        const store = makeStore();
        await store.setWatermark({ lastSuccessAt: 100, lastInitAt: 50, lastConsolidatedCount: 1 });
        await store.setWatermark({ lastSuccessAt: 200, lastInitAt: 60, lastConsolidatedCount: 3 });
        const w = await store.getWatermark();
        expect(w.lastSuccessAt).toBe(200);
        expect(w.lastInitAt).toBe(60);
        expect(w.lastConsolidatedCount).toBe(3);
    });
    test("upserts do NOT mutate the watermark singleton", async () => {
        const store = makeStore();
        await store.upsert(baseOutput({ threadId: "thr-x", sourceUpdatedAt: 9999 }));
        const w = await store.getWatermark();
        expect(w.lastSuccessAt).toBeNull();
        expect(w.lastInitAt).toBeNull();
        expect(w.lastConsolidatedCount).toBe(0);
    });
    test("getWatermark throws when the singleton row is deleted out-of-band", async () => {
        const db = new Database(":memory:");
        const store = new Stage1Store(db);
        db.exec("DELETE FROM consolidate_watermark WHERE id = 1");
        await expect(store.getWatermark()).rejects.toThrow(/consolidate_watermark singleton row \(id=1\) is missing/);
    });
});
describe("Stage1Store — store sharing one Database", () => {
    test("two Stage1Store instances over the same db see each other's writes", async () => {
        const db = new Database(":memory:");
        const a = new Stage1Store(db);
        const b = new Stage1Store(db);
        await a.upsert(baseOutput({ threadId: "thr-shared", sourceUpdatedAt: 500 }));
        const rows = await b.fetchSince(null);
        expect(rows).toHaveLength(1);
        expect(rows[0].threadId).toBe("thr-shared");
    });
});
