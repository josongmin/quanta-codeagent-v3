/**
 * RFC-06 F4 — CLI + web skill surfaces converge on the ONE durable authority.
 *
 * HELLGATE (the F4 RED → GREEN):
 *   RED  — a skill disabled THROUGH the authority still showed as active in the
 *          CLI `/reload-skills` readout AND the web `/skills` readout, because
 *          each surface ran its OWN discovery scan (a second cache, divergent
 *          from the live runtime view).
 *   GREEN — both surfaces read a projection off the SAME authority, so a disable
 *          converges: the web readout OMITS the skill (active projection) and the
 *          CLI management row is TAGGED disabled (agrees with the runtime view),
 *          both at the authority's current revision. `/reload-skills` invokes the
 *          authority `sync()` and renders that revision (never an independent
 *          re-scan).
 *
 * These drive the REAL `buildSkillRuntimeAuthority` (fs discovery) + the REAL
 * surface seams (`buildSkillsCallback` / `buildSkillsReloadCallback` for CLI,
 * `buildSkillsReadoutSource` for web). The anti-vacuity RED baseline proves the
 * authority read is LOAD-BEARING: a no-authority callback re-scans disk and MISSES
 * the disable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSkillBlock } from "@/agent/tier1/skill"
import type { AgentConfig } from "@/agent/types"
import { buildSkillsCallback, buildSkillsReloadCallback } from "@/apps/cli/repl/skills-surface"
import { buildSkillsReadoutSource } from "@/apps/web-daemon/authority-readouts"
import { buildSkillRuntimeAuthority } from "@/runner/assemble/session-authorities"
import { createInMemoryDisabledStore } from "@/skill"

let root: string
let userDir: string
let systemDir: string

const writeSkill = async (name: string, description: string): Promise<void> => {
  const d = join(userDir, name)
  await mkdir(d, { recursive: true })
  await writeFile(
    join(d, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "body"].join("\n"),
  )
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "f4-surfaces-"))
  userDir = join(root, "user-skills")
  systemDir = join(root, "system-skills") // empty ⇒ isolates from bundled skills
  await mkdir(systemDir, { recursive: true })
  await writeSkill("demo", "a demo skill")
  await writeSkill("other", "another skill")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("RFC-06 F4 — CLI + web converge on ONE authority", () => {
  test("disable through the authority: CLI reload + web readout both AGREE with the disabled view", async () => {
    const authority = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      disabledStore: createInMemoryDisabledStore(),
    })
    const cliList = buildSkillsCallback({ dir: userDir }, undefined, authority)
    const cliReload = buildSkillsReloadCallback({ dir: userDir }, undefined, authority)
    const webSkills = buildSkillsReadoutSource(authority)
    if (cliList === undefined || cliReload === undefined) throw new Error("callbacks must be wired")

    // BEFORE disable — both surfaces list `demo` as an active (untagged) skill.
    expect((await cliList()).find((r) => r.name === "demo")?.disabled).toBeUndefined()
    expect((await webSkills()).map((r) => r.name)).toContain("demo")

    // Disable `demo` THROUGH the authority (the single mutation seam).
    const res = await authority.setEnabled("demo", false, authority.read().revision)
    expect(res.ok).toBe(true)
    const revAfter = authority.read().revision

    // AFTER — web readout OMITS demo (active projection); CLI management row is
    // TAGGED disabled with the effective reason (agrees with the disabled view).
    expect((await webSkills()).map((r) => r.name)).not.toContain("demo")
    const demoRow = (await cliList()).find((r) => r.name === "demo")
    expect(demoRow?.disabled).toBe(true)
    expect(demoRow?.disableReason).toBe("user")
    // `other` is untouched on both surfaces.
    expect((await webSkills()).map((r) => r.name)).toContain("other")

    // `/reload-skills` invokes sync() and renders THIS revision; rows agree.
    const reloaded = await cliReload()
    expect(reloaded.revision).toBe(revAfter)
    expect(reloaded.rows.find((r) => r.name === "demo")?.disabled).toBe(true)

    // Re-enable converges back on ALL surfaces at a higher revision.
    const back = await authority.setEnabled("demo", true, authority.read().revision)
    expect(back.ok).toBe(true)
    expect((await webSkills()).map((r) => r.name)).toContain("demo")
    expect((await cliList()).find((r) => r.name === "demo")?.disabled).toBeUndefined()
  })

  test("ANTI-VACUITY / RED baseline: a NO-authority CLI callback re-scans disk and MISSES a disable (authority read is load-bearing)", async () => {
    // A durable disable exists in the authority, but a callback built WITHOUT the
    // authority does an independent disk scan — the pre-F4 divergence. It lists
    // `demo` as active (untagged), which is exactly the trust lie F4 removes.
    const authority = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      disabledStore: createInMemoryDisabledStore(),
    })
    await authority.setEnabled("demo", false, authority.read().revision)

    const scanOnly = buildSkillsCallback({ dir: userDir }, undefined, undefined)
    if (scanOnly === undefined) throw new Error("callback must be wired")
    const rows = await scanOnly()
    const demoRow = rows.find((r) => r.name === "demo")
    expect(demoRow).toBeDefined() // scan cannot see the authority's disable …
    expect(demoRow?.disabled).toBeUndefined() // … so it never tags it (RED).

    // The SAME config WITH the authority DOES reflect the disable (GREEN),
    // proving the divergence is closed only by reading the authority.
    const withAuthority = buildSkillsCallback({ dir: userDir }, undefined, authority)
    if (withAuthority === undefined) throw new Error("callback must be wired")
    expect((await withAuthority()).find((r) => r.name === "demo")?.disabled).toBe(true)
  })

  test("ONE authority feeds prompt + ToolSearch + invocation + CLI + web (no second cache)", async () => {
    // The composition-root authority, threaded into buildSkillBlock via
    // `config.skills.authority` (the F4 convergence) AND read by the CLI + web
    // seams. A single disable must drop `demo` from ALL FIVE surfaces.
    const authority = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      disabledStore: createInMemoryDisabledStore(),
    })
    const config = {
      skills: { dir: userDir, authority },
      cwd: "/repo",
      registry: { specs: () => [] },
    } as unknown as AgentConfig
    const block = await buildSkillBlock(config)
    if (block === undefined) throw new Error("expected skill block")
    // The block USES the injected authority — no second in-process cache.
    expect(block.authority).toBe(authority)

    const cliList = buildSkillsCallback({ dir: userDir }, undefined, authority)
    const webSkills = buildSkillsReadoutSource(authority)
    if (cliList === undefined) throw new Error("cli callback must be wired")
    const skillTool = block.tools.find((t) => t.name === "Skill")
    if (skillTool === undefined) throw new Error("expected Skill tool")

    // BEFORE — demo present on prompt / search / invocation-spec / CLI / web.
    expect(block.runtime.activeInventory().map((s) => s.name)).toContain("demo")
    expect(block.runtime.searchable().map((e) => e.skill.name)).toContain("demo")
    expect(skillTool.getSpec?.()?.description ?? "").toContain("demo")
    expect((await cliList()).find((r) => r.name === "demo")?.disabled).toBeUndefined()
    expect((await webSkills()).map((r) => r.name)).toContain("demo")

    // ONE disable through the shared authority.
    const res = await authority.setEnabled("demo", false, authority.read().revision)
    expect(res.ok).toBe(true)

    // AFTER — demo gone from ALL FIVE at the same revision.
    expect(block.runtime.activeInventory().map((s) => s.name)).not.toContain("demo")
    expect(block.runtime.searchable().map((e) => e.skill.name)).not.toContain("demo")
    expect(skillTool.getSpec?.()?.description ?? "").not.toContain("demo")
    expect((await cliList()).find((r) => r.name === "demo")?.disabled).toBe(true)
    expect((await webSkills()).map((r) => r.name)).not.toContain("demo")
    expect(block.runtime.revision()).toBe(authority.read().revision)
  })

  test("/reload-skills sync() converges on a CROSS-PROCESS durable disable", async () => {
    const path = join(root, "disabled-xproc.json")
    const authorityA = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      disabledSetPath: path,
    })
    const reloadA = buildSkillsReloadCallback({ dir: userDir }, undefined, authorityA)
    if (reloadA === undefined) throw new Error("reload must be wired")

    // Session A initially sees demo active.
    expect((await reloadA()).rows.find((r) => r.name === "demo")?.disabled).toBeUndefined()

    // Session B disables demo durably (a different process over the same file).
    const authorityB = await buildSkillRuntimeAuthority({
      snapshotInputs: { userDir, systemDir },
      disabledSetPath: path,
    })
    const r = await authorityB.setEnabled("demo", false, authorityB.read().revision)
    expect(r.ok).toBe(true)

    // A's `/reload-skills` sync()s the durable set and now AGREES.
    const reloaded = await reloadA()
    expect(reloaded.rows.find((r) => r.name === "demo")?.disabled).toBe(true)
    expect(reloaded.revision).toBeGreaterThan(0)
  })
})
