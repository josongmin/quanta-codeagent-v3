/**
 * Hellgate — ADR-0493 thin-client route WIRING on the web surface (G2b-01).
 *
 * The frontmatter `thin-client-dispatch` tag is parsed (discover.ts) and the
 * `QUANTA_THIN_CLIENT_DISPATCH` knob is registered, but `resolveThinClientRoute`
 * had ZERO src callers — the documented tag+gate combination was a silent no-op.
 * The wire: the web daemon (the ONE in-repo thin surface host) resolves each
 * active skill's effective route at the `/skills` projection boundary — the
 * decision object the thin host consumes — so a tagged skill, gate ON, observably
 * routes; gate OFF or tag absent stays byte-identical.
 *
 * Proven here (producer-side wiring proof, real discovery + real authority):
 *   TC-01  gate ON, tagged skill  ⇒ its readout row carries the resolved route
 *          ("control-request"); an untagged sibling row carries NO route.
 *   TC-02  paired control — gate OFF ⇒ rows are byte-identical {name,description}
 *          (no `route` field for ANY skill, tagged or not).
 *   TC-03  the RENDERED `/skills` readout (resolveReadout, the exact payload the
 *          thin host receives) annotates the routed skill only under the gate;
 *          gate OFF output is byte-identical to today's rendering.
 *   TC-04  production threading — `buildReadoutSources` hands `env` through to
 *          the skills source (the composition seam the daemon uses).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSkillsReadoutSource } from "@/apps/web-daemon/authority-readouts"
import { createCanvasUsageSource } from "@/apps/web-daemon/canvas-usage-source"
import { resolveReadout } from "@/apps/web-daemon/readout"
import { buildReadoutSources } from "@/apps/web-daemon/runtime-factory/readout-sources"
import { buildSkillRuntimeAuthority } from "@/runner/assemble/session-authorities"
import type { SkillRuntimeAuthority } from "@/skill"
import { createInMemoryDisabledStore } from "@/skill"

let root: string
let userDir: string
let systemDir: string
let authority: SkillRuntimeAuthority

const ON: Record<string, string | undefined> = { QUANTA_THIN_CLIENT_DISPATCH: "1" }
const OFF: Record<string, string | undefined> = {}

const writeSkill = async (
  name: string,
  description: string,
  extraFrontmatter: readonly string[] = [],
): Promise<void> => {
  const d = join(userDir, name)
  await mkdir(d, { recursive: true })
  await writeFile(
    join(d, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      ...extraFrontmatter,
      "---",
      "body",
    ].join("\n"),
  )
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "thin-route-wire-"))
  userDir = join(root, "user-skills")
  systemDir = join(root, "system-skills") // empty ⇒ isolates from bundled skills
  await mkdir(systemDir, { recursive: true })
  // REAL frontmatter parse: the tag rides `thin-client-dispatch` (discover.ts).
  // NB: the description must NOT contain any route token — TC-03 asserts the
  // rendered payload carries the token only as the gate-ON annotation.
  await writeSkill("routed", "a tagged skill", ["thin-client-dispatch: control-request"])
  await writeSkill("plain", "an untagged skill")
  authority = await buildSkillRuntimeAuthority({
    snapshotInputs: { userDir, systemDir },
    disabledStore: createInMemoryDisabledStore(),
  })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("ADR-0493 wire — the web skills projection resolves the thin-client route", () => {
  test("TC-01: gate ON ⇒ the tagged skill's row carries the resolved route; untagged has none", async () => {
    const rows = await buildSkillsReadoutSource(authority, ON)()
    const routed = rows.find((r) => r.name === "routed")
    const plain = rows.find((r) => r.name === "plain")
    expect(routed).toBeDefined()
    expect(plain).toBeDefined()
    // The routed EXECUTION decision the thin host consumes (ADR-0493: thin
    // surface + gate ON ⇒ the descriptor's valid tag).
    expect(routed?.route).toBe("control-request")
    // Tag absent ⇒ local ⇒ NO route field (additive default).
    expect(plain?.route).toBeUndefined()
  })

  test("TC-02: paired control — gate OFF ⇒ byte-identical {name,description} rows", async () => {
    const rows = await buildSkillsReadoutSource(authority, OFF)()
    expect(rows.map((r) => r.name).sort()).toEqual(["plain", "routed"])
    for (const row of rows) {
      // EXACT shape check: no `route` key may appear when the gate is off —
      // default-OFF byte-identity at the decision-object level.
      expect(Object.keys(row).sort()).toEqual(["description", "name"])
    }
  })

  test("TC-03: rendered /skills readout annotates the route ONLY under the gate", async () => {
    const on = await resolveReadout("skills", {} as never, {
      skills: buildSkillsReadoutSource(authority, ON),
    })
    expect(on.wired).toBe(true)
    const routedLine = on.output.split("\n").find((l) => l.includes("routed"))
    const plainLine = on.output.split("\n").find((l) => l.includes("plain"))
    expect(routedLine).toContain("control-request")
    expect(plainLine).not.toContain("local")
    expect(plainLine).not.toContain("control-request")

    // Paired control: gate OFF ⇒ the rendered payload the thin host receives is
    // byte-identical to today's (no route token anywhere).
    const off = await resolveReadout("skills", {} as never, {
      skills: buildSkillsReadoutSource(authority, OFF),
    })
    expect(off.wired).toBe(true)
    expect(off.output).not.toContain("control-request")
    expect(off.output).toContain("routed")
    expect(off.output).toContain("plain")
  })

  test("TC-04: buildReadoutSources threads env to the skills source (composition seam)", async () => {
    const sources = buildReadoutSources({
      taskRegistry: undefined,
      planStore: undefined,
      skillAuthority: authority,
      memoryStore: undefined,
      usageHolder: createCanvasUsageSource(),
      env: ON,
    })
    expect(sources.skills).toBeDefined()
    const rows = await sources.skills?.()
    expect(rows?.find((r) => r.name === "routed")?.route).toBe("control-request")

    // Paired control: env absent ⇒ gate cannot be on ⇒ no route field.
    const bare = buildReadoutSources({
      taskRegistry: undefined,
      planStore: undefined,
      skillAuthority: authority,
      memoryStore: undefined,
      usageHolder: createCanvasUsageSource(),
    })
    const bareRows = await bare.skills?.()
    expect(bareRows?.find((r) => r.name === "routed")?.route).toBeUndefined()
  })
})
