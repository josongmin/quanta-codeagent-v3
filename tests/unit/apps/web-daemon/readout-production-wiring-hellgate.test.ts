/**
 * Hellgate — PRODUCTION wiring proof for the UUX-1-11 readout sources.
 *
 * The sibling `readout-sources-hellgate` pins the pure resolver against
 * injected fakes; THIS gate proves the real composition root
 * (`buildProductionRuntimeFactory`) actually threads live collaborators onto
 * the facade's `readoutSources` getter — the exact seam `startWebDaemon`
 * duck-reads. A regression that drops the getter (or wires a dead instance)
 * turns this RED, where a source-regex test would stay green.
 *
 * Hermetic: dummy OPENAI key (adapter constructed, no network until a turn),
 * temp memory sqlite (NEVER the user's real store), temp skills dir. No
 * session/turn is run — composition only.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveReadout, type WebReadoutSources } from "@/apps/web-daemon/readout"
import { buildProductionRuntimeFactory } from "@/apps/web-daemon/runtime-factory"
import type { SessionSnapshotLite } from "@/protocol/session"

const tmp = mkdtempSync(join(tmpdir(), "quanta-readout-wiring-"))
const skillsDir = join(tmp, "skills")

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "QUANTA_PROVIDER",
  "QUANTA_MEMORY",
  "QUANTA_MEMORY_PATH",
  "QUANTA_SKILLS_DIR",
] as const
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))

afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(tmp, { recursive: true, force: true })
})

const SNAP: SessionSnapshotLite = {
  sessionId: "wire-1",
  revision: 1,
  seq: 1,
  state: { status: "idle", draftInput: "", permissionMode: "default", messageCount: 0 },
  capabilities: {
    approvals: "none",
    tools: true,
    memory: false,
    artifacts: false,
    subagents: true,
    automation: false,
    shellSnapshot: false,
    transport: "websocket",
  },
  pendingApproval: null,
  openArtifacts: [],
}

describe("production runtime factory — readout sources are LIVE on the facade", () => {
  test("facade exposes readoutSources whose accessors serve real data", async () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy-not-a-real-key"
    process.env.QUANTA_PROVIDER = "openai"
    // Hermetic memory: point the default-ON store at a temp sqlite so this test
    // can NEVER touch the user's real durable store.
    process.env.QUANTA_MEMORY_PATH = join(tmp, "memory-test.db")
    // A discoverable user skill so the skills accessor returns a real row.
    process.env.QUANTA_SKILLS_DIR = skillsDir
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(skillsDir, "wiring-proof-skill"), { recursive: true })
    writeFileSync(
      join(skillsDir, "wiring-proof-skill", "SKILL.md"),
      "---\nname: wiring-proof-skill\ndescription: proves the readout wiring\n---\nbody\n",
    )

    const factory = buildProductionRuntimeFactory()
    const facade = await factory()
    const sources = (facade as { readoutSources?: WebReadoutSources }).readoutSources
    expect(sources).toBeDefined()
    if (sources === undefined) throw new Error("unreachable")

    // agents — the surface-owned TaskRegistry (empty fleet, but WIRED).
    const agents = await resolveReadout("agents", SNAP, sources)
    expect(agents.wired).toBe(true)
    expect(agents.output).toContain("no subagent tasks")

    // plan — the in-memory plan store (no plan yet, but WIRED).
    const plan = await resolveReadout("plan", SNAP, sources)
    expect(plan.wired).toBe(true)
    expect(plan.output).toContain("no plan")

    // skills — real disk discovery finds the temp skill.
    const skills = await resolveReadout("skills", SNAP, sources)
    expect(skills.wired).toBe(true)
    expect(skills.output).toContain("wiring-proof-skill")

    // memory — the temp sqlite store (empty, but WIRED and NOT the user's).
    const memory = await resolveReadout("memory", SNAP, sources)
    expect(memory.wired).toBe(true)
    expect(memory.output).toContain("store is empty")

    // context — the always-on usage holder (no prompt yet, but WIRED).
    const context = await resolveReadout("context", SNAP, sources)
    expect(context.wired).toBe(true)
    expect(context.output).toContain("no prompt assembled yet")

    // cost is deliberately NOT on the facade — it is the server-owned fold.
    expect(sources.cost).toBeUndefined()
  })

  test("QUANTA_MEMORY=off degrades ONLY the memory readout (honest copy)", async () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy-not-a-real-key"
    process.env.QUANTA_PROVIDER = "openai"
    process.env.QUANTA_MEMORY = "off"
    const facade = await buildProductionRuntimeFactory()()
    const sources = (facade as { readoutSources?: WebReadoutSources }).readoutSources
    expect(sources).toBeDefined()
    if (sources === undefined) throw new Error("unreachable")
    const memory = await resolveReadout("memory", SNAP, sources)
    expect(memory.wired).toBe(false)
    expect(memory.isError).toBe(false)
    expect(memory.output).toContain("QUANTA_MEMORY")
    // Siblings stay wired.
    expect((await resolveReadout("plan", SNAP, sources)).wired).toBe(true)
    delete process.env.QUANTA_MEMORY
  })
})
