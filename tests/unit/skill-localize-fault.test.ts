/**
 * Unit coverage for the bundled `localize-fault` system skill (3-stage
 * Agentless fault localization funnel). Mirrors the `progress-audit` test
 * shape: frontmatter parse, body invariants (3 stages + outcome enum + signal
 * hierarchy), discovery, and wiring seams.
 */
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  discoverSystemSkills,
  findLocalizeFaultSkill,
  LOCALIZE_FAULT_SKILL_NAME,
  parseFrontmatter,
  systemSkillsDir,
  triggerLocalizeFault,
} from "../../src/skill"

const SKILL_MD = join(systemSkillsDir(), "localize-fault", "SKILL.md")

describe("localize-fault SKILL.md — frontmatter", () => {
  test("lenient parser extracts name, description, tools allowlist", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { data, body } = parseFrontmatter(raw)
    expect(data.name).toBe("localize-fault")
    expect(typeof data.description).toBe("string")
    // Trigger phrases must ride raw so the matcher in prompt.ts sees them.
    expect(data.description).toContain("localize")
    expect(data.description).toContain("어디서 깨지는지")
    expect(data.description).toContain("fault localization")
    // tools: is the runtime-enforcement seam — the 3-stage tool set.
    expect(data.tools).toEqual([
      "localize",
      "read",
      "grep",
      "glob",
      "lsp_document_symbol",
      "lsp_references",
      "diagnostics",
      "test_runner",
    ])
    expect(body.length).toBeGreaterThan(500)
  })

  test("dual-shape: allowedTools mirrors tools; strict-shape SSOT fields present", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { data } = parseFrontmatter(raw)
    expect(data.allowedTools).toEqual(data.tools)
    expect(data.userInvocable).toBe("true")
    expect(data.category).toBe("skill")
    expect(data.stability).toBe("stable")
  })
})

describe("localize-fault SKILL.md — body invariants", () => {
  test("body contains the 3 stages in order (file → function → edit-location)", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
    const stages = ["Stage 1 — FILE", "Stage 2 — FUNCTION", "Stage 3 — EDIT-LOCATION"]
    for (const s of stages) expect(body).toContain(s)
    // In order.
    let cursor = 0
    for (const s of stages) {
      const idx = body.indexOf(s, cursor)
      expect(idx).toBeGreaterThanOrEqual(cursor)
      cursor = idx + s.length
    }
  })

  test("body encodes the signal hierarchy (source text outranks rg hits)", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
    // The load-bearing rule: rg locates, source proves.
    expect(body).toMatch(/rg.*locates.*source.*proves|locates.*candidate.*reading the\s+source/i)
    expect(body).toContain("10/10 trust")
  })

  test("body has the outcome enum (located / narrowed / uncertain) and forbids premature 'found'", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
    expect(body).toContain("located")
    expect(body).toContain("narrowed")
    expect(body).toContain("uncertain")
    // `found`/`done` forbidden until Stage 2 source confirms.
    expect(body).toContain("forbidden")
  })

  test("body has the 4 truth surfaces (type/owner/wire/test) in Stage 3", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
    for (const surface of ["**type**", "**owner**", "**wire**", "**test**"]) {
      expect(body).toContain(surface)
    }
  })

  test("source attribution points at Agentless + Codex signal docs", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { body } = parseFrontmatter(raw)
    expect(body).toContain("Source attribution")
    expect(body).toContain("Agentless")
    expect(body).toContain("may-20-codex-signal.md")
  })
})

describe("discoverSystemSkills() — localize-fault present alongside progress-audit", () => {
  test("both bundled skills discovered, sorted by name", async () => {
    const skills = await discoverSystemSkills()
    const names = skills.map((s) => s.name)
    expect(names).toContain("localize-fault")
    expect(names).toContain("progress-audit")
    // sorted-by-name contract (localize-fault < progress-audit).
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })

  test("localize-fault carries the 3-stage tool allowlist + sourcePath", async () => {
    const lf = (await discoverSystemSkills()).find((s) => s.name === "localize-fault")
    expect(lf).toBeDefined()
    if (!lf) return
    expect(lf.tools).toContain("localize")
    expect(lf.tools).toContain("lsp_document_symbol")
    expect(lf.tools).toContain("lsp_references")
    expect(lf.sourcePath.endsWith("SKILL.md")).toBe(true)
  })
})

describe("localize-fault wiring seams", () => {
  test("LOCALIZE_FAULT_SKILL_NAME matches frontmatter name:", async () => {
    const raw = await readFile(SKILL_MD, "utf8")
    const { data } = parseFrontmatter(raw)
    const declared: string = String(data.name ?? "")
    const constant: string = LOCALIZE_FAULT_SKILL_NAME
    expect(constant).toBe(declared)
  })

  test("triggerLocalizeFault() returns the Skill-tool input shape, byte-stable", () => {
    const args = triggerLocalizeFault()
    expect(args).toEqual({ name: LOCALIZE_FAULT_SKILL_NAME })
    expect(triggerLocalizeFault()).toEqual(args)
  })

  test("findLocalizeFaultSkill() returns the discovered record", async () => {
    const lf = await findLocalizeFaultSkill()
    expect(lf).toBeDefined()
    if (!lf) return
    expect(lf.name).toBe(LOCALIZE_FAULT_SKILL_NAME)
    expect(lf.body.length).toBeGreaterThan(500)
  })
})
