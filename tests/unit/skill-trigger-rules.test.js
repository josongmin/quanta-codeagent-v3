import { describe, expect, test } from "bun:test";
import { buildTurnContext } from "@/agent";
/**
 * Phase 7: Skill trigger rules + tool routing matrix (Codex `skills-audit.md`
 * + `tool-routing-and-triggering.md` absorption).
 *
 * These tests pin the per-turn "## Active skills" block — catalogue + the four
 * trigger rules — and verify the byte-identical contract: absent or empty
 * `activeSkills` produces NO block (skill-less sessions stay byte-stable).
 */
const seed = [{ role: "user", content: [{ type: "text", text: "do it" }] }];
const base = (over = {}) => ({
    baseMessages: seed,
    cwd: "/repo",
    planMode: false,
    ...over,
});
const reminderText = (m) => {
    const block = m.content[0];
    return block?.type === "text" ? block.text : "";
};
const tail = (input) => {
    const { messages } = buildTurnContext(input);
    return reminderText(messages[messages.length - 1]);
};
describe("buildTurnContext activeSkills block (Phase 7)", () => {
    test("renders the '## Active skills' header + entry + trigger rules", () => {
        const text = tail(base({
            activeSkills: [{ name: "review", description: "Review a pull request" }],
        }));
        expect(text).toContain("## Active skills");
        expect(text).toContain("- $review — Review a pull request");
        // All four trigger rules present.
        expect(text).toContain("Trigger rules:");
        expect(text).toContain("1. If the user names a skill");
        expect(text).toContain("2. If the task clearly matches a skill description");
        expect(text).toContain("3. If multiple apply, pick the minimal covering set");
        expect(text).toContain("4. Progressive disclosure: load SKILL.md body via the `Skill` tool");
    });
    test("renders multiple skills with first-line descriptions only", () => {
        const text = tail(base({
            activeSkills: [
                { name: "init", description: "Initialize a new CLAUDE.md file" },
                // Multi-line description: only the first non-empty line should ride.
                { name: "review", description: "Review a pull request\nLong body follows." },
                { name: "simplify", description: "Simplify and reuse changed code" },
            ],
        }));
        expect(text).toContain("- $init — Initialize a new CLAUDE.md file");
        expect(text).toContain("- $review — Review a pull request");
        expect(text).not.toContain("Long body follows.");
        expect(text).toContain("- $simplify — Simplify and reuse changed code");
        // Order preserved as supplied (no reorder/sort imposed by the renderer).
        const iInit = text.indexOf("- $init");
        const iReview = text.indexOf("- $review");
        const iSimplify = text.indexOf("- $simplify");
        expect(iInit).toBeLessThan(iReview);
        expect(iReview).toBeLessThan(iSimplify);
    });
    test("entry with empty description renders as bare `- $name`", () => {
        const text = tail(base({ activeSkills: [{ name: "bare", description: "" }] }));
        expect(text).toContain("- $bare");
        // No trailing em-dash separator when description is empty.
        expect(text).not.toContain("- $bare — ");
    });
    test("empty activeSkills ⇒ no block (byte-identical to absent)", () => {
        const withEmpty = tail(base({ activeSkills: [] }));
        const without = tail(base());
        expect(withEmpty).not.toContain("## Active skills");
        expect(withEmpty).not.toContain("Trigger rules:");
        // The two tails should be identical — empty array is a no-op.
        expect(withEmpty).toBe(without);
    });
    test("absent activeSkills ⇒ no block (backward compat)", () => {
        const text = tail(base());
        expect(text).not.toContain("## Active skills");
        expect(text).not.toContain("Trigger rules:");
    });
    test("skills block precedes memory hints (so trigger rules read before routing hints)", () => {
        const text = tail(base({
            activeSkills: [{ name: "review", description: "Review a pull request" }],
            memoryContext: "memory-hint-marker",
        }));
        const skillsIdx = text.indexOf("## Active skills");
        const memIdx = text.indexOf("memory-hint-marker");
        expect(skillsIdx).toBeGreaterThanOrEqual(0);
        expect(memIdx).toBeGreaterThanOrEqual(0);
        expect(skillsIdx).toBeLessThan(memIdx);
    });
    test("repo-local rules precede the skills block (repo authority > skill)", () => {
        const text = tail(base({
            repoRules: {
                sourcePath: "/repo/AGENTS.md",
                entrypoint: "AGENTS.md",
                body: "no heuristics; fail-closed",
                loadedAt: 0,
            },
            activeSkills: [{ name: "review", description: "Review a pull request" }],
        }));
        const repoIdx = text.indexOf("## Repo-local rules");
        const skillsIdx = text.indexOf("## Active skills");
        expect(repoIdx).toBeGreaterThanOrEqual(0);
        expect(skillsIdx).toBeGreaterThanOrEqual(0);
        expect(repoIdx).toBeLessThan(skillsIdx);
    });
    test("activeSkills do NOT shift the cached system prefix", () => {
        const withoutSkills = buildTurnContext(base()).system;
        const withSkills = buildTurnContext(base({ activeSkills: [{ name: "review", description: "Review a pull request" }] })).system;
        // Skills ride in the dynamic reminder, NEVER in the cached prefix.
        expect(withSkills).toEqual(withoutSkills);
    });
});
