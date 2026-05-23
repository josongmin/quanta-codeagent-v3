/**
 * Inference + ReviewContext / ApprovalDecision verb plumbing for the L4
 * review-kind matrix (ADR-0070).
 *
 * Coverage:
 *   I-1   inferReviewKind exhaustive: web_fetch, web_search, mcp, delete,
 *         terminal, plan, edit defaults.
 *   I-2   isDecisionLegalFor (already tested in review-kind.test.ts) — pin
 *         the bijection here so the gate's validation logic has a stable
 *         contract.
 *   I-3   buildDecision carries the optional `verb` through validation
 *         unchanged.
 *   I-4   buildDecision validation does not require `verb` (legacy callers
 *         are byte-identical).
 */
import { describe, expect, test } from "bun:test";
import { ALL_REVIEW_KINDS, buildDecision, inferReviewKind, isDecisionLegalFor, } from "@/permission";
describe("inferReviewKind — exhaustive", () => {
    test.each([
        ["web_fetch", false, "web_fetch"],
        ["webFetch", false, "web_fetch"],
        ["fetch", false, "web_fetch"],
        ["http_get", false, "web_fetch"],
        ["web_search", false, "web_search"],
        ["webSearch", false, "web_search"],
        ["semantic_search", false, "web_search"],
        ["mcp__abc__list", false, "mcp"],
        ["mcp_search", false, "mcp"],
        ["delete", false, "delete"],
        ["rm", false, "delete"],
        ["remove", false, "delete"],
        ["bash", false, "terminal"],
        ["shell", false, "terminal"],
        ["exec", false, "terminal"],
        ["run", false, "terminal"],
        ["my_shell", false, "terminal"],
        ["read", true, "plan"], // read-only fallthrough
        ["grep", true, "plan"],
        ["write", false, "edit"], // mutating fallthrough
        ["edit", false, "edit"],
    ])("inferReviewKind(%s, isReadOnly=%s) === %s", (tool, ro, expected) => {
        expect(inferReviewKind(tool, ro)).toBe(expected);
    });
});
describe("verb plumbing through buildDecision", () => {
    test("I-3: optional verb roundtrips through buildDecision", () => {
        const verb = { verb: "reject_and_tell", message: "use the typed API" };
        const dec = buildDecision({
            reviewer: "user",
            outcome: "user_denied",
            riskLevel: "high",
            rationale: "explicit deny",
            decidedAt: 0,
            verb,
        });
        expect(dec.verb).toEqual(verb);
    });
    test("I-4: absent verb is OMITTED (legacy byte-identical)", () => {
        const dec = buildDecision({
            reviewer: "auto_review",
            outcome: "config_allowed",
            riskLevel: "low",
            rationale: "policy allowed",
            decidedAt: 0,
        });
        expect("verb" in dec).toBe(false);
    });
});
describe("isDecisionLegalFor — cross-product bijection (regression guard)", () => {
    test("universal verbs accepted for every kind", () => {
        for (const k of ALL_REVIEW_KINDS) {
            expect(isDecisionLegalFor(k, { verb: "run" })).toBe(true);
            expect(isDecisionLegalFor(k, { verb: "skip" })).toBe(true);
            expect(isDecisionLegalFor(k, { verb: "reject_and_tell", message: "x" })).toBe(true);
        }
    });
    test("allowlist_commands ⇒ terminal only", () => {
        const v = { verb: "allowlist_commands", commands: ["ls"] };
        expect(isDecisionLegalFor("terminal", v)).toBe(true);
        expect(isDecisionLegalFor("edit", v)).toBe(false);
        expect(isDecisionLegalFor("mcp", v)).toBe(false);
    });
});
