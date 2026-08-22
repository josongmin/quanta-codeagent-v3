/**
 * RFC-06 F3 hellgate — live prompt inventory, live ToolSearch, and dynamic tool
 * specs, all off ONE runtime authority revision.
 *
 * RED (the pre-F3 defect this packet closes): a skill disabled AFTER tool/session
 * construction still appears in
 *   (a) the prompt "## Active skills" inventory (a frozen `activeSkills` array),
 *   (b) ToolSearch's `catalog:"skills"` mode (a frozen `snapshot.registry.entries`
 *       closure), and
 *   (c) the `Skill` tool's model spec (its description is frozen at construction).
 * Each of the three "RED CONTROL" blocks below reconstructs that frozen pattern
 * and PROVES it still leaks the disabled skill — so the GREEN assertions are not
 * vacuous.
 *
 * GREEN (F3): the live reader, the live searchable closure, and the dynamic-spec
 * (`getSpec`) arm all read the CURRENT authority view, so ONE disable revision
 * drops the skill from all three on the next read, while an unrelated static tool
 * stays byte-identical.
 *
 * The final block drives the REAL `buildSkillBlock` composition end-to-end: it
 * exposes the SAME authority the Skill tool resolver / ToolSearch / reader all
 * read from, disables through it, and proves the disable propagates to every
 * surface — the wiring proof (bare imports are not evidence).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { buildSkillBlock } from "../../../../src/agent/tier1/skill"
import type { AgentConfig } from "../../../../src/agent/types"
import {
  buildSkillSnapshot,
  createInMemoryDisabledStore,
  createSkillRuntimeAuthority,
  createSkillRuntimeReader,
  createSkillTool,
  createToolSearchTool,
  type SkillRuntimeAuthority,
  type SkillSnapshot,
  staticSkillResolver,
} from "../../../../src/skill"
import { type Tool, type ToolContext, ToolRegistry, type ToolResult } from "../../../../src/tool"

const CTX: ToolContext = { cwd: "/", signal: new AbortController().signal }

const run = async (tool: Tool, input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, CTX)) {
    const e = ev as { type: string; result?: ToolResult }
    if (e.type === "result" && e.result) result = e.result
  }
  if (!result) throw new Error("tool produced no result")
  return result
}

let root: string
let userDir: string
let systemDir: string

const writeSkill = async (name: string): Promise<void> => {
  const d = join(userDir, name)
  await mkdir(d, { recursive: true })
  await writeFile(
    join(d, "SKILL.md"),
    ["---", `name: ${name}`, `description: the ${name} skill`, "---", `${name} body`].join("\n"),
  )
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "f3-live-"))
  userDir = join(root, "user-skills")
  systemDir = join(root, "system-skills") // empty ⇒ isolates from bundled skills
  await mkdir(systemDir, { recursive: true })
  await writeSkill("demo")
  await writeSkill("other")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Build a fresh {snapshot, authority} pair over the fixture dir. Each test gets
 *  its own in-memory disabled store so disables do not bleed across tests. */
const freshAuthority = async (): Promise<{
  snapshot: SkillSnapshot
  authority: SkillRuntimeAuthority
}> => {
  const snapshot = await buildSkillSnapshot({ userDir, systemDir })
  const store = createInMemoryDisabledStore()
  const persisted = await store.read()
  const authority = createSkillRuntimeAuthority({
    snapshot,
    policy: null,
    disabledStore: store,
    persisted,
  })
  return { snapshot, authority }
}

const disable = async (authority: SkillRuntimeAuthority, name: string): Promise<void> => {
  const res = await authority.setEnabled(name, false, authority.read().revision)
  expect(res.ok).toBe(true)
}

describe("F3 — live prompt inventory (SkillRuntimeReader)", () => {
  test("RED CONTROL: a frozen active-array still lists a since-disabled skill", async () => {
    const { authority } = await freshAuthority()
    // The pre-F3 pattern: copy the active names ONCE, then disable.
    const frozen = authority.read().active.map((s) => s.name)
    await disable(authority, "demo")
    // The frozen copy is stale — it STILL contains the disabled skill (this is
    // exactly the leak F3 removes).
    expect(frozen).toContain("demo")
  })

  test("GREEN: the live reader drops a disabled skill on the next read", async () => {
    const { authority } = await freshAuthority()
    const reader = createSkillRuntimeReader(authority)
    expect(reader.activeInventory().map((s) => s.name)).toEqual(["demo", "other"])
    const revBefore = reader.revision()
    await disable(authority, "demo")
    // NEXT read reflects the disable — no stale array.
    expect(reader.activeInventory().map((s) => s.name)).toEqual(["other"])
    expect(reader.revision()).toBe(revBefore + 1)
    // Re-enable restores it at a HIGHER revision.
    const re = await authority.setEnabled("demo", true, authority.read().revision)
    expect(re.ok).toBe(true)
    expect(reader.activeInventory().map((s) => s.name)).toEqual(["demo", "other"])
    expect(reader.revision()).toBe(revBefore + 2)
  })
})

describe("F3 — live ToolSearch searchable projection", () => {
  const skillSelect = { query: "select:demo", catalog: "skills" as const }

  test("RED CONTROL: a frozen snapshot.entries closure still finds a disabled skill", async () => {
    const { snapshot, authority } = await freshAuthority()
    // The pre-F3 wiring: ToolSearch closes over the FROZEN registry entries.
    const frozenSearch = createToolSearchTool(
      () => [],
      () => snapshot.registry.entries,
    )
    expect((await run(frozenSearch, skillSelect)).ok).toBe(true)
    await disable(authority, "demo")
    // Frozen ⇒ ToolSearch STILL surfaces the disabled skill.
    const after = await run(frozenSearch, skillSelect)
    expect(after.ok).toBe(true)
    expect(after.output).toContain("demo")
  })

  test("GREEN: the live searchable closure drops a disabled skill on the next call", async () => {
    const { authority } = await freshAuthority()
    const liveSearch = createToolSearchTool(
      () => [],
      () => authority.read().searchable,
    )
    expect((await run(liveSearch, skillSelect)).ok).toBe(true)
    await disable(authority, "demo")
    const after = await run(liveSearch, skillSelect)
    expect(after.ok).toBe(false)
    expect(after.output).not.toContain("the demo skill")
  })
})

describe("F3 — dynamic tool spec (getSpec) on the model surface", () => {
  const skillDesc = (registry: ToolRegistry): string =>
    registry.specs().find((s) => s.name === "Skill")?.description ?? ""

  test("RED CONTROL: a STATIC Skill tool freezes its description at construction", async () => {
    const { snapshot, authority } = await freshAuthority()
    // No `liveCatalogue` ⇒ static description, and NO getSpec arm.
    const staticSkill = createSkillTool({
      resolve: staticSkillResolver([...snapshot.skills]),
      catalogue: snapshot.skills,
    })
    expect(staticSkill.getSpec).toBeUndefined()
    const registry = new ToolRegistry([staticSkill])
    expect(skillDesc(registry)).toContain("demo")
    await disable(authority, "demo")
    // Frozen description ⇒ the disabled skill STILL appears in the model spec.
    expect(skillDesc(registry)).toContain("demo")
  })

  test("GREEN: a live Skill tool's spec drops a disabled skill on the next specs() call", async () => {
    const { snapshot, authority } = await freshAuthority()
    const liveSkill = createSkillTool({
      resolve: staticSkillResolver([...snapshot.skills]),
      catalogue: snapshot.skills,
      liveCatalogue: () => authority.read().active,
    })
    expect(typeof liveSkill.getSpec).toBe("function")
    const registry = new ToolRegistry([liveSkill])
    expect(skillDesc(registry)).toContain("demo")
    expect(skillDesc(registry)).toContain("other")
    const schemaBefore = registry.specs().find((s) => s.name === "Skill")?.input_schema
    await disable(authority, "demo")
    // NEXT specs() call re-dereferences getSpec ⇒ demo gone, other remains.
    expect(skillDesc(registry)).not.toContain("demo")
    expect(skillDesc(registry)).toContain("other")
    // getSpec keeps the tool's IDENTITY: name + input_schema unchanged across the
    // disable (only the description tracks the live projection). This is what lets
    // the registry advertise==dispatch generation stay intact.
    const spec = registry.specs().find((s) => s.name === "Skill")
    expect(spec?.name).toBe("Skill")
    expect(spec?.input_schema).toEqual(schemaBefore as Record<string, unknown>)
    // …and it matches what a STATIC (getSpec-less) Skill tool would advertise —
    // the schema is not perturbed by the dynamic arm.
    const staticSpec = new ToolRegistry([
      createSkillTool({
        resolve: staticSkillResolver([...snapshot.skills]),
        catalogue: snapshot.skills,
      }),
    ])
      .specs()
      .find((s) => s.name === "Skill")
    expect(spec?.input_schema).toEqual(staticSpec?.input_schema as Record<string, unknown>)
  })
})

describe("F3 — static-tool compatibility + gate-OFF byte-identity", () => {
  const staticTool = (name: string): Tool => ({
    name,
    description: `the ${name} tool`,
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute() {
      yield { type: "result", result: { ok: true, output: "" } }
    },
  })

  test("a tool with no getSpec is advertised from static fields, unchanged across calls", async () => {
    const { authority } = await freshAuthority()
    const a = staticTool("Alpha")
    const b = staticTool("Beta")
    expect(a.getSpec).toBeUndefined()
    const registry = new ToolRegistry([a, b])
    const before = JSON.stringify(registry.specs())
    // A disable on an unrelated authority must not perturb static specs.
    await disable(authority, "demo")
    const after = JSON.stringify(registry.specs())
    expect(after).toBe(before)
  })

  test("gate-OFF: a registry of only static tools yields byte-identical specs each request", () => {
    const registry = new ToolRegistry([staticTool("Alpha"), staticTool("Beta")])
    const first = JSON.stringify(registry.specs())
    const second = JSON.stringify(registry.specs())
    expect(second).toBe(first)
    // Exact frozen order/shape pin (would break if specs() started reordering or
    // injecting dynamic content for static tools).
    expect(registry.specs().map((s) => s.name)).toEqual(["Alpha", "Beta"])
  })
})

describe("F3 — buildSkillBlock wiring proof (one disable, all surfaces)", () => {
  const cfg = (): AgentConfig =>
    ({
      skills: { dir: userDir, systemDir },
      cwd: "/repo",
      registry: { specs: () => [] },
    }) as unknown as AgentConfig

  test("no copied inventory array remains on the block (reader replaces it)", async () => {
    const block = await buildSkillBlock(cfg())
    expect(block).toBeDefined()
    // The pre-F3 frozen `inventory` array is GONE; a live reader + authority
    // replace it.
    expect(block && "inventory" in block).toBe(false)
    expect(typeof block?.runtime.activeInventory).toBe("function")
    expect(typeof block?.authority.setEnabled).toBe("function")
  })

  test("disabling through the block's authority drops the skill from prompt + ToolSearch + Skill spec on the next read", async () => {
    const block = await buildSkillBlock(cfg())
    if (!block) throw new Error("expected skill block")
    const skillTool = block.tools.find((t) => t.name === "Skill")
    const toolSearch = block.tools.find((t) => t.name === "ToolSearch")
    if (!skillTool || !toolSearch) throw new Error("expected Skill + ToolSearch tools")

    // BEFORE: demo present on all three surfaces (same revision).
    expect(block.runtime.activeInventory().map((s) => s.name)).toContain("demo")
    expect(skillTool.getSpec?.()?.description ?? "").toContain("demo")
    const searchBefore = await run(toolSearch, { query: "select:demo", catalog: "skills" })
    expect(searchBefore.ok).toBe(true)

    // ONE disable through the SAME authority every surface reads from.
    await disable(block.authority, "demo")

    // AFTER: demo gone from ALL THREE on the next read — before any next model
    // call. `other` remains (a disable is scoped, not a wipe).
    const inv = block.runtime.activeInventory().map((s) => s.name)
    expect(inv).not.toContain("demo")
    expect(inv).toContain("other")

    const specDesc = skillTool.getSpec?.()?.description ?? ""
    expect(specDesc).not.toContain("demo")
    expect(specDesc).toContain("other")

    const searchAfter = await run(toolSearch, { query: "select:demo", catalog: "skills" })
    expect(searchAfter.ok).toBe(false)
  })
})
