/**
 * RFC-06 F2 hellgate — execution-time skill invocation cutover.
 *
 * The `Skill` tool must resolve its target through the LIVE F1 runtime authority
 * AT INVOCATION time, never off a construction-time snapshot. This pins the F2
 * REDs + receipts:
 *
 *   (RED/GREEN) construct the tool, disable a skill AFTER construction, then
 *     invoke the ALREADY-CREATED handle → it must be BLOCKED. Injecting the OLD
 *     captured-map behavior (a `staticSkillResolver` frozen at construction) into
 *     the exact same assertion makes it RED — the static handle still executes
 *     the since-disabled skill. That is the escape F2 closes.
 *   (receipt) a same-session re-enable RESTORES the handle at a HIGHER revision.
 *   (concurrent) a cross-process disabled-set write (another writer to the shared
 *     store) is adopted at ACTION time via the resolver's `sync()` — no restart.
 *   (typed) missing name ⇒ typed "Unknown skill" (never a throw); duplicate names
 *     resolve deterministically through the authority, not a Map last-write-wins.
 *   (no captured map) the tool source retains no `byName` construction snapshot.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type {
  Skill,
  SkillRegistry,
  SkillRegistryEntry,
  SkillRuntimeAuthority,
  SkillScope,
  SkillSnapshot,
} from "@/skill"
import {
  createAuthoritySkillResolver,
  createInMemoryDisabledStore,
  createSkillRuntimeAuthority,
  createSkillTool,
  DISABLED_SET_SCHEMA_VERSION,
  type DisabledStorePort,
  emptyDisabledSet,
  staticSkillResolver,
} from "@/skill"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

/* ------------------------------------------------------------------------- *
 * Fixtures — hand-built registry snapshot (no fs). Mirrors the F1 authority
 * hellgate's fixture so the two packets share one construction shape.
 * ------------------------------------------------------------------------- */

const mkSkill = (name: string, scope: SkillScope, body?: string): Skill => ({
  name,
  description: `desc-${name}`,
  body: body ?? `body-${name}`,
  sourcePath: `/fixtures/${name}/SKILL.md`,
  scope,
})

/** Build a snapshot from explicit entries (allows DUP names for the collision
 *  pin — the real registry resolves precedence; we assert the tool delegates to
 *  it and never crashes / silently last-write-wins). */
const mkSnapshotFrom = (entries: SkillRegistryEntry[]): SkillSnapshot => {
  const byName = new Map<string, SkillRegistryEntry>()
  for (const e of entries) if (!byName.has(e.skill.name)) byName.set(e.skill.name, e)
  const registry: SkillRegistry = {
    entries,
    collisions: [],
    lookup: (n) => byName.get(n),
    bySope: () => [],
  }
  return { skills: entries.map((e) => e.skill), registry }
}

const mkSnapshot = (specs: readonly { name: string; scope: SkillScope }[]): SkillSnapshot =>
  mkSnapshotFrom(
    specs
      .map((s) => ({ skill: mkSkill(s.name, s.scope), winnerScope: s.scope, overriddenScopes: [] }))
      .sort((a, b) => (a.skill.name < b.skill.name ? -1 : 1)),
  )

const buildAuthority = (
  snapshot: SkillSnapshot,
  store: DisabledStorePort = createInMemoryDisabledStore(),
): { authority: SkillRuntimeAuthority; store: DisabledStorePort } => {
  const authority = createSkillRuntimeAuthority({
    snapshot,
    policy: null,
    disabledStore: store,
    persisted: emptyDisabledSet(),
  })
  return { authority, store }
}

const CTX: ToolContext = { cwd: "/", signal: new AbortController().signal }

const run = async (
  tool: Tool<{ name: string; args?: string | undefined }>,
  input: { name: string; args?: string | undefined },
): Promise<{ ok: boolean; output: string }> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, CTX)) last = ev
  if (last?.type !== "result") throw new Error("no result")
  return { ok: last.result.ok, output: last.result.output }
}

/* ------------------------------------------------------------------------- *
 * (RED/GREEN) disable AFTER construction blocks the already-created handle.
 * ------------------------------------------------------------------------- */

describe("F2 — action-time resolution blocks a since-disabled handle", () => {
  test("GREEN: authority-backed handle created BEFORE disable is BLOCKED after disable", async () => {
    const { authority } = buildAuthority(
      mkSnapshot([
        { name: "deploy", scope: "user" },
        { name: "review", scope: "user" },
      ]),
    )
    // Handle captured at construction — like the model already holds the tool.
    const tool = createSkillTool({
      resolve: createAuthoritySkillResolver(authority),
      catalogue: [...authority.read().active],
    })

    // Before disable: the handle executes the skill body.
    const before = await run(tool, { name: "deploy" })
    expect(before.ok).toBe(true)
    expect(before.output).toContain("body-deploy")

    // Disable AFTER the handle exists.
    const rev0 = authority.read().revision
    const res = await authority.setEnabled("deploy", false, rev0)
    expect(res.ok).toBe(true)

    // The SAME already-created handle must now be BLOCKED — action-time re-check.
    const after = await run(tool, { name: "deploy" })
    expect(after.ok).toBe(false)
    expect(after.output.toLowerCase()).toContain("disabled")
    expect(after.output).not.toContain("body-deploy")

    // A sibling that was never disabled still executes off the same handle.
    const sibling = await run(tool, { name: "review" })
    expect(sibling.ok).toBe(true)
    expect(sibling.output).toContain("body-review")
  })

  test("RED-on-injection: the OLD captured-map behavior (static resolver) STILL executes the disabled skill", async () => {
    const { authority } = buildAuthority(mkSnapshot([{ name: "deploy", scope: "user" }]))
    // Inject a resolver frozen at construction — this is exactly what the deleted
    // `new Map(skills.map(...))` did: it never consults the authority again.
    const staleList = [...authority.read().active]
    const staleTool = createSkillTool({
      resolve: staticSkillResolver(staleList),
      catalogue: staleList,
    })

    await authority.setEnabled("deploy", false, authority.read().revision)

    // The stale handle STILL runs the since-disabled skill → this is the RED the
    // authority-backed resolver closes. (Same assertion as the GREEN test above,
    // inverted: proves that test is non-vacuous and pins the exact bug.)
    const leaked = await run(staleTool, { name: "deploy" })
    expect(leaked.ok).toBe(true)
    expect(leaked.output).toContain("body-deploy")
  })
})

/* ------------------------------------------------------------------------- *
 * (receipt) re-enable restores the handle at a HIGHER revision.
 * ------------------------------------------------------------------------- */

describe("F2 — re-enable restores the handle at a higher revision", () => {
  test("disable then re-enable: same handle blocked, then executes; revision strictly increases", async () => {
    const { authority } = buildAuthority(mkSnapshot([{ name: "deploy", scope: "user" }]))
    const tool = createSkillTool({
      resolve: createAuthoritySkillResolver(authority),
      catalogue: [...authority.read().active],
    })

    const rev0 = authority.read().revision
    const disable = await authority.setEnabled("deploy", false, rev0)
    expect(disable.ok).toBe(true)
    if (!disable.ok) return
    const blocked = await run(tool, { name: "deploy" })
    expect(blocked.ok).toBe(false)
    // The block message reports the CURRENT revision (>= the disable revision).
    expect(blocked.output).toContain(`revision ${disable.view.revision}`)

    const reenable = await authority.setEnabled("deploy", true, disable.view.revision)
    expect(reenable.ok).toBe(true)
    if (!reenable.ok) return
    expect(reenable.view.revision).toBeGreaterThan(disable.view.revision)

    const restored = await run(tool, { name: "deploy" })
    expect(restored.ok).toBe(true)
    expect(restored.output).toContain("body-deploy")
  })
})

/* ------------------------------------------------------------------------- *
 * (concurrent) a cross-process disabled-set write is adopted at ACTION time.
 * ------------------------------------------------------------------------- */

describe("F2 — concurrent (cross-process) disabled-set write converges at action time", () => {
  test("another writer to the shared store disables a skill; the next invocation is blocked (no restart)", async () => {
    const store = createInMemoryDisabledStore()
    const { authority } = buildAuthority(mkSnapshot([{ name: "deploy", scope: "user" }]), store)
    const tool = createSkillTool({
      resolve: createAuthoritySkillResolver(authority),
      catalogue: [...authority.read().active],
    })

    // Works before any concurrent change.
    expect((await run(tool, { name: "deploy" })).ok).toBe(true)

    // Simulate a CONCURRENT session/process writing the durable disabled set
    // directly (bypassing THIS authority's setEnabled), at a higher revision.
    await store.write({
      schemaVersion: DISABLED_SET_SCHEMA_VERSION,
      revision: authority.read().revision + 1,
      names: ["deploy"],
    })

    // The resolver's action-time `sync()` adopts the store → immediate block,
    // with no re-construction of the tool or the authority.
    const after = await run(tool, { name: "deploy" })
    expect(after.ok).toBe(false)
    expect(after.output.toLowerCase()).toContain("disabled")
  })
})

/* ------------------------------------------------------------------------- *
 * (typed) missing + collision cases are values, never crashes.
 * ------------------------------------------------------------------------- */

describe("F2 — missing / collision resolution is typed, never a crash", () => {
  test("unknown name ⇒ typed 'Unknown skill' with the LIVE available list", async () => {
    const { authority } = buildAuthority(mkSnapshot([{ name: "deploy", scope: "user" }]))
    const tool = createSkillTool({
      resolve: createAuthoritySkillResolver(authority),
      catalogue: [...authority.read().active],
    })
    const miss = await run(tool, { name: "ghost" })
    expect(miss.ok).toBe(false)
    expect(miss.output).toContain("Unknown skill: ghost")
    // The "Available" hint is LIVE (active projection), not a stale catalogue.
    expect(miss.output).toContain("deploy")
  })

  test("a disabled name is reported 'disabled', a never-existing name 'unknown' — the two are distinct", async () => {
    const { authority } = buildAuthority(
      mkSnapshot([
        { name: "deploy", scope: "user" },
        { name: "review", scope: "user" },
      ]),
    )
    const tool = createSkillTool({
      resolve: createAuthoritySkillResolver(authority),
      catalogue: [...authority.read().active],
    })
    await authority.setEnabled("deploy", false, authority.read().revision)

    const disabled = await run(tool, { name: "deploy" })
    expect(disabled.output.toLowerCase()).toContain("disabled")
    expect(disabled.output).not.toContain("Unknown skill")

    const unknown = await run(tool, { name: "nope" })
    expect(unknown.output).toContain("Unknown skill: nope")
    // A disabled name must NOT leak into the live "Available" hint.
    expect(unknown.output).not.toContain("deploy")
    expect(unknown.output).toContain("review")
  })

  test("duplicate registry names resolve deterministically (winner), never crash / last-write-wins", async () => {
    // Two entries share a name; the registry `lookup` keeps the FIRST (precedence
    // winner). The OLD `new Map(skills.map(...))` would have silently kept the
    // LAST. Resolution must be deterministic and crash-free.
    const winner = mkSkill("dup", "admin", "body-WINNER")
    const loser = mkSkill("dup", "user", "body-loser")
    const snapshot = mkSnapshotFrom([
      { skill: winner, winnerScope: "admin", overriddenScopes: [] },
      { skill: loser, winnerScope: "user", overriddenScopes: [] },
    ])
    const { authority } = buildAuthority(snapshot)
    const tool = createSkillTool({
      resolve: createAuthoritySkillResolver(authority),
      catalogue: [...authority.read().active],
    })
    const r = await run(tool, { name: "dup" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("body-WINNER")
    expect(r.output).not.toContain("body-loser")
  })
})

/* ------------------------------------------------------------------------- *
 * (no captured map) — the tool source retains no construction-time snapshot.
 * ------------------------------------------------------------------------- */

describe("F2 — the captured `byName` map is deleted (no both-old-and-new)", () => {
  test("skill-tool.ts source contains no `byName` resolution map (comments stripped)", () => {
    const raw = readFileSync(join(import.meta.dir, "../../../src/skill/skill-tool.ts"), "utf8")
    // Strip block + line comments so a doc-comment MENTION of the deleted pattern
    // does not falsely trip the guard — we assert the CODE has no captured map.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(code).not.toContain("byName")
    expect(code).not.toContain("new Map(")
    expect(code).not.toContain(".get(want)")
    // Positive wiring proof: resolution goes through the injected action-time seam.
    expect(code).toContain("await deps.resolve(want)")
  })

  test("PRODUCTION wiring: tier1 buildSkillBlock injects the AUTHORITY resolver (not a static/captured one)", () => {
    const raw = readFileSync(join(import.meta.dir, "../../../src/agent/tier1/skill.ts"), "utf8")
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    // The live invocation path builds a runtime authority and wires the
    // action-time resolver into the Skill tool. A regression back to a captured
    // list (`createSkillTool(skills)` / `staticSkillResolver`) would fail here.
    expect(code).toContain("createSkillRuntimeAuthority(")
    expect(code).toContain("resolve: createAuthoritySkillResolver(authority)")
    expect(code).not.toContain("staticSkillResolver")
    expect(code).not.toContain("createSkillTool(skills)")
  })
})
