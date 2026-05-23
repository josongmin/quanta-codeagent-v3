/**
 * Turn-kind enum + invariants tests (ADR-0030).
 *
 * Covers:
 *   - Truth table for `isSteerable` over all four kinds.
 *   - `NON_STEERABLE_KINDS` set membership.
 *   - `makeTurnHeader` happy path + every invariant violation it enforces.
 *
 * No mocks, no Date.now() — clocks are passed in. The module under test is
 * pure; the test reads as a contract document.
 */
import { describe, expect, test } from "bun:test";
import { ALL_TURN_KINDS, isSteerable, makeTurnHeader, NON_STEERABLE_KINDS, TurnHeaderInvalidError, } from "@/agent/turn-kind";
const FIXED_CLOCK = 1_700_000_000_000;
const ok = (overrides = {}) => makeTurnHeader({
    turnId: "t-1",
    kind: "main",
    startedAt: FIXED_CLOCK,
    threadId: "thread-A",
    ...overrides,
});
describe("turn-kind — isSteerable truth table (4 kinds)", () => {
    test("main is steerable", () => {
        expect(isSteerable("main")).toBe(true);
    });
    test("review is NOT steerable", () => {
        expect(isSteerable("review")).toBe(false);
    });
    test("compact is NOT steerable", () => {
        expect(isSteerable("compact")).toBe(false);
    });
    test("standalone is NOT steerable", () => {
        expect(isSteerable("standalone")).toBe(false);
    });
    test("NON_STEERABLE_KINDS contains exactly review/compact/standalone", () => {
        expect(NON_STEERABLE_KINDS.size).toBe(3);
        expect(NON_STEERABLE_KINDS.has("review")).toBe(true);
        expect(NON_STEERABLE_KINDS.has("compact")).toBe(true);
        expect(NON_STEERABLE_KINDS.has("standalone")).toBe(true);
        expect(NON_STEERABLE_KINDS.has("main")).toBe(false);
    });
    test("ALL_TURN_KINDS enumerates exactly the four enum literals", () => {
        expect(ALL_TURN_KINDS).toEqual(["main", "review", "compact", "standalone"]);
    });
    test("every kind in ALL_TURN_KINDS has a defined steerability decision", () => {
        for (const k of ALL_TURN_KINDS) {
            expect(typeof isSteerable(k)).toBe("boolean");
        }
    });
});
describe("turn-kind — makeTurnHeader happy paths", () => {
    test("constructs a frozen-shape header with all fields preserved", () => {
        const h = makeTurnHeader({
            turnId: "01HXYZ",
            kind: "review",
            startedAt: FIXED_CLOCK,
            threadId: "thread-Q",
        });
        expect(h.turnId).toBe("01HXYZ");
        expect(h.kind).toBe("review");
        expect(h.startedAt).toBe(FIXED_CLOCK);
        expect(h.threadId).toBe("thread-Q");
    });
    test("startedAt=0 is accepted (epoch is valid for replay fixtures)", () => {
        const h = ok({ startedAt: 0 });
        expect(h.startedAt).toBe(0);
    });
    test("each TurnKind literal constructs successfully", () => {
        for (const kind of ALL_TURN_KINDS) {
            const h = ok({ kind });
            expect(h.kind).toBe(kind);
        }
    });
});
describe("turn-kind — makeTurnHeader invariant violations", () => {
    test("empty turnId → TurnHeaderInvalidError", () => {
        expect(() => ok({ turnId: "" })).toThrow(TurnHeaderInvalidError);
    });
    test("whitespace-padded turnId → TurnHeaderInvalidError", () => {
        expect(() => ok({ turnId: " t-1 " })).toThrow(TurnHeaderInvalidError);
    });
    test("invalid kind literal → TurnHeaderInvalidError", () => {
        // Forced cast simulates a runtime value escaping the TS type system
        // (e.g. an old persisted record). The constructor must reject it.
        expect(() => ok({ kind: "made-up" })).toThrow(TurnHeaderInvalidError);
    });
    test("negative startedAt → TurnHeaderInvalidError", () => {
        expect(() => ok({ startedAt: -1 })).toThrow(TurnHeaderInvalidError);
    });
    test("non-integer startedAt → TurnHeaderInvalidError", () => {
        expect(() => ok({ startedAt: 1.5 })).toThrow(TurnHeaderInvalidError);
    });
    test("NaN startedAt → TurnHeaderInvalidError", () => {
        expect(() => ok({ startedAt: Number.NaN })).toThrow(TurnHeaderInvalidError);
    });
    test("Infinity startedAt → TurnHeaderInvalidError", () => {
        expect(() => ok({ startedAt: Number.POSITIVE_INFINITY })).toThrow(TurnHeaderInvalidError);
    });
    test("empty threadId → TurnHeaderInvalidError", () => {
        expect(() => ok({ threadId: "" })).toThrow(TurnHeaderInvalidError);
    });
    test("error exposes the offending field", () => {
        try {
            ok({ turnId: "" });
            throw new Error("expected throw");
        }
        catch (e) {
            expect(e).toBeInstanceOf(TurnHeaderInvalidError);
            expect(e.field).toBe("turnId");
        }
    });
    test("error name is stable for log triage", () => {
        try {
            ok({ startedAt: -1 });
            throw new Error("expected throw");
        }
        catch (e) {
            expect(e.name).toBe("TurnHeaderInvalidError");
            expect(e.field).toBe("startedAt");
        }
    });
});
