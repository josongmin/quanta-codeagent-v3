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
 * Hermetic: an injected in-memory boot LLM/catalog plus a fetch tripwire, temp
 * Quanta/session roots, temp memory sqlite and temp skills dir. Neither the
 * network nor the user's real ~/.quanta tree is reachable. No session/turn is
 * run — composition only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as fsp from "node:fs/promises"
import { readdir } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  resolveReadout,
  SOURCE_BACKED_READOUTS,
  type WebReadoutSources,
} from "@/apps/web-daemon/readout"
import { buildProductionRuntimeFactory } from "@/apps/web-daemon/runtime-factory"
import type { LLMPort } from "@/llm"
import type { SessionSnapshotLite } from "@/protocol/session"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { makeSnapshotLite } from "../../../support/session-fixtures"

const tmp = mkdtempSync(join(tmpdir(), "quanta-readout-wiring-"))
const skillsDir = join(tmp, "skills")

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "QUANTA_PROVIDER",
  "QUANTA_MEMORY",
  "QUANTA_MEMORY_PATH",
  "QUANTA_SKILLS_DIR",
  "QUANTA_CONFIG_DIR",
  "QUANTA_SESSIONS_DIR",
  "QUANTA_OBJECTIVE_TOOLS",
  "QUANTA_GOAL_ENFORCE",
  "QUANTA_OBJECTIVE_BUDGET_ENFORCE",
] as const
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))
const savedCwd = process.cwd()
const realFetch = globalThis.fetch
let networkAttempts = 0
const realQuantaHome = join(homedir(), ".quanta")
const homeReadAttempts: string[] = []
const restoreReadGuards: (() => void)[] = []

/** Test-local I/O fence: only real user-state paths are refused; fixture and
 * repository reads still use the real filesystem. Count BEFORE throwing, since
 * production fail-soft readers can otherwise hide an attempted home read. */
const refuseUserHomeRead = (input: unknown): void => {
  const path =
    input instanceof URL ? fileURLToPath(input) : Buffer.isBuffer(input) ? input.toString() : input
  if (typeof path !== "string") return
  const absolute = resolve(path)
  if (absolute !== realQuantaHome && !absolute.startsWith(`${realQuantaHome}${sep}`)) return
  homeReadAttempts.push(absolute)
  throw new Error(`hermetic readout: refused user-home read ${absolute}`)
}

const guardReadBoundary = (owner: object, method: string): void => {
  const boundary = owner as Record<string, (...args: unknown[]) => unknown>
  const original = boundary[method]
  if (original === undefined) throw new Error(`missing filesystem boundary: ${method}`)
  const spy = spyOn(boundary, method).mockImplementation((...args: unknown[]) => {
    refuseUserHomeRead(args[0])
    return Reflect.apply(original, owner, args)
  })
  restoreReadGuards.push(() => spy.mockRestore())
}

const hermeticLlm: LLMPort = {
  provider: "openai",
  model: "hermetic-model",
  async *stream() {},
  listModels: async () => ["hermetic-model", "hermetic-model-next"],
}

const buildHermeticFactory = () =>
  buildProductionRuntimeFactory({
    boot: { provider: "openai", model: "hermetic-model", llm: hermeticLlm },
  })

beforeAll(() => {
  // The production MCP/config loaders must see only the fixture, regardless of
  // whether the developer's checkout later acquires a live .mcp.json.
  process.chdir(tmp)
  for (const name of [
    "readFile",
    "readdir",
    "open",
    "stat",
    "lstat",
    "realpath",
    "readlink",
    "access",
  ] as const) {
    guardReadBoundary(fs, name)
    guardReadBoundary(fs, `${name}Sync`)
    guardReadBoundary(fsp, name)
  }
  guardReadBoundary(fs, "existsSync")
  guardReadBoundary(Bun, "file")
  // Any accidental adapter call is counted and rejected before it can leave
  // the process. The injected boot port's catalog is in-memory, so the final
  // zero assertion proves the production composition never touched a network.
  globalThis.fetch = (async () => {
    networkAttempts += 1
    throw new Error("readout production wiring test attempted network access")
  }) as unknown as typeof fetch
})

afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetRuntimeConfig()
  globalThis.fetch = realFetch
  for (const restore of restoreReadGuards.reverse()) restore()
  process.chdir(savedCwd)
  rmSync(tmp, { recursive: true, force: true })
})

const SNAP: SessionSnapshotLite = makeSnapshotLite({
  sessionId: "wire-1",
  revision: 1,
  seq: 1,
  capabilities: { tools: true, subagents: true, transport: "websocket" },
})

describe("production runtime factory — readout sources are LIVE on the facade", () => {
  test("paired RED injection: user-home reads are refused and counted on every I/O family", () => {
    const target = join(realQuantaHome, "sessions", "hermetic-tripwire.json")
    // Named imports are intentional: this is the form used by the production
    // sticky-model reader and /doctor, so a property-only spy cannot pass.
    expect(() => readFileSync(target)).toThrow("refused user-home read")
    expect(() => readdir(realQuantaHome)).toThrow("refused user-home read")
    expect(() => Bun.file(target)).toThrow("refused user-home read")
    expect(homeReadAttempts).toEqual([target, realQuantaHome, target])
    // Deliberate probes are not production activity. From here any attempted
    // user-state access makes the composition assertions below RED.
    homeReadAttempts.length = 0
  })

  test("facade exposes readoutSources whose accessors serve real data", async () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy-not-a-real-key"
    process.env.QUANTA_PROVIDER = "openai"
    // Every Quanta-owned durable path is rooted in this fixture. In particular,
    // /doctor must scan tmp/sessions, never the developer's ~/.quanta/sessions.
    process.env.QUANTA_CONFIG_DIR = join(tmp, "config")
    process.env.QUANTA_SESSIONS_DIR = join(tmp, "sessions")
    __resetRuntimeConfig()
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

    const factory = buildHermeticFactory()
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

    // model (aug-28) — the model switch's READ half: effective model + the ids
    // `set_model` accepts. The in-memory catalog contains a second candidate,
    // proving the production readout invoked the catalog accessor.
    const model = await resolveReadout("model", SNAP, sources)
    expect(model.wired).toBe(true)
    expect(model.output).toContain("model  hermetic-model")
    expect(model.output).toContain("hermetic-model-next")

    // Cost is deliberately NOT on the facade's readout bundle — the server
    // projects the facade's accounting authority into that accessor.
    expect(sources.cost).toBeUndefined()

    // CENSUS (aug-28) — every source-backed readout is either WIRED here or listed
    // as a documented exception. This replaces the hand-enumeration above as the
    // completeness authority: the `model` readout shipped while this file's list
    // was not extended, so a wired-but-unthreaded readout was invisible. Readout
    // #13 cannot slip the same way.
    const DOCUMENTED_UNWIRED: Readonly<Record<string, string>> = {
      cost: "server-owned accounting projection in startWebDaemon",
      // Composed only when a .mcp.json exists; this hermetic boot has none.
      mcp: "no .mcp.json in the hermetic temp cwd",
      // W1b — the goal accessor reads the objective domain for a THREAD, and the
      // facade is built before any session exists, so it has no key to read
      // under. `startWebDaemon` binds it to the live session id through
      // `buildDaemonReadoutSources`; that composition is proven directly by
      // tests/unit/apps/web-daemon/readout-goal-hellgate.test.ts (including the
      // wrong-thread case), which is what keeps this exception from being a way
      // to ship an unthreaded readout.
      goal: "bound to the live session id in startWebDaemon, not on the facade",
    }
    const unwired: string[] = []
    for (const name of SOURCE_BACKED_READOUTS) {
      const r = await resolveReadout(name, SNAP, sources)
      if (!r.wired && DOCUMENTED_UNWIRED[name] === undefined) unwired.push(name)
    }
    expect(unwired).toEqual([])

    const doctor = await resolveReadout("doctor", SNAP, sources)
    expect(doctor.output).toContain(`root: ${join(tmp, "sessions")}`)
    expect(doctor.output).not.toContain(join(homedir(), ".quanta"))
    expect(networkAttempts).toBe(0)
    expect(homeReadAttempts).toEqual([])
  })

  test("QUANTA_MEMORY=off degrades ONLY the memory readout (honest copy)", async () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy-not-a-real-key"
    process.env.QUANTA_PROVIDER = "openai"
    process.env.QUANTA_MEMORY = "off"
    process.env.QUANTA_CONFIG_DIR = join(tmp, "config-off")
    process.env.QUANTA_SESSIONS_DIR = join(tmp, "sessions-off")
    __resetRuntimeConfig()
    const facade = await buildHermeticFactory()()
    const sources = (facade as { readoutSources?: WebReadoutSources }).readoutSources
    expect(sources).toBeDefined()
    if (sources === undefined) throw new Error("unreachable")
    const memory = await resolveReadout("memory", SNAP, sources)
    expect(memory.wired).toBe(false)
    expect(memory.isError).toBe(false)
    expect(memory.output).toContain("QUANTA_MEMORY")
    // Siblings stay wired.
    expect((await resolveReadout("plan", SNAP, sources)).wired).toBe(true)
    expect(networkAttempts).toBe(0)
    expect(homeReadAttempts).toEqual([])
    delete process.env.QUANTA_MEMORY
  })
})
