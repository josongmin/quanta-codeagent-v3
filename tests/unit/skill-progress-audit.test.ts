/**
 * Unit coverage for the bundled `progress-audit` system skill (ADR-0045).
 *
 * Three contracts are pinned here:
 *   1. The SKILL.md frontmatter parses correctly through BOTH the lenient
 *      `parseFrontmatter` (which the discoverer uses to populate
 *      `Skill.tools`) AND the strict `parseSkillMarkdown` (which is the SSOT
 *      shape for category routing per ADR-0040). The skill ships both
 *      `tools:` (lenient runtime enforcement) and the strict 6-field set.
 *   2. The skill BODY contains every P0 critical rule verbatim — these six
 *      rules are the entire reason the skill exists, so drift in the body
 *      must fail loudly at test time.
 *   3. `discoverSystemSkills()` picks up the skill on startup with the
 *      expected `name`, `description`, and `tools:` allowlist.
 */
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { discoverSystemSkills, parseFrontmatter, systemSkillsDir } from "../../src/skill"
import { parseSkillMarkdown } from "../../src/skill/skill-frontmatter"

const SKILL_MD = join(systemSkillsDir(), "progress-audit", "SKILL.md")

describe("progress-audit SKILL.md — frontmatter", () => {
  test("lenient parser extracts name, description, tools allowlist", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { data, body } = parseFrontmatter(raw)
    expect(data.name).toBe("progress-audit")
    expect(typeof data.description).toBe("string")
    // The description carries the Korean trigger phrases that route the model
    // here. They must ride raw (no romanisation) so the trigger matcher in
    // prompt.ts sees them when the user types them.
    expect(data.description).toContain("진행률")
    expect(data.description).toContain("코드 레벨로만")
    expect(data.description).toContain("P0/P1/P2")
    // Lenient `tools:` is the runtime-enforcement seam — must list exactly
    // the three audit-safe tools (Read/Grep/Bash), in order.
    expect(data.tools).toEqual(["Read", "Grep", "Bash"])
    // Body must be non-empty (the procedure section is load-bearing).
    expect(body.length).toBeGreaterThan(500)
  })

  test("strict parseSkillMarkdown rejects (extra `tools:` key) — documents dual-shape state", async () => {
    // SSOT note: the SKILL.md ships BOTH `tools:` (for the existing host
    // enforcement path which reads the lenient field) AND the strict
    // 6-field shape (`userInvocable`/`allowedTools`/`category`/`stability`).
    // The strict parser uses `.strict()` and rejects unknown keys, so the
    // SKILL.md does not round-trip through it as-is. This is a known
    // limitation captured in ADR-0045 §한계: the lenient discoverer is the
    // SSOT for runtime today; a follow-up may collapse the dual shape.
    const raw = await readFile(SKILL_MD, "utf8")
    const r = parseSkillMarkdown(raw)
    expect(r.ok).toBe(false)
  })
})

describe("progress-audit SKILL.md — P0 critical rules", () => {
  test("body contains all six P0 rules in order", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
    // Each rule's load-bearing phrase. Drift in the wording is the bug the
    // test catches — the rules are the entire contract of the skill.
    const rulePhrases: readonly string[] = [
      "No finding without code evidence",
      "No grep-only proof",
      'No "looks fine" without an explicit review scope',
      "Partial proof is not closed",
      "Default review-only",
      "Stub / fallback / degraded rails stay visible",
    ]
    // Each rule appears.
    for (const p of rulePhrases) {
      expect(body).toContain(p)
    }
    // The rules appear IN ORDER (rule 1 before rule 2 before rule 3 …).
    let cursor = 0
    for (const p of rulePhrases) {
      const idx = body.indexOf(p, cursor)
      expect(idx).toBeGreaterThanOrEqual(cursor)
      cursor = idx + p.length
    }
  })

  test("body contains the outcome enum and forbids 'complete' wording", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { data, body } = parseFrontmatter(raw)
    // Outcome enum is the audit's terminal vocabulary.
    expect(body).toContain("success")
    expect(body).toContain("partial")
    expect(body).toContain("uncertain")
    // The skill must explicitly forbid the word `complete` in audit output.
    // The check is on the *prescription* (must mention forbidden token),
    // not a regex over the whole body — the body itself is allowed to USE
    // the word inside an instruction sentence ("forbidden", "without
    // running step 6").
    expect(body).toContain("forbidden")
    // The frontmatter `description` carries the "never claims complete without
    // verification" promise so the trigger matcher surfaces the discipline at
    // catalogue-listing time, before the body is even read.
    expect(String(data.description).toLowerCase()).toContain("never claims")
  })

  test("body lists the 7-step procedure", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
    // Each step header. Numbering must be 1..7 so the model can resume mid-
    // procedure if interrupted (rule 1: restart from the last completed step).
    for (let n = 1; n <= 7; n++) {
      expect(body).toMatch(new RegExp(`^\\s*${n}\\.\\s+\\*\\*`, "m"))
    }
    // Step 6 specifically mandates verification (tests / commands), which is
    // the promotion path from `partial` to `success`.
    expect(body).toContain("Verify with the narrowest trustworthy command")
  })
})

describe("discoverSystemSkills() — bundled discovery", () => {
  test("returns the progress-audit skill on startup", async () => {
    const skills = await discoverSystemSkills()
    const names = skills.map((s) => s.name)
    expect(names).toContain("progress-audit")
  })

  test("progress-audit skill has the audit-safe tool allowlist", async () => {
    const skills = await discoverSystemSkills()
    const pa = skills.find((s) => s.name === "progress-audit")
    expect(pa).toBeDefined()
    if (!pa) return
    // tools: is what the host wires into `skillToolAllowlist` for the gate.
    expect(pa.tools).toEqual(["Read", "Grep", "Bash"])
    // Description is the model-facing trigger-match surface.
    expect(pa.description).toContain("진행률")
    expect(pa.description).toContain("code-only")
    // Source path comes back as an absolute path; sanity-check it ends with
    // the expected file name so a misconfigured discoverer fails loudly.
    expect(pa.sourcePath.endsWith("SKILL.md")).toBe(true)
  })

  test("systemSkillsDir() points at a real directory containing the skill", async () => {
    const dir = systemSkillsDir()
    expect(typeof dir).toBe("string")
    expect(dir.length).toBeGreaterThan(0)
    // The skill's SKILL.md must exist on disk relative to this dir.
    const raw = await readFile(join(dir, "progress-audit", "SKILL.md"), "utf8")
    expect(raw).toContain("name: progress-audit")
  })
})
