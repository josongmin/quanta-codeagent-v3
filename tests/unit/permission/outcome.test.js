/**
 * Outcome state-machine + invariant matrix coverage (ADR-0029).
 *
 * Covers:
 *   - isTerminal / isAllowed / requiresUserConfirmation truth tables for
 *     all 8 outcome literals (full enum coverage, exhaustiveness-asserted).
 *   - buildDecision invariant matrix (3 reviewer × 8 outcome = 24 cells).
 *   - rationale / decidedAt input validation.
 *
 * No mocks, no fixtures — outcome.ts is pure.
 */
import { describe, expect, test } from "bun:test";
import { ALL_OUTCOMES, ALL_REVIEWERS, buildDecision, isAdmissible, isAllowed, isTerminal, OutcomeInvariantError, requiresUserConfirmation, } from "@/permission";
const validClock = 1_700_000_000_000;
const rationale = "unit-test";
describe("outcome — enum completeness", () => {
    test("ALL_OUTCOMES enumerates exactly 8 literals", () => {
        expect(ALL_OUTCOMES.length).toBe(8);
        expect(new Set(ALL_OUTCOMES).size).toBe(8);
    });
    test("ALL_REVIEWERS enumerates exactly 3 literals", () => {
        expect(ALL_REVIEWERS.length).toBe(3);
        expect(new Set(ALL_REVIEWERS).size).toBe(3);
    });
});
describe("outcome — isTerminal truth table", () => {
    test.each(ALL_OUTCOMES.map((o) => [o]))("isTerminal(%s) === true", (outcome) => {
        expect(isTerminal(outcome)).toBe(true);
    });
});
describe("outcome — isAllowed truth table", () => {
    const allowed = [
        "not_needed",
        "config_allowed",
        "guardian_approved",
        "user_approved",
        "user_approved_for_session",
    ];
    const denied = ["guardian_denied", "user_denied", "user_aborted"];
    test.each(allowed.map((o) => [o]))("isAllowed(%s) === true", (outcome) => {
        expect(isAllowed(outcome)).toBe(true);
    });
    test.each(denied.map((o) => [o]))("isAllowed(%s) === false", (outcome) => {
        expect(isAllowed(outcome)).toBe(false);
    });
    test("allowed ∪ denied covers every outcome (partition)", () => {
        expect(new Set([...allowed, ...denied]).size).toBe(ALL_OUTCOMES.length);
    });
});
describe("outcome — requiresUserConfirmation truth table", () => {
    const userOutcomes = [
        "user_approved",
        "user_approved_for_session",
        "user_denied",
        "user_aborted",
    ];
    const nonUserOutcomes = [
        "not_needed",
        "config_allowed",
        "guardian_approved",
        "guardian_denied",
    ];
    test.each(userOutcomes.map((o) => [o]))("requiresUserConfirmation(%s) === true", (outcome) => {
        expect(requiresUserConfirmation(outcome)).toBe(true);
    });
    test.each(nonUserOutcomes.map((o) => [o]))("requiresUserConfirmation(%s) === false", (outcome) => {
        expect(requiresUserConfirmation(outcome)).toBe(false);
    });
});
describe("outcome — invariant matrix (3 × 8 = 24 cells)", () => {
    const admissibleByReviewer = {
        user: new Set([
            "not_needed",
            "user_approved",
            "user_approved_for_session",
            "user_denied",
            "user_aborted",
        ]),
        auto_review: new Set(["not_needed", "config_allowed"]),
        guardian_subagent: new Set(["not_needed", "guardian_approved", "guardian_denied"]),
    };
    for (const reviewer of ALL_REVIEWERS) {
        for (const outcome of ALL_OUTCOMES) {
            const ok = admissibleByReviewer[reviewer].has(outcome);
            const label = `${reviewer} × ${outcome} → ${ok ? "admissible" : "REJECT"}`;
            test(label, () => {
                expect(isAdmissible(reviewer, outcome)).toBe(ok);
                if (ok) {
                    const d = buildDecision({
                        reviewer,
                        outcome,
                        riskLevel: "low",
                        rationale,
                        decidedAt: validClock,
                    });
                    expect(d.reviewer).toBe(reviewer);
                    expect(d.outcome).toBe(outcome);
                }
                else {
                    expect(() => buildDecision({
                        reviewer,
                        outcome,
                        riskLevel: "low",
                        rationale,
                        decidedAt: validClock,
                    })).toThrow(OutcomeInvariantError);
                }
            });
        }
    }
});
describe("outcome — buildDecision input validation", () => {
    test("rejects empty rationale", () => {
        expect(() => buildDecision({
            reviewer: "auto_review",
            outcome: "config_allowed",
            riskLevel: "low",
            rationale: "",
            decidedAt: validClock,
        })).toThrow(OutcomeInvariantError);
    });
    test("rejects negative decidedAt", () => {
        expect(() => buildDecision({
            reviewer: "auto_review",
            outcome: "config_allowed",
            riskLevel: "low",
            rationale,
            decidedAt: -1,
        })).toThrow(OutcomeInvariantError);
    });
    test("rejects non-integer decidedAt", () => {
        expect(() => buildDecision({
            reviewer: "auto_review",
            outcome: "config_allowed",
            riskLevel: "low",
            rationale,
            decidedAt: 1.5,
        })).toThrow(OutcomeInvariantError);
    });
    test("rejects NaN / Infinity decidedAt", () => {
        expect(() => buildDecision({
            reviewer: "auto_review",
            outcome: "config_allowed",
            riskLevel: "low",
            rationale,
            decidedAt: Number.NaN,
        })).toThrow(OutcomeInvariantError);
        expect(() => buildDecision({
            reviewer: "auto_review",
            outcome: "config_allowed",
            riskLevel: "low",
            rationale,
            decidedAt: Number.POSITIVE_INFINITY,
        })).toThrow(OutcomeInvariantError);
    });
    test("zero decidedAt is accepted (epoch is valid)", () => {
        const d = buildDecision({
            reviewer: "auto_review",
            outcome: "config_allowed",
            riskLevel: "low",
            rationale,
            decidedAt: 0,
        });
        expect(d.decidedAt).toBe(0);
    });
    test("returned decision is a plain value (no live refs)", () => {
        const d = buildDecision({
            reviewer: "guardian_subagent",
            outcome: "guardian_approved",
            riskLevel: "medium",
            rationale,
            decidedAt: validClock,
        });
        expect(JSON.parse(JSON.stringify(d))).toEqual(JSON.parse(JSON.stringify({
            reviewer: "guardian_subagent",
            outcome: "guardian_approved",
            riskLevel: "medium",
            rationale,
            decidedAt: validClock,
        })));
    });
    test("OutcomeInvariantError exposes reviewer + outcome on the error instance", () => {
        try {
            buildDecision({
                reviewer: "auto_review",
                outcome: "user_approved",
                riskLevel: "low",
                rationale,
                decidedAt: validClock,
            });
            throw new Error("expected throw");
        }
        catch (e) {
            expect(e).toBeInstanceOf(OutcomeInvariantError);
            const err = e;
            expect(err.reviewer).toBe("auto_review");
            expect(err.outcome).toBe("user_approved");
            expect(err.name).toBe("OutcomeInvariantError");
        }
    });
});
