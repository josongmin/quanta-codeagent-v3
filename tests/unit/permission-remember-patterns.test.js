import { describe, expect, test } from "bun:test";
import { autoResolvable, grantPatterns, PatternGrantStore } from "@/permission";
const mk = (toolCallId, rememberPatterns, opts) => ({
    toolCallId,
    rememberPatterns,
    suggestedPermissions: opts?.suggested ?? [],
    isMaybeDangerous: opts?.dangerous ?? false,
});
describe("grantPatterns", () => {
    test("returns a new set covering the union, leaving inputs untouched", () => {
        const base = new Set(["a"]);
        const out = grantPatterns(base, ["b", "c"]);
        expect([...out].sort()).toEqual(["a", "b", "c"]);
        // purity: original set unchanged
        expect([...base]).toEqual(["a"]);
    });
    test("union with empty patterns is a copy of the input", () => {
        const base = new Set(["x"]);
        const out = grantPatterns(base, []);
        expect(out).not.toBe(base);
        expect([...out]).toEqual(["x"]);
    });
    test("dedupes already-present patterns", () => {
        const out = grantPatterns(new Set(["a"]), ["a", "a", "b"]);
        expect([...out].sort()).toEqual(["a", "b"]);
    });
});
describe("autoResolvable — cascade", () => {
    test("auto-resolves pending requests whose patterns are all now covered", () => {
        const pending = [mk("t1", ["p1"]), mk("t2", ["p1", "p2"]), mk("t3", ["p3"])];
        const allowed = new Set(["p1", "p2"]);
        const out = autoResolvable({
            allowedPatterns: allowed,
            pending,
            excludeToolCallId: "t-granted",
            alreadyResolved: new Set(),
        });
        expect(out.map((t) => t.toolCallId).sort()).toEqual(["t1", "t2"]);
    });
    test("excludes the just-granted request itself", () => {
        const pending = [mk("t1", ["p1"]), mk("t2", ["p1"])];
        const out = autoResolvable({
            allowedPatterns: new Set(["p1"]),
            pending,
            excludeToolCallId: "t1",
            alreadyResolved: new Set(),
        });
        expect(out.map((t) => t.toolCallId)).toEqual(["t2"]);
    });
    test("skips already-resolved requests", () => {
        const pending = [mk("t1", ["p1"]), mk("t2", ["p1"])];
        const out = autoResolvable({
            allowedPatterns: new Set(["p1"]),
            pending,
            alreadyResolved: new Set(["t1"]),
        });
        expect(out.map((t) => t.toolCallId)).toEqual(["t2"]);
    });
});
describe("autoResolvable — zero-pattern guard", () => {
    test("a request with zero rememberPatterns is NEVER auto-passed", () => {
        const pending = [mk("t1", []), mk("t2", ["p1"])];
        const out = autoResolvable({
            allowedPatterns: new Set(["p1"]),
            pending,
            alreadyResolved: new Set(),
        });
        expect(out.map((t) => t.toolCallId)).toEqual(["t2"]);
    });
});
describe("autoResolvable — isMaybeDangerous gate", () => {
    test("dangerous request not auto-resolved even when patterns are covered", () => {
        const pending = [mk("t1", ["p1"], { dangerous: true })];
        const out = autoResolvable({
            allowedPatterns: new Set(["p1"]),
            pending,
            alreadyResolved: new Set(),
        });
        expect(out).toEqual([]);
    });
    test("dangerous request auto-resolves only with explicit allowDangerous", () => {
        const pending = [mk("t1", ["p1"], { dangerous: true })];
        const out = autoResolvable({
            allowedPatterns: new Set(["p1"]),
            pending,
            alreadyResolved: new Set(),
            allowDangerous: true,
        });
        expect(out.map((t) => t.toolCallId)).toEqual(["t1"]);
    });
    test("partial coverage never resolves regardless of allowDangerous", () => {
        const pending = [mk("t1", ["p1", "p2"])];
        const out = autoResolvable({
            allowedPatterns: new Set(["p1"]),
            pending,
            alreadyResolved: new Set(),
            allowDangerous: true,
        });
        expect(out).toEqual([]);
    });
});
describe("PatternGrantStore", () => {
    test("grant accumulates patterns and isCovered reflects them", () => {
        const store = new PatternGrantStore(["seed"]);
        expect(store.isCovered(["seed"])).toBe(true);
        expect(store.isCovered(["nope"])).toBe(false);
        store.grant(["p1", "p2"]);
        expect(store.isCovered(["p1", "p2"])).toBe(true);
        expect(store.isCovered(["p1", "missing"])).toBe(false);
    });
    test("granted() returns a defensive copy", () => {
        const store = new PatternGrantStore(["a"]);
        const snap = store.granted();
        snap.add("mutated");
        expect(store.isCovered(["mutated"])).toBe(false);
    });
    test("cascade returns ids newly covered after a grant", () => {
        const store = new PatternGrantStore();
        const pending = [mk("t1", ["p1"]), mk("t2", ["p1", "p2"]), mk("t3", ["p9"])];
        store.grant(["p1", "p2"]);
        const ids = store.cascade(pending, "t-granted");
        expect(ids.sort()).toEqual(["t1", "t2"]);
    });
    test("cascade honors alreadyResolved and dangerous gate", () => {
        const store = new PatternGrantStore(["p1"]);
        const pending = [mk("t1", ["p1"]), mk("t2", ["p1"], { dangerous: true }), mk("t3", ["p1"])];
        const ids = store.cascade(pending, "t3", { alreadyResolved: new Set(["t1"]) });
        // t1 already resolved, t3 excluded, t2 dangerous → none
        expect(ids).toEqual([]);
        const idsDanger = store.cascade(pending, "t3", {
            alreadyResolved: new Set(["t1"]),
            allowDangerous: true,
        });
        expect(idsDanger).toEqual(["t2"]);
    });
});
