/**
 * Skill vs Extension classifier + allowed-tool gate tests
 * (Cluster E / F14, ADR-0040).
 */
import { describe, expect, test } from "bun:test";
import { assertAllowedTool, classify, isToolAllowed, ToolNotAllowedBySkillError, } from "../../src/skill/skill-vs-extension";
const fm = (overrides = {}) => ({
    name: "demo",
    description: "x",
    userInvocable: false,
    allowedTools: [],
    category: "skill",
    stability: "stable",
    ...overrides,
});
describe("classify", () => {
    test("classifies a userInvocable skill", () => {
        const got = classify(fm({ category: "skill", userInvocable: true }));
        expect(got).toEqual({ kind: "skill", userInvocable: true });
    });
    test("classifies a non-userInvocable skill", () => {
        const got = classify(fm({ category: "skill", userInvocable: false }));
        expect(got).toEqual({ kind: "skill", userInvocable: false });
    });
    test("classifies an extension as non-userInvocable", () => {
        const got = classify(fm({ category: "extension", userInvocable: false }));
        expect(got).toEqual({ kind: "extension", userInvocable: false });
    });
    test("rejects extension + userInvocable=true (contradiction)", () => {
        expect(() => classify(fm({ category: "extension", userInvocable: true }))).toThrow(ToolNotAllowedBySkillError);
    });
});
describe("assertAllowedTool / isToolAllowed", () => {
    test("permits a tool that is explicitly listed", () => {
        expect(() => assertAllowedTool(fm({ allowedTools: ["Read"] }), "Read")).not.toThrow();
        expect(isToolAllowed(fm({ allowedTools: ["Read"] }), "Read")).toBe(true);
    });
    test("denies a tool that is not listed", () => {
        expect(() => assertAllowedTool(fm({ allowedTools: ["Read"] }), "Bash")).toThrow(ToolNotAllowedBySkillError);
        expect(isToolAllowed(fm({ allowedTools: ["Read"] }), "Bash")).toBe(false);
    });
    test("EMPTY allowedTools means NO tools allowed (not 'all')", () => {
        expect(() => assertAllowedTool(fm({ allowedTools: [] }), "Read")).toThrow(ToolNotAllowedBySkillError);
        expect(isToolAllowed(fm({ allowedTools: [] }), "Read")).toBe(false);
    });
    test("case-sensitive (Read != read)", () => {
        expect(isToolAllowed(fm({ allowedTools: ["Read"] }), "read")).toBe(false);
    });
    test("exact-match only — no prefix over-match (Read not allowed by [ReadFile])", () => {
        // Tool-name analog of the rules-matcher `rm` MUST NOT match `rmdir`
        // guard. `allowedTools` membership is whole-string `Array.includes`, so
        // a requested tool that is merely a PREFIX (or substring) of an allowed
        // tool name must NOT be permitted — otherwise a skill granting `ReadFile`
        // would silently widen to `Read`, `ReadFileLines`, etc.
        const guarded = fm({ allowedTools: ["ReadFile"] });
        expect(isToolAllowed(guarded, "Read")).toBe(false);
        expect(() => assertAllowedTool(guarded, "Read")).toThrow(ToolNotAllowedBySkillError);
        // ...and the exact name is still permitted.
        expect(isToolAllowed(guarded, "ReadFile")).toBe(true);
        expect(() => assertAllowedTool(guarded, "ReadFile")).not.toThrow();
    });
    test("error message names the offending tool and skill", () => {
        let caught;
        try {
            assertAllowedTool(fm({ name: "rummager", allowedTools: ["X"] }), "Y");
        }
        catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ToolNotAllowedBySkillError);
        expect(caught.message).toMatch(/rummager/);
        expect(caught.message).toMatch(/'Y'/);
    });
});
