import { describe, expect, test } from "bun:test";
import { HARD_DENY_RULES } from "@/permission/policy";
import { PERMISSION_RULE_FIXTURES } from "./permission-rules.fixtures";
/**
 * Rule-level enforcement for the HARD_DENY catalog. Refactor A: the
 * adversarial cases (`mustBlock` / `mustAllow`) USED to live inline on
 * each rule in `src/permission/policy.ts`. That collapsed authorship: the
 * regex author and the fixture author were the same person in the same
 * PR, so a rule with a regex bug could ship if the matching fixture had
 * the same blind spot. Refactor A moved the fixtures to a separate file
 * (`permission-rules.fixtures.ts`) so the corpus can be reviewed
 * independently of the regex.
 *
 * This file now cross-checks the two sources of truth:
 *   1. every rule.name in HARD_DENY_RULES has a fixture entry, AND
 *   2. every fixture key references an existing rule.name.
 * Both directions matter — (1) catches "added a rule, forgot the
 * adversarial corpus"; (2) catches "renamed a rule, fixture went stale".
 *
 * End-to-end behavior on `hardDeny(action)` stays covered by
 * `tests/unit/permission-hardening.test.ts` (untouched by this refactor).
 */
describe("HARD_DENY rule catalog — structural invariants", () => {
    test("at least 11 rules exist (CR3 baseline)", () => {
        expect(HARD_DENY_RULES.length).toBeGreaterThanOrEqual(11);
    });
    test("rule names are unique", () => {
        const names = HARD_DENY_RULES.map((r) => r.name);
        const unique = new Set(names);
        expect(unique.size).toBe(names.length);
    });
    test("rule names are non-empty kebab-case identifiers", () => {
        for (const r of HARD_DENY_RULES) {
            expect(r.name.length).toBeGreaterThan(0);
            // kebab-case: lowercase letters/digits with single-dash separators.
            expect(r.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        }
    });
    test("each rule has a one-line description", () => {
        for (const r of HARD_DENY_RULES) {
            expect(r.description.length).toBeGreaterThan(0);
            expect(r.description.includes("\n")).toBe(false);
        }
    });
});
describe("HARD_DENY rule catalog — cross-check rules ↔ fixtures", () => {
    test("every rule has a fixture entry (no rule ships without adversarial cases)", () => {
        const missing = [];
        for (const r of HARD_DENY_RULES) {
            if (!Object.hasOwn(PERMISSION_RULE_FIXTURES, r.name))
                missing.push(r.name);
        }
        expect(missing).toEqual([]);
    });
    test("every fixture entry references an existing rule (no orphan after rename)", () => {
        const ruleNames = new Set(HARD_DENY_RULES.map((r) => r.name));
        const orphans = Object.keys(PERMISSION_RULE_FIXTURES).filter((k) => !ruleNames.has(k));
        expect(orphans).toEqual([]);
    });
    test("each fixture entry declares at least one mustBlock and one mustAllow case", () => {
        for (const [name, fixture] of Object.entries(PERMISSION_RULE_FIXTURES)) {
            expect(fixture.mustBlock.length, `${name}.mustBlock`).toBeGreaterThanOrEqual(1);
            expect(fixture.mustAllow.length, `${name}.mustAllow`).toBeGreaterThanOrEqual(1);
        }
    });
});
describe("HARD_DENY rule catalog — mustBlock positives fire", () => {
    for (const rule of HARD_DENY_RULES) {
        const fixture = PERMISSION_RULE_FIXTURES[rule.name];
        if (!fixture)
            continue; // surfaced by the cross-check test above
        for (const cmd of fixture.mustBlock) {
            test(`[${rule.name}] blocks: ${cmd}`, () => {
                expect(rule.pattern.test(cmd)).toBe(true);
            });
        }
    }
});
describe("HARD_DENY rule catalog — mustAllow negatives stay clean", () => {
    for (const rule of HARD_DENY_RULES) {
        const fixture = PERMISSION_RULE_FIXTURES[rule.name];
        if (!fixture)
            continue; // surfaced by the cross-check test above
        for (const cmd of fixture.mustAllow) {
            test(`[${rule.name}] does NOT match: ${cmd}`, () => {
                expect(rule.pattern.test(cmd)).toBe(false);
            });
        }
    }
});
