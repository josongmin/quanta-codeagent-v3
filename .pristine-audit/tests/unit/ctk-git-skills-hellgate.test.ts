/**
 * ADR-0102 Phase AS — 8 CTK git skills (Cursor absorption batch).
 *
 * Each skill ships as a single `SKILL.md` under `src/skill/system-skills/`
 * and is picked up by `discoverSystemSkills()` automatically. The hellgate
 * pins the contract: every skill is discoverable, has the right name,
 * declares the expected allowedTools surface, and contains the SKILL-
 * specific anchor phrases (no silent rename / silent rewrite).
 */

import { describe, expect, test } from "bun:test"
import { discoverSystemSkills } from "@/skill"

const CTK_SKILLS = [
  {
    name: "babysit",
    anchors: ["babysit", "gh pr checks", "Intent conflict", "shepherd"],
  },
  {
    name: "fix-merge-conflicts",
    anchors: ["merge-conflict", "Build-validated", "ours", "theirs", "bun run typecheck"],
  },
  {
    name: "get-pr-comments",
    anchors: ["reviewThreads", "file:line", "blocking", "outdated", "isResolved"],
  },
  {
    name: "loop-on-ci",
    anchors: ["gh pr checks", "log-failed", "--no-verify", "thrashing", "Flake"],
  },
  {
    name: "make-pr-easy-to-review",
    anchors: ["Noisy commits", "Stale description", "Unrelated files", "mechanical"],
  },
  {
    name: "new-branch-and-pr",
    anchors: ["quanta/", "[quanta]", "gh pr create", "always-confirm"],
  },
  {
    name: "pr-review-canvas",
    anchors: ["moved-code", "color-moved", "logic", "moved", "mechanical"],
  },
  {
    name: "review-and-ship",
    anchors: ["Self-review", "Verify", "pr-review-canvas", "new-branch-and-pr"],
  },
] as const

describe("ADR-0102 Phase AS — CTK git skills (hellgate)", () => {
  test("all 8 CTK skills are discoverable via discoverSystemSkills()", async () => {
    const skills = await discoverSystemSkills()
    const names = new Set(skills.map((s) => s.name))
    for (const ctk of CTK_SKILLS) {
      expect(names.has(ctk.name)).toBe(true)
    }
  })

  test("each CTK skill declares Bash in allowedTools (PR ops require shell)", async () => {
    const skills = await discoverSystemSkills()
    for (const ctk of CTK_SKILLS) {
      const skill = skills.find((s) => s.name === ctk.name)
      expect(skill).toBeDefined()
      expect(skill?.tools).toContain("Bash")
    }
  })

  test("each CTK skill body contains its anchor phrases (no silent rewrite)", async () => {
    const skills = await discoverSystemSkills()
    for (const ctk of CTK_SKILLS) {
      const skill = skills.find((s) => s.name === ctk.name)
      expect(skill).toBeDefined()
      for (const anchor of ctk.anchors) {
        expect(
          skill?.body.includes(anchor),
          `[${ctk.name}] body must contain anchor "${anchor}"`,
        ).toBe(true)
      }
    }
  })

  test("each CTK skill declares an outcome enum (no 'complete' as a terminal state)", async () => {
    const skills = await discoverSystemSkills()
    for (const ctk of CTK_SKILLS) {
      const skill = skills.find((s) => s.name === ctk.name)
      expect(skill).toBeDefined()
      // All CTK skills MUST declare an explicit outcome enum — no implicit
      // "complete" terminal state. The convention from Codex `task_outcome`
      // is success/partial/uncertain or skill-specific equivalents.
      expect(skill?.body).toContain("Outcome enum")
    }
  })

  test("babysit skill names the canonical 'gh pr checks' SoT (not 'GitHub UI')", async () => {
    const skills = await discoverSystemSkills()
    const babysit = skills.find((s) => s.name === "babysit")
    expect(babysit?.body).toContain("gh pr checks")
    // Adversarial: the babysit anti-pattern was to read CI state from the
    // web UI / memory. The skill body must explicitly forbid that.
    expect(babysit?.body.toLowerCase()).toMatch(/not.+infer.+from.+(?:web ui|memory)/is)
  })

  test("pr-review-canvas declares the moved-code detection invariant", async () => {
    const skills = await discoverSystemSkills()
    const canvas = skills.find((s) => s.name === "pr-review-canvas")
    expect(canvas?.body).toContain("moved-code")
    // The KILLER FEATURE: moved code is INVISIBLE by default — separated
    // from logic so reviewers see signal, not noise.
    expect(canvas?.body).toMatch(/INVISIBLE.+default/i)
  })

  test("loop-on-ci forbids --no-verify verbatim", async () => {
    const skills = await discoverSystemSkills()
    const ci = skills.find((s) => s.name === "loop-on-ci")
    expect(ci?.body).toContain("--no-verify")
    expect(ci?.body).toMatch(/--no-verify.+forbidden|forbidden.+--no-verify/i)
  })
})
