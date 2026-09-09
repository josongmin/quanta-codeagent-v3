import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCliSkillAuthority } from "@/apps/cli/repl/session-setup"
import { buildWebSkillAuthority } from "@/apps/web-daemon/authority-readouts"
import {
  composeSessionSkillAuthority,
  SkillAdminPolicyLoadError,
} from "@/runner/assemble/session-authorities"
import { createInMemoryDisabledStore } from "@/skill"

const writeSkill = (dir: string, name: string): void => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name}`, "---", "body"].join("\n"),
  )
}

describe("G-F11 CLI/web org input surfaces", () => {
  test("CLI and web active sets honor the same resolved org policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "r16-surf-"))
    try {
      const userDir = join(root, "user")
      const orgDir = join(root, "org")
      writeSkill(userDir, "demo")
      writeSkill(join(orgDir, "admin-skills"), "admin-pin")
      writeFileSync(join(orgDir, "org-policy.json"), JSON.stringify({ bannedSkills: ["demo"] }))
      const env = { QUANTA_ORG_CONFIG_DIR: orgDir }
      const store = createInMemoryDisabledStore()
      const viaCompose = await composeSessionSkillAuthority({
        skills: { dir: userDir },
        env,
        disabledStore: store,
      })
      const cli = await buildCliSkillAuthority({ dir: userDir }, env)
      const web = await buildWebSkillAuthority({ dir: userDir }, env)
      const names = (a: typeof viaCompose) =>
        a
          ?.read()
          .active.map((s) => s.name)
          .sort()
      expect(names(viaCompose)).toContain("admin-pin")
      expect(names(viaCompose)).not.toContain("demo")
      expect(names(cli)).toContain("admin-pin")
      expect(names(cli)).not.toContain("demo")
      expect(names(web)).toContain("admin-pin")
      expect(names(web)).not.toContain("demo")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("empty QUANTA_ORG_CONFIG_DIR opts out on CLI and web", async () => {
    const root = mkdtempSync(join(tmpdir(), "r16-surf-opt-"))
    try {
      const userDir = join(root, "user")
      const orgDir = join(root, "org")
      writeSkill(userDir, "demo")
      mkdirSync(join(orgDir, "admin-skills"), { recursive: true })
      writeFileSync(join(orgDir, "org-policy.json"), JSON.stringify({ bannedSkills: ["demo"] }))
      const env = { QUANTA_ORG_CONFIG_DIR: orgDir }
      const opted = { QUANTA_ORG_CONFIG_DIR: "" }
      const banned = await buildCliSkillAuthority({ dir: userDir }, env)
      const cli = await buildCliSkillAuthority({ dir: userDir }, opted)
      const web = await buildWebSkillAuthority({ dir: userDir }, opted)
      expect(banned?.read().active.map((s) => s.name)).not.toContain("demo")
      expect(cli?.read().active.map((s) => s.name)).toContain("demo")
      expect(web?.read().active.map((s) => s.name)).toContain("demo")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("malformed org policy is fail-loud on CLI and web surfaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "r16-surf-bad-"))
    try {
      const userDir = join(root, "user")
      const orgDir = join(root, "org")
      writeSkill(userDir, "demo")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "org-policy.json"), '{ "bannedSkills": "nope" }')
      const env = { QUANTA_ORG_CONFIG_DIR: orgDir }
      await expect(buildCliSkillAuthority({ dir: userDir }, env)).rejects.toBeInstanceOf(
        SkillAdminPolicyLoadError,
      )
      await expect(buildWebSkillAuthority({ dir: userDir }, env)).rejects.toBeInstanceOf(
        SkillAdminPolicyLoadError,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
