/**
 * jun-6 wave-2 REACHABILITY e2e (HELLGATE) — proves the two SECURITY-critical
 * dispatch wirings act through the REAL composition path (not just the unit
 * harness in the slice hellgates):
 *
 *   A. permission_request hook through the REAL `dispatchTool` →
 *      `runAdmissibilityGate`:
 *        - hook deny  ⇒ the tool is DENIED and never executes;
 *        - hook allow ⇒ the tool is ADMITTED and executes;
 *        - hook allow on a HARD_DENY command ⇒ STILL DENIED (the §4.4 floor —
 *          the security pin: a hook can never route around the denylist);
 *        - no hook / knob OFF ⇒ BYTE-IDENTICAL (the gate falls through to the
 *          policy stack and the call admits as today).
 *
 *   B. interruptBehavior through the REAL `dispatchTool` → `buildToolContext`:
 *        - knob ON + a `block` tool ⇒ `ctx.criticalSection` is wired and the
 *          tool runs over a DERIVED signal (not the raw upstream one), so its
 *          atomic window can withhold an in-flight abort;
 *        - knob OFF ⇒ BYTE-IDENTICAL (no criticalSection; ctx.signal === the
 *          raw upstream signal — a `block` tool behaves exactly like `cancel`).
 *
 * Knobs are driven through the FROZEN runtime-config (set env → reset cache →
 * dispatch → restore), the same way a real run reads them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const ENV_KEYS = ["QUANTA_PERMISSION_HOOK", "QUANTA_TOOL_INTERRUPT_BLOCK"] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  __resetRuntimeConfig()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

const perm: PermissionContext = { mode: "acceptEdits" }

const call = (name: string, input: unknown, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const config = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
    ...over,
  }) as AgentConfig

/* ───────────────── A. permission_request through the REAL gate ───────────── */

const makeBash = (onRun: () => void): Tool => {
  const tool: Tool = {
    name: "bash",
    description: "bash test tool",
    inputSchema: z.object({ command: z.string() }) as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async function* (): AsyncIterable<ToolEvent> {
      onRun()
      yield { type: "result", result: { ok: true, output: "bash-ran" } }
    },
  }
  tool.extractShellCommand = (input: unknown) =>
    typeof (input as { command?: unknown }).command === "string"
      ? (input as { command: string }).command
      : null
  return tool
}

describe("A. permission_request hook — REAL dispatch → admissibility gate", () => {
  test("hook deny ⇒ tool DENIED, never executes (knob ON)", async () => {
    process.env.QUANTA_PERMISSION_HOOK = "1"
    __resetRuntimeConfig()
    let ran = false
    const hooks = new HookBus()
    hooks.on("permission_request", () => ({ permission: "deny", reason: "blocked by policy" }))
    const res = await dispatchTool(
      call("bash", { command: "echo hi" }),
      config({ registry: new ToolRegistry([makeBash(() => (ran = true))]), hooks }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.block.content).toContain("Permission denied")
    expect(res.block.content).toContain("blocked by policy")
    expect(ran).toBe(false)
  })

  test("hook allow ⇒ tool ADMITTED, executes (knob ON)", async () => {
    process.env.QUANTA_PERMISSION_HOOK = "1"
    __resetRuntimeConfig()
    let ran = false
    const hooks = new HookBus()
    hooks.on("permission_request", () => ({ permission: "allow" }))
    const res = await dispatchTool(
      call("bash", { command: "echo hi" }),
      config({ registry: new ToolRegistry([makeBash(() => (ran = true))]), hooks }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(ran).toBe(true)
  })

  test("HEADLINE (SECURITY PIN): hook allow on a HARD_DENY command ⇒ STILL denied", async () => {
    process.env.QUANTA_PERMISSION_HOOK = "1"
    __resetRuntimeConfig()
    let ran = false
    const hooks = new HookBus()
    // The SAME allow that admitted the benign call above must NOT admit a
    // denylisted command — the §4.4 floor holds through the real gate.
    hooks.on("permission_request", () => ({ permission: "allow" }))
    const res = await dispatchTool(
      call("bash", { command: "rm -rf /" }),
      config({ registry: new ToolRegistry([makeBash(() => (ran = true))]), hooks }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.block.content).toMatch(/handoff|Permission denied/)
    expect(ran).toBe(false)
  })

  test("knob OFF ⇒ BYTE-IDENTICAL: hook present but NOT consulted (admits as today)", async () => {
    // QUANTA_PERMISSION_HOOK unset → the gate never emits permission_request.
    delete process.env.QUANTA_PERMISSION_HOOK
    __resetRuntimeConfig()
    let ran = false
    let hookConsulted = false
    const hooks = new HookBus()
    hooks.on("permission_request", () => {
      hookConsulted = true
      return { permission: "deny", reason: "would block IF consulted" }
    })
    const res = await dispatchTool(
      call("bash", { command: "echo hi" }),
      config({ registry: new ToolRegistry([makeBash(() => (ran = true))]), hooks }),
      perm,
    )
    // acceptEdits admits the benign command; the permission_request handler is
    // never consulted because the knob is off.
    expect(hookConsulted).toBe(false)
    expect(res.ok).toBe(true)
    expect(ran).toBe(true)
  })

  test("no HookBus ⇒ BYTE-IDENTICAL even with the knob ON (nothing to emit)", async () => {
    process.env.QUANTA_PERMISSION_HOOK = "1"
    __resetRuntimeConfig()
    let ran = false
    const res = await dispatchTool(
      call("bash", { command: "echo hi" }),
      config({ registry: new ToolRegistry([makeBash(() => (ran = true))]) }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(ran).toBe(true)
  })
})

/* ───────────────── B. interruptBehavior through the REAL dispatch ────────── */

/** A read-only `block` tool that records the ctx it received so the test can
 *  assert whether the dispatch seam threaded a criticalSection + derived signal.
 *  Read-only so the permission gate admits it unconditionally (we are testing
 *  the interrupt wiring, not permission). */
const makeBlockProbe = (
  sink: { ctx?: ToolContext; sawCriticalSection: boolean },
  upstream: AbortSignal,
): Tool => {
  const tool: Tool = {
    name: "block_probe",
    description: "block-interrupt probe",
    inputSchema: z.object({}) as z.ZodType<unknown>,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async function* (_input, ctx): AsyncIterable<ToolEvent> {
      sink.ctx = ctx
      sink.sawCriticalSection = ctx.criticalSection !== undefined
      // Prove the signal is DERIVED (not the raw upstream) when wired: open a
      // section, abort upstream, and confirm the derived signal is withheld.
      if (ctx.criticalSection !== undefined) {
        const section = ctx.criticalSection.begin()
        ;(upstream as AbortSignal & { _fireAbort?: () => void })._fireAbort?.()
        // Inside the section the derived signal must NOT yet be aborted.
        sink.sawCriticalSection = !ctx.signal.aborted
        section.end()
      }
      yield { type: "result", result: { ok: true, output: "probe-ran" } }
    },
  }
  tool.interruptBehavior = () => "block"
  return tool
}

describe("B. interruptBehavior — REAL dispatch → buildToolContext", () => {
  test("knob ON + block tool ⇒ criticalSection WIRED + signal is DERIVED (withholds abort)", async () => {
    process.env.QUANTA_TOOL_INTERRUPT_BLOCK = "1"
    __resetRuntimeConfig()
    const source = new AbortController()
    // expose a fire hook so the probe can abort upstream mid-section
    ;(source.signal as AbortSignal & { _fireAbort?: () => void })._fireAbort = () =>
      source.abort(new Error("esc"))
    const sink = { sawCriticalSection: false } as {
      ctx?: ToolContext
      sawCriticalSection: boolean
    }
    const res = await dispatchTool(
      call("block_probe", {}),
      config({
        registry: new ToolRegistry([makeBlockProbe(sink, source.signal)]),
        signal: source.signal,
      }),
      perm,
    )
    expect(res.ok).toBe(true)
    // criticalSection was wired AND the derived signal withheld the upstream
    // abort while the section was open.
    expect(sink.sawCriticalSection).toBe(true)
    expect(sink.ctx?.criticalSection).toBeDefined()
    // The ctx signal is the DERIVED one, distinct from the raw upstream.
    expect(sink.ctx?.signal).not.toBe(source.signal)
  })

  test("knob OFF ⇒ BYTE-IDENTICAL: no criticalSection, ctx.signal === raw upstream", async () => {
    delete process.env.QUANTA_TOOL_INTERRUPT_BLOCK
    __resetRuntimeConfig()
    const source = new AbortController()
    const sink = { sawCriticalSection: false } as {
      ctx?: ToolContext
      sawCriticalSection: boolean
    }
    const res = await dispatchTool(
      call("block_probe", {}),
      config({
        registry: new ToolRegistry([makeBlockProbe(sink, source.signal)]),
        signal: source.signal,
      }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(sink.ctx?.criticalSection).toBeUndefined()
    // The raw upstream signal is threaded verbatim (byte-identical legacy path).
    expect(sink.ctx?.signal).toBe(source.signal)
  })
})
