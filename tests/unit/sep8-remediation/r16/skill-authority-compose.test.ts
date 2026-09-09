import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  composeSessionSkillAuthority,
  SkillAdminPolicyLoadError,
} from "@/runner/assemble/session-authorities"
import { createInMemoryDisabledStore, type DisabledStorePort } from "@/skill"

const throwingDisabledStore = (): DisabledStorePort => ({
  read: async () => {
    throw new Error("store down")
  },
  write: async () => undefined,
  mutate: async () => {
    throw new Error("store down")
  },
})

const writeSkill = (dir: string, name: string): void => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name}`, "---", "body"].join("\n"),
  )
}

describe("G-F11 composeSessionSkillAuthority", () => {
  test("env org dir applies banned/required; explicit null opt-out does not", async () => {
    const root = mkdtempSync(join(tmpdir(), "r16-org-"))
    try {
      const userDir = join(root, "user")
      const orgDir = join(root, "org")
      writeSkill(userDir, "demo")
      writeSkill(userDir, "other")
      mkdirSync(join(orgDir, "admin-skills"), { recursive: true })
      writeFileSync(
        join(orgDir, "org-policy.json"),
        JSON.stringify({ bannedSkills: ["demo"], requiredSkills: ["other"] }),
      )
      const emptySystem = join(root, "system")
      mkdirSync(emptySystem, { recursive: true })
      const env = { QUANTA_ORG_CONFIG_DIR: orgDir }
      const enforced = await composeSessionSkillAuthority({
        skills: { dir: userDir },
        env,
        systemDir: emptySystem,
        disabledStore: createInMemoryDisabledStore(),
      })
      expect(enforced?.read().active.map((s) => s.name)).toEqual(["other"])
      expect(enforced?.read().management.find((m) => m.name === "demo")?.disableReason).toBe(
        "administrator",
      )

      const optedOut = await composeSessionSkillAuthority({
        skills: { dir: userDir },
        env,
        orgConfigDir: null,
        systemDir: emptySystem,
        disabledStore: createInMemoryDisabledStore(),
      })
      expect(
        optedOut
          ?.read()
          .active.map((s) => s.name)
          .sort(),
      ).toEqual(["demo", "other"])

      const xdg = join(root, "xdg")
      const defaultOrg = join(xdg, "quanta", "org")
      mkdirSync(join(defaultOrg, "admin-skills"), { recursive: true })
      writeFileSync(
        join(defaultOrg, "org-policy.json"),
        JSON.stringify({ bannedSkills: ["demo"], requiredSkills: ["other"] }),
      )
      const fromDefault = await composeSessionSkillAuthority({
        skills: { dir: userDir },
        env: { XDG_CONFIG_HOME: xdg },
        systemDir: emptySystem,
        disabledStore: createInMemoryDisabledStore(),
      })
      expect(fromDefault?.read().active.map((s) => s.name)).toEqual(["other"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("malformed org policy is fail-loud, not silent disable", async () => {
    const root = mkdtempSync(join(tmpdir(), "r16-bad-"))
    try {
      const userDir = join(root, "user")
      writeSkill(userDir, "demo")
      await expect(
        composeSessionSkillAuthority({
          skills: { dir: userDir },
          env: {},
          orgConfigDir: root,
          readPolicyFile: async () => '{ "bannedSkills": "nope" }',
          disabledStore: createInMemoryDisabledStore(),
        }),
      ).rejects.toBeInstanceOf(SkillAdminPolicyLoadError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("generic construction failure warns once and fail-opens", async () => {
    const seen: string[] = []
    const result = await composeSessionSkillAuthority({
      skills: {},
      env: {},
      warn: (info) => {
        seen.push(info.error)
      },
      disabledStore: throwingDisabledStore(),
    })
    expect(result).toBeUndefined()
    expect(seen).toEqual(["store down"])
  })

  test("generic construction warning redacts secrets", async () => {
    const seen: string[] = []
    const secret = `ghp_${"A".repeat(36)}`
    const result = await composeSessionSkillAuthority({
      skills: {},
      env: {},
      warn: (info) => {
        seen.push(info.error)
      },
      disabledStore: {
        read: async () => {
          throw new Error(`store down ${secret}`)
        },
        write: async () => undefined,
        mutate: async () => {
          throw new Error(`store down ${secret}`)
        },
      },
    })
    expect(result).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toContain(secret)
    expect(seen[0]).toContain("[REDACTED")
  })

  test("throwing warning sink still fail-opens", async () => {
    const result = await composeSessionSkillAuthority({
      skills: {},
      env: {},
      warn: () => {
        throw new Error("sink")
      },
      disabledStore: throwingDisabledStore(),
    })
    expect(result).toBeUndefined()
  })
})
