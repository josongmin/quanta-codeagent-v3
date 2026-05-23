/**
 * Review-kind permission matrix coverage (ADR-0070).
 *
 * Covers:
 *   - ALL_REVIEW_KINDS / ALL_REASON_CODES / ALL_REVIEW_DECISION_VERBS
 *     completeness (closed-union enumeration).
 *   - isExecutionBlocking for every kind (PLAN false, all others true).
 *   - reasonCodeFor exhaustiveness + stopCategoryFor wiring.
 *   - isDecisionLegalFor: legal + illegal verb/kind pairings.
 *   - exhaustive switches over ReviewKind / ReasonCode / ReviewDecision verb
 *     with `never` defaults compile (compile-time, asserted at runtime).
 *
 * No mocks, no fixtures — review-kind.ts is pure.
 */
import { describe, expect, test } from "bun:test";
import { ALL_REASON_CODES, ALL_REVIEW_DECISION_VERBS, ALL_REVIEW_KINDS, isDecisionLegalFor, isExecutionBlocking, reasonCodeFor, stopCategoryFor, } from "@/permission/review-kind";
describe("review-kind — enum completeness", () => {
    test("ALL_REVIEW_KINDS enumerates exactly 7 unique literals", () => {
        expect(ALL_REVIEW_KINDS.length).toBe(7);
        expect(new Set(ALL_REVIEW_KINDS).size).toBe(7);
    });
    test("ALL_REASON_CODES enumerates exactly 7 unique literals", () => {
        expect(ALL_REASON_CODES.length).toBe(7);
        expect(new Set(ALL_REASON_CODES).size).toBe(7);
    });
    test("ALL_REVIEW_DECISION_VERBS enumerates exactly 6 unique literals", () => {
        expect(ALL_REVIEW_DECISION_VERBS.length).toBe(6);
        expect(new Set(ALL_REVIEW_DECISION_VERBS).size).toBe(6);
    });
    test("there is exactly one reason code per review kind (bijection)", () => {
        const codes = new Set(ALL_REVIEW_KINDS.map(reasonCodeFor));
        expect(codes.size).toBe(ALL_REVIEW_KINDS.length);
        expect(codes).toEqual(new Set(ALL_REASON_CODES));
    });
});
describe("review-kind — isExecutionBlocking", () => {
    const blocking = [
        "edit",
        "delete",
        "terminal",
        "mcp",
        "web_fetch",
        "web_search",
    ];
    test.each(blocking.map((k) => [k]))("isExecutionBlocking(%s) === true", (kind) => {
        expect(isExecutionBlocking(kind)).toBe(true);
    });
    test("isExecutionBlocking(plan) === false (PLAN is non-blocking)", () => {
        expect(isExecutionBlocking("plan")).toBe(false);
    });
    test("plan is the ONLY non-blocking kind", () => {
        const nonBlocking = ALL_REVIEW_KINDS.filter((k) => !isExecutionBlocking(k));
        expect(nonBlocking).toEqual(["plan"]);
    });
});
describe("review-kind — reasonCodeFor + stopCategoryFor", () => {
    test.each(ALL_REVIEW_KINDS.map((k) => [k]))("reasonCodeFor(%s) === <kind>.needs_approval", (kind) => {
        expect(reasonCodeFor(kind)).toBe(`${kind}.needs_approval`);
    });
    test("stopCategoryFor returns a typed needs_user_approval stop", () => {
        for (const kind of ALL_REVIEW_KINDS) {
            const stop = stopCategoryFor(kind);
            expect(stop.stopCategory).toBe("needs_user_approval");
            expect(stop.reasonCode).toBe(reasonCodeFor(kind));
        }
    });
});
describe("review-kind — isDecisionLegalFor", () => {
    const run = { verb: "run" };
    const skip = { verb: "skip" };
    const reject = { verb: "reject_and_tell", message: "use the typed API instead" };
    const cmds = { verb: "allowlist_commands", commands: ["ls", "git status"] };
    const tool = { verb: "allowlist_tool", server: "fs", tool: "read_file" };
    const domain = { verb: "allowlist_domain", domain: "example.com" };
    test("universal verbs (run/skip/reject_and_tell) are legal for EVERY kind", () => {
        for (const kind of ALL_REVIEW_KINDS) {
            expect(isDecisionLegalFor(kind, run)).toBe(true);
            expect(isDecisionLegalFor(kind, skip)).toBe(true);
            expect(isDecisionLegalFor(kind, reject)).toBe(true);
        }
    });
    test("allowlist_commands is legal ONLY for terminal", () => {
        for (const kind of ALL_REVIEW_KINDS) {
            expect(isDecisionLegalFor(kind, cmds)).toBe(kind === "terminal");
        }
    });
    test("allowlist_tool is legal ONLY for mcp", () => {
        for (const kind of ALL_REVIEW_KINDS) {
            expect(isDecisionLegalFor(kind, tool)).toBe(kind === "mcp");
        }
    });
    test("allowlist_domain is legal ONLY for web_fetch / web_search", () => {
        for (const kind of ALL_REVIEW_KINDS) {
            expect(isDecisionLegalFor(kind, domain)).toBe(kind === "web_fetch" || kind === "web_search");
        }
    });
    test("illegal pairings are rejected (spot checks)", () => {
        expect(isDecisionLegalFor("edit", cmds)).toBe(false);
        expect(isDecisionLegalFor("terminal", tool)).toBe(false);
        expect(isDecisionLegalFor("mcp", domain)).toBe(false);
        expect(isDecisionLegalFor("plan", cmds)).toBe(false);
        expect(isDecisionLegalFor("web_fetch", tool)).toBe(false);
    });
    test("reject_and_tell carries a steering message", () => {
        if (reject.verb === "reject_and_tell") {
            expect(reject.message).toBe("use the typed API instead");
        }
        else {
            throw new Error("expected reject_and_tell");
        }
    });
});
describe("review-kind — exhaustive switches compile + run", () => {
    // Local exhaustive switches that would fail to compile if a member were
    // added to the union without an explicit case here (mirror of the module's
    // own `never` guards). Runtime assertion proves they actually execute.
    const blockingViaSwitch = (kind) => {
        switch (kind) {
            case "edit":
            case "delete":
            case "terminal":
            case "mcp":
            case "web_fetch":
            case "web_search":
                return true;
            case "plan":
                return false;
            default: {
                const _exhaustive = kind;
                throw new Error(`Unhandled ReviewKind: ${String(_exhaustive)}`);
            }
        }
    };
    const reasonLabel = (code) => {
        switch (code) {
            case "edit.needs_approval":
            case "delete.needs_approval":
            case "terminal.needs_approval":
            case "mcp.needs_approval":
            case "web_fetch.needs_approval":
            case "web_search.needs_approval":
            case "plan.needs_approval":
                return code;
            default: {
                const _exhaustive = code;
                throw new Error(`Unhandled ReasonCode: ${String(_exhaustive)}`);
            }
        }
    };
    const verbLabel = (verb) => {
        switch (verb) {
            case "run":
            case "skip":
            case "allowlist_commands":
            case "allowlist_tool":
            case "allowlist_domain":
            case "reject_and_tell":
                return verb;
            default: {
                const _exhaustive = verb;
                throw new Error(`Unhandled verb: ${String(_exhaustive)}`);
            }
        }
    };
    test("ReviewKind switch matches isExecutionBlocking", () => {
        for (const kind of ALL_REVIEW_KINDS) {
            expect(blockingViaSwitch(kind)).toBe(isExecutionBlocking(kind));
        }
    });
    test("ReasonCode switch handles every code", () => {
        for (const code of ALL_REASON_CODES) {
            expect(reasonLabel(code)).toBe(code);
        }
    });
    test("ReviewDecision verb switch handles every verb", () => {
        for (const verb of ALL_REVIEW_DECISION_VERBS) {
            expect(verbLabel(verb)).toBe(verb);
        }
    });
});
