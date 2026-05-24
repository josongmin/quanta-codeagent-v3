/**
 * ADR-0134 Phase A — Skill scope + install-state types + frontmatter strict
 * schema. This file pins the type-level + parser-level contracts that the
 * registry (Phase B) and admin enforcement (Phase C) will rely on.
 *
 * Coverage:
 *  1. SkillScope enum — 7 values, round-trip via isSkillScope guard
 *  2. SkillInstallState enum — 3 values, round-trip via isSkillInstallState
 *  3. SKILL_SCOPES_PRECEDENCE_DESC order — admin first, builtIn last
 *  4. Frontmatter strict — extra fields rejected (existing invariant preserved)
 *  5. Frontmatter scope optional — absent ⇒ undefined (path-infer happens
 *     downstream in discovery)
 *  6. Frontmatter scope explicit — valid scope round-trips
 *  7. Frontmatter scope invalid — unknown token rejected by strict parser
 *  8. Frontmatter installState explicit — valid value round-trips
 *  9. Frontmatter admin scope + no installState ⇒ backfilled to "required"
 * 10. Frontmatter admin scope + installState='optional' ⇒ rejected (contradiction)
 * 11. Frontmatter adminInstalledBy without admin scope ⇒ rejected
 * 12. Discovery path-infer: ~/.claude/skills/ ⇒ 'user'
 * 13. Discovery path-infer: <repo>/.quanta/skills/ ⇒ 'repo'
 * 14. Discovery path-infer: src/skill/system-skills/ ⇒ 'system'
 * 15. Discovery path-infer: <home>/.quanta/personal-skills/ ⇒ 'personal'
 * 16. Discovery path-infer: <org>/admin-skills/ ⇒ 'admin'
 * 17. Discovery path-infer: anything else ⇒ 'builtIn'
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverSkills,
  isSkillInstallState,
  isSkillScope,
  SKILL_INSTALL_STATES,
  SKILL_SCOPES,
  SKILL_SCOPES_PRECEDENCE_DESC,
  skillScope,
} from "@/skill"
import { parseSkillMarkdown } from "@/skill/skill-frontmatter"
import type { Skill } from "@/skill/types"

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "skill-scope-types-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const writeSkill = async (dir: string, body: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "SKILL.md"), body)
}

describe("SkillScope enum", () => {
  test("contains exactly 7 scope values", () => {
    expect([...SKILL_SCOPES].sort()).toEqual(
      ["admin", "builtIn", "personal", "repo", "system", "team", "user"].sort(),
    )
  })

  test("isSkillScope accepts every literal", () => {
    for (const s of SKILL_SCOPES) expect(isSkillScope(s)).toBe(true)
  })

  test("isSkillScope rejects unknown / non-string", () => {
    expect(isSkillScope("plugin")).toBe(false)
    expect(isSkillScope("ADMIN")).toBe(false)
    expect(isSkillScope(undefined)).toBe(false)
    expect(isSkillScope(null)).toBe(false)
    expect(isSkillScope(7)).toBe(false)
    expect(isSkillScope({})).toBe(false)
  })

  test("skillScope() returns the tagged value or 'builtIn' fallback", () => {
    expect(skillScope({ scope: "admin" })).toBe("admin")
    expect(skillScope({ scope: "user" })).toBe("user")
    expect(skillScope({})).toBe("builtIn") // ADR-0134 default fallback
  })
})

describe("SkillInstallState enum", () => {
  test("contains exactly 3 install-state values", () => {
    expect([...SKILL_INSTALL_STATES].sort()).toEqual(["optional", "recommended", "required"])
  })

  test("isSkillInstallState round-trip", () => {
    for (const s of SKILL_INSTALL_STATES) expect(isSkillInstallState(s)).toBe(true)
    expect(isSkillInstallState("forced")).toBe(false)
    expect(isSkillInstallState(null)).toBe(false)
  })
})

describe("SKILL_SCOPES_PRECEDENCE_DESC", () => {
  test("admin is highest, builtIn is lowest", () => {
    expect(SKILL_SCOPES_PRECEDENCE_DESC[0]).toBe("admin")
    expect(SKILL_SCOPES_PRECEDENCE_DESC[SKILL_SCOPES_PRECEDENCE_DESC.length - 1]).toBe("builtIn")
  })

  test("contains all 7 scopes exactly once", () => {
    expect([...SKILL_SCOPES_PRECEDENCE_DESC].sort()).toEqual([...SKILL_SCOPES].sort())
  })

  test("ADR-0134 fixed order", () => {
    expect([...SKILL_SCOPES_PRECEDENCE_DESC]).toEqual([
      "admin",
      "repo",
      "team",
      "user",
      "personal",
      "system",
      "builtIn",
    ])
  })
})

describe("strict frontmatter — pre-0134 invariants", () => {
  const VALID_MINIMAL = [
    "---",
    "name: my-skill",
    "description: a short desc",
    "userInvocable: true",
    "allowedTools: [Read]",
    "category: skill",
    "stability: stable",
    "---",
    "body",
  ].join("\n")

  test("baseline minimal frontmatter parses", () => {
    const r = parseSkillMarkdown(VALID_MINIMAL)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.frontmatter.name).toBe("my-skill")
    expect(r.value.frontmatter.scope).toBeUndefined()
    expect(r.value.frontmatter.installState).toBeUndefined()
  })

  test("extra unknown field is rejected", () => {
    const bad = VALID_MINIMAL.replace("stability: stable", "stability: stable\nfoo: bar")
    const r = parseSkillMarkdown(bad)
    expect(r.ok).toBe(false)
  })
})

describe("strict frontmatter — ADR-0134 scope/installState fields", () => {
  const base = (extra: string): string =>
    [
      "---",
      "name: my-skill",
      "description: d",
      "userInvocable: true",
      "allowedTools: [Read]",
      "category: skill",
      "stability: stable",
      extra,
      "---",
      "body",
    ].join("\n")

  test("explicit scope: user round-trips", () => {
    const r = parseSkillMarkdown(base("scope: user"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.frontmatter.scope).toBe("user")
  })

  test("explicit scope: admin without installState ⇒ backfilled to required", () => {
    const r = parseSkillMarkdown(base("scope: admin"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.frontmatter.scope).toBe("admin")
    expect(r.value.frontmatter.installState).toBe("required")
  })

  test("explicit scope: admin + installState: optional ⇒ rejected (contradiction)", () => {
    const r = parseSkillMarkdown(base("scope: admin\ninstallState: optional"))
    expect(r.ok).toBe(false)
  })

  test("unknown scope token ⇒ rejected (closed union)", () => {
    const r = parseSkillMarkdown(base("scope: plugin"))
    expect(r.ok).toBe(false)
  })

  test("adminInstalledBy without admin scope ⇒ rejected", () => {
    const r = parseSkillMarkdown(base("scope: user\nadminInstalledBy: org-x"))
    expect(r.ok).toBe(false)
  })

  test("adminInstalledBy with admin scope ⇒ accepted", () => {
    const r = parseSkillMarkdown(base("scope: admin\nadminInstalledBy: acme-corp"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.frontmatter.adminInstalledBy).toBe("acme-corp")
  })
})

describe("discovery path-inferred scope (lenient parser)", () => {
  const MINI = ["---", "name: x", "description: d", "---", "body"].join("\n")

  const expectScopeForPath = async (suffix: string, expected: Skill["scope"]): Promise<void> => {
    const dir = join(root, suffix)
    await writeSkill(join(dir, "x"), MINI)
    const skills = await discoverSkills(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.scope).toBe(expected)
  }

  test("path containing .claude/skills/ ⇒ user (pre-0134 location)", async () => {
    await expectScopeForPath("home/.claude/skills", "user")
  })

  test("path containing .quanta/skills/ ⇒ repo", async () => {
    await expectScopeForPath("repo/.quanta/skills", "repo")
  })

  test("path containing .quanta/personal-skills/ ⇒ personal", async () => {
    await expectScopeForPath("home/.quanta/personal-skills", "personal")
  })

  test("path containing admin-skills/ ⇒ admin", async () => {
    await expectScopeForPath("org/admin-skills", "admin")
  })

  test("path containing .team-skills/ ⇒ team", async () => {
    await expectScopeForPath("repo/.team-skills", "team")
  })

  test("path containing skill/system-skills/ ⇒ system", async () => {
    await expectScopeForPath("src/skill/system-skills", "system")
  })

  test("unrelated path ⇒ builtIn fallback", async () => {
    await expectScopeForPath("misc-vault", "builtIn")
  })

  test("explicit frontmatter scope wins over path inference", async () => {
    // Use a fresh root subtree so earlier tests' fixtures don't shadow this one.
    const fresh = join(root, "override-test/repo/.quanta/skills")
    const dir = join(fresh, "overridden")
    // Repo-path inference would give 'repo'; explicit 'user' must win.
    const body = ["---", "name: overridden", "description: d", "scope: user", "---", "body"].join(
      "\n",
    )
    await writeSkill(dir, body)
    const skills = await discoverSkills(fresh)
    const sk = skills.find((s) => s.name === "overridden")
    expect(sk?.scope).toBe("user")
  })
})
