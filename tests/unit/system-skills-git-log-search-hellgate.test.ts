/**
 * ADR-0172 hellgate — git-log-search system skill.
 *
 * Pins the SKILL.md frontmatter + body shape AND the router seam
 * (NAME constant / Trigger interface / triggerXxx() / findXxxSkill()).
 *
 * Research-grounded as a SKILL (not a tool): Cursor exposes
 * `blame_by_file_path` as an atomic tool but its git history-search
 * workflows live in CTK skills via `git`/`gh` shell — exploratory queries
 * need user iteration on a narrative workflow, not single-shot atomic
 * execution. See `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  discoverSystemSkills,
  findGitLogSearchSkill,
  GIT_LOG_SEARCH_SKILL_NAME,
  type GitLogSearchTrigger,
  parseFrontmatter,
  triggerGitLogSearch,
} from "@/skill"

const SKILL_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "skill",
  "system-skills",
  "git-log-search",
)
const SKILL_MD = join(SKILL_DIR, "SKILL.md")

describe("ADR-0172 — git-log-search system skill (hellgate)", () => {
  test("HELL-1: SKILL.md exists with full frontmatter shape (mirrors fix-merge-conflicts)", () => {
    expect(existsSync(SKILL_MD)).toBe(true)
    const { data } = parseFrontmatter(readFileSync(SKILL_MD, "utf8"))
    // name + description (strings)
    expect(data.name).toBe("git-log-search")
    expect(typeof data.description).toBe("string")
    expect((data.description as string).length).toBeGreaterThan(40)
    // userInvocable: true (strict parser accepts lowercase "true" string)
    expect(String(data.userInvocable).toLowerCase()).toBe("true")
    // Strict allowlist metadata is the on-disk SSOT.
    const allowedTools = (data.allowedTools ?? []) as string[]
    expect(allowedTools).toContain("Bash")
    expect(allowedTools).toContain("Read")
    expect(data.tools).toBeUndefined()
    // category / stability — same shape as siblings
    expect(data.category).toBe("skill")
    expect(data.stability).toBe("stable")
  })

  test("HELL-2: body has all required sections (no silent restructuring)", () => {
    const { body } = parseFrontmatter(readFileSync(SKILL_MD, "utf8"))
    const required = [
      "## When this skill activates",
      "## P0 rules",
      "## Procedure",
      "## What NOT to do",
      "## Common queries",
    ]
    for (const section of required) {
      expect(body.includes(section), `body must contain "${section}"`).toBe(true)
    }
  })

  test('HELL-3: router descriptor exported with kind="system" name="git-log-search"', async () => {
    // NAME constant matches kebab id.
    expect(GIT_LOG_SEARCH_SKILL_NAME).toBe("git-log-search")
    // triggerGitLogSearch() returns the typed trigger envelope.
    const trig: GitLogSearchTrigger = triggerGitLogSearch()
    expect(trig).toEqual({ name: "git-log-search" })
    // findGitLogSearchSkill() resolves via discoverSystemSkills() and the
    // discovered record has scope === "system" (path-inferred from
    // `src/skill/system-skills/`).
    const found = await findGitLogSearchSkill()
    expect(found).toBeDefined()
    expect(found?.name).toBe("git-log-search")
    expect(found?.scope).toBe("system")
    expect(found?.tools).toEqual(["Bash", "Read"])
    expect((found?.body ?? "").length).toBeGreaterThan(0)
    // Also reachable via the top-level discovery (no silent omission from barrel).
    const all = await discoverSystemSkills()
    expect(all.some((s) => s.name === "git-log-search")).toBe(true)
  })

  test("HELL-4: body mentions all 4 search modes (pickaxe / regex / author / since+file)", () => {
    const { body } = parseFrontmatter(readFileSync(SKILL_MD, "utf8"))
    // Pickaxe: `-S` flag
    expect(body.includes("-S")).toBe(true)
    expect(body.toLowerCase().includes("pickaxe")).toBe(true)
    // Regex: `-G` flag
    expect(body.includes("-G")).toBe(true)
    expect(body.toLowerCase().includes("regex")).toBe(true)
    // Author filter
    expect(body.includes("--author")).toBe(true)
    // Since (time) filter
    expect(body.includes("--since")).toBe(true)
    // Path filter (positional, shown as `-- <path>`)
    expect(body.includes("-- <path>")).toBe(true)
  })

  test("HELL-5: body cites ADR-0105 env hygiene + US-separator format", () => {
    const { body } = parseFrontmatter(readFileSync(SKILL_MD, "utf8"))
    // ADR-0105 env-hygiene quartet — all four env vars must appear so the
    // skill's procedure cannot drift away from the determinism contract.
    expect(body.includes("GIT_OPTIONAL_LOCKS=0")).toBe(true)
    expect(body.includes("GIT_PAGER=cat")).toBe(true)
    expect(body.includes("GIT_TERMINAL_PROMPT=0")).toBe(true)
    expect(body.includes("LC_ALL=C")).toBe(true)
    // ADR grounding explicit
    expect(body.includes("ADR-0105")).toBe(true)
    // US-separator (\x1f) format string verbatim — `%H%x1f%an%x1f%ai%x1f%s`.
    expect(body.includes("%H%x1f%an%x1f%ai%x1f%s")).toBe(true)
  })
})
