/**
 * Skill `model:` / `effort:` read-seam contracts — catalog row 6.2 promotion
 * from pure-advisory (L2) to advisory + enforceable seam (L3). The advisory
 * STATUS is unchanged (the skill slice still does not enforce); what this
 * file pins is that a HOST has a clean, type-safe seam to read author
 * declarations without reaching into `skill.model` / `skill.effort` directly
 * and risking field-name drift.
 *
 * Pinned contract:
 *   - `undefined` when the override is absent (so a host's `?? fallback`
 *     pattern composes cleanly under `exactOptionalPropertyTypes`).
 *   - Honours the full `SkillEffort` union (literal + number — a `0` is a
 *     VALID effort override and MUST be preserved, not falsy-coerced away).
 *   - Treats `model: ""` (empty string) as "not declared" — empty strings in
 *     YAML frontmatter are user error / sentinel, not a real override.
 */
import { describe, expect, test } from "bun:test";
import { skillEffortOverride, skillModelOverride } from "@/skill";
const skill = (over = {}) => ({
    name: "test-skill",
    description: "for tests",
    body: "body",
    sourcePath: "/tmp/test-skill/SKILL.md",
    ...over,
});
describe("skillModelOverride", () => {
    test("returns the declared model id when present", () => {
        expect(skillModelOverride(skill({ model: "claude-opus-4-7" }))).toBe("claude-opus-4-7");
    });
    test("returns undefined when model is absent", () => {
        expect(skillModelOverride(skill())).toBeUndefined();
    });
    test("returns undefined for an empty string (treated as not declared, not sentinel)", () => {
        expect(skillModelOverride(skill({ model: "" }))).toBeUndefined();
    });
    test("preserves 'inherit' literal verbatim — host owns the semantics", () => {
        // CC v2 documents `model: inherit` as a legal value; the seam does NOT
        // interpret it. A host that wants special handling reads the string.
        expect(skillModelOverride(skill({ model: "inherit" }))).toBe("inherit");
    });
});
describe("skillEffortOverride", () => {
    test("returns the declared literal effort when present", () => {
        expect(skillEffortOverride(skill({ effort: "high" }))).toBe("high");
        expect(skillEffortOverride(skill({ effort: "max" }))).toBe("max");
    });
    test("returns a numeric effort verbatim (CC v2 supports `<int>` form)", () => {
        expect(skillEffortOverride(skill({ effort: 4096 }))).toBe(4096);
    });
    test("returns 0 verbatim (must NOT be falsy-coerced — 0 is a valid override)", () => {
        expect(skillEffortOverride(skill({ effort: 0 }))).toBe(0);
    });
    test("returns undefined when effort is absent", () => {
        expect(skillEffortOverride(skill())).toBeUndefined();
    });
});
describe("composition: hosts compose seams without reaching skill.model / skill.effort directly", () => {
    test("undefined-fallback pattern works under exactOptionalPropertyTypes", () => {
        // This is the realistic host pattern — the seam returning `undefined` (and
        // never an explicit explicit-undefined) is what makes `?? default` clean.
        const declared = skill({ model: "claude-sonnet-4-6", effort: "medium" });
        const absent = skill();
        const composed = (s) => ({
            model: skillModelOverride(s) ?? "default-model",
            effort: skillEffortOverride(s) ?? "low",
        });
        expect(composed(declared)).toEqual({ model: "claude-sonnet-4-6", effort: "medium" });
        expect(composed(absent)).toEqual({ model: "default-model", effort: "low" });
    });
});
