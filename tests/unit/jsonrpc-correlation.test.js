import { describe, expect, test } from "bun:test";
import { brandRequestId, createRequestIdGenerator, nextRequestId } from "@/shared/jsonrpc";
describe("createRequestIdGenerator", () => {
    test("starts at seed and increments by 1 each call", () => {
        const g = createRequestIdGenerator(1);
        expect(g.next()).toBe(1);
        expect(g.next()).toBe(2);
        expect(g.next()).toBe(3);
    });
    test("seedable from arbitrary integer", () => {
        const g = createRequestIdGenerator(100);
        expect(g.next()).toBe(100);
        expect(g.next()).toBe(101);
    });
    test("peek does not advance the counter", () => {
        const g = createRequestIdGenerator(5);
        expect(g.peek()).toBe(5);
        expect(g.peek()).toBe(5);
        expect(g.next()).toBe(5);
        expect(g.peek()).toBe(6);
    });
    test("rejects non-integer seed", () => {
        expect(() => createRequestIdGenerator(1.5)).toThrow(TypeError);
    });
    test("rejects negative seed", () => {
        expect(() => createRequestIdGenerator(-1)).toThrow(RangeError);
    });
    test("rejects seed beyond MAX_SAFE_INTEGER", () => {
        expect(() => createRequestIdGenerator(Number.MAX_SAFE_INTEGER + 10)).toThrow(RangeError);
    });
    test("generates 10_000 ids without collisions", () => {
        const g = createRequestIdGenerator(1);
        const seen = new Set();
        for (let i = 0; i < 10_000; i++) {
            const id = g.next();
            expect(seen.has(id)).toBe(false);
            seen.add(id);
        }
        expect(seen.size).toBe(10_000);
    });
    test("monotonically strictly increasing", () => {
        const g = createRequestIdGenerator(1);
        let prev = -Infinity;
        for (let i = 0; i < 1000; i++) {
            const v = g.next();
            expect(v).toBeGreaterThan(prev);
            prev = v;
        }
    });
    test("throws on exhaustion at MAX_SAFE_INTEGER", () => {
        const g = createRequestIdGenerator(Number.MAX_SAFE_INTEGER);
        expect(g.next()).toBe(Number.MAX_SAFE_INTEGER);
        expect(() => g.next()).toThrow(RangeError);
    });
    test("two independent generators have independent counters", () => {
        const a = createRequestIdGenerator(1);
        const b = createRequestIdGenerator(1);
        expect(a.next()).toBe(1);
        expect(a.next()).toBe(2);
        expect(b.next()).toBe(1);
    });
});
describe("nextRequestId (process-wide default)", () => {
    test("returns monotonically increasing values", () => {
        const a = nextRequestId();
        const b = nextRequestId();
        expect(b).toBeGreaterThan(a);
    });
});
describe("brandRequestId", () => {
    test("brands without bumping any counter", () => {
        const g = createRequestIdGenerator(1);
        const branded = brandRequestId(999);
        expect(branded).toBe(999);
        expect(g.peek()).toBe(1);
    });
});
