/**
 * Maestro nickname pool tests (Cluster E / F17, ADR-0042).
 *
 * Invariants:
 *   - Exactly 39 unique ASCII names, ≤ 12 chars each.
 *   - `assignNickname` deterministic — same seed ⇒ same name across calls.
 *   - `nextSequentialNickname` exhausts cleanly to `null` (no reuse, no fallback).
 *   - No `Math.random()` anywhere in the source module.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assignNickname, MAESTRO_NICKNAMES, nextSequentialNickname, } from "../../src/subagent/nicknames";
describe("MAESTRO_NICKNAMES pool invariants", () => {
    test("exactly 39 entries", () => {
        expect(MAESTRO_NICKNAMES.length).toBe(39);
    });
    test("all entries unique", () => {
        expect(new Set(MAESTRO_NICKNAMES).size).toBe(39);
    });
    test("all entries ASCII letters, length 1..12", () => {
        for (const n of MAESTRO_NICKNAMES) {
            expect(n.length).toBeGreaterThanOrEqual(1);
            expect(n.length).toBeLessThanOrEqual(12);
            expect(/^[A-Za-z]+$/.test(n)).toBe(true);
        }
    });
});
describe("assignNickname determinism", () => {
    test("same string seed ⇒ same name across calls", () => {
        expect(assignNickname("agent-1")).toBe(assignNickname("agent-1"));
        expect(assignNickname("task_abc")).toBe(assignNickname("task_abc"));
    });
    test("same numeric seed ⇒ same name", () => {
        expect(assignNickname(42)).toBe(assignNickname(42));
    });
    test("string '42' and number 42 land at the same name (number → str)", () => {
        expect(assignNickname(42)).toBe(assignNickname("42"));
    });
    test("different seeds usually yield different names (coverage check)", () => {
        // Hash a handful of seeds; expect at least 5 distinct nicknames out of 10.
        const seeds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
        const got = new Set(seeds.map((s) => assignNickname(s)));
        expect(got.size).toBeGreaterThanOrEqual(5);
    });
    test("seed → name is in the pool", () => {
        const got = assignNickname("xyz");
        expect(MAESTRO_NICKNAMES).toContain(got);
    });
});
describe("nextSequentialNickname", () => {
    test("returns the first name when used set is empty", () => {
        expect(nextSequentialNickname(new Set())).toBe(MAESTRO_NICKNAMES[0] ?? "<none>");
    });
    test("skips already-used names", () => {
        const used = new Set([MAESTRO_NICKNAMES[0] ?? "", MAESTRO_NICKNAMES[1] ?? ""]);
        expect(nextSequentialNickname(used)).toBe(MAESTRO_NICKNAMES[2] ?? "<none>");
    });
    test("returns null when the entire pool is used", () => {
        const used = new Set(MAESTRO_NICKNAMES);
        expect(nextSequentialNickname(used)).toBeNull();
    });
    test("issues 39 distinct names without repeat, then null", () => {
        const used = new Set();
        for (let i = 0; i < 39; i++) {
            const n = nextSequentialNickname(used);
            expect(n).not.toBeNull();
            if (n !== null) {
                expect(used.has(n)).toBe(false);
                used.add(n);
            }
        }
        expect(nextSequentialNickname(used)).toBeNull();
    });
});
describe("no Math.random() in source", () => {
    test("source module has no occurrence of 'Math.random'", async () => {
        const src = await readFile(join(import.meta.dir, "..", "..", "src", "subagent", "nicknames.ts"), "utf8");
        expect(src.includes("Math.random")).toBe(false);
    });
});
