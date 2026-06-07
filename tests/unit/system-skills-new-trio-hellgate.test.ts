/**
 * ADR-0176 hellgate — debug/blame skills trio (3 prompt-only system skills).
 *
 * Sibling cluster to git-log-search (ADR-0173). The three skills:
 *   - debug-trace          orchestrates crash investigation (parse → read → hypothesis)
 *   - explain-stack-trace  pure read-only narrative explainer (no fix proposal)
 *   - blame-section        multi-line section ownership wrapping git_blame_heatmap
 *
 * Each skill follows the SAME shape as `git-log-search`: prompt-only
 * (SKILL.md body + frontmatter mirroring strict + lenient parsers) + a
 * router seam (`<NAME>_SKILL_NAME` + `<Name>Trigger` + `trigger<Name>()` +
 * `find<Name>Skill()`).
 *
 * Nine cases pin the contract (3 per skill):
 *   HELL-<dir>-1   frontmatter valid + 5 required fields present
 *   HELL-<dir>-2   router descriptor exports NAME + trigger() + find() AND
 *                  is reachable via discoverSystemSkills()
 *   HELL-<dir>-3   body has all 5 required sections AND cites the specific
 *                  tool names declared in allowedTools
 *
 * Research-grounded as a SKILL trio (not tools): Cursor exposes per-action
 * tools (`blame_by_file_path`) but workflow-shaped tasks (`pr-review-canvas`,
 * `make-pr-easy-to-review`) live in CTK skills via gh/git shell — exploratory
 * crash/blame queries need user iteration, not single-shot execution. See
 * `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BLAME_SECTION_SKILL_NAME,
  type BlameSectionTrigger,
  DEBUG_TRACE_SKILL_NAME,
  type DebugTraceTrigger,
  discoverSystemSkills,
  EXPLAIN_STACK_TRACE_SKILL_NAME,
  type ExplainStackTraceTrigger,
  findBlameSectionSkill,
  findDebugTraceSkill,
  findExplainStackTraceSkill,
  parseFrontmatter,
  type Skill,
  triggerBlameSection,
  triggerDebugTrace,
  triggerExplainStackTrace,
} from "@/skill"

const SKILL_ROOT = join(import.meta.dir, "..", "..", "src", "skill", "system-skills")

// Spec table: each entry pins the SKILL.md frontmatter shape + the router
// seam + the body's required tool-name citations (P0 rules cite specific
// allowedTools so drift to a generic phrasing fails HELL-3).
type SkillSpec = {
  readonly dir: string
  readonly name: string
  readonly trigger: () => { readonly name: string }
  readonly find: () => Promise<Skill | undefined>
  readonly expectedAllowedTools: ReadonlyArray<string>
  readonly bodyMustCiteTools: ReadonlyArray<string>
}

const SPECS: ReadonlyArray<SkillSpec> = [
  {
    dir: "debug-trace",
    name: DEBUG_TRACE_SKILL_NAME,
    trigger: triggerDebugTrace as () => DebugTraceTrigger,
    find: findDebugTraceSkill,
    expectedAllowedTools: ["Bash", "Read", "Grep", "parse_test_failure", "file_tree_summary"],
    // P0 rules MUST cite the deterministic parser by name (rule 1) and the
    // read tool (rule 2). file_tree_summary is mentioned in Procedure step 3.
    bodyMustCiteTools: ["parse_test_failure", "Read"],
  },
  {
    dir: "explain-stack-trace",
    name: EXPLAIN_STACK_TRACE_SKILL_NAME,
    trigger: triggerExplainStackTrace as () => ExplainStackTraceTrigger,
    find: findExplainStackTraceSkill,
    expectedAllowedTools: ["Read", "Grep", "parse_test_failure"],
    // Pure read-only: P0 rule 1 cites parse_test_failure; Procedure step 2
    // cites Read.
    bodyMustCiteTools: ["parse_test_failure", "Read"],
  },
  {
    dir: "blame-section",
    name: BLAME_SECTION_SKILL_NAME,
    trigger: triggerBlameSection as () => BlameSectionTrigger,
    find: findBlameSectionSkill,
    expectedAllowedTools: ["Bash", "Read", "git_blame", "git_blame_heatmap"],
    // P0 rule 1 names git_blame_heatmap + start_line/end_line; the alternate
    // git_blame is in the allowlist for the original-vs-recent distinction.
    bodyMustCiteTools: ["git_blame_heatmap", "start_line", "end_line"],
  },
] as const

const REQUIRED_SECTIONS = [
  "## When this skill activates",
  "## P0 rules",
  "## Procedure",
  "## What NOT to do",
  "## Common queries",
] as const

const readSkill = (dir: string): { data: Record<string, unknown>; body: string } => {
  const path = join(SKILL_ROOT, dir, "SKILL.md")
  expect(existsSync(path), `expected SKILL.md at ${path}`).toBe(true)
  return parseFrontmatter(readFileSync(path, "utf8"))
}

describe("ADR-0176 — debug/blame skills trio (hellgate)", () => {
  for (const spec of SPECS) {
    // ---- HELL-<dir>-1: frontmatter valid + 5 required fields present ----
    test(`HELL-${spec.dir}-1: SKILL.md frontmatter has all 5 required fields (name/description/userInvocable/allowedTools/category+stability)`, () => {
      const { data } = readSkill(spec.dir)

      // name matches directory (drift catcher)
      const name = typeof data.name === "string" ? data.name.trim() : ""
      expect(name, `[${spec.dir}] frontmatter 'name' must match directory`).toBe(spec.dir)

      // description present + meaningful length
      const description = typeof data.description === "string" ? data.description.trim() : ""
      expect(
        description.length,
        `[${spec.dir}] frontmatter must declare 'description'`,
      ).toBeGreaterThan(40)

      // userInvocable: true (lenient parser yields string "true")
      expect(
        String(data.userInvocable).toLowerCase(),
        `[${spec.dir}] must be userInvocable: true`,
      ).toBe("true")

      // allowedTools is a non-empty list AND contains the spec'd tools
      expect(Array.isArray(data.allowedTools), `[${spec.dir}] allowedTools must be a list`).toBe(
        true,
      )
      const allowedTools = data.allowedTools as ReadonlyArray<string>
      for (const tool of spec.expectedAllowedTools) {
        expect(allowedTools, `[${spec.dir}] allowedTools must contain ${tool}`).toContain(tool)
      }

      expect(data.tools, `[${spec.dir}] must not ship a legacy tools mirror`).toBeUndefined()

      // category/stability — same shape as siblings
      expect(data.category, `[${spec.dir}] category must be 'skill'`).toBe("skill")
      expect(data.stability, `[${spec.dir}] stability must be 'stable'`).toBe("stable")
    })
  }

  for (const spec of SPECS) {
    // ---- HELL-<dir>-2: router descriptor exports NAME + trigger() + find() ----
    test(`HELL-${spec.dir}-2: router exports NAME + trigger() + find() AND reachable via discoverSystemSkills()`, async () => {
      // NAME mirrors SKILL.md kebab id (compile-time literal)
      expect(spec.name).toBe(spec.dir)

      // trigger() returns the typed envelope, byte-stable
      const trig = spec.trigger()
      expect(trig).toEqual({ name: spec.dir })

      // find() resolves via discoverSystemSkills(); scope = "system"
      const found = await spec.find()
      expect(found, `[${spec.dir}] find${spec.dir}Skill() must resolve`).toBeDefined()
      expect(found?.name).toBe(spec.dir)
      expect(found?.scope).toBe("system")
      expect(found?.tools).toEqual([...spec.expectedAllowedTools])
      expect((found?.body ?? "").length).toBeGreaterThan(0)

      // Reachable via top-level discovery (no silent barrel omission)
      const all = await discoverSystemSkills()
      expect(
        all.some((s) => s.name === spec.dir),
        `[${spec.dir}] must be reachable via discoverSystemSkills()`,
      ).toBe(true)
    })
  }

  for (const spec of SPECS) {
    // ---- HELL-<dir>-3: body has all 5 required sections + cites tools ----
    test(`HELL-${spec.dir}-3: body has all 5 required sections AND cites specific allowedTools names`, () => {
      const { body } = readSkill(spec.dir)

      // All 5 required sections present (no silent restructuring)
      for (const section of REQUIRED_SECTIONS) {
        expect(body.includes(section), `[${spec.dir}] body must contain "${section}"`).toBe(true)
      }

      // Body cites the specific tool names from allowedTools (not generic
      // phrasing like "use the parser"). This catches drift where the
      // SKILL.md prose decouples from the declared toolset.
      for (const toolName of spec.bodyMustCiteTools) {
        expect(
          body.includes(toolName),
          `[${spec.dir}] body must cite specific tool name "${toolName}"`,
        ).toBe(true)
      }
    })
  }
})
