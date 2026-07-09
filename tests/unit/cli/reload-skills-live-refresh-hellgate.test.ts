/**
 * WS-G item 10 (UUX-5-08 + UUX-2-13) — `/reload-skills` and boot-frozen skill
 * state.
 *
 * GATE HALF (UUX-5-08 verification): the fix-queue claimed the agent's
 * skillGate (session-bootstrap.ts:164) is "frozen at boot". On the CURRENT
 * interactive path every turn runs `runAgent` → `createRunAgentContext` →
 * `buildSessionFeatures` → `buildSkillBlock(config)` → `discoverSkills(dir)`
 * — a FRESH disk scan per turn. These tests PIN that per-turn seam: a skill
 * file added after "boot" IS visible to the next turn's block (inventory +
 * allowlists) and the gate built from it arms the new skill's scope. If a
 * future refactor caches discovery at boot, these go RED — that is the
 * regression the bugbash feared.
 *
 * PILLS HALF (UUX-2-13, the REAL boot-freeze): the skills status pill was
 * loaded once by `installPills` and `/reload-skills` re-discovered for
 * DISPLAY only — the pill kept the boot inventory. Fix: `buildSkillsCallback`
 * accepts the pills sink; every `ctx.skills()` invocation (both `/skills` and
 * `/reload-skills`) pushes the fresh inventory into the pill.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSkillGate } from "@/agent/loop/skill-gate"
import { buildSkillBlock } from "@/agent/tier1/skill"
import { buildSkillsCallback } from "../../../src/apps/cli/repl/skills-surface"

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reload-skills-live-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const writeSkill = async (dir: string, name: string, allowed: string): Promise<void> => {
  const d = join(dir, name)
  await mkdir(d, { recursive: true })
  await writeFile(
    join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill ${name}\nallowedTools: ["${allowed}"]\n---\nBody of ${name}.\n`,
  )
}

/** Minimal config for buildSkillBlock — only `skills` and `registry.specs`
 *  are consumed on this path. */
const cfgFor = (dir: string): Parameters<typeof buildSkillBlock>[0] =>
  ({
    skills: { dir },
    registry: { specs: () => [] },
  }) as unknown as Parameters<typeof buildSkillBlock>[0]

describe("gate half — per-turn re-discovery (UUX-5-08)", () => {
  test("a skill added AFTER boot is in the NEXT turn's block + gate view", async () => {
    const dir = join(root, "gate")
    await writeSkill(dir, "boot-skill", "Read")
    // "Boot" turn: only boot-skill exists.
    const boot = await buildSkillBlock(cfgFor(dir))
    expect(boot?.inventory.map((s) => s.name)).toContain("boot-skill")
    expect(boot?.inventory.map((s) => s.name)).not.toContain("new-skill")

    // Operator drops a new skill on disk mid-session.
    await writeSkill(dir, "new-skill", "Bash")

    // NEXT turn: createRunAgentContext re-runs buildSkillBlock — the new
    // skill must appear WITHOUT any process restart.
    const next = await buildSkillBlock(cfgFor(dir))
    expect(next?.inventory.map((s) => s.name)).toContain("new-skill")
    expect(next?.allowlists?.get("new-skill")).toEqual(["Bash"])

    // And the gate built from the fresh block arms the new skill's scope.
    const gate = buildSkillGate(next?.allowlists, next?.overrides)
    expect(gate).toBeDefined()
    gate?.observe("Skill", { name: "new-skill" }, true)
    expect(gate?.activeSkillName()).toBe("new-skill")
    expect(gate?.allow("bash")).toBe(true)
  })
})

describe("pills half — ctx.skills() refreshes the skills pill (UUX-2-13)", () => {
  test("every skills callback invocation pushes the FRESH inventory to the pill", async () => {
    const dir = join(root, "pills")
    await writeSkill(dir, "alpha", "Read")
    const updates: Array<{ activeSkills?: Array<{ name: string }> }> = []
    const pills = {
      update: (patch: { activeSkills?: Array<{ name: string }> }) => updates.push(patch),
    }
    const cb = buildSkillsCallback({ dir }, pills)
    expect(cb).toBeDefined()

    await cb?.()
    const first = updates.at(-1)?.activeSkills?.map((s) => s.name) ?? []
    expect(first).toContain("alpha")

    await writeSkill(dir, "beta", "Bash")
    await cb?.() // the /reload-skills path
    const second = updates.at(-1)?.activeSkills?.map((s) => s.name) ?? []
    expect(second).toContain("alpha")
    expect(second).toContain("beta")
  })

  test("no pills sink ⇒ callback still works (display-only surfaces unchanged)", async () => {
    const dir = join(root, "pills2")
    await writeSkill(dir, "gamma", "Read")
    const cb = buildSkillsCallback({ dir })
    const rows = await cb?.()
    expect(rows?.map((r) => r.name)).toContain("gamma")
  })
})
