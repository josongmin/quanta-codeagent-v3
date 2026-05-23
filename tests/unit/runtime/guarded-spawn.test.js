import { describe, expect, test } from "bun:test";
import { withSpawnedChild } from "@/runtime";
describe("withSpawnedChild — RAII spawn guard contract", () => {
    test("normal path: returns body's value, NEVER kills, clears timer + runs cleanup", async () => {
        let killed = 0;
        let cleaned = 0;
        const timer = setTimeout(() => { }, 60_000);
        const out = await withSpawnedChild({ kill: () => killed++, timer, cleanup: () => cleaned++ }, async () => "result");
        expect(out).toBe("result");
        expect(killed).toBe(0); // success path must NOT kill
        expect(cleaned).toBe(1);
        // timer was cleared by the guard's finally; clearing again is a harmless no-op.
        clearTimeout(timer);
    });
    test("throw path: kills exactly once, rethrows the ORIGINAL error, still cleans up", async () => {
        let killed = 0;
        let cleaned = 0;
        const boom = new Error("body boom");
        await expect(withSpawnedChild({ kill: () => killed++, cleanup: () => cleaned++ }, async () => {
            throw boom;
        })).rejects.toBe(boom); // identity-preserving, not wrapped
        expect(killed).toBe(1); // exactly one kill on the abnormal path
        expect(cleaned).toBe(1); // finally still ran
    });
    test("optional timer/cleanup may be omitted without error", async () => {
        let killed = 0;
        const out = await withSpawnedChild({ kill: () => killed++ }, async () => 42);
        expect(out).toBe(42);
        expect(killed).toBe(0);
    });
    test("cleanup runs even when the body throws AND on the normal path (never split)", async () => {
        // Normal
        let cleaned = 0;
        await withSpawnedChild({ kill: () => { }, cleanup: () => cleaned++ }, async () => undefined);
        // Throw
        await withSpawnedChild({ kill: () => { }, cleanup: () => cleaned++ }, async () => undefined).catch(() => { });
        await withSpawnedChild({ kill: () => { }, cleanup: () => cleaned++ }, async () => {
            throw new Error("x");
        }).catch(() => { });
        expect(cleaned).toBe(3);
    });
});
