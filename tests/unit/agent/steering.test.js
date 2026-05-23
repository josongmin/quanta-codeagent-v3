/**
 * Mid-turn steering decision tests (ADR-0030).
 *
 * Covers (all eight rejection reasons + happy path + invariant errors):
 *   - accepted happy path with a fresh SteerInjection
 *   - interrupted               → "interrupted"
 *   - no active turn            → "no_active_turn"
 *   - turn id mismatch          → "expected_turn_mismatch"
 *   - non-steerable kinds (3×)  → matching non_steerable_* reasons
 *   - empty / whitespace input  → "empty_input"
 *   - oversized input           → "input_too_large"
 *   - decision order (first violation wins)
 *   - SteerInputInvalidError on programming-level violations
 *   - utf8ByteLength deterministic over multibyte chars
 *
 * The module under test is pure — no Date.now() inside. Tests supply a
 * fixed clock so the assertions read as a contract document.
 */
import { describe, expect, test } from "bun:test";
import { ALL_REJECTION_REASONS, SteerInputInvalidError, steer, utf8ByteLength, } from "@/agent/steering";
import { makeTurnHeader } from "@/agent/turn-kind";
const FIXED_CLOCK = 1_700_000_000_000;
const DEFAULT_TURN_ID = "turn-001";
const DEFAULT_THREAD_ID = "thread-A";
const header = (overrides = {}) => makeTurnHeader({
    turnId: DEFAULT_TURN_ID,
    kind: "main",
    startedAt: FIXED_CLOCK,
    threadId: DEFAULT_THREAD_ID,
    ...overrides,
});
const state = (overrides = {}) => ({
    currentTurn: header(),
    isInterrupted: false,
    ...overrides,
});
const req = (overrides = {}) => ({
    expectedTurnId: DEFAULT_TURN_ID,
    input: "please also check the lockfile",
    submittedAt: FIXED_CLOCK + 100,
    ...overrides,
});
const cfg = (overrides = {}) => ({
    maxInputBytes: 4096,
    ...overrides,
});
describe("steering — happy path", () => {
    test("accepted produces a SteerInjection with the active turn id", () => {
        const out = steer(req(), state(), cfg());
        expect(out.kind).toBe("accepted");
        if (out.kind !== "accepted")
            return;
        expect(out.injection.role).toBe("user");
        expect(out.injection.content).toBe("please also check the lockfile");
        expect(out.injection.injectedAt).toBe(FIXED_CLOCK + 100);
        expect(out.injection.injectedDuringTurnId).toBe(DEFAULT_TURN_ID);
    });
    test("accepted preserves multiline / unicode content verbatim", () => {
        const text = "한글 입력\n두 줄";
        const out = steer(req({ input: text }), state(), cfg());
        expect(out.kind).toBe("accepted");
        if (out.kind === "accepted") {
            expect(out.injection.content).toBe(text);
        }
    });
});
describe("steering — rejection: interrupted (highest precedence)", () => {
    test("interrupted state rejects with reason='interrupted'", () => {
        const out = steer(req(), state({ isInterrupted: true }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected") {
            expect(out.reason).toBe("interrupted");
            expect(out.rejectedAt).toBe(FIXED_CLOCK + 100);
        }
    });
    test("interrupted wins over no_active_turn (decision order)", () => {
        const out = steer(req(), state({ currentTurn: null, isInterrupted: true }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("interrupted");
    });
});
describe("steering — rejection: no_active_turn", () => {
    test("null currentTurn rejects with reason='no_active_turn'", () => {
        const out = steer(req(), state({ currentTurn: null }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("no_active_turn");
    });
});
describe("steering — rejection: expected_turn_mismatch", () => {
    test("expectedTurnId not equal to active turn id rejects", () => {
        const out = steer(req({ expectedTurnId: "turn-999" }), state({ currentTurn: header({ turnId: "turn-001" }) }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("expected_turn_mismatch");
    });
    test("mismatch wins over non_steerable (decision order: id checked first)", () => {
        // Different turnId AND non-steerable kind. Per documented order in
        // steer(), the id mismatch is checked BEFORE the kind gate, so the
        // expected_turn_mismatch reason wins. Locks the contract.
        const out = steer(req({ expectedTurnId: "turn-999" }), state({ currentTurn: header({ turnId: "turn-001", kind: "review" }) }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("expected_turn_mismatch");
    });
});
describe("steering — rejection: non-steerable turn kinds", () => {
    test("review kind rejects with reason='non_steerable_review'", () => {
        const out = steer(req(), state({ currentTurn: header({ kind: "review" }) }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("non_steerable_review");
    });
    test("compact kind rejects with reason='non_steerable_compact'", () => {
        const out = steer(req(), state({ currentTurn: header({ kind: "compact" }) }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("non_steerable_compact");
    });
    test("standalone kind rejects with reason='non_steerable_standalone'", () => {
        const out = steer(req(), state({ currentTurn: header({ kind: "standalone" }) }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("non_steerable_standalone");
    });
    test("non-steerable rejection wins over empty/oversized input (kind checked first)", () => {
        const out = steer(req({ input: "" }), state({ currentTurn: header({ kind: "review" }) }), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("non_steerable_review");
    });
});
describe("steering — rejection: empty input", () => {
    test("empty string rejects with reason='empty_input'", () => {
        const out = steer(req({ input: "" }), state(), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("empty_input");
    });
    test("whitespace-only input rejects with reason='empty_input'", () => {
        const out = steer(req({ input: "   \n\t  " }), state(), cfg());
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("empty_input");
    });
});
describe("steering — rejection: input_too_large", () => {
    test("input exceeding maxInputBytes rejects with reason='input_too_large'", () => {
        const big = "a".repeat(10);
        const out = steer(req({ input: big }), state(), cfg({ maxInputBytes: 5 }));
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("input_too_large");
    });
    test("input exactly at maxInputBytes is accepted (boundary)", () => {
        const exact = "a".repeat(8);
        const out = steer(req({ input: exact }), state(), cfg({ maxInputBytes: 8 }));
        expect(out.kind).toBe("accepted");
    });
    test("oversize measured in UTF-8 bytes, not JS chars (multibyte input)", () => {
        // "한" is 3 bytes in UTF-8. 4 chars × 3 bytes = 12 bytes.
        const multibyte = "한".repeat(4);
        expect(utf8ByteLength(multibyte)).toBe(12);
        const out = steer(req({ input: multibyte }), state(), cfg({ maxInputBytes: 11 }));
        expect(out.kind).toBe("rejected");
        if (out.kind === "rejected")
            expect(out.reason).toBe("input_too_large");
    });
});
describe("steering — SteerInputInvalidError (programming bugs)", () => {
    test("non-string input throws SteerInputInvalidError", () => {
        expect(() => steer(
        // Forced cast simulates a surface that handed us a non-string.
        req({ input: 123 }), state(), cfg())).toThrow(SteerInputInvalidError);
    });
    test("NaN submittedAt throws SteerInputInvalidError", () => {
        expect(() => steer(req({ submittedAt: Number.NaN }), state(), cfg())).toThrow(SteerInputInvalidError);
    });
    test("negative submittedAt throws SteerInputInvalidError", () => {
        expect(() => steer(req({ submittedAt: -1 }), state(), cfg())).toThrow(SteerInputInvalidError);
    });
    test("empty expectedTurnId throws SteerInputInvalidError", () => {
        expect(() => steer(req({ expectedTurnId: "" }), state(), cfg())).toThrow(SteerInputInvalidError);
    });
    test("non-positive maxInputBytes throws SteerInputInvalidError", () => {
        expect(() => steer(req(), state(), cfg({ maxInputBytes: 0 }))).toThrow(SteerInputInvalidError);
    });
    test("non-integer maxInputBytes throws SteerInputInvalidError", () => {
        expect(() => steer(req(), state(), cfg({ maxInputBytes: 1.5 }))).toThrow(SteerInputInvalidError);
    });
    test("SteerInputInvalidError exposes the offending field", () => {
        try {
            steer(req({ submittedAt: -1 }), state(), cfg());
            throw new Error("expected throw");
        }
        catch (e) {
            expect(e).toBeInstanceOf(SteerInputInvalidError);
            expect(e.field).toBe("submittedAt");
        }
    });
});
describe("steering — utf8ByteLength", () => {
    test("ASCII string returns its char length", () => {
        expect(utf8ByteLength("hello")).toBe(5);
    });
    test("empty string returns 0", () => {
        expect(utf8ByteLength("")).toBe(0);
    });
    test("multibyte (Korean) characters count as 3 bytes each", () => {
        expect(utf8ByteLength("한")).toBe(3);
        expect(utf8ByteLength("한국어")).toBe(9);
    });
    test("emoji (4-byte UTF-8) counts as 4 bytes", () => {
        // Test name says "emoji" but we use a string we know is 4 UTF-8 bytes
        // (a surrogate-pair codepoint), avoiding emoji literals in source per
        // project style.
        const fourByte = String.fromCodePoint(0x1f600);
        expect(utf8ByteLength(fourByte)).toBe(4);
    });
    test("non-string input throws SteerInputInvalidError", () => {
        expect(() => utf8ByteLength(123)).toThrow(SteerInputInvalidError);
    });
});
describe("steering — closed enum coverage", () => {
    test("ALL_REJECTION_REASONS lists exactly the eight closed reasons", () => {
        expect(ALL_REJECTION_REASONS).toEqual([
            "no_active_turn",
            "expected_turn_mismatch",
            "non_steerable_review",
            "non_steerable_compact",
            "non_steerable_standalone",
            "empty_input",
            "input_too_large",
            "interrupted",
        ]);
        expect(ALL_REJECTION_REASONS.length).toBe(8);
    });
});
