/**
 * ★ CONTRACT — B5: ADR-0029 reviewer-tier × outcome enum. src/permission/
 *   outcome.ts ALL_OUTCOMES (8 states), `_exhaustive: never` exhaustiveness,
 *   `buildDecision` throws OutcomeInvariantError on every illegal
 *   reviewer×outcome cell (24-cell matrix). Sticky DenialMemory precedence:
 *   user_aborted > guardian_denied > user_denied (monotone — no later allow
 *   can override a sticky denial).
 *
 * HELLGATE — outcome invariant FULL MATRIX + sticky-denial conflict proofs (B5).
 *
 * Two security invariants under attack:
 *
 *  1. The (reviewer × outcome) invariant matrix is a HARD contract. A
 *     compromised/buggy reviewer port that returns an illegal pairing (e.g.
 *     auto_review producing a user-only outcome, guardian producing a user
 *     outcome, auto_review producing a denial it is not allowed to render)
 *     MUST throw OutcomeInvariantError — never be normalized or silently
 *     accepted. We re-enumerate all 24 cells AND independently verify the
 *     "boundary" illegal pairs the brief calls out by name.
 *
 *  2. Sticky DenialMemory precedence is monotone: under a CONFLICT where
 *     user_aborted, guardian_denied AND user_denied all target the same
 *     actionKey, the strongest (user_aborted) wins, and a LATER allow attempt
 *     does NOT override a sticky denial (the reviewer port is never consulted).
 *
 * Source under test: src/permission/outcome.ts + src/permission/reviewer.ts.
 * outcome.test.ts already covers the 24-cell happy/illegal split; this file
 * ADDS the named boundary cells + the conflict-resolution attack.
 */
import { describe, expect, test } from "bun:test";
import { ALL_OUTCOMES, ALL_REVIEWERS, buildDecision, isAdmissible, OutcomeInvariantError, reviewAction, } from "@/permission";
const CLOCK = 1_700_000_000_000;
// ─── 1. FULL MATRIX re-enumeration (3 × 8 = 24) — every illegal pair throws ──
describe("HELLGATE B5 — full (reviewer × outcome) matrix: every cell is enforced", () => {
    // The canonical legal sets (independently transcribed from the ADR-0029
    // contract, NOT imported from the source under test — so a source-side
    // matrix mutation is caught by THIS test, not masked by it).
    const LEGAL = {
        user: new Set([
            "not_needed",
            "user_approved",
            "user_approved_for_session",
            "user_denied",
            "user_aborted",
        ]),
        auto_review: new Set(["not_needed", "config_allowed"]),
        guardian_subagent: new Set([
            "not_needed",
            "guardian_approved",
            "guardian_denied",
        ]),
    };
    let legalCells = 0;
    let illegalCells = 0;
    for (const reviewer of ALL_REVIEWERS) {
        for (const outcome of ALL_OUTCOMES) {
            const legal = LEGAL[reviewer].has(outcome);
            if (legal)
                legalCells++;
            else
                illegalCells++;
            test(`${reviewer} × ${outcome} ⇒ ${legal ? "LEGAL" : "OutcomeInvariantError"}`, () => {
                expect(isAdmissible(reviewer, outcome)).toBe(legal);
                if (legal) {
                    const d = buildDecision({
                        reviewer,
                        outcome,
                        riskLevel: "low",
                        rationale: "hellgate",
                        decidedAt: CLOCK,
                    });
                    expect(d.reviewer).toBe(reviewer);
                    expect(d.outcome).toBe(outcome);
                }
                else {
                    let thrown;
                    try {
                        buildDecision({
                            reviewer,
                            outcome,
                            riskLevel: "low",
                            rationale: "hellgate",
                            decidedAt: CLOCK,
                        });
                    }
                    catch (e) {
                        thrown = e;
                    }
                    expect(thrown).toBeInstanceOf(OutcomeInvariantError);
                    expect(thrown.reviewer).toBe(reviewer);
                    expect(thrown.outcome).toBe(outcome);
                }
            });
        }
    }
    test("matrix partition: exactly 24 cells, 10 legal / 14 illegal", () => {
        expect(legalCells + illegalCells).toBe(24);
        expect(legalCells).toBe(10);
        expect(illegalCells).toBe(14);
    });
});
// ─── 2. Named boundary illegal pairs (brief callouts) ────────────────────────
describe("HELLGATE B5 — named boundary illegal pairs throw (no silent normalize)", () => {
    const illegal = [
        ["guardian_subagent", "user_approved", "guardian producing a user-only outcome"],
        ["guardian_subagent", "user_approved_for_session", "guardian forging a session approval"],
        ["guardian_subagent", "user_denied", "guardian forging a user denial"],
        ["guardian_subagent", "user_aborted", "guardian forging a user abort"],
        ["guardian_subagent", "config_allowed", "guardian forging an auto/config allow"],
        ["auto_review", "user_aborted", "auto_review producing user_aborted"],
        ["auto_review", "user_approved", "auto_review forging a human approval"],
        ["auto_review", "user_denied", "auto_review rendering a denial it cannot"],
        ["auto_review", "guardian_denied", "auto_review rendering a guardian denial"],
        ["auto_review", "guardian_approved", "auto_review forging a guardian approval"],
        ["user", "config_allowed", "user reviewer forging a config_allowed"],
        ["user", "guardian_approved", "user reviewer forging a guardian approval"],
        ["user", "guardian_denied", "user reviewer forging a guardian denial"],
    ];
    for (const [reviewer, outcome, label] of illegal) {
        test(`${label} (${reviewer} × ${outcome}) throws`, () => {
            expect(() => buildDecision({ reviewer, outcome, riskLevel: "high", rationale: "x", decidedAt: CLOCK })).toThrow(OutcomeInvariantError);
        });
    }
});
// ─── 3. Sticky-denial precedence under CONFLICT (reviewAction) ───────────────
const action = (over = {}) => ({
    tool: "bash",
    input: { command: "rm -rf ./build" },
    isReadOnly: false,
    actionKey: "bash:danger",
    ...over,
});
const ctx = (over = {}) => ({
    sessionId: "s1",
    turnId: "t1",
    priorDenials: [],
    configReviewer: "user",
    decidedAt: CLOCK,
    ...over,
});
/** A port that LOUDLY allows — used to prove the sticky denial short-circuits
 *  BEFORE the port is ever consulted. If any method runs, the test fails. */
const allowingPort = (counter) => ({
    userReview: async () => {
        counter.calls++;
        return {
            reviewer: "user",
            outcome: "user_approved",
            riskLevel: "low",
            rationale: "would-allow",
            decidedAt: CLOCK,
        };
    },
    autoReview: async () => {
        counter.calls++;
        return {
            reviewer: "auto_review",
            outcome: "config_allowed",
            riskLevel: "low",
            rationale: "would-allow",
            decidedAt: CLOCK,
        };
    },
    guardianReview: async () => {
        counter.calls++;
        return {
            reviewer: "guardian_subagent",
            outcome: "guardian_approved",
            riskLevel: "low",
            rationale: "would-allow",
            decidedAt: CLOCK,
        };
    },
});
const denial = (over) => ({
    sessionId: "s1",
    actionKey: "bash:danger",
    reviewer: "guardian_subagent",
    outcome: "guardian_denied",
    deniedAt: CLOCK - 1000,
    ...over,
});
describe("HELLGATE B5 — sticky denial precedence under CONFLICT (aborted > guardian > user)", () => {
    test("user_aborted + guardian_denied + user_denied all present ⇒ user_aborted wins", async () => {
        const counter = { calls: 0 };
        // configReviewer is auto_review with an allowing port — the sticky denial
        // must short-circuit so the port is NEVER consulted.
        const out = await reviewAction(action(), ctx({
            configReviewer: "auto_review",
            priorDenials: [
                denial({ reviewer: "user", outcome: "user_denied", deniedAt: CLOCK - 3000 }),
                denial({
                    reviewer: "guardian_subagent",
                    outcome: "guardian_denied",
                    deniedAt: CLOCK - 2000,
                }),
                denial({ reviewer: "user", outcome: "user_aborted", deniedAt: CLOCK - 1000 }),
            ],
        }), allowingPort(counter));
        expect(out.outcome).toBe("user_aborted");
        expect(out.reviewer).toBe("user");
        expect(counter.calls).toBe(0);
    });
    test("guardian_denied + user_denied (no abort) ⇒ guardian_denied wins", async () => {
        const counter = { calls: 0 };
        const out = await reviewAction(action(), ctx({
            configReviewer: "user",
            priorDenials: [
                denial({ reviewer: "user", outcome: "user_denied", deniedAt: CLOCK - 2000 }),
                denial({
                    reviewer: "guardian_subagent",
                    outcome: "guardian_denied",
                    deniedAt: CLOCK - 1000,
                }),
            ],
        }), allowingPort(counter));
        expect(out.outcome).toBe("guardian_denied");
        expect(counter.calls).toBe(0);
    });
    test("a LATER allow does NOT override a sticky denial (fresh approving port ignored)", async () => {
        const counter = { calls: 0 };
        // Even though the configured reviewer would approve RIGHT NOW, the prior
        // sticky denial for the same actionKey wins. The "later allow" is the live
        // port response — it must never be reached.
        const out = await reviewAction(action(), ctx({
            configReviewer: "user", // userReview would return user_approved
            priorDenials: [denial({ reviewer: "guardian_subagent", outcome: "guardian_denied" })],
        }), allowingPort(counter));
        expect(out.outcome).toBe("guardian_denied");
        expect(counter.calls).toBe(0);
        // The replayed denial carries the CURRENT clock, not the original deniedAt.
        expect(out.decidedAt).toBe(CLOCK);
    });
    test("ordering is set-not-array: shuffled priorDenials still yield user_aborted", async () => {
        const counter = { calls: 0 };
        const out = await reviewAction(action(), ctx({
            configReviewer: "guardian_subagent",
            priorDenials: [
                denial({ reviewer: "user", outcome: "user_aborted", deniedAt: CLOCK - 1 }),
                denial({ reviewer: "user", outcome: "user_denied", deniedAt: CLOCK - 9999 }),
                denial({
                    reviewer: "guardian_subagent",
                    outcome: "guardian_denied",
                    deniedAt: CLOCK - 5,
                }),
            ],
        }), allowingPort(counter));
        expect(out.outcome).toBe("user_aborted");
        expect(counter.calls).toBe(0);
    });
});
