/**
 * §2.3 e2e HELLGATE — a real directory-form skill whose `agents/openai.yaml`
 * declares `policy.allow_implicit_invocation: false` is DISCOVERED from disk,
 * and the gated `implicitlyInvocableSkills` filter excludes it from the
 * implicit-injection set while the EXPLICIT surface (the discovered skill list)
 * still contains it.
 *
 * Drives the REAL seam: real tmpdir, real SKILL.md + agents/openai.yaml, the
 * actual `discoverSkills` → `Skill.allowImplicitInvocation` → activation filter.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { implicitlyInvocableSkills } from "../../src/skill/activation"
import { discoverSkills } from "../../src/skill/discover"

const FENCE = (name: string): string =>
  ["---", `name: ${name}`, `description: ${name} desc`, "---", "Body."].join("\n")

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), "qcav3-skill-implicit-e2e-"))

const writeSkill = async (root: string, name: string, policyYaml?: string): Promise<void> => {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "SKILL.md"), FENCE(name), "utf8")
  if (policyYaml !== undefined) {
    await mkdir(join(dir, "agents"), { recursive: true })
    await writeFile(join(dir, "agents", "openai.yaml"), policyYaml, "utf8")
  }
}

const created: string[] = []
afterEach(async () => {
  delete process.env.QUANTA_SKILL_IMPLICIT_POLICY
  while (created.length > 0) {
    const d = created.pop()
    if (d) await rm(d, { recursive: true, force: true })
  }
})

describe("§2.3 skill implicit-invocation policy — e2e discover + gate", () => {
  test("discovery lifts policy.allow_implicit_invocation:false onto the Skill", async () => {
    const root = await tmp()
    created.push(root)
    await writeSkill(root, "private-skill", "policy:\n  allow_implicit_invocation: false\n")
    await writeSkill(root, "public-skill", "policy:\n  allow_implicit_invocation: true\n")
    await writeSkill(root, "plain-skill") // no agents/openai.yaml

    const skills = await discoverSkills(root)
    const byName = new Map(skills.map((s) => [s.name, s]))
    expect(byName.get("private-skill")?.allowImplicitInvocation).toBe(false)
    expect(byName.get("public-skill")?.allowImplicitInvocation).toBe(true)
    // plain skill: no policy file ⇒ field omitted (codex default = allowed)
    expect("allowImplicitInvocation" in (byName.get("plain-skill") ?? {})).toBe(false)
  })

  test("gate ON ⇒ implicit set excludes the false-policy skill; full set keeps it", async () => {
    const root = await tmp()
    created.push(root)
    await writeSkill(root, "private-skill", "policy:\n  allow_implicit_invocation: false\n")
    await writeSkill(root, "plain-skill")

    const skills = await discoverSkills(root)
    expect(skills.map((s) => s.name).sort()).toEqual(["plain-skill", "private-skill"])

    const implicit = implicitlyInvocableSkills(skills, { QUANTA_SKILL_IMPLICIT_POLICY: "1" })
    // private-skill opted out of implicit injection; the explicit surface (the
    // full `skills` list above) STILL contains it.
    expect(implicit.map((s) => s.name)).toEqual(["plain-skill"])
  })

  test("BYTE-IDENTITY: gate OFF ⇒ implicit set === full discovered set", async () => {
    const root = await tmp()
    created.push(root)
    await writeSkill(root, "private-skill", "policy:\n  allow_implicit_invocation: false\n")

    const skills = await discoverSkills(root)
    const implicit = implicitlyInvocableSkills(skills, {}) // gate OFF
    expect(implicit).toEqual(skills)
  })
})
