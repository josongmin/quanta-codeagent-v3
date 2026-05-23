import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, normalizeEntry, SqliteStore } from "@/memory";
const NOW = 1_700_000_000_000;
const entry = (over) => ({
    kind: "fact",
    text: "default text",
    tags: [],
    createdAt: NOW,
    ...over,
});
const tmpRoot = mkdtempSync(join(tmpdir(), "memory-sqlite-"));
afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
});
describe("SqliteStore (:memory:)", () => {
    test("save → recall round trip", async () => {
        const store = new SqliteStore(":memory:");
        try {
            await store.save(entry({ id: "1", text: "hello world", tags: ["greeting"] }));
            const got = await store.recall({ text: "hello" });
            expect(got).toHaveLength(1);
            // Round-trip preserves all fields and applies the documented store-boundary
            // defaults (tier/importance/updatedAt/accessCount) — see normalizeEntry.
            expect(got[0]).toEqual(normalizeEntry(entry({ id: "1", text: "hello world", tags: ["greeting"] })));
        }
        finally {
            store.close();
        }
    });
    test("save upserts by id (ON CONFLICT)", async () => {
        const store = new SqliteStore(":memory:");
        try {
            await store.save(entry({ id: "1", text: "v1" }));
            await store.save(entry({ id: "1", text: "v2", sessionId: "s9" }));
            const got = await store.recall({});
            expect(got).toHaveLength(1);
            expect(got[0]?.text).toBe("v2");
            expect(got[0]?.sessionId).toBe("s9");
        }
        finally {
            store.close();
        }
    });
    test("empty id rejects", async () => {
        const store = new SqliteStore(":memory:");
        try {
            await expect(store.save(entry({ id: "" }))).rejects.toThrow("id is required");
        }
        finally {
            store.close();
        }
    });
    test("sessionId omitted when absent (exactOptionalPropertyTypes)", async () => {
        const store = new SqliteStore(":memory:");
        try {
            await store.save(entry({ id: "1" }));
            const got = await store.recall({});
            expect("sessionId" in got[0]).toBe(false);
        }
        finally {
            store.close();
        }
    });
});
describe("SqliteStore (file path)", () => {
    test("persistence across reopen", async () => {
        const path = join(tmpRoot, "persist.db");
        const a = new SqliteStore(path);
        await a.save(entry({ id: "1", text: "durable", tags: ["t"], sessionId: "s1" }));
        a.close();
        const b = new SqliteStore(path);
        try {
            const got = await b.recall({ text: "durable" });
            expect(got).toHaveLength(1);
            expect(got[0]?.id).toBe("1");
            expect(got[0]?.sessionId).toBe("s1");
        }
        finally {
            b.close();
        }
    });
    test("schema init is idempotent (construct twice on same file)", async () => {
        const path = join(tmpRoot, "idem.db");
        const a = new SqliteStore(path);
        await a.save(entry({ id: "1" }));
        a.close();
        // Re-running CREATE TABLE/INDEX IF NOT EXISTS must not throw or wipe data.
        const b = new SqliteStore(path);
        try {
            expect(await b.recall({})).toHaveLength(1);
        }
        finally {
            b.close();
        }
    });
});
describe("ranking parity: SqliteStore vs InMemoryStore", () => {
    const dataset = [
        entry({ id: "a", text: "the quick brown fox", tags: ["animal"], createdAt: NOW }),
        entry({
            id: "b",
            text: "lazy dog sleeps",
            tags: ["animal", "sleep"],
            kind: "observation",
            createdAt: NOW - 5_000,
        }),
        entry({
            id: "c",
            text: "decision: use sqlite",
            tags: ["tech"],
            kind: "decision",
            createdAt: NOW - 100_000_000,
        }),
        entry({ id: "d", text: "another quick note", tags: ["misc"], createdAt: NOW - 50 }),
    ];
    const queries = [
        {},
        { text: "quick" },
        { tags: ["animal"] },
        { tags: ["animal", "sleep"] },
        { kinds: ["decision"] },
        { kinds: ["observation", "fact"], text: "quick" },
        { freshness: ["fresh"] },
        { limit: 2 },
        { text: "zzz-no-match" },
    ];
    test("identical ordered results for every query", async () => {
        const mem = new InMemoryStore(dataset);
        const sql = new SqliteStore(":memory:");
        try {
            for (const e of dataset)
                await sql.save(e);
            for (const q of queries) {
                const memIds = (await mem.recall(q)).map((e) => e.id);
                const sqlIds = (await sql.recall(q)).map((e) => e.id);
                expect(sqlIds).toEqual(memIds);
            }
        }
        finally {
            sql.close();
        }
    });
});
