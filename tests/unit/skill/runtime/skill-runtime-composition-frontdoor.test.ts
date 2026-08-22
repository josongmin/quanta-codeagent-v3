/**
 * RFC-06 F1 front-door — the production composition binding
 * (`buildSkillRuntimeAuthority`) calls the REAL registry + admin-policy loaders.
 *
 * RFC-06: "The production composition test must show a real loader call; existence
 * of decision functions is not evidence." These tests drive the real
 * `buildSkillSnapshot` (fs discovery over a fixture dir) and the real
 * `loadAdminPolicy` (parse+validate over an injected fs READER — the lowest seam,
 * so the loader's own logic runs on the production path). Removing the
 * `loadAdminPolicy` call from `build-skills.ts` makes the banned/required
 * enforcement below RED — the receipt for a real loader wiring.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSkillRuntimeAuthority } from "@/runner/assemble/session-authorities"
import {
  type AdminPolicyReader,
  createInMemoryDisabledStore,
  DISABLED_SET_SCHEMA_VERSION,
} from "@/skill"

let root: string
let userDir: string
let systemDir: string
let orgDir: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "f1-composition-"))
  userDir = join(root, "user-skills")
  systemDir = join(root, "system-skills") // empty ⇒ isolates from bundled skills
  orgDir = join(root, "org")
  await mkdir(systemDir, { recursive: true })
  // A real user skill discovered by the real registry loader.
  const demo = join(userDir, "demo")
  await mkdir(demo, { recursive: true })
  await writeFile(
    join(demo, "SKILL.md"),
    ["---", "name: demo", "description: a demo skill", "---", "demo body"].join("\n"),
  )
  const other = join(userDir, "other")
  await mkdir(other, { recursive: true })
  await writeFile(
    join(other, "SKILL.md"),
    ["---", "name: other", "description: another skill", "---", "other body"].join("\n"),
  )
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A reader that returns the given org-policy JSON for the org-policy.json path
 *  (null for anything else) — feeds the REAL loadAdminPolicy. */
const policyReader =
  (json: string | null): AdminPolicyReader =>
  async (path) =>
    path.endsWith("org-policy.json") ? json : null

describe("F1 front-door — real loader composition", () => {
  test("real registry loader: discovered skills populate the active projection", async () => {
    const authority = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      disabledStore: createInMemoryDisabledStore(),
    })
    expect(
      authority
        .read()
        .active.map((s) => s.name)
        .sort(),
    ).toEqual(["demo", "other"])
  })

  test("real admin-policy loader: a banned name is administrator-disabled end-to-end", async () => {
    const authority = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      orgConfigDir: orgDir,
      readPolicyFile: policyReader(JSON.stringify({ bannedSkills: ["demo"] })),
      disabledStore: createInMemoryDisabledStore(),
    })
    const v = authority.read()
    // demo is banned by the loaded policy ⇒ absent from active, administrator reason.
    expect(v.active.map((s) => s.name)).toEqual(["other"])
    expect(v.management.find((m) => m.name === "demo")?.disableReason).toBe("administrator")
    // Enabling it is refused through the real policy.
    const res = await authority.setEnabled("demo", true, v.revision)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.rejection).toEqual({ kind: "policy_denied", name: "demo", reason: "banned" })
  })

  test("real admin-policy loader: a required name is pinned enabled against a persisted disable", async () => {
    const authority = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      orgConfigDir: orgDir,
      readPolicyFile: policyReader(JSON.stringify({ requiredSkills: ["demo"] })),
      disabledStore: createInMemoryDisabledStore({
        schemaVersion: DISABLED_SET_SCHEMA_VERSION,
        revision: 2,
        names: ["demo"],
      }),
    })
    // Required PINS demo enabled even though it is in the persisted disabled set.
    expect(authority.read().active.map((s) => s.name)).toContain("demo")
    const res = await authority.setEnabled("demo", false, authority.read().revision)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.rejection.kind).toBe("policy_denied")
  })

  test("no org policy (absent file) ⇒ all discovered skills active", async () => {
    const authority = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      orgConfigDir: orgDir,
      readPolicyFile: policyReader(null),
      disabledStore: createInMemoryDisabledStore(),
    })
    expect(
      authority
        .read()
        .active.map((s) => s.name)
        .sort(),
    ).toEqual(["demo", "other"])
  })

  test("malformed org-policy.json fails LOUD (real loader validation runs on the prod path)", async () => {
    await expect(
      buildSkillRuntimeAuthority({
        snapshotInputs: { userDir, systemDir },
        orgConfigDir: orgDir,
        readPolicyFile: policyReader('{ "bannedSkills": "not-an-array" }'),
        disabledStore: createInMemoryDisabledStore(),
      }),
    ).rejects.toThrow(/org-policy\.json/)
  })

  test("default JSON store path builds when no store injected (real disabled-set adapter)", async () => {
    const authority = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      disabledSetPath: join(root, "disabled.json"),
    })
    const before = authority.read()
    const res = await authority.setEnabled("demo", false, before.revision)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.view.active.map((s) => s.name)).toEqual(["other"])
    // A fresh authority over the same durable file sees the persisted disable.
    const reopened = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      disabledSetPath: join(root, "disabled.json"),
    })
    expect(reopened.read().active.map((s) => s.name)).toEqual(["other"])
    expect(reopened.read().management.find((m) => m.name === "demo")?.disableReason).toBe("user")
  })
})
