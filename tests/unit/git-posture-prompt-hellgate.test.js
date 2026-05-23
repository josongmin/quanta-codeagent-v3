/**
 * ADR-0099 hellgate — Git posture (default fail-closed) prompt section
 *
 * Codex §18.2 (Default-NO-git) + §18.4 (destructive verbatim ban) + §18.5
 * (naming convention) absorption. These are prompt-only rules — no HARD_DENY
 * regex enforcement at this layer (A3 covers that). The test asserts the
 * prompt contains the LLM-readable verbatim ban so the model has the policy
 * even before any tool gate.
 *
 * 10 adversarial cases.
 */
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "@/agent";
describe("ADR-0099 Git posture prompt section (hellgate)", () => {
    const prompt = buildSystemPrompt();
    test("HELL-1: section is present (titled 'Git posture')", () => {
        expect(prompt).toContain("Git posture");
    });
    // ── Default-NO-git posture (§18.2) ────────────────────────────────────
    test("HELL-2: explicit 'DO NOT git commit ... unless explicitly requested'", () => {
        // Verbatim from Codex §18.2 — model MUST see this exact directive.
        // `s` flag = dotAll so `.+` crosses newlines (the bullet wraps lines).
        expect(prompt).toMatch(/DO NOT git commit.+unless.+explicitly requested/is);
    });
    test("HELL-3: read-only ops listed as free (status/log/diff/blame)", () => {
        // The model must know inspection is free; otherwise it might refuse even
        // diagnostic calls. Verbatim list defends against over-restriction.
        expect(prompt).toMatch(/status.+log.+diff.+blame/);
    });
    test("HELL-4: 'save your work' / 'clean up' / 'sync' explicitly NOT consent", () => {
        // Adversarial: vague phrasing must not be treated as commit consent.
        expect(prompt).toMatch(/save your work.+not.+explicit|not.+explicit.+save your work/is);
    });
    // ── Destructive verbatim ban (§18.4) ──────────────────────────────────
    test("HELL-5: `git reset --hard` banned verbatim", () => {
        expect(prompt).toContain("git reset --hard");
    });
    test("HELL-6: `git checkout -- ` banned verbatim", () => {
        expect(prompt).toContain("git checkout -- ");
    });
    test("HELL-7: `git commit --amend` banned verbatim", () => {
        expect(prompt).toContain("git commit --amend");
    });
    test("HELL-8: `git push --force` / `--force-with-lease` banned verbatim", () => {
        expect(prompt).toContain("git push --force");
        expect(prompt).toContain("--force-with-lease");
    });
    test("HELL-9: `git rebase -i` banned verbatim", () => {
        expect(prompt).toContain("git rebase -i");
    });
    // ── Hook bypass + unrelated revert ───────────────────────────────────
    test("HELL-10: `--no-verify` discipline + 'do not revert unrelated' present", () => {
        // Codex §18.4: never skip hooks; never revert unrelated user changes.
        expect(prompt).toMatch(/--no-verify/);
        expect(prompt).toMatch(/unrelated|not yours/i);
    });
    // ── Naming convention (§18.5) ─────────────────────────────────────────
    test("HELL-11: branch/PR naming convention present (`quanta/<desc>`, `[quanta] <desc>`)", () => {
        expect(prompt).toContain("quanta/");
        expect(prompt).toContain("[quanta]");
    });
});
