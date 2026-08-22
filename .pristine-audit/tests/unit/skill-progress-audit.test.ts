/**
 * Unit coverage for the bundled `progress-audit` system skill (ADR-0045).
 *
 * Four contracts are pinned here:
 *   1. The SKILL.md frontmatter is strict-shape clean (`allowedTools` SSOT),
 *      and discovery projects that metadata onto the runtime allowlist
 *      surface (`Skill.tools`) the host enforces.
 *   2. The skill BODY contains every P0 critical rule verbatim, IN ORDER,
 *      and each rule appears with its 1-based numbered prefix — these six
 *      rules are the entire reason the skill exists, so drift in the body
 *      OR the numbering must fail loudly at test time.
 *   3. `discoverSystemSkills()` picks up the skill on startup with the
 *      expected `name`, `description`, and `tools:` allowlist, AND is
 *      idempotent (two back-to-back calls return identical results).
 *   4. The Pass-3 wiring seams (`PROGRESS_AUDIT_SKILL_NAME`,
 *      `triggerProgressAudit`, `findProgressAuditSkill`) match the
 *      frontmatter, are router-agnostic, and stay byte-stable across calls.
 */
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  discoverSystemSkills,
  findProgressAuditSkill,
  PROGRESS_AUDIT_SKILL_NAME,
  parseFrontmatter,
  systemSkillsDir,
  triggerProgressAudit,
} from "../../src/skill"
import { parseSkillMarkdown } from "../../src/skill/skill-frontmatter"

const SKILL_MD = join(systemSkillsDir(), "progress-audit", "SKILL.md")

describe("progress-audit SKILL.md — frontmatter", () => {
  test("frontmatter exposes strict allowlist metadata and discovery preserves it at runtime", async () => {
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
    expect(data.allowedTools).toEqual(["Read", "Grep", "Bash"])
    expect(data.userInvocable).toBe("true")
    expect(data.category).toBe("skill")
    expect(data.stability).toBe("stable")
    const discovered = await findProgressAuditSkill()
    expect(Array.isArray(data.allowedTools)).toBe(true)
    if (!Array.isArray(data.allowedTools)) throw new Error("expected allowedTools array")
    expect(discovered?.tools).toEqual(data.allowedTools)
    // Body must be non-empty (the procedure section is load-bearing).
    expect(body.length).toBeGreaterThan(500)
  })

  test("strict parseSkillMarkdown accepts the bundled file as-is", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const r = parseSkillMarkdown(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.frontmatter.allowedTools).toEqual(["Read", "Grep", "Bash"])
  })

  test("lenient parser retains the strict-shape fields without a runtime mirror", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { data } = parseFrontmatter(raw)
    expect(data.allowedTools).toEqual(["Read", "Grep", "Bash"])
    expect(data.tools).toBeUndefined()
    expect(data.userInvocable).toBe("true")
    expect(data.category).toBe("skill")
    expect(data.stability).toBe("stable")
  })

  test("lenient parser carries the description's `never claims complete` promise", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { data } = parseFrontmatter(raw)
    // The frontmatter `description` carries the "never claims complete
    // without verification" promise so the trigger matcher surfaces the
    // discipline at catalogue-listing time, before the body is even read.
    expect(String(data.description).toLowerCase()).toContain("never claims")
  })
})

describe("progress-audit SKILL.md — P0 critical rules (structural)", () => {
  test("body contains all six P0 rules in order AND with 1..6 numbering", async () => {
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
    // STRUCTURAL: each rule appears as a numbered list item with `**Rule
    // phrase.**` (or `Rule phrase"`) bolded — i.e. the AUTHORING shape, not
    // just naked prose. Drift to "Six rules:" → bulleted format without
    // numbering would fail this assertion.
    for (let n = 1; n <= rulePhrases.length; n++) {
      const phrase = rulePhrases[n - 1]
      if (phrase === undefined) throw new Error("rulePhrases gap")
      // Escape the phrase for regex; the line shape is `<n>. **<phrase>...`
      // (the bold span may continue past the phrase since some rules have
      // a trailing period inside the bold range — anchor only on the
      // PREFIX). Multiline mode so `^` matches at line starts.
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      expect(body).toMatch(new RegExp(`^\\s*${n}\\.\\s+\\*\\*${escaped}`, "m"))
    }
  })

  test("body contains the outcome enum and forbids 'complete' wording", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
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
  })

  test("body lists the 7-step procedure with structural numbering", async () => {
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

  test("body contains the 'Source attribution' section pointing at Codex", async () => {
    // Provenance is load-bearing for the absorbed-from-Codex claim. If the
    // attribution gets stripped (e.g. accidental re-write), the test fails.
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
    expect(body).toContain("Source attribution")
    expect(body).toContain("Codex Desktop")
    expect(body).toContain("ADR-0045")
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

  test("discoverSystemSkills() is idempotent across back-to-back calls", async () => {
    // Two calls in a row MUST return structurally identical results.
    // (Filesystem IO is the only impurity; the result shape is deterministic.)
    const a = await discoverSystemSkills()
    const b = await discoverSystemSkills()
    expect(a).toHaveLength(b.length)
    // Compare each skill by serialisable fields — `sourcePath` is absolute
    // and stable so it serialises byte-identical too.
    for (let i = 0; i < a.length; i++) {
      const sa = a[i]
      const sb = b[i]
      expect(sa?.name).toBe(sb?.name ?? "")
      expect(sa?.description).toBe(sb?.description ?? "")
      expect(sa?.tools).toEqual(sb?.tools ?? [])
      expect(sa?.body).toBe(sb?.body ?? "")
      expect(sa?.sourcePath).toBe(sb?.sourcePath ?? "")
    }
  })

  test("discoverSystemSkills() returns skills sorted by name", async () => {
    const skills = await discoverSystemSkills()
    const names = skills.map((s) => s.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    // `discoverSkills` is documented as sorted-by-name; the system layer
    // delegates to it. This protects against a future refactor that
    // accidentally reorders.
    expect(names).toEqual(sorted)
  })
})

describe("progress-audit wiring seams (ADR-0045 §wiring)", () => {
  test("PROGRESS_AUDIT_SKILL_NAME matches the SKILL.md frontmatter `name:`", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { data } = parseFrontmatter(raw)
    // SSOT alignment: the exported constant MUST equal whatever the SKILL.md
    // declares. Renaming one without the other is a security-relevant drift
    // (a router would arm the wrong skill, or no skill at all). Compare via
    // string-typed locals so the narrow literal type on PROGRESS_AUDIT_SKILL_
    // NAME doesn't reject the runtime-extracted value at compile time.
    const declaredName: string = String(data.name ?? "")
    const constantName: string = PROGRESS_AUDIT_SKILL_NAME
    expect(constantName).toBe(declaredName)
  })

  test("triggerProgressAudit() returns the Skill-tool input shape", () => {
    const args = triggerProgressAudit()
    // Shape mirrors the `Skill` tool's input schema.
    expect(args).toEqual({ name: PROGRESS_AUDIT_SKILL_NAME })
    // Byte-stable: two calls return structurally identical objects (the
    // function is documented as pure / idempotent).
    const again = triggerProgressAudit()
    expect(again).toEqual(args)
  })

  test("findProgressAuditSkill() returns the discovered skill record", async () => {
    const pa = await findProgressAuditSkill()
    expect(pa).toBeDefined()
    if (!pa) return
    expect(pa.name).toBe(PROGRESS_AUDIT_SKILL_NAME)
    expect(pa.tools).toEqual(["Read", "Grep", "Bash"])
    expect(pa.body.length).toBeGreaterThan(500)
  })
})
