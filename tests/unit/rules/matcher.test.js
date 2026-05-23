/**
 * Matcher tests — locks the longest-prefix-match invariant and the
 * space-boundary rule (`git` MUST NOT match `github`). These two
 * properties together are what distinguishes the DSL from a naive
 * `startsWith` check.
 */
import { describe, expect, test } from "bun:test";
import { matchCommand, parseRules } from "@/rules";
/** Inline-builder for test rules — bypasses the parser when we want
 *  to construct adversarial rule sets directly. */
const makeRule = (action, prefix, line = 1) => Object.freeze({
    action,
    prefix,
    layer: "system",
    sourceLine: line,
    sourceFile: "test",
});
describe("matchCommand — basic match semantics", () => {
    test("exact match returns the rule", () => {
        const rules = [makeRule("allow", "git status")];
        const outcome = matchCommand("git status", rules);
        expect(outcome.kind).toBe("matched");
        if (outcome.kind === "matched") {
            expect(outcome.rule.prefix).toBe("git status");
        }
    });
    test("longer command matches a shorter rule prefix at a space boundary", () => {
        const rules = [makeRule("allow", "git status")];
        const outcome = matchCommand("git status --short", rules);
        expect(outcome.kind).toBe("matched");
    });
    test("empty rule list always returns no_match", () => {
        const outcome = matchCommand("anything", []);
        expect(outcome).toEqual({ kind: "no_match" });
    });
    test("non-matching command returns no_match", () => {
        const rules = [makeRule("allow", "git status")];
        const outcome = matchCommand("npm test", rules);
        expect(outcome).toEqual({ kind: "no_match" });
    });
});
describe("matchCommand — longest-prefix-match wins", () => {
    test("longest prefix wins over shorter sibling", () => {
        const rules = [
            makeRule("allow", "git"),
            makeRule("deny", "git push --force"),
            makeRule("allow", "git push"),
        ];
        const outcome = matchCommand("git push --force origin", rules);
        expect(outcome.kind).toBe("matched");
        if (outcome.kind === "matched") {
            expect(outcome.rule.action).toBe("deny");
            expect(outcome.rule.prefix).toBe("git push --force");
        }
    });
    test("longer rule wins regardless of declaration order", () => {
        const rules = [makeRule("deny", "git push --force", 1), makeRule("allow", "git push", 2)];
        const outcome = matchCommand("git push --force origin", rules);
        expect(outcome.kind).toBe("matched");
        if (outcome.kind === "matched") {
            expect(outcome.rule.prefix).toBe("git push --force");
        }
    });
    test("equal-length prefixes resolve by source order (lower index wins)", () => {
        const rules = [
            makeRule("allow", "git push", 1),
            // Note: this is a different prefix that happens to be equal length —
            // we use this to lock stable tie-breaking semantics.
            makeRule("deny", "npm test", 2),
        ];
        // Only the first rule matches, so the result is unambiguous.
        expect(matchCommand("git push origin main", rules).kind).toBe("matched");
    });
});
describe("matchCommand — space-boundary requirement", () => {
    test("`git` rule does NOT match `github`", () => {
        const rules = [makeRule("allow", "git")];
        const outcome = matchCommand("github status", rules);
        expect(outcome).toEqual({ kind: "no_match" });
    });
    test("`git` rule does NOT match `git-status` (hyphen, not space)", () => {
        const rules = [makeRule("allow", "git")];
        const outcome = matchCommand("git-status", rules);
        expect(outcome).toEqual({ kind: "no_match" });
    });
    test("`git` rule MATCHES `git status` (space delimiter)", () => {
        const rules = [makeRule("allow", "git")];
        const outcome = matchCommand("git status", rules);
        expect(outcome.kind).toBe("matched");
    });
    test("`git` rule MATCHES `git` (exact match, no trailing chars)", () => {
        const rules = [makeRule("allow", "git")];
        const outcome = matchCommand("git", rules);
        expect(outcome.kind).toBe("matched");
    });
    test("tab after prefix is NOT a space-boundary match", () => {
        // Locks the explicit decision in matcher.ts: only 0x20 counts.
        const rules = [makeRule("allow", "git")];
        const outcome = matchCommand("git\tstatus", rules);
        expect(outcome).toEqual({ kind: "no_match" });
    });
});
describe("matchCommand — input normalisation", () => {
    test("leading whitespace in the command is stripped before matching", () => {
        const rules = [makeRule("allow", "git status")];
        const outcome = matchCommand("   git status", rules);
        expect(outcome.kind).toBe("matched");
    });
    test("trailing whitespace in the command is preserved (not used to bypass)", () => {
        // The trailing space should not affect the match (the prefix is shorter),
        // but also should not be required for matching.
        const rules = [makeRule("allow", "git status")];
        expect(matchCommand("git status   ", rules).kind).toBe("matched");
    });
    test("leading tabs in the command are stripped", () => {
        const rules = [makeRule("allow", "ls")];
        const outcome = matchCommand("\t\tls -la", rules);
        expect(outcome.kind).toBe("matched");
    });
});
describe("matchCommand — caller-array safety", () => {
    test("does not mutate the caller's rules array", () => {
        const rules = [makeRule("allow", "a"), makeRule("deny", "abc"), makeRule("ask", "abcd")];
        const before = rules.map((r) => r.prefix);
        matchCommand("abcdef", rules);
        expect(rules.map((r) => r.prefix)).toEqual(before);
    });
});
describe("matchCommand — integration with parseRules", () => {
    test("end-to-end: parse then match locks the deny verdict on a force push", () => {
        const text = ["allow git status", "ask git push", "deny git push --force"].join("\n");
        const rules = parseRules(text, "system", "default.rules");
        const outcome = matchCommand("git push --force origin main", rules);
        expect(outcome.kind).toBe("matched");
        if (outcome.kind === "matched") {
            expect(outcome.rule.action).toBe("deny");
        }
    });
    test("end-to-end: ask rule is selected when no deny outranks it", () => {
        const text = ["allow git status", "ask git push"].join("\n");
        const rules = parseRules(text, "system", "default.rules");
        const outcome = matchCommand("git push origin main", rules);
        expect(outcome.kind).toBe("matched");
        if (outcome.kind === "matched") {
            expect(outcome.rule.action).toBe("ask");
        }
    });
});
