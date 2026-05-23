import { describe, expect, test } from "bun:test";
import { TaskRegistry } from "../../src/subagent";
/**
 * Round 2 — `TaskRegistry.maxRetained` LRU eviction.
 *
 * Settled records (completed/failed/stopped) are capped at `maxRetained` (256
 * default). Running tasks are NEVER evicted regardless of count. Oldest-by-
 * `endedAt` settled records are dropped first.
 */
const okResult = (over = {}) => ({
    ok: true,
    finalText: "done",
    turns: 1,
    ...over,
});
/** Yield to the event loop so `Date.now()` advances at least 1ms — important
 *  because eviction sorts by `endedAt` and same-millisecond settles are
 *  ordering-ambiguous. 2ms is the safety margin used elsewhere in the suite. */
const tick = async () => {
    await new Promise((r) => setTimeout(r, 2));
};
/** Register + complete `id` with a short tick in between, so its `endedAt` is
 *  strictly later than any previously-completed task. Returns the id. */
const registerAndComplete = async (reg, id) => {
    reg.register({ id, description: id });
    await tick();
    reg.complete(id, okResult({ finalText: id }));
    return id;
};
describe("TaskRegistry — LRU eviction (maxRetained)", () => {
    test("settled count over cap ⇒ oldest are evicted, newest 3 remain", async () => {
        const reg = new TaskRegistry({ maxRetained: 3 });
        const ids = [];
        for (let i = 0; i < 5; i++) {
            ids.push(await registerAndComplete(reg, `t${i}`));
        }
        // Oldest 2 evicted, newest 3 retained.
        expect(reg.get("t0")).toBeUndefined();
        expect(reg.get("t1")).toBeUndefined();
        expect(reg.get("t2")?.status).toBe("completed");
        expect(reg.get("t3")?.status).toBe("completed");
        expect(reg.get("t4")?.status).toBe("completed");
        // `list()` reflects the same.
        expect(reg.list()).toHaveLength(3);
    });
    test("running tasks are NEVER evicted regardless of count", async () => {
        const reg = new TaskRegistry({ maxRetained: 2 });
        // Register 5, complete none — they all stay (running tasks are immune).
        for (let i = 0; i < 5; i++)
            reg.register({ id: `r${i}`, description: `r${i}` });
        expect(reg.list()).toHaveLength(5);
        expect(reg.pendingIds().sort()).toEqual(["r0", "r1", "r2", "r3", "r4"]);
        // Now settle 3 of the 5 running ones — those 3 enter the settled pool. Cap
        // is 2, so the oldest-settled is evicted; the 2 remaining running ones are
        // never touched.
        for (const id of ["r0", "r1", "r2"]) {
            await tick();
            reg.complete(id, okResult());
        }
        // r0 (oldest settled) evicted; r1, r2 retained; r3, r4 still running.
        expect(reg.get("r0")).toBeUndefined();
        expect(reg.get("r1")?.status).toBe("completed");
        expect(reg.get("r2")?.status).toBe("completed");
        expect(reg.get("r3")?.status).toBe("running");
        expect(reg.get("r4")?.status).toBe("running");
        // Settled count is now 2 (== cap); running tasks live alongside.
        expect(reg.list()).toHaveLength(4);
    });
    test("mixed: settle some + leave some running, then exceed cap ⇒ only settled evicted", async () => {
        const reg = new TaskRegistry({ maxRetained: 2 });
        // Two running anchors that must survive everything.
        reg.register({ id: "anchor-A", description: "A" });
        reg.register({ id: "anchor-B", description: "B" });
        // Settle 4 tasks — only the newest 2 settled survive; anchors untouched.
        for (let i = 0; i < 4; i++)
            await registerAndComplete(reg, `s${i}`);
        expect(reg.get("anchor-A")?.status).toBe("running");
        expect(reg.get("anchor-B")?.status).toBe("running");
        expect(reg.get("s0")).toBeUndefined();
        expect(reg.get("s1")).toBeUndefined();
        expect(reg.get("s2")?.status).toBe("completed");
        expect(reg.get("s3")?.status).toBe("completed");
    });
    test("eviction order is endedAt ascending (oldest settled first)", async () => {
        const reg = new TaskRegistry({ maxRetained: 2 });
        // Settle in known order — assert strict endedAt ordering BEFORE the third
        // settle triggers eviction.
        await registerAndComplete(reg, "first");
        await registerAndComplete(reg, "second");
        const firstEnded = reg.get("first")?.endedAt;
        const secondEnded = reg.get("second")?.endedAt;
        expect(firstEnded).toBeDefined();
        expect(secondEnded).toBeDefined();
        if (firstEnded === undefined || secondEnded === undefined)
            throw new Error("unreachable");
        expect(firstEnded < secondEnded).toBe(true);
        // Third settle overflows the cap by 1 ⇒ "first" (oldest endedAt) evicted.
        await registerAndComplete(reg, "third");
        expect(reg.get("first")).toBeUndefined();
        expect(reg.get("second")?.status).toBe("completed");
        expect(reg.get("third")?.status).toBe("completed");
    });
    test("stop() triggers eviction (oldest settled dropped when overflow)", async () => {
        const reg = new TaskRegistry({ maxRetained: 2 });
        await registerAndComplete(reg, "completed-1");
        await registerAndComplete(reg, "completed-2");
        // A third settled record via stop() — overflows the cap.
        reg.register({ id: "running-then-stopped", description: "x" });
        await tick();
        expect(reg.forceStop("running-then-stopped")).toBe(true);
        expect(reg.get("completed-1")).toBeUndefined();
        expect(reg.get("completed-2")?.status).toBe("completed");
        expect(reg.get("running-then-stopped")?.status).toBe("stopped");
    });
    test("fail() triggers eviction (oldest settled dropped when overflow)", async () => {
        const reg = new TaskRegistry({ maxRetained: 2 });
        await registerAndComplete(reg, "ok-1");
        await registerAndComplete(reg, "ok-2");
        reg.register({ id: "fails", description: "y" });
        await tick();
        reg.fail("fails", "kaboom");
        expect(reg.get("ok-1")).toBeUndefined();
        expect(reg.get("ok-2")?.status).toBe("completed");
        expect(reg.get("fails")?.status).toBe("failed");
        expect(reg.get("fails")?.error).toBe("kaboom");
    });
    test("at-the-cap (no overflow) ⇒ no eviction occurs (O(1) common path)", async () => {
        const reg = new TaskRegistry({ maxRetained: 3 });
        await registerAndComplete(reg, "a");
        await registerAndComplete(reg, "b");
        await registerAndComplete(reg, "c");
        expect(reg.list()).toHaveLength(3);
        expect(reg.get("a")?.status).toBe("completed");
        expect(reg.get("b")?.status).toBe("completed");
        expect(reg.get("c")?.status).toBe("completed");
    });
});
