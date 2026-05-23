import { describe, expect, test } from "bun:test";
import { persistSession, recallContext, SESSION_TAG } from "@/agent/memory";
import { EMBED_DIM, InMemoryStore, } from "@/memory";
const assistant = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
});
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
/**
 * Fixed epoch for deterministic wall-clock arithmetic in eviction/freshness
 * tests. The memory module's `archived` boundary lives at exactly 40 days
 * past `createdAt`; with a real `Date.now()`, CI clock skew or a slow setup
 * could nudge entries across that boundary. Pinning both ends to `TEST_NOW`
 * (and injecting it via the `now` deps seam) makes the threshold unambiguous.
 */
const TEST_NOW = 1_700_000_000_000;
const fixedNow = () => TEST_NOW;
/** Deterministic 1536-vec derived from a string hash (stable per text). */
const fakeVec = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++)
        h = (h ^ text.charCodeAt(i)) * 16777619;
    const out = new Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) {
        h = (h ^ (h << 13)) >>> 0;
        out[i] = ((h % 2000) - 1000) / 1000;
    }
    return out;
};
/** FakeEmbedder: deterministic per-text vectors; optionally always throws. */
const fakeEmbedder = (opts) => ({
    embed: async (texts) => {
        if (opts?.throws)
            throw new Error("embed down");
        return texts.map(fakeVec);
    },
});
/** FakeLLM: streams `out` as one text_delta + message_stop, or throws. */
const fakeLLM = (out) => ({
    stream() {
        return {
            async *[Symbol.asyncIterator]() {
                if (typeof out !== "string")
                    throw new Error("llm down");
                yield { type: "text_delta", delta: out };
                yield { type: "message_stop", stop_reason: "end_turn" };
            },
        };
    },
});
/** Wrap a store so update() always throws (reinforcement robustness test). */
const throwingUpdate = (inner) => ({
    save: (e) => inner.save(e),
    update: () => Promise.reject(new Error("update boom")),
    delete: (id) => inner.delete(id),
    get: (id) => inner.get(id),
    all: () => inner.all(),
    recall: (q) => inner.recall(q),
});
describe("recallContext", () => {
    test("lexical-only recall, formatted block", async () => {
        const store = new InMemoryStore([
            { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
        ]);
        const out = await recallContext({ store }, "database");
        expect(out).toBe("## Memory hints (routing hints only — not proof)\n- (fact) uses Postgres 16");
    });
    test("with embedder embeds the query (still recalls)", async () => {
        const store = new InMemoryStore([
            { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
        ]);
        const out = await recallContext({ store, embedder: fakeEmbedder() }, "db engine");
        expect(out).toContain("- (fact) uses Postgres 16");
    });
    test("embedder throwing degrades to lexical (no throw)", async () => {
        const store = new InMemoryStore([{ id: "a", kind: "fact", text: "x", tags: [], createdAt: 1 }]);
        const out = await recallContext({ store, embedder: fakeEmbedder({ throws: true }) }, "q");
        expect(out).toContain("- (fact) x");
    });
    test("empty primary (tiers filter) falls back to SESSION_TAG", async () => {
        const store = new InMemoryStore([
            {
                id: "s1",
                kind: "decision",
                tier: "episodic",
                text: "decided on Bun",
                tags: [SESSION_TAG],
                createdAt: 1,
            },
        ]);
        // Primary restricted to semantic → empty; fallback (tags, no tier) finds it.
        const out = await recallContext({ store }, "anything", { tiers: ["semantic"] });
        expect(out).toBe("## Memory hints (routing hints only — not proof)\n- (decision) decided on Bun");
    });
    test("empty store → null", async () => {
        const out = await recallContext({ store: new InMemoryStore() }, "q");
        expect(out).toBeNull();
    });
    test("reinforcement bumps accessCount and importance", async () => {
        const store = new InMemoryStore([
            { id: "a", kind: "fact", text: "t", tags: [], createdAt: 1, importance: 0.5, accessCount: 2 },
        ]);
        await recallContext({ store }, "t");
        const e = await store.get("a");
        expect(e?.accessCount).toBe(3);
        expect(e?.importance).toBeCloseTo(0.52, 5);
        expect(typeof e?.lastAccessedAt).toBe("number");
    });
    test("reinforcement failure does not break recall", async () => {
        const inner = new InMemoryStore([{ id: "a", kind: "fact", text: "t", tags: [], createdAt: 1 }]);
        const out = await recallContext({ store: throwingUpdate(inner) }, "t");
        expect(out).toContain("- (fact) t");
    });
    test("onStats: fires once with recalled count + lexical (embedded=false)", async () => {
        const store = new InMemoryStore([
            { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
        ]);
        const seen = [];
        const out = await recallContext({ store, onStats: (s) => seen.push(s) }, "database");
        expect(out).toBe("## Memory hints (routing hints only — not proof)\n- (fact) uses Postgres 16");
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({ recalled: 1, embedded: false, fellBack: false });
    });
    test("onStats: embedded=true when an embedder produced the query vector", async () => {
        const store = new InMemoryStore([
            { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
        ]);
        const seen = [];
        await recallContext({ store, embedder: fakeEmbedder(), onStats: (s) => seen.push(s) }, "db");
        expect(seen).toHaveLength(1);
        expect(seen[0]?.embedded).toBe(true);
    });
    test("onStats: embedder throwing → embedded=false (lexical degrade)", async () => {
        const store = new InMemoryStore([{ id: "a", kind: "fact", text: "x", tags: [], createdAt: 1 }]);
        const seen = [];
        await recallContext({ store, embedder: fakeEmbedder({ throws: true }), onStats: (s) => seen.push(s) }, "q");
        expect(seen).toHaveLength(1);
        expect(seen[0]?.embedded).toBe(false);
    });
    test("onStats: fellBack=true when SESSION_TAG fallback path is taken", async () => {
        const store = new InMemoryStore([
            {
                id: "s1",
                kind: "decision",
                tier: "episodic",
                text: "decided on Bun",
                tags: [SESSION_TAG],
                createdAt: 1,
            },
        ]);
        const seen = [];
        const out = await recallContext({ store, onStats: (s) => seen.push(s) }, "anything", {
            tiers: ["semantic"],
        });
        expect(out).toBe("## Memory hints (routing hints only — not proof)\n- (decision) decided on Bun");
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({ recalled: 1, embedded: false, fellBack: true });
    });
    test("onStats: empty store → recalled 0, fires once, returns null", async () => {
        const seen = [];
        const out = await recallContext({ store: new InMemoryStore(), onStats: (s) => seen.push(s) }, "q");
        expect(out).toBeNull();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({ recalled: 0, embedded: false, fellBack: true });
    });
    test("onStats: an observer throw never escapes recallContext", async () => {
        const store = new InMemoryStore([{ id: "a", kind: "fact", text: "t", tags: [], createdAt: 1 }]);
        const out = await recallContext({
            store,
            onStats: () => {
                throw new Error("observer boom");
            },
        }, "t");
        expect(out).toContain("- (fact) t");
    });
    test("text truncated to 600 chars + ellipsis", async () => {
        const long = "x".repeat(700);
        const store = new InMemoryStore([{ id: "a", kind: "fact", text: long, tags: [], createdAt: 1 }]);
        const out = await recallContext({ store }, "x");
        expect(out).toBe(`## Memory hints (routing hints only — not proof)\n- (fact) ${"x".repeat(600)}…`);
    });
});
describe("persistSession", () => {
    test("heuristic path (no llm) persists final assistant text", async () => {
        const store = new InMemoryStore();
        await persistSession({ store }, { sessionId: "s1", finalMessages: [user("hi"), assistant("Final decision: ship it.")] });
        const all = await store.all();
        expect(all).toHaveLength(1);
        expect(all[0]?.text).toBe("Final decision: ship it.");
        expect(all[0]?.tags).toContain(SESSION_TAG);
    });
    test("no assistant text → no-op", async () => {
        const store = new InMemoryStore();
        await persistSession({ store }, { sessionId: "s1", finalMessages: [user("hi")] });
        expect((await store.all()).length).toBe(0);
    });
    test("distill path (FakeLLM JSON array) inserts records", async () => {
        const store = new InMemoryStore();
        const json = JSON.stringify([
            {
                kind: "fact",
                tier: "semantic",
                text: "uses Bun runtime",
                tags: ["stack"],
                importance: 0.9,
            },
        ]);
        await persistSession({ store, llm: fakeLLM(json) }, { sessionId: "s2", finalMessages: [user("q"), assistant("done")] });
        const all = await store.all();
        expect(all).toHaveLength(1);
        expect(all[0]?.text).toBe("uses Bun runtime");
        expect(all[0]?.kind).toBe("fact");
    });
    test("re-running a session updates rather than duplicates (deterministic id)", async () => {
        const store = new InMemoryStore();
        const input = { sessionId: "s3", finalMessages: [user("q"), assistant("stable summary")] };
        await persistSession({ store }, input);
        await persistSession({ store }, input);
        // Second run: exact-text dupe → heuristic skip. Still one entry.
        expect((await store.all()).length).toBe(1);
    });
    test("heuristic skip on exact-text dupe", async () => {
        const store = new InMemoryStore([
            { id: "old", kind: "decision", text: "ship it", tags: [SESSION_TAG], createdAt: 1 },
        ]);
        await persistSession({ store }, { sessionId: "s4", finalMessages: [assistant("ship it")] });
        expect((await store.all()).length).toBe(1);
    });
    test("LLM merge op updates target, does not save candidate", async () => {
        const store = new InMemoryStore([
            {
                id: "old",
                kind: "fact",
                text: "alpha beta gamma delta",
                tags: [],
                createdAt: TEST_NOW,
            },
        ]);
        const op = JSON.stringify({
            action: "merge",
            intoId: "old",
            text: "alpha beta gamma delta merged",
            tags: ["db"],
            importance: 0.8,
        });
        await persistSession({ store, llm: fakeLLM(op), distill: false, now: fixedNow }, { sessionId: "s5", finalMessages: [assistant("alpha beta gamma delta epsilon")] });
        const all = await store.all();
        expect(all).toHaveLength(1);
        expect(all[0]?.text).toBe("alpha beta gamma delta merged");
        expect(all[0]?.importance).toBeCloseTo(0.8, 5);
    });
    test("LLM supersede op saves candidate and marks old superseded", async () => {
        const store = new InMemoryStore([
            { id: "old", kind: "fact", text: "one two three four five", tags: [], createdAt: TEST_NOW },
        ]);
        const op = JSON.stringify({ action: "supersede", oldId: "old" });
        await persistSession({ store, llm: fakeLLM(op), distill: false, now: fixedNow }, { sessionId: "s6", finalMessages: [assistant("one two three four six")] });
        const all = await store.all();
        expect(all).toHaveLength(2);
        const old = all.find((e) => e.id === "old");
        expect(old?.supersededBy).toBeDefined();
    });
    test("LLM skip op persists nothing", async () => {
        const store = new InMemoryStore([
            { id: "old", kind: "fact", text: "uses postgres database thing", tags: [], createdAt: 1 },
        ]);
        await persistSession({ store, llm: fakeLLM('{"action":"skip"}'), distill: false }, { sessionId: "s7", finalMessages: [assistant("uses postgres database stuff")] });
        expect((await store.all()).length).toBe(1);
    });
    test("eviction deletes cap-overflow entries", async () => {
        const seed = [];
        for (let i = 0; i < 6; i++) {
            seed.push({
                id: `e${i}`,
                kind: "fact",
                tier: "episodic",
                text: `entry ${i}`,
                tags: [],
                createdAt: 1000 + i,
                importance: 0.1,
            });
        }
        const store = new InMemoryStore(seed);
        await persistSession({ store, evictionCaps: { episodicMax: 2 } }, { sessionId: "s8", finalMessages: [assistant("a fresh distinct summary line")] });
        const all = await store.all();
        const episodic = all.filter((e) => e.tier === "episodic");
        expect(episodic.length).toBeLessThanOrEqual(2);
    });
    test("eviction decays archived low-value survivors", async () => {
        const old = TEST_NOW - 40 * 24 * 60 * 60 * 1000; // 40d → archived
        const store = new InMemoryStore([
            {
                id: "arch",
                kind: "fact",
                tier: "semantic",
                text: "old archived knowledge",
                tags: [],
                createdAt: old,
                importance: 0.8,
            },
        ]);
        await persistSession({ store, now: fixedNow }, { sessionId: "s9", finalMessages: [assistant("an unrelated brand new summary")] });
        const e = await store.get("arch");
        expect(e?.importance).toBeCloseTo(0.4, 5); // 0.8 * EVICTION_DECAY(0.5)
    });
    test("onStats: heuristic path reports distilled+inserted exactly once", async () => {
        const store = new InMemoryStore();
        const seen = [];
        await persistSession({ store, onStats: (s) => seen.push(s) }, { sessionId: "ps1", finalMessages: [user("hi"), assistant("a distinct heuristic line")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            distilled: 1,
            inserted: 1,
            merged: 0,
            superseded: 0,
            skipped: 0,
        });
    });
    test("onStats: no-records path still fires once (all zero)", async () => {
        const store = new InMemoryStore();
        const seen = [];
        await persistSession({ store, onStats: (s) => seen.push(s) }, { sessionId: "ps2", finalMessages: [user("hi")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.distilled).toBe(0);
        expect(seen[0]?.inserted).toBe(0);
    });
    test("onStats: distill path reports distilled+inserted", async () => {
        const store = new InMemoryStore();
        const json = JSON.stringify([
            {
                kind: "fact",
                tier: "semantic",
                text: "uses Bun runtime",
                tags: ["stack"],
                importance: 0.9,
            },
        ]);
        const seen = [];
        await persistSession({ store, llm: fakeLLM(json), onStats: (s) => seen.push(s) }, { sessionId: "ps3", finalMessages: [user("q"), assistant("done")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ distilled: 1, inserted: 1 });
    });
    test("onStats: skip op increments skipped", async () => {
        const store = new InMemoryStore([
            { id: "old", kind: "fact", text: "uses postgres database thing", tags: [], createdAt: 1 },
        ]);
        const seen = [];
        await persistSession({ store, llm: fakeLLM('{"action":"skip"}'), distill: false, onStats: (s) => seen.push(s) }, { sessionId: "ps4", finalMessages: [assistant("uses postgres database stuff")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ inserted: 0, skipped: 1 });
    });
    test("onStats: merge op increments merged", async () => {
        const store = new InMemoryStore([
            { id: "old", kind: "fact", text: "alpha beta gamma delta", tags: [], createdAt: TEST_NOW },
        ]);
        const op = JSON.stringify({
            action: "merge",
            intoId: "old",
            text: "alpha beta gamma delta merged",
            tags: ["db"],
            importance: 0.8,
        });
        const seen = [];
        await persistSession({ store, llm: fakeLLM(op), distill: false, onStats: (s) => seen.push(s), now: fixedNow }, { sessionId: "ps5", finalMessages: [assistant("alpha beta gamma delta epsilon")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ merged: 1, inserted: 0 });
    });
    test("onStats: supersede op increments superseded", async () => {
        const store = new InMemoryStore([
            { id: "old", kind: "fact", text: "one two three four five", tags: [], createdAt: TEST_NOW },
        ]);
        const op = JSON.stringify({ action: "supersede", oldId: "old" });
        const seen = [];
        await persistSession({ store, llm: fakeLLM(op), distill: false, onStats: (s) => seen.push(s), now: fixedNow }, { sessionId: "ps6", finalMessages: [assistant("one two three four six")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ superseded: 1, inserted: 0 });
    });
    test("onStats: eviction sweep reports deleted", async () => {
        const seed = [];
        for (let i = 0; i < 6; i++) {
            seed.push({
                id: `e${i}`,
                kind: "fact",
                tier: "episodic",
                text: `entry ${i}`,
                tags: [],
                createdAt: 1000 + i,
                importance: 0.1,
            });
        }
        const store = new InMemoryStore(seed);
        const seen = [];
        await persistSession({ store, evictionCaps: { episodicMax: 2 }, onStats: (s) => seen.push(s) }, { sessionId: "ps7", finalMessages: [assistant("a fresh distinct summary line")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.deleted).toBeGreaterThan(0);
    });
    test("onStats: eviction sweep reports decayed", async () => {
        const old = TEST_NOW - 40 * 24 * 60 * 60 * 1000;
        const store = new InMemoryStore([
            {
                id: "arch",
                kind: "fact",
                tier: "semantic",
                text: "old archived knowledge",
                tags: [],
                createdAt: old,
                importance: 0.8,
            },
        ]);
        const seen = [];
        await persistSession({ store, onStats: (s) => seen.push(s), now: fixedNow }, { sessionId: "ps8", finalMessages: [assistant("an unrelated brand new summary")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.decayed).toBeGreaterThan(0);
    });
    test("onStats: fires once (best-effort) even when store blows up", async () => {
        const boomStore = {
            save: () => Promise.reject(new Error("save boom")),
            update: () => Promise.reject(new Error("update boom")),
            delete: () => Promise.reject(new Error("delete boom")),
            get: () => Promise.reject(new Error("get boom")),
            all: () => Promise.reject(new Error("all boom")),
            recall: () => Promise.reject(new Error("recall boom")),
        };
        const seen = [];
        await persistSession({ store: boomStore, onStats: (s) => seen.push(s) }, { sessionId: "ps9", finalMessages: [assistant("text")] });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.distilled).toBe(1);
        expect(seen[0]?.inserted).toBe(0);
    });
    test("onStats: an observer throw never escapes persistSession", async () => {
        const store = new InMemoryStore();
        await expect(persistSession({
            store,
            onStats: () => {
                throw new Error("observer boom");
            },
        }, { sessionId: "ps10", finalMessages: [assistant("a line")] })).resolves.toBeUndefined();
    });
    // C10: persistSession used to call store.all() once PER distilled record
    // (in findNearDuplicates) PLUS once in the eviction sweep — O(records+1)
    // full-store scans. It now hoists ONE snapshot and mirrors ops into it.
    describe("C10: store.all() is O(1) per persistSession (not O(records))", () => {
        /** Wrap a store, counting all() calls; everything else passes through. */
        const countingAll = (inner) => {
            let n = 0;
            return {
                count: () => n,
                store: {
                    save: (e) => inner.save(e),
                    update: (id, p) => inner.update(id, p),
                    delete: (id) => inner.delete(id),
                    get: (id) => inner.get(id),
                    all: () => {
                        n++;
                        return inner.all();
                    },
                    recall: (q) => inner.recall(q),
                },
            };
        };
        test("multi-record distill: exactly ONE store.all() regardless of record count", async () => {
            const json = JSON.stringify([
                { kind: "fact", tier: "semantic", text: "alpha one fact line", tags: [], importance: 0.6 },
                { kind: "fact", tier: "semantic", text: "beta two fact line", tags: [], importance: 0.6 },
                {
                    kind: "fact",
                    tier: "semantic",
                    text: "gamma three fact line",
                    tags: [],
                    importance: 0.6,
                },
                {
                    kind: "decision",
                    tier: "episodic",
                    text: "delta four decision",
                    tags: [],
                    importance: 0.6,
                },
            ]);
            const { store, count } = countingAll(new InMemoryStore());
            await persistSession({ store, llm: fakeLLM(json) }, { sessionId: "c10a", finalMessages: [user("q"), assistant("done")] });
            // 4 records: old code = 4 (dedup) + 1 (sweep) = 5 scans. New code = 1.
            expect(count()).toBe(1);
        });
        test("single-record path: still exactly ONE store.all()", async () => {
            const { store, count } = countingAll(new InMemoryStore());
            await persistSession({ store }, { sessionId: "c10b", finalMessages: [assistant("a single distinct summary")] });
            expect(count()).toBe(1);
        });
        // Outcome-equivalence: the hoisted-snapshot impl must produce the SAME
        // observable store state the old per-record-rescan impl did. The decisive
        // correctness case is intra-run dedup: a record inserted mid-loop must be
        // visible to a LATER record's findNearDuplicates (old code saw it via the
        // fresh store.all(); new code must see it via the mirrored snapshot push).
        // If the mirror were dropped, the 2nd identical record would wrongly
        // insert → 2 entries instead of 1. That divergence is what we pin.
        const normalized = async (s) => (await s.all())
            .map((e) => `${e.id}|${e.text}|${[...(e.tags ?? [])].sort().join(",")}|${e.importance ?? ""}|${e.supersededBy ?? ""}`)
            .sort();
        test("outcome-equivalence: intra-run dedup — 2nd identical record skips the mid-loop insert", async () => {
            const json = JSON.stringify([
                {
                    kind: "fact",
                    tier: "semantic",
                    text: "one identical durable line",
                    tags: ["x"],
                    importance: 0.7,
                },
                {
                    kind: "fact",
                    tier: "semantic",
                    text: "one identical durable line",
                    tags: ["x"],
                    importance: 0.7,
                },
                {
                    kind: "fact",
                    tier: "semantic",
                    text: "a clearly different second line",
                    tags: ["y"],
                    importance: 0.7,
                },
            ]);
            const store = new InMemoryStore();
            await persistSession({ store, llm: fakeLLM(json) }, { sessionId: "c10c", finalMessages: [user("q"), assistant("done")] });
            const all = await store.all();
            // 1st identical inserted; 2nd identical skipped (saw the 1st via the
            // mirrored snapshot); the distinct 3rd inserted → exactly 2 entries.
            expect(all).toHaveLength(2);
            expect(all.filter((e) => e.text === "one identical durable line")).toHaveLength(1);
            expect(all.some((e) => e.text === "a clearly different second line")).toBe(true);
        });
        test("outcome-equivalence: re-run is idempotent (deterministic-id skip) — final state byte-identical", async () => {
            const input = {
                sessionId: "c10d",
                finalMessages: [user("q"), assistant("stable persisted body line")],
            };
            const once = new InMemoryStore();
            await persistSession({ store: once }, input);
            const afterFirst = await normalized(once);
            await persistSession({ store: once }, input); // re-run: exact-text dupe → skip
            const afterSecond = await normalized(once);
            expect(afterSecond).toEqual(afterFirst); // no duplication, no drift
            expect(afterSecond).toHaveLength(1);
        });
        test("outcome-equivalence: merge/supersede outcomes unchanged vs pre-C10 expectations", async () => {
            // Mirrors the existing merge + supersede single-record tests; pins that
            // the snapshot mirroring did not perturb the consolidation outcome.
            const mStore = new InMemoryStore([
                {
                    id: "old",
                    kind: "fact",
                    text: "alpha beta gamma delta",
                    tags: [],
                    createdAt: TEST_NOW,
                },
            ]);
            await persistSession({
                store: mStore,
                llm: fakeLLM(JSON.stringify({
                    action: "merge",
                    intoId: "old",
                    text: "alpha beta gamma delta merged",
                    tags: ["db"],
                    importance: 0.8,
                })),
                distill: false,
                now: fixedNow,
            }, { sessionId: "c10e", finalMessages: [assistant("alpha beta gamma delta epsilon")] });
            const m = await mStore.all();
            expect(m).toHaveLength(1);
            expect(m[0]?.text).toBe("alpha beta gamma delta merged");
            expect(m[0]?.importance).toBeCloseTo(0.8, 5);
            const sStore = new InMemoryStore([
                {
                    id: "old",
                    kind: "fact",
                    text: "one two three four five",
                    tags: [],
                    createdAt: TEST_NOW,
                },
            ]);
            await persistSession({
                store: sStore,
                llm: fakeLLM(JSON.stringify({ action: "supersede", oldId: "old" })),
                distill: false,
                now: fixedNow,
            }, { sessionId: "c10f", finalMessages: [assistant("one two three four six")] });
            const s = await sStore.all();
            expect(s).toHaveLength(2);
            expect(s.find((e) => e.id === "old")?.supersededBy).toBeDefined();
        });
    });
    test("never throws when distill/store blow up", async () => {
        const boomStore = {
            save: () => Promise.reject(new Error("save boom")),
            update: () => Promise.reject(new Error("update boom")),
            delete: () => Promise.reject(new Error("delete boom")),
            get: () => Promise.reject(new Error("get boom")),
            all: () => Promise.reject(new Error("all boom")),
            recall: () => Promise.reject(new Error("recall boom")),
        };
        await expect(persistSession({ store: boomStore, llm: fakeLLM({ throw: true }) }, { sessionId: "s10", finalMessages: [assistant("text")] })).resolves.toBeUndefined();
    });
});
