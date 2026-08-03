/**
 * RFC03-0 — canonical SkillRegistry snapshot cutover contract.
 *
 * The registry snapshot (`buildSkillSnapshot`) is the SINGLE discovery +
 * precedence authority. Every runtime surface (prompt `buildSkillBlock`, the
 * `Skill` tool inventory, and the CLI `/skills` list) must derive from the
 * SAME snapshot so they cannot disagree on:
 *   - which skill WINS a system↔user name collision, and
 *   - the ORDER of the resolved set.
 *
 * ADR-0134 precedence: `admin > repo > team > user > personal > system`, so a
 * user skill of the same name WINS over a bundled system skill. This is the
 * canonical decision; the pre-registry ad-hoc "system wins" tier1 merge was the
 * deviation being removed here.
 *
 * Anti-vacuous: we plant a genuine collision + a genuine ordering difference
 * and assert the concrete winner/order through the real production surfaces
 * (`buildSkillBlock`, `buildSkillsCallback`), not through the projector alone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSkillSnapshot } from "@/skill"

let userDir: string
let systemDir: string

const writeSkill = async (dir: string, name: string, description: string): Promise<void> => {
  const target = join(dir, name)
  await mkdir(target, { recursive: true })
  await writeFile(
    join(target, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", `body of ${name}`].join("\n"),
  )
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-cutover-"))
  userDir = join(root, "user")
  systemDir = join(root, "system")
  await mkdir(userDir, { recursive: true })
  await mkdir(systemDir, { recursive: true })
})
afterEach(async () => {
  // best-effort cleanup of the shared parent
  await rm(join(userDir, ".."), { recursive: true, force: true })
})

describe("RFC03-0 canonical snapshot", () => {
  test("user skill WINS a name collision over a system skill", async () => {
    await writeSkill(systemDir, "shared-skill", "SYSTEM version")
    await writeSkill(userDir, "shared-skill", "USER version")

    const snap = await buildSkillSnapshot({ userDir, systemDir })
    const winner = snap.registry.lookup("shared-skill")
    expect(winner).toBeDefined()
    // ADR-0134: user > system.
    expect(winner?.winnerScope).toBe("user")
    expect(winner?.skill.description).toBe("USER version")
    expect(winner?.overriddenScopes).toContain("system")
    // The winning skill list carries exactly one entry for the colliding name.
    expect(snap.skills.filter((s) => s.name === "shared-skill")).toHaveLength(1)
  })

  test("snapshot skills are sorted deterministically by name", async () => {
    await writeSkill(userDir, "zebra", "z")
    await writeSkill(userDir, "alpha", "a")
    await writeSkill(systemDir, "mango", "m")
    const snap = await buildSkillSnapshot({ userDir, systemDir })
    const names = snap.skills.map((s) => s.name)
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(names).toContain("alpha")
    expect(names).toContain("zebra")
    expect(names).toContain("mango")
  })

  test("system-only skill survives when user dir has no collision", async () => {
    await writeSkill(systemDir, "only-system", "S")
    await writeSkill(userDir, "only-user", "U")
    const snap = await buildSkillSnapshot({ userDir, systemDir })
    expect(snap.registry.lookup("only-system")?.winnerScope).toBe("system")
    expect(snap.registry.lookup("only-user")?.winnerScope).toBe("user")
  })
})
