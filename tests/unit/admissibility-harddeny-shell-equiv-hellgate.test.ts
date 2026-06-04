/**
 * ★ CONTRACT — A1 (audit findings #3/#5/#9): HARD_DENY is enforced UNIFORMLY
 *   across the admissibility gate for ANY shell-equivalent tool, and no
 *   allow-capable path (mode-policy under bypass, the permission stack, or a
 *   tool-profile confirm-approval) can route a denylisted command around the
 *   security boundary. A tool-profile confirm-approval ALSO honours the
 *   pre_tool_use hook as the irrevocable last gate (parity with every other
 *   allow path).
 *
 * HELLGATE — these are adversarial. Each case maxes out an allow-capable axis
 * and points it at a denylisted command (or, for #9, at a hook veto) and
 * asserts the gate still DENIES.
 *
 * Defects proven blocked:
 *   #3 — a NON-bash shell-equivalent tool (exposes `extractShellCommand`) with
 *        a HARD_DENY command reaches mode-policy / the permission stack with NO
 *        early-hard-deny bypass wired. Before the fix the gate dropped the
 *        registry-derived command off the action, so `hardDeny()` inside
 *        `evaluate`/`evaluateStack` fell back to the bash-only legacy probe and
 *        the dangerous command was ADMITTED. After the fix it is DENIED.
 *   #5 — a tool-profile `confirm` outcome whose onConfirm approves a HARD_DENY
 *        command. Before the fix the confirm-approval admitted it; after, the
 *        HARD_DENY check fires first and DENIES (onConfirm never consulted).
 *   #9 — a tool-profile confirm-APPROVAL of a SAFE command must still hit the
 *        pre_tool_use hook, which can veto last. Before the fix the profile
 *        confirm path returned admit (null) WITHOUT the hook.
 *
 * Source under test: src/agent/admissibility-gate.ts (runAdmissibilityGate).
 * Helpers mirror tests/unit/admissibility-hellgate.test.ts (test files are not
 * importable as modules — intentionally duplicated).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import type {
  ToolPolicy,
  ToolProfileName,
  ToolProfileResolver,
} from "@/agent/tool-profile"
import type { ToolUseBlock } from "@/llm"
import {
  __resetDefaultPermissionStore,
  type PermissionContext,
} from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

const shellSchema = z.object({ command: z.string() })

/** A NON-bash shell-equivalent tool: it is named "shell" (NOT "bash") and
 *  exposes `extractShellCommand`. The bash-only legacy HARD_DENY probe does
 *  NOT cover it — only the registry-derived path does. */
const makeShellTool = (name: string): Tool => {
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: shellSchema as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }
  ;(
    tool as Tool & { extractShellCommand: (input: unknown) => string | null }
  ).extractShellCommand = (input) => (input as { command: string }).command
  return tool
}

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const cfg = (over: Record<string, unknown> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

/** A profile slot whose resolver ALWAYS returns the given policy kind. */
const profileSlot = (kind: ToolPolicy["kind"]): AgentConfig["toolProfile"] => {
  const resolver: ToolProfileResolver = {
    resolve: () => ({ kind, reason: `forced ${kind}` }),
  }
  return { resolver, defaultName: "ask" as ToolProfileName }
}

/** The action the dispatch seam would pass — deliberately WITHOUT shellCommand,
 *  exactly like the production `actionOf` helper, to prove the gate re-derives
 *  it from the registry rather than trusting the caller. */
const actionOf = (tool: Tool, input: unknown): AdmissibilityAction => ({
  tool: tool.name,
  input,
  isReadOnly: tool.isReadOnly(),
})

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "a1-harddeny-shell-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

const shell = makeShellTool("shell")

describe("HELLGATE A1#3 — HARD_DENY fires for a NON-bash shell-equivalent tool", () => {
  // No rulesStore / reviewerPort / permissionPatternStore ⇒ earlyHardDeny is
  // SKIPPED. The denylist must therefore be enforced by the downstream gates
  // (mode-policy `evaluate` / permission-stack `evaluateStack`), which only
  // works if the gate re-derives shellCommand from the registry.
  const danger = "rm -rf /"

  test("bypass mode (no stack) — dangerous command is DENIED, not admitted", async () => {
    const c = cfg({
      registry: new ToolRegistry([shell]),
      permission: { mode: "bypass" },
    })
    const input = { command: danger }
    const res = await runAdmissibilityGate(
      call("shell", input),
      c,
      { mode: "bypass" },
      actionOf(shell, input),
    )
    expect(res).not.toBeNull()
    expect(res?.block.content).toContain("Blocked dangerous command")
    expect(res?.block.content).toContain(danger)
  })

  test("permission stack enabled + bypass — dangerous command is DENIED via the stack", async () => {
    const c = cfg({
      registry: new ToolRegistry([shell]),
      permission: { mode: "bypass" },
      sessionId: "t-1",
      permissionStack: { enabled: true },
    })
    const input = { command: danger }
    const res = await runAdmissibilityGate(
      call("shell", input),
      c,
      { mode: "bypass" },
      actionOf(shell, input),
    )
    expect(res).not.toBeNull()
    expect(res?.block.content).toContain("Blocked dangerous command")
  })

  test("a SAFE non-bash shell command is NOT hard-denied (no false positive)", async () => {
    const hooks = new HookBus()
    let hookSeen = false
    hooks.on("pre_tool_use", () => {
      hookSeen = true
    })
    const c = cfg({
      registry: new ToolRegistry([shell]),
      permission: { mode: "bypass" },
      hooks,
    })
    const input = { command: "git status" }
    const res = await runAdmissibilityGate(
      call("shell", input),
      c,
      { mode: "bypass" },
      actionOf(shell, input),
    )
    // Admitted (null) — bypass mode allows; hook consulted on the admit path.
    expect(res).toBeNull()
    expect(hookSeen).toBe(true)
  })
})

describe("HELLGATE A1#5 — a tool-profile confirm-approval can NOT admit a HARD_DENY", () => {
  test("profile=confirm + onConfirm approves rm -rf / ⇒ DENIED (handoff), onConfirm never consulted", async () => {
    let confirmed = false
    const c = cfg({
      registry: new ToolRegistry([shell]),
      permission: { mode: "default" },
      toolProfile: profileSlot("confirm"),
      onConfirm: async () => {
        confirmed = true
        return true
      },
    })
    const input = { command: "rm -rf /" }
    const res = await runAdmissibilityGate(
      call("shell", input),
      c,
      { mode: "default" },
      actionOf(shell, input),
    )
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("handoff")
    expect(res?.block.content).toContain("human handoff")
    expect(res?.block.content).toContain("Blocked dangerous command")
    // HARD_DENY short-circuits BEFORE the confirm prompt — the user is never
    // even asked, so an "approve everything" handler cannot route around it.
    expect(confirmed).toBe(false)
  })
})

describe("HELLGATE A1#9 — a tool-profile confirm-APPROVAL still hits the pre_tool_use hook", () => {
  test("profile=confirm approves a SAFE command, hook denies ⇒ final DENY", async () => {
    let hookCount = 0
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => {
      hookCount += 1
      return { deny: "exfil policy" }
    })
    let confirmed = false
    const c = cfg({
      registry: new ToolRegistry([shell]),
      permission: { mode: "default" },
      toolProfile: profileSlot("confirm"),
      hooks,
      onConfirm: async () => {
        confirmed = true
        return true
      },
    })
    const input = { command: "git status" } // safe — no HARD_DENY
    const res = await runAdmissibilityGate(
      call("shell", input),
      c,
      { mode: "default" },
      actionOf(shell, input),
    )
    // The confirm-approval was admitted by the profile, then the hook vetoed.
    expect(confirmed).toBe(true)
    expect(hookCount).toBe(1)
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("hook-denied")
    expect(res?.block.content).toContain("exfil policy")
  })
})
