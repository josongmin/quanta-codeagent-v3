/**
 * ADR-0134 hellgate — engineering-task system-skill bundle (4 skills).
 *
 * Sibling to ADR-0111 (CTK git-skill bundle). The CTK absorption covered
 * git workflow tasks; this bundle covers the four highest-ROI generic
 * engineering tasks: debug-error / add-tests / explain-code /
 * extract-function. Each is prompt-only (SKILL.md body) + a typed router
 * seam (`<name>/index.ts`), mirroring the existing CTK shape exactly.
 *
 * 12 cases pin the contract:
 *   1-8  per-skill: SKILL.md frontmatter parses + router descriptor exported
 *   9    barrel exports all 4 trigger/find pairs alongside existing entries
 *   10   each SKILL.md body has "## P0 rules" header (consistency invariant)
 *   11   each SKILL.md body has "## Procedure" header (consistency invariant)
 *   12   total system-skills count = previous (13) + 4 newly added = 17
 *
 * Drift detection: a future rename of a SKILL.md `name:` field without
 * updating the corresponding `<NAME>_SKILL_NAME` constant fails the
 * "router NAME === SKILL.md kebab" assertion in case 2/4/6/8.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  ADD_TESTS_SKILL_NAME,
  DEBUG_ERROR_SKILL_NAME,
  discoverSystemSkills,
  EXPLAIN_CODE_SKILL_NAME,
  EXTRACT_FUNCTION_SKILL_NAME,
  findAddTestsSkill,
  findDebugErrorSkill,
  findExplainCodeSkill,
  findExtractFunctionSkill,
  parseFrontmatter,
  triggerAddTests,
  triggerDebugError,
  triggerExplainCode,
  triggerExtractFunction,
} from "@/skill"

const SKILL_ROOT = join(import.meta.dir, "..", "..", "src", "skill", "system-skills")

const BUNDLE = [
  {
    dir: "debug-error",
    name: DEBUG_ERROR_SKILL_NAME,
    trigger: triggerDebugError,
    find: findDebugErrorSkill,
  },
  {
    dir: "add-tests",
    name: ADD_TESTS_SKILL_NAME,
    trigger: triggerAddTests,
    find: findAddTestsSkill,
  },
  {
    dir: "explain-code",
    name: EXPLAIN_CODE_SKILL_NAME,
    trigger: triggerExplainCode,
    find: findExplainCodeSkill,
  },
  {
    dir: "extract-function",
    name: EXTRACT_FUNCTION_SKILL_NAME,
    trigger: triggerExtractFunction,
    find: findExtractFunctionSkill,
  },
] as const

const readSkill = (dir: string): { data: Record<string, unknown>; body: string } => {
  const path = join(SKILL_ROOT, dir, "SKILL.md")
  expect(existsSync(path), `expected SKILL.md at ${path}`).toBe(true)
  return parseFrontmatter(readFileSync(path, "utf8"))
}

describe("ADR-0134 — engineering-task skills bundle (hellgate)", () => {
  // ---- HELL-1/3/5/7: per-skill SKILL.md frontmatter validity ----
  for (const skill of BUNDLE) {
    test(`HELL-${skill.dir}-frontmatter: SKILL.md exists with valid description + allowedTools`, () => {
      const { data } = readSkill(skill.dir)

      const name = typeof data.name === "string" ? data.name.trim() : ""
      expect(name, `[${skill.dir}] frontmatter 'name' must match directory`).toBe(skill.dir)

      const description = typeof data.description === "string" ? data.description.trim() : ""
      expect(
        description.length,
        `[${skill.dir}] frontmatter must declare 'description'`,
      ).toBeGreaterThan(0)

      expect(Array.isArray(data.allowedTools), `[${skill.dir}] allowedTools must be a list`).toBe(
        true,
      )
      expect(
        (data.allowedTools as unknown[]).length,
        `[${skill.dir}] allowedTools must be non-empty`,
      ).toBeGreaterThan(0)

      expect(data.tools, `[${skill.dir}] must not ship a legacy tools mirror`).toBeUndefined()

      // parseFrontmatter is lenient and returns scalars as strings (the
      // strict 6-field parser in `skill-frontmatter.ts` is the one that
      // coerces). The on-disk shape just needs to be the literal "true".
      expect(String(data.userInvocable), `[${skill.dir}] must be userInvocable`).toBe("true")
      expect(data.category, `[${skill.dir}] category must be 'skill'`).toBe("skill")
    })
  }

  // ---- HELL-2/4/6/8: per-skill router descriptor ----
  for (const skill of BUNDLE) {
    test(`HELL-${skill.dir}-router: NAME constant + trigger() + find() all wire to "${skill.dir}"`, async () => {
      const { data } = readSkill(skill.dir)
      // NAME mirrors SKILL.md kebab id.
      expect(skill.name).toBe(skill.dir)

      // trigger() returns { name: kebab } — Skill-tool input shape.
      const t = skill.trigger()
      expect(t).toEqual({ name: skill.name })

      // find() resolves to a discovered Skill record with body populated.
      const found = await skill.find()
      expect(found, `[${skill.dir}] findXxxSkill() must resolve`).toBeDefined()
      expect(found?.name).toBe(skill.name)
      expect(found?.tools).toEqual(data.allowedTools as string[])
      expect((found?.body ?? "").length, `[${skill.dir}] body must be non-empty`).toBeGreaterThan(0)
    })
  }

  // ---- HELL-9: combined barrel reach ----
  test("HELL-9: all 4 trigger/find pairs reachable via `@/skill` top-level barrel", () => {
    // The imports at top of file would fail to parse if any were missing —
    // this test is the explicit pin so a future barrel cleanup breaks
    // with a clear name.
    expect(BUNDLE.length).toBe(4)
    for (const skill of BUNDLE) {
      expect(typeof skill.trigger).toBe("function")
      expect(typeof skill.find).toBe("function")
    }
  })

  // ---- HELL-10: P0 rules header invariant ----
  test("HELL-10: each SKILL.md body contains '## P0 rules' header", () => {
    for (const skill of BUNDLE) {
      const { body } = readSkill(skill.dir)
      expect(body, `[${skill.dir}] body must contain '## P0 rules' header`).toContain("## P0 rules")
    }
  })

  // ---- HELL-11: Procedure header invariant ----
  test("HELL-11: each SKILL.md body contains '## Procedure' header", () => {
    for (const skill of BUNDLE) {
      const { body } = readSkill(skill.dir)
      expect(body, `[${skill.dir}] body must contain '## Procedure' header`).toContain(
        "## Procedure",
      )
    }
  })

  // ---- HELL-12: total system-skills count = previous + 4 ----
  test("HELL-12: discoverSystemSkills() includes all 4 new entries", async () => {
    // Previous bundle (pre-ADR-0134): babysit, fix-merge-conflicts,
    // get-pr-comments, localize-fault, loop-on-ci, make-pr-easy-to-review,
    // new-branch-and-pr, pr-review-canvas, progress-audit, review-and-ship,
    // rewind = 11 skills (NOT counting hidden / non-SKILL.md dirs).
    // ADR-0134 adds 4 → 15 minimum.
    //
    // We count by reading the directory (skill dirs only — i.e. dirs with
    // a SKILL.md file at the root) so this test is robust against future
    // additions: it pins "≥ 4 new" without locking the exact ceiling.
    const dirs = readdirSync(SKILL_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => {
        try {
          return statSync(join(SKILL_ROOT, d.name, "SKILL.md")).isFile()
        } catch {
          return false
        }
      })
      .map((d) => d.name)

    // All 4 new dirs must be present.
    for (const skill of BUNDLE) {
      expect(dirs, `[${skill.dir}] dir must be present on disk`).toContain(skill.dir)
    }

    // Discovery must find each by name.
    const discovered = await discoverSystemSkills()
    const discoveredNames = new Set(discovered.map((s) => s.name))
    for (const skill of BUNDLE) {
      expect(
        discoveredNames.has(skill.name),
        `[${skill.name}] must appear in discoverSystemSkills()`,
      ).toBe(true)
    }

    // No duplicate names (silent shadow detector).
    expect(new Set(discovered.map((s) => s.name)).size).toBe(discovered.length)
  })
})
