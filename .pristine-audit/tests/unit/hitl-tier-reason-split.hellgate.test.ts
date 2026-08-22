/**
 * ★ HELLGATE — D-1 follow-through (jul-10): split the needs-sandbox tier from
 *   confirm:"sensitive" at the PDP.
 *
 * WHY: D-1 seeded `hitl:{enabled:true}` on the TTY CLI. Because bash without a
 * sandbox profile conflates to `always-confirm` (src/tool/bash/index.ts
 * tierForProfile off/undefined ⇒ always-confirm; src/permission/pdp.ts
 * documents the conflation), EVERY bash command prompted under acceptEdits AND
 * bypass. Target matrix (Claude Code parity):
 *
 *   - reason = "sensitive" (git push etc.): asks under ALL modes incl. bypass
 *     (the universal floor — unchanged).
 *   - reason = "needs-sandbox" (bash w/o profile, mutating MCP tools w/o
 *     hitlTier): asks under default AND acceptEdits, but BYPASS TRULY BYPASSES
 *     (falls through to mode policy, which allows — HARD_DENY still wins).
 *
 * FULL 12-CELL MATRIX pinned below ({sensitive, needs-sandbox} × {default,
 * acceptEdits, bypass} × hitl {enabled, absent}); the single changed cell is
 * needs-sandbox × enabled × bypass (ask → auto). All other cells are PAIRED
 * CONTROLS pinning today's behavior.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { __resetHitlOverrides } from "@/agent"
import { runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetDefaultPermissionStore } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"

type Mode = "default" | "acceptEdits" | "bypass"

/** Inherently-sensitive always-confirm tool (git push shape). */
const sensitiveTool = (name: string): Tool =>
  ({
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    capability: () => ({ confirm: "sensitive" as const }),
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }) as Tool

/** bash-w/o-profile shape: always-confirm tier, capability needs-sandbox,
 *  shell-equivalent (extractShellCommand) so HARD_DENY applies. */
const needsSandboxTool = (name: string): Tool =>
  ({
    name,
    description: `${name} tool`,
    inputSchema: z.object({ command: z.string().optional() }).passthrough() as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    capability: () => ({ confirm: "needs-sandbox" as const }),
    extractShellCommand: (input: { command?: string }) => input.command ?? "",
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }) as Tool

/** Mutating MCP-tool shape: NO hitlTier, NO capability — the `inferToolTier`
 *  fail-closed catch-all (always-confirm). */
const inferredCatchAllTool = (name: string): Tool =>
  ({
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }) as Tool

/** Explicitly-declared always-confirm WITHOUT a capability (deliberate audit
 *  ceremony — e.g. `git_commit --amend`, workspace-write-net bash). */
const declaredTool = (name: string): Tool =>
  ({
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }) as Tool

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
const originalOverrides = process.env.QUANTA_HITL_OVERRIDES
let stateRoot: string | null = null

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "hitl-split-"))
  process.env.QUANTA_PERMISSION_STATE = join(stateRoot, "permission-state.json")
  delete process.env.QUANTA_HITL_OVERRIDES
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
  __resetHitlOverrides()
})

afterEach(() => {
  if (stateRoot !== null) {
    rmSync(stateRoot, { recursive: true, force: true })
    stateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  if (originalOverrides === undefined) delete process.env.QUANTA_HITL_OVERRIDES
  else process.env.QUANTA_HITL_OVERRIDES = originalOverrides
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
  __resetHitlOverrides()
})

const runGate = async (args: {
  tool: Tool
  mode: Mode
  hitl?: AgentConfig["hitl"]
  input?: Record<string, unknown>
}): Promise<{ asked: number; res: unknown }> => {
  let asked = 0
  const name = args.tool.name
  const input = args.input ?? {}
  const call: ToolUseBlock = { type: "tool_use", id: "c1", name, input }
  const cfg = {
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: args.mode } as PermissionContext,
    registry: new ToolRegistry([args.tool]),
    onConfirm: async () => {
      asked += 1
      return true
    },
    ...(args.hitl !== undefined ? { hitl: args.hitl } : {}),
  } as unknown as AgentConfig
  const res = await runAdmissibilityGate(
    call,
    cfg,
    { mode: args.mode } as PermissionContext,
    { tool: name, input, isReadOnly: false },
    undefined,
    {},
  )
  return { asked, res }
}

/* ------------------------------------------------------------------------- *
 * THE 12-CELL MATRIX. `ask: 1` ⇒ onConfirm consulted exactly once (approve ⇒
 * admitted); `ask: 0` ⇒ auto (admitted with NO consult). Every cell expects
 * admission (res === null) because the confirm handler approves.
 * ------------------------------------------------------------------------- */
const MATRIX: ReadonlyArray<{
  toolKind: "sensitive" | "needs-sandbox"
  hitl: "enabled" | "absent"
  mode: Mode
  ask: 0 | 1
  note: string
}> = [
  // sensitive — universal floor: asked in EVERY cell (all paired controls).
  { toolKind: "sensitive", hitl: "enabled", mode: "default", ask: 1, note: "control" },
  { toolKind: "sensitive", hitl: "enabled", mode: "acceptEdits", ask: 1, note: "control" },
  { toolKind: "sensitive", hitl: "enabled", mode: "bypass", ask: 1, note: "floor holds" },
  { toolKind: "sensitive", hitl: "absent", mode: "default", ask: 1, note: "control" },
  { toolKind: "sensitive", hitl: "absent", mode: "acceptEdits", ask: 1, note: "control" },
  { toolKind: "sensitive", hitl: "absent", mode: "bypass", ask: 1, note: "floor holds" },
  // needs-sandbox — asks under default/acceptEdits when hitl enabled; BYPASS
  // TRULY BYPASSES (the one changed cell). hitl-absent row = mode policy.
  { toolKind: "needs-sandbox", hitl: "enabled", mode: "default", ask: 1, note: "control" },
  { toolKind: "needs-sandbox", hitl: "enabled", mode: "acceptEdits", ask: 1, note: "control" },
  { toolKind: "needs-sandbox", hitl: "enabled", mode: "bypass", ask: 0, note: "THE SPLIT" },
  { toolKind: "needs-sandbox", hitl: "absent", mode: "default", ask: 1, note: "mode ask" },
  { toolKind: "needs-sandbox", hitl: "absent", mode: "acceptEdits", ask: 0, note: "control" },
  { toolKind: "needs-sandbox", hitl: "absent", mode: "bypass", ask: 0, note: "control" },
]

describe("HELLGATE — needs-sandbox vs sensitive 12-cell matrix", () => {
  for (const cell of MATRIX) {
    test(`${cell.toolKind} × hitl-${cell.hitl} × ${cell.mode} ⇒ ask=${cell.ask} (${cell.note})`, async () => {
      const tool =
        cell.toolKind === "sensitive" ? sensitiveTool("deployer") : needsSandboxTool("sh")
      const { asked, res } = await runGate({
        tool,
        mode: cell.mode,
        ...(cell.hitl === "enabled" ? { hitl: { enabled: true } } : {}),
      })
      expect(asked).toBe(cell.ask)
      expect(res).toBeNull() // approved / auto ⇒ admitted in every matrix cell
    })
  }
})

describe("HELLGATE — inferred catch-all (mutating MCP tool w/o hitlTier) rides the needs-sandbox split", () => {
  test("hitl enabled × bypass ⇒ auto (bypass truly bypasses)", async () => {
    const { asked, res } = await runGate({
      tool: inferredCatchAllTool("mcp_mutator"),
      mode: "bypass",
      hitl: { enabled: true },
    })
    expect(asked).toBe(0)
    expect(res).toBeNull()
  })

  test("PAIRED CONTROL — hitl enabled × acceptEdits ⇒ still asks (not an edit)", async () => {
    const { asked, res } = await runGate({
      tool: inferredCatchAllTool("mcp_mutator"),
      mode: "acceptEdits",
      hitl: { enabled: true },
    })
    expect(asked).toBe(1)
    expect(res).toBeNull()
  })
})

describe("ADVERSARIAL — the bypass fallthrough must not weaken any harder gate", () => {
  test("denylisted command CANNOT smuggle through the needs-sandbox bypass fallthrough (HARD_DENY wins)", async () => {
    const { asked, res } = await runGate({
      tool: needsSandboxTool("sh"),
      mode: "bypass",
      hitl: { enabled: true },
      input: { command: "rm -rf /usr" },
    })
    expect(asked).toBe(0) // never consulted — terminal deny, not an ask
    expect(res).not.toBeNull() // BLOCKED — never admitted
    // AND it blocks through the HANDOFF seam (runHitlGate's hard-deny path),
    // not the mode-policy wording — the onHandoff/OTel handoff contract holds.
    const denied = res as { ok: boolean; preview: string }
    expect(denied.ok).toBe(false)
    expect(denied.preview).toBe("handoff")
  })

  test("a sensitive tool NEVER rides the needs-sandbox fallthrough, even declaring hitlTier 'pre-approval-ok'", async () => {
    // Sneaky shape: hitlTier says pre-approval-ok but capability says sensitive
    // — the capability is the SSOT and promotes to the universal floor.
    const sneaky = {
      ...sensitiveTool("sneaky"),
      hitlTier: () => "pre-approval-ok",
    } as unknown as Tool
    const { asked, res } = await runGate({ tool: sneaky, mode: "bypass", hitl: { enabled: true } })
    expect(asked).toBe(1) // STILL asked under bypass — the floor holds
    expect(res).toBeNull()
  })

  test("a DECLARED always-confirm tool (no capability) does NOT ride the bypass fallthrough", async () => {
    const { asked, res } = await runGate({
      tool: declaredTool("amender"),
      mode: "bypass",
      hitl: { enabled: true },
    })
    expect(asked).toBe(1) // explicit declaration keeps its confirm under bypass
    expect(res).toBeNull()
  })

  test("an UNRECOGNIZED confirm value (untyped bridge tool) stays fail-closed — no bypass ride, no tier downgrade", async () => {
    // Legacy `inferToolTier` escalated ANY truthy confirm to always-confirm.
    // The reason split must keep that: an unknown value is "declared" (asks
    // under bypass), NEVER "needs-sandbox" (would auto-run) and NEVER a
    // downgrade to the read-only "none" fallback.
    const untyped = {
      ...inferredCatchAllTool("bridge"),
      isReadOnly: () => true, // read-only-LOOKING — the nastiest downgrade shape
      capability: () => ({ confirm: "yolo" }),
    } as unknown as Tool
    const { asked, res } = await runGate({ tool: untyped, mode: "bypass", hitl: { enabled: true } })
    expect(asked).toBe(1) // still confirmed under bypass — fail-closed parity
    expect(res).toBeNull()
  })

  test("a REGISTRY-escalated always-confirm tool does NOT ride the bypass fallthrough", async () => {
    // Operator override escalates a pre-approval-ok tool to always-confirm —
    // reason "registry", not "needs-sandbox": the operator asked for the gate.
    const overridesPath = join(stateRoot ?? tmpdir(), "hitl-overrides.json")
    writeFileSync(
      overridesPath,
      JSON.stringify({ version: 1, annotations: [{ tool: "escalated", tier: "always-confirm" }] }),
    )
    process.env.QUANTA_HITL_OVERRIDES = overridesPath
    __resetRuntimeConfig()
    __resetHitlOverrides()
    const preApproved = {
      ...declaredTool("escalated"),
      hitlTier: () => "pre-approval-ok",
    } as unknown as Tool
    const { asked, res } = await runGate({
      tool: preApproved,
      mode: "bypass",
      hitl: { enabled: true },
    })
    expect(asked).toBe(1) // operator escalation holds under bypass
    expect(res).toBeNull()
  })
})
