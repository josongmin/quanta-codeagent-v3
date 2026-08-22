/**
 * Smoke test for the CTK git-skill bundle (ADR-0111).
 *
 * Eight system skills are bundled under `src/skill/system-skills/<name>/SKILL.md`,
 * adapted from Cursor's cursor-team-kit (CTK). This is a minimal file-presence +
 * frontmatter contract test — deeper invariants live in
 * `tests/unit/ctk-git-skills-hellgate.test.ts` and `…-router-hellgate.test.ts`.
 *
 * What it pins:
 *   1. All 8 SKILL.md files exist at the expected on-disk path.
 *   2. Each file has a parseable frontmatter block with `name` and
 *      `description` present.
 *   3. The 8 `name` fields are unique (no silent duplicate).
 *
 * What it deliberately does NOT pin (left to richer hellgate tests):
 *   - Anchor phrases / per-skill body invariants.
 *   - `allowedTools` / `category` / `stability` field shapes.
 *   - Activation glob (`paths:`) behavior.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter } from "@/skill"

const SKILL_ROOT = join(import.meta.dir, "..", "..", "src", "skill", "system-skills")

const GIT_BUNDLE = [
  "babysit",
  "fix-merge-conflicts",
  "get-pr-comments",
  "loop-on-ci",
  "make-pr-easy-to-review",
  "new-branch-and-pr",
  "pr-review-canvas",
  "review-and-ship",
] as const

describe("ADR-0111 — CTK git-skill bundle (smoke)", () => {
  test("all 8 SKILL.md files exist at the expected path", () => {
    for (const name of GIT_BUNDLE) {
      const path = join(SKILL_ROOT, name, "SKILL.md")
      expect(existsSync(path), `expected SKILL.md at ${path}`).toBe(true)
    }
  })

  test("each SKILL.md parses with non-empty name and description", () => {
    for (const dirName of GIT_BUNDLE) {
      const path = join(SKILL_ROOT, dirName, "SKILL.md")
      const raw = readFileSync(path, "utf8")
      const { data, body } = parseFrontmatter(raw)

      const name = typeof data.name === "string" ? data.name.trim() : ""
      expect(name, `[${dirName}] frontmatter must declare 'name'`).not.toBe("")

      // description: prefer frontmatter, fall back to first non-empty body
      // line (matching discoverSkills() shaping behavior).
      const fmDesc = typeof data.description === "string" ? data.description.trim() : ""
      const bodyDesc =
        body
          .split("\n")
          .find((l) => l.trim() !== "")
          ?.trim() ?? ""
      expect(
        fmDesc !== "" || bodyDesc !== "",
        `[${dirName}] must have a description (frontmatter or first body line)`,
      ).toBe(true)
    }
  })

  test("the 8 declared names are unique (no silent duplicate id)", () => {
    const names: string[] = []
    for (const dirName of GIT_BUNDLE) {
      const path = join(SKILL_ROOT, dirName, "SKILL.md")
      const { data } = parseFrontmatter(readFileSync(path, "utf8"))
      const name = typeof data.name === "string" ? data.name.trim() : dirName
      names.push(name)
    }
    expect(new Set(names).size).toBe(GIT_BUNDLE.length)
  })

  test("each SKILL.md frontmatter 'name' matches its directory name", () => {
    // Drift between directory and declared name silently breaks
    // discoverSystemSkills() routing.
    for (const dirName of GIT_BUNDLE) {
      const path = join(SKILL_ROOT, dirName, "SKILL.md")
      const { data } = parseFrontmatter(readFileSync(path, "utf8"))
      const name = typeof data.name === "string" ? data.name.trim() : ""
      expect(name, `[${dirName}] frontmatter 'name' must match directory`).toBe(dirName)
    }
  })
})
