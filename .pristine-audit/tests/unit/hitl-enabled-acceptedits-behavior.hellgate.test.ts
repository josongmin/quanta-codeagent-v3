/**
 * ★ HELLGATE — D-1 behavioral pin (audit W3-D2): what `hitl.enabled` actually
 *   CHANGES at the gate, so the TTY-gated CLI seed is not invisible to the
 *   suite (tests run non-TTY, so the composition seed never fires here — this
 *   pins the GATE semantic the seed turns on).
 *
 * The D-1 delta: with `hitl:{enabled:true}` (web since jun-10, CLI TTY now),
 * an always-confirm-tier tool consults onConfirm EVEN under acceptEdits —
 * previously the CLI fell through to mode policy, which auto-allowed it
 * (UUX-1-03's split). On a sandbox-less surface bash's tier is always-confirm
 * for EVERY command, so bash prompts under acceptEdits too; the [a]lways-
 * session verb + allowlistEscalated dedup are the burden mitigations.
 * jul-10 UPDATE (D-1 follow-through, tier-reason split): under BYPASS a
 * `needs-sandbox`-reason tool now falls through to mode policy (bypass truly
 * bypasses) — see `hitl-tier-reason-split.hellgate.test.ts` for the 12-cell
 * matrix. The acceptEdits cells pinned HERE are UNCHANGED by that split: the
 * tool below declares hitlTier "always-confirm" with NO capability (reason
 * "declared"), and even a needs-sandbox tool still asks under acceptEdits.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetDefaultPermissionStore } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"

const alwaysConfirmTool = (name: string): Tool => {
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
    hitlTier: (_input: unknown): "always-confirm" => "always-confirm",
  }
  return tool
}

const call = (name: string): ToolUseBlock => ({ type: "tool_use", id: "c1", name, input: {} })

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let stateRoot: string | null = null

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "hitl-d1-"))
  process.env.QUANTA_PERMISSION_STATE = join(stateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (stateRoot !== null) {
    rmSync(stateRoot, { recursive: true, force: true })
    stateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

type GateConfig = Parameters<typeof runAdmissibilityGate>[1]

const runGate = async (over: { hitl?: GateConfig["hitl"]; confirm: () => void }) => {
  const tool = alwaysConfirmTool("deployer")
  const cfg: GateConfig = {
    cwd: "/repo",
    planMode: false,
    registry: new ToolRegistry([tool]),
    onConfirm: async () => {
      over.confirm()
      return true
    },
    ...(over.hitl !== undefined ? { hitl: over.hitl } : {}),
  }
  return runAdmissibilityGate(
    call("deployer"),
    cfg,
    { mode: "acceptEdits" } as PermissionContext,
    { tool: "deployer", input: {}, isReadOnly: false },
    undefined,
    {},
  )
}

describe("HELLGATE D-1 — hitl.enabled semantic at the gate (acceptEdits)", () => {
  test("enabled: an always-confirm tool CONSULTS onConfirm under acceptEdits", async () => {
    let asked = 0
    const res = await runGate({ hitl: { enabled: true }, confirm: () => asked++ })
    expect(asked).toBe(1) // the operator was asked (and approved)
    expect(res).toBeNull() // approved ⇒ admitted
  })

  test("PAIRED CONTROL — absent hitl: the same tool auto-runs (the pre-D-1 CLI split)", async () => {
    let asked = 0
    const res = await runGate({ confirm: () => asked++ })
    expect(asked).toBe(0) // fallthrough — mode policy auto-allowed, no ask
    expect(res).toBeNull()
  })
})
