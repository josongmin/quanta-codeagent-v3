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
import { createInMemoryDisabledStore, DISABLED_SET_SCHEMA_VERSION } from "@/skill"

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

  test("required pin beats user disable on CLI and web", async () => {
    const root = mkdtempSync(join(tmpdir(), "r16-surf-req-"))
    try {
      const userDir = join(root, "user")
      const orgDir = join(root, "org")
      writeSkill(userDir, "r16-keep")
      writeSkill(userDir, "r16-demo")
      writeFileSync(
        join(userDir, ".disabled.json"),
        JSON.stringify({
          schemaVersion: DISABLED_SET_SCHEMA_VERSION,
          revision: 1,
          names: ["r16-keep", "r16-demo"],
        }),
      )
      mkdirSync(join(orgDir, "admin-skills"), { recursive: true })
      writeFileSync(
        join(orgDir, "org-policy.json"),
        JSON.stringify({ bannedSkills: ["r16-demo"], requiredSkills: ["r16-keep"] }),
      )
      const env = { QUANTA_ORG_CONFIG_DIR: orgDir }
      const opted = { QUANTA_ORG_CONFIG_DIR: "" }
      const cli = await buildCliSkillAuthority({ dir: userDir }, env)
      const web = await buildWebSkillAuthority({ dir: userDir }, env)
      const off = await buildCliSkillAuthority({ dir: userDir }, opted)
      const active = (a: typeof cli) => a?.read().active.map((s) => s.name) ?? []
      expect(active(cli)).toContain("r16-keep")
      expect(active(cli)).not.toContain("r16-demo")
      expect(active(web)).toContain("r16-keep")
      expect(active(web)).not.toContain("r16-demo")
      expect(off?.read().management.find((m) => m.name === "r16-keep")?.disableReason).toBe("user")
      expect(active(off)).not.toContain("r16-keep")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("XDG default org dir applies on CLI and web when env is omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "r16-surf-xdg-"))
    try {
      const userDir = join(root, "user")
      const xdg = join(root, "xdg")
      const orgDir = join(xdg, "quanta", "org")
      writeSkill(userDir, "r16-demo")
      mkdirSync(join(orgDir, "admin-skills"), { recursive: true })
      writeFileSync(join(orgDir, "org-policy.json"), JSON.stringify({ bannedSkills: ["r16-demo"] }))
      const env = { XDG_CONFIG_HOME: xdg }
      const cli = await buildCliSkillAuthority({ dir: userDir }, env)
      const web = await buildWebSkillAuthority({ dir: userDir }, env)
      expect(cli?.read().active.map((s) => s.name)).not.toContain("r16-demo")
      expect(web?.read().active.map((s) => s.name)).not.toContain("r16-demo")
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
