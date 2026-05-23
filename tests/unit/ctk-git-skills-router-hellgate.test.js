/**
 * ADR-0102 Track 3 hellgate — CTK 8 skills slash-command router seam.
 *
 * Per-skill `index.ts` mirrors the `progress-audit`/`localize-fault` pattern:
 * NAME constant + Trigger interface + triggerXxx() factory + findXxxSkill()
 * accessor. 10 adversarial cases pin the contract — NAME ↔ SKILL.md
 * frontmatter, Skill-tool input shape, barrel reach, literal-type discrimination.
 */
import { describe, expect, test } from "bun:test";
import { BABYSIT_SKILL_NAME, findBabysitSkill, findFixMergeConflictsSkill, findGetPrCommentsSkill, findLoopOnCiSkill, findMakePrEasyToReviewSkill, findNewBranchAndPrSkill, findPrReviewCanvasSkill, findReviewAndShipSkill, FIX_MERGE_CONFLICTS_SKILL_NAME, GET_PR_COMMENTS_SKILL_NAME, LOOP_ON_CI_SKILL_NAME, MAKE_PR_EASY_TO_REVIEW_SKILL_NAME, NEW_BRANCH_AND_PR_SKILL_NAME, PR_REVIEW_CANVAS_SKILL_NAME, REVIEW_AND_SHIP_SKILL_NAME, triggerBabysit, triggerFixMergeConflicts, triggerGetPrComments, triggerLoopOnCi, triggerMakePrEasyToReview, triggerNewBranchAndPr, triggerPrReviewCanvas, triggerReviewAndShip, } from "@/skill";
const CTK = [
    { name: BABYSIT_SKILL_NAME, trigger: triggerBabysit, find: findBabysitSkill, kebab: "babysit" },
    {
        name: FIX_MERGE_CONFLICTS_SKILL_NAME,
        trigger: triggerFixMergeConflicts,
        find: findFixMergeConflictsSkill,
        kebab: "fix-merge-conflicts",
    },
    {
        name: GET_PR_COMMENTS_SKILL_NAME,
        trigger: triggerGetPrComments,
        find: findGetPrCommentsSkill,
        kebab: "get-pr-comments",
    },
    {
        name: LOOP_ON_CI_SKILL_NAME,
        trigger: triggerLoopOnCi,
        find: findLoopOnCiSkill,
        kebab: "loop-on-ci",
    },
    {
        name: MAKE_PR_EASY_TO_REVIEW_SKILL_NAME,
        trigger: triggerMakePrEasyToReview,
        find: findMakePrEasyToReviewSkill,
        kebab: "make-pr-easy-to-review",
    },
    {
        name: NEW_BRANCH_AND_PR_SKILL_NAME,
        trigger: triggerNewBranchAndPr,
        find: findNewBranchAndPrSkill,
        kebab: "new-branch-and-pr",
    },
    {
        name: PR_REVIEW_CANVAS_SKILL_NAME,
        trigger: triggerPrReviewCanvas,
        find: findPrReviewCanvasSkill,
        kebab: "pr-review-canvas",
    },
    {
        name: REVIEW_AND_SHIP_SKILL_NAME,
        trigger: triggerReviewAndShip,
        find: findReviewAndShipSkill,
        kebab: "review-and-ship",
    },
];
describe("ADR-0102 Track 3 — CTK skills slash-command router (hellgate)", () => {
    test("HELL-1: NAME constant === SKILL.md kebab id (SSOT drift detector)", () => {
        for (const skill of CTK) {
            expect(skill.name).toBe(skill.kebab);
        }
    });
    test("HELL-2: each triggerXxx() returns { name: kebab }", () => {
        for (const skill of CTK) {
            expect(skill.trigger()).toEqual({ name: skill.name });
        }
    });
    test("HELL-3: each findXxxSkill() resolves to discovered Skill record (body present)", async () => {
        for (const skill of CTK) {
            const found = await skill.find();
            expect(found).toBeDefined();
            expect(found?.name).toBe(skill.name);
            expect((found?.body ?? "").length).toBeGreaterThan(0);
        }
    });
    test("HELL-4: triggerXxx() output is byte-stable (pure)", () => {
        for (const skill of CTK) {
            const a = skill.trigger();
            const b = skill.trigger();
            expect(a).toEqual(b);
            expect(a).not.toBe(b); // new object each call (no mutable shared ref)
        }
    });
    test("HELL-5: Trigger interface narrows to the literal id (compile-time discriminator)", () => {
        // The type system pins the `name` field to the literal string. At runtime
        // we assert the shape; the compile-time guarantee is in the `as const`
        // declaration of each NAME constant + the `typeof XXX_SKILL_NAME` field type.
        const t = triggerBabysit();
        expect(t.name).toBe("babysit");
    });
    test("HELL-6: NAME constants are kebab-case identifiers (no SCREAMING / camelCase)", () => {
        for (const skill of CTK) {
            expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        }
    });
    test("HELL-7: 8 trigger/find pairs all reachable via `@/skill` top-level barrel", () => {
        // Already verified by the test imports above succeeding at module-load time —
        // a missing export would have failed the file to even parse. This test is
        // the explicit pin so a future barrel cleanup that drops one of these
        // re-exports breaks the suite with a clear name.
        expect(CTK.length).toBe(8);
        for (const skill of CTK) {
            expect(typeof skill.trigger).toBe("function");
            expect(typeof skill.find).toBe("function");
        }
    });
    test("HELL-8: Promise.all over 8 findXxxSkill() concurrent calls resolves each correctly", async () => {
        const results = await Promise.all(CTK.map((s) => s.find()));
        expect(results.length).toBe(8);
        for (let i = 0; i < CTK.length; i++) {
            expect(results[i]?.name).toBe(CTK[i].name);
        }
    });
    test("HELL-9: findXxxSkill() returns Promise (not throwing sync)", () => {
        for (const skill of CTK) {
            const p = skill.find();
            expect(p).toBeInstanceOf(Promise);
        }
    });
    test("HELL-10: triggerXxx().name is assignable to the Skill-tool input shape `{ name: string }`", () => {
        // Static contract: each Trigger.name is a string literal, so widening to
        // `{ name: string }` is byte-identical. Runtime check pins it.
        for (const skill of CTK) {
            const input = skill.trigger();
            expect(typeof input.name).toBe("string");
            expect(input.name.length).toBeGreaterThan(0);
        }
    });
});
