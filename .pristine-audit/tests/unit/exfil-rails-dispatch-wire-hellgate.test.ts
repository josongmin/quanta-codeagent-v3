/**
 * jun-6 exfil-rails (a)+(b) — dispatch-seam WIRING hellgate (L3 proof).
 *
 * Proves the rails flow through `dispatchTool` → `buildToolContext` → the REAL
 * write tool end-to-end, gated by the runtime-config knobs:
 *   - (b) glob guard: OFF (default) ⇒ a glob path is a literal write
 *     (byte-identical); ON (`QUANTA_GLOB_WRITE_GUARD=1`) ⇒ typed `rejected`.
 *   - (a) write budget: inert unless BOTH `QUANTA_WRITE_BUDGET=1` AND a cap are
 *     set AND the turn is untrusted (`QUANTA_UNTRUSTED_ENVELOPE=1`); past the cap
 *     ⇒ confirm (denied at dispatch). Trusted turn ⇒ unlimited (no false
 *     positive). All knobs unset ⇒ byte-identical (no counter, no glob check).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { type AssemblerEnv, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import type { ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import { __resetRuntimeConfig } from "@/shared"
import { ToolRegistry } from "@/tool"
import { createSessionWriteBudget } from "@/tool/_shared/write-budget"
import { writeTool } from "@/tool/write"

const perm: PermissionContext = { mode: "acceptEdits" }

let root: string
const saved: Record<string, string | undefined> = {}
const KNOBS = [
  "QUANTA_GLOB_WRITE_GUARD",
  "QUANTA_WRITE_BUDGET",
  "QUANTA_WRITE_BUDGET_MAX",
  "QUANTA_UNTRUSTED_ENVELOPE",
  "QUANTA_PERMISSION_STATE",
]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exfil-wire-"))
  for (const k of KNOBS) saved[k] = process.env[k]
  for (const k of KNOBS) delete process.env[k]
  process.env.QUANTA_PERMISSION_STATE = join(root, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const k of KNOBS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

/** A minimal AgentConfig carrying the REAL write tool, optionally with a
 *  host-assembled `writeBudget` slot, and a turn ordinal. */
const cfg = (over?: Partial<AgentConfig>): AgentConfig =>
  ({
    registry: new ToolRegistry([writeTool]),
    cwd: root,
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
    ...over,
  }) as AgentConfig

const writeCall = (id: string, path: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "write",
  input: { path, content: "x" },
})

describe("(b) glob guard — dispatch wiring", () => {
  test("OFF (default) ⇒ a glob path is written as a literal (byte-identical)", async () => {
    const p = join(root, "lit?.txt")
    const res = await dispatchTool(writeCall("c1", p), cfg(), perm)
    expect(res.ok).toBe(true)
    expect(existsSync(p)).toBe(true)
  })

  test("ON ⇒ a glob path is rejected, no file created", async () => {
    process.env.QUANTA_GLOB_WRITE_GUARD = "1"
    __resetRuntimeConfig()
    const p = join(root, "**/*.ts")
    const res = await dispatchTool(writeCall("c2", p), cfg(), perm)
    expect(res.ok).toBe(false)
    expect(res.preview).toContain("Glob patterns are not allowed")
  })
})

describe("(a) write budget — dispatch wiring (turn binding via config.run.turn)", () => {
  const session = (untrusted: boolean, cap: number) =>
    createSessionWriteBudget({
      untrustedContext: untrusted,
      maxWritesPerTurn: cap,
      overVerdict: "confirm",
    })

  // The budget only threads onto ToolContext when BOTH the slot is present AND
  // QUANTA_WRITE_BUDGET_MAX is set (dispatch reads the cap from runtime-config).
  const armKnobs = (cap: string) => {
    process.env.QUANTA_WRITE_BUDGET = "1"
    process.env.QUANTA_WRITE_BUDGET_MAX = cap
    __resetRuntimeConfig()
  }

  test("budget slot absent ⇒ byte-identical (unlimited writes)", async () => {
    armKnobs("1") // knobs on, but no config.writeBudget slot ⇒ no threading
    const base = cfg({ run: { turn: 0 } } as Partial<AgentConfig>)
    for (let i = 0; i < 5; i++) {
      const r = await dispatchTool(writeCall(`n${i}`, join(root, `n${i}.txt`)), base, perm)
      expect(r.ok).toBe(true)
    }
  })

  test("MAX knob unset ⇒ dispatch does NOT thread the budget (no magic default)", async () => {
    process.env.QUANTA_WRITE_BUDGET = "1"
    // QUANTA_WRITE_BUDGET_MAX deliberately unset.
    __resetRuntimeConfig()
    const base = cfg({ writeBudget: session(true, 1), run: { turn: 0 } } as Partial<AgentConfig>)
    // With no cap in runtime-config, dispatch omits the ctx field ⇒ unlimited.
    for (let i = 0; i < 5; i++) {
      const r = await dispatchTool(writeCall(`u${i}`, join(root, `u${i}.txt`)), base, perm)
      expect(r.ok).toBe(true)
    }
  })

  test("enabled + cap + untrusted ⇒ budget fires past the cap at dispatch", async () => {
    armKnobs("2")
    const base = cfg({ writeBudget: session(true, 2), run: { turn: 0 } } as Partial<AgentConfig>)
    expect((await dispatchTool(writeCall("a", join(root, "a.txt")), base, perm)).ok).toBe(true)
    expect((await dispatchTool(writeCall("b", join(root, "b.txt")), base, perm)).ok).toBe(true)
    const third = await dispatchTool(writeCall("c", join(root, "c.txt")), base, perm)
    expect(third.ok).toBe(false)
    expect(existsSync(join(root, "c.txt"))).toBe(false)
  })

  test("TRUSTED session ⇒ no false positive (unlimited writes)", async () => {
    armKnobs("2")
    const base = cfg({ writeBudget: session(false, 2), run: { turn: 0 } } as Partial<AgentConfig>)
    for (let i = 0; i < 10; i++) {
      const r = await dispatchTool(writeCall(`t${i}`, join(root, `t${i}.txt`)), base, perm)
      expect(r.ok).toBe(true)
    }
  })

  test("PER-TURN reset via dispatch: turn 2 is fresh after turn 1 hit the cap", async () => {
    armKnobs("1")
    const s = session(true, 1)
    const t1 = cfg({ writeBudget: s, run: { turn: 1 } } as Partial<AgentConfig>)
    expect((await dispatchTool(writeCall("t1a", join(root, "t1a.txt")), t1, perm)).ok).toBe(true)
    expect((await dispatchTool(writeCall("t1b", join(root, "t1b.txt")), t1, perm)).ok).toBe(false)
    // Turn 2: dispatch binds turn 2 ⇒ counter resets ⇒ first write is ok again.
    const t2 = cfg({ writeBudget: s, run: { turn: 2 } } as Partial<AgentConfig>)
    expect((await dispatchTool(writeCall("t2a", join(root, "t2a.txt")), t2, perm)).ok).toBe(true)
  })
})

describe("(a) write budget — host assembler routing", () => {
  const baseConfig = (): RuntimeAgentConfigBase =>
    ({ cwd: root }) as unknown as RuntimeAgentConfigBase
  const assembleWith = (env: AssemblerEnv) =>
    assembleAgentConfig({ mode: "interactive", base: baseConfig() }, env)

  test("knobs unset ⇒ cfg.writeBudget UNSET (default-OFF)", () => {
    expect(assembleWith({}).writeBudget).toBeUndefined()
  })

  test("QUANTA_WRITE_BUDGET=1 + cap ⇒ assembler mints the SessionWriteBudget", () => {
    const cfg = assembleWith({ QUANTA_WRITE_BUDGET: "1", QUANTA_WRITE_BUDGET_MAX: "5" })
    expect(cfg.writeBudget).toBeDefined()
  })

  test("enabled but NO cap ⇒ UNSET (no-heuristics: cap is a required knob)", () => {
    expect(assembleWith({ QUANTA_WRITE_BUDGET: "1" }).writeBudget).toBeUndefined()
  })

  test("cap but knob OFF ⇒ UNSET (strict opt-in)", () => {
    expect(assembleWith({ QUANTA_WRITE_BUDGET_MAX: "5" }).writeBudget).toBeUndefined()
  })

  test("untrusted gating: assembled budget is INERT when QUANTA_UNTRUSTED_ENVELOPE unset", () => {
    // Trusted session ⇒ the SessionWriteBudget returns `ok` regardless of count.
    const cfg = assembleWith({ QUANTA_WRITE_BUDGET: "1", QUANTA_WRITE_BUDGET_MAX: "1" })
    const b = cfg.writeBudget
    expect(b).toBeDefined()
    for (let i = 0; i < 10; i++) expect(b?.recordWrite(0)).toBe("ok")
  })

  test("untrusted gating: assembled budget FIRES when QUANTA_UNTRUSTED_ENVELOPE=1", () => {
    const cfg = assembleWith({
      QUANTA_WRITE_BUDGET: "1",
      QUANTA_WRITE_BUDGET_MAX: "1",
      QUANTA_UNTRUSTED_ENVELOPE: "1",
    })
    const b = cfg.writeBudget
    expect(b?.recordWrite(0)).toBe("ok")
    expect(b?.recordWrite(0)).toBe("confirm")
  })
})
