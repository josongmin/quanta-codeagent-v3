/**
 * Unit tests — {@link ConfirmDecision} adapter (ADR-0076 Gap-4 deny_and_steer).
 *
 * Asserts the BYTE-IDENTICAL legacy boolean mapping AND the structured-union
 * validation contract:
 *   - boolean true/false ↔ allow/deny (byte-identical for every existing caller);
 *   - structured allow/deny/deny_and_steer round-trip;
 *   - invalid shapes (null, primitives, unknown literals, empty steer) THROW
 *     ConfirmDecisionError — no silent coercion to deny;
 *   - `isAllowed` truth table;
 *   - `buildDenySteerMessage` extraction + invariant check.
 */
import { describe, expect, test } from "bun:test";
import { ALL_CONFIRM_DECISIONS, buildDenySteerMessage, ConfirmDecisionError, isAllowed, normalizeConfirm, } from "@/agent/confirm-decision";
describe("ConfirmDecision — ALL_CONFIRM_DECISIONS contract", () => {
    test("enumerates exactly the three decision literals", () => {
        const sorted = [...ALL_CONFIRM_DECISIONS].sort((a, b) => a.localeCompare(b));
        expect(sorted).toEqual(["allow", "deny", "deny_and_steer"]);
    });
});
describe("normalizeConfirm — boolean BYTE-IDENTICAL legacy mapping", () => {
    test("true → allow", () => {
        expect(normalizeConfirm(true)).toEqual({ decision: "allow" });
    });
    test("false → deny", () => {
        expect(normalizeConfirm(false)).toEqual({ decision: "deny" });
    });
});
describe("normalizeConfirm — structured ConfirmDecision round-trip", () => {
    test("{decision:'allow'} passes through", () => {
        expect(normalizeConfirm({ decision: "allow" })).toEqual({ decision: "allow" });
    });
    test("{decision:'deny'} passes through", () => {
        expect(normalizeConfirm({ decision: "deny" })).toEqual({ decision: "deny" });
    });
    test("{decision:'deny_and_steer', steer:'do X'} passes through verbatim", () => {
        const d = { decision: "deny_and_steer", steer: "try a smaller scope first" };
        expect(normalizeConfirm(d)).toEqual(d);
    });
    test("deny_and_steer preserves unicode + whitespace inside the steer", () => {
        const steer = "  use Glob 대신 ripgrep으로  ";
        const out = normalizeConfirm({ decision: "deny_and_steer", steer });
        expect(out).toEqual({ decision: "deny_and_steer", steer });
    });
});
describe("normalizeConfirm — invalid shapes THROW (no silent coercion)", () => {
    test("null throws ConfirmDecisionError", () => {
        expect(() => normalizeConfirm(null)).toThrow(ConfirmDecisionError);
    });
    test("undefined throws ConfirmDecisionError", () => {
        expect(() => normalizeConfirm(undefined)).toThrow(ConfirmDecisionError);
    });
    test("number throws ConfirmDecisionError", () => {
        expect(() => normalizeConfirm(1)).toThrow(ConfirmDecisionError);
    });
    test("string throws ConfirmDecisionError", () => {
        expect(() => normalizeConfirm("allow")).toThrow(ConfirmDecisionError);
    });
    test("object without decision throws", () => {
        expect(() => normalizeConfirm({})).toThrow(ConfirmDecisionError);
    });
    test("unknown decision literal throws", () => {
        expect(() => normalizeConfirm({ decision: "approve" })).toThrow(ConfirmDecisionError);
    });
    test("deny_and_steer with missing steer throws", () => {
        expect(() => normalizeConfirm({ decision: "deny_and_steer" })).toThrow(ConfirmDecisionError);
    });
    test("deny_and_steer with empty steer throws", () => {
        expect(() => normalizeConfirm({ decision: "deny_and_steer", steer: "" })).toThrow(ConfirmDecisionError);
    });
    test("deny_and_steer with whitespace-only steer throws", () => {
        expect(() => normalizeConfirm({ decision: "deny_and_steer", steer: "   \n\t" })).toThrow(ConfirmDecisionError);
    });
    test("deny_and_steer with non-string steer throws", () => {
        expect(() => normalizeConfirm({ decision: "deny_and_steer", steer: 42 })).toThrow(ConfirmDecisionError);
    });
    test("error carries the offending field name", () => {
        try {
            normalizeConfirm({ decision: "deny_and_steer", steer: "" });
            throw new Error("did not throw");
        }
        catch (e) {
            expect(e).toBeInstanceOf(ConfirmDecisionError);
            expect(e.field).toBe("steer");
            expect(e.name).toBe("ConfirmDecisionError");
        }
    });
    test("unknown literal error carries the `decision` field", () => {
        try {
            normalizeConfirm({ decision: "approve" });
            throw new Error("did not throw");
        }
        catch (e) {
            expect(e).toBeInstanceOf(ConfirmDecisionError);
            expect(e.field).toBe("decision");
        }
    });
});
describe("isAllowed — truth table over the closed union", () => {
    test("allow → true", () => {
        expect(isAllowed({ decision: "allow" })).toBe(true);
    });
    test("deny → false", () => {
        expect(isAllowed({ decision: "deny" })).toBe(false);
    });
    test("deny_and_steer → false (still a refusal)", () => {
        expect(isAllowed({ decision: "deny_and_steer", steer: "x" })).toBe(false);
    });
});
describe("buildDenySteerMessage — extraction + invariant", () => {
    test("allow → null", () => {
        expect(buildDenySteerMessage({ decision: "allow" })).toBeNull();
    });
    test("deny → null", () => {
        expect(buildDenySteerMessage({ decision: "deny" })).toBeNull();
    });
    test("deny_and_steer → carries the steer text verbatim", () => {
        expect(buildDenySteerMessage({ decision: "deny_and_steer", steer: "try Glob instead" })).toBe("try Glob instead");
    });
    test("deny_and_steer with empty steer throws (defense in depth)", () => {
        expect(() => buildDenySteerMessage({ decision: "deny_and_steer", steer: "" })).toThrow(ConfirmDecisionError);
    });
    test("deny_and_steer with whitespace-only steer throws (defense in depth)", () => {
        expect(() => buildDenySteerMessage({ decision: "deny_and_steer", steer: "   " })).toThrow(ConfirmDecisionError);
    });
});
