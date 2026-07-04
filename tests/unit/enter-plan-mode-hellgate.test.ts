/**
 * Hellgate — `enter_plan_mode` (model-driven plan-mode ENTRY, the inverse of
 * `request_plan_exit`).
 *
 * Contract pinned here:
 *   - Registered ONLY when `config.planExitPort` is wired (pairs with the exit
 *     tool so the round-trip is always closable). Absent ⇒ byte-identical off.
 *   - Read-only + concurrency-SAFE (unlike exit, entry blocks on NOBODY — it
 *     only restricts the agent, the safe direction — so no operator round-trip).
 *   - Classified `null` in MUTATING_TOOL_TABLE ⇒ always callable in BOTH modes
 *     (you call it FROM default to enter; a second call in plan mode is a no-op).
 *   - The handler relays the reason to `ctx.enterPlanMode`; the loop applies the
 *     mode flip at the NEXT turn boundary via `applyPendingPlanEntry`.
 *   - `applyPendingPlanEntry` flips default→plan (planMode/mode/collaborationMode),
 *     emits a single `mode_changed{from:default,to:plan}`, injects a reminder.
 *   - Idempotent: applying it when ALREADY in plan mode is a no-op (no emit).
 *   - After entry, the dispatch seam blocks a mutating tool with the mode-block.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { applyPendingPlanEntry } from "@/agent/loop/plan-enter-wire"
import { assertNotMutatingInPlanMode, isMutatingTool, mutatingToolKind } from "@/agent/mode"
import { buildEnterPlanBlock } from "@/agent/tier1/enter-plan"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent } from "@/stream"
import { enterPlanModeTool } from "@/tool/enter-plan-mode"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const dummyPort = async () => ({ decision: "approved" as const })

const collectStream = () => {
  const events: AgentEvent[] = []
  return { stream: { emit: (e: AgentEvent) => events.push(e) }, events }
}

const runTool = async (
  ctx: Partial<ToolContext>,
  input: unknown = { reason: "multi-file refactor; plan first" },
): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const ev of enterPlanModeTool().execute(input as never, ctx as ToolContext)) {
    out.push(ev)
  }
  return out
}

describe("enter_plan_mode — gating (default-ON with the plan lifecycle, byte-identical off)", () => {
  test("buildEnterPlanBlock returns undefined without planExitPort (byte-identical off)", () => {
    expect(buildEnterPlanBlock({} as AgentConfig)).toBeUndefined()
  })

  test("buildEnterPlanBlock returns the tool when planExitPort is wired (pairs with exit)", () => {
    const tool = buildEnterPlanBlock({ planExitPort: dummyPort } as unknown as AgentConfig)
    expect(tool?.name).toBe("enter_plan_mode")
  })
})

describe("enter_plan_mode — tool contract", () => {
  test("read-only AND concurrency-safe (entry restricts only the agent; no operator block)", () => {
    const t = enterPlanModeTool()
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({ reason: "x" })).toBe(true)
  })

  test("classified null in MUTATING_TOOL_TABLE ⇒ callable in BOTH modes", () => {
    expect(isMutatingTool("enter_plan_mode")).toBe(false)
    expect(mutatingToolKind("enter_plan_mode")).toBeNull()
    expect(() => assertNotMutatingInPlanMode("plan", "enter_plan_mode")).not.toThrow()
    expect(() => assertNotMutatingInPlanMode("default", "enter_plan_mode")).not.toThrow()
  })

  test("handler relays the reason to ctx.enterPlanMode and reports success", async () => {
    let seen: string | undefined
    const events = await runTool({ enterPlanMode: (reason: string) => (seen = reason) })
    expect(seen).toBe("multi-file refactor; plan first")
    const result = events.find((e) => e.type === "result")
    expect(result).toMatchObject({ result: { ok: true } })
  })

  test("handler degrades gracefully when the port is unwired (ok:false, no throw)", async () => {
    const events = await runTool({})
    const result = events.find((e) => e.type === "result") as Extract<ToolEvent, { type: "result" }>
    expect(result.result.ok).toBe(false)
    expect(result.result.output).toContain("unavailable")
  })
})

describe("applyPendingPlanEntry — the deferred next-turn flip", () => {
  test("flips default→plan, emits ONE mode_changed, injects a reminder", () => {
    const { stream, events } = collectStream()
    const cfg = { stream } as unknown as AgentConfig
    const hooks: { injectAfterSystem?: string }[] = []
    applyPendingPlanEntry(cfg, { reason: "big change" }, hooks as never)
    expect(cfg.planMode).toBe(true)
    expect(cfg.mode).toBe("plan")
    expect(cfg.collaborationMode).toBe("plan")
    const modeChanges = events.filter((e) => e.type === "mode_changed")
    expect(modeChanges).toHaveLength(1)
    expect(modeChanges[0]).toMatchObject({ from: "default", to: "plan" })
    expect(hooks).toHaveLength(1)
    expect(hooks[0]?.injectAfterSystem).toContain("big change")
  })

  test("idempotent — a no-op when already in plan mode (no emit, no reminder)", () => {
    const { stream, events } = collectStream()
    const cfg = { stream, collaborationMode: "plan" } as unknown as AgentConfig
    const hooks: unknown[] = []
    applyPendingPlanEntry(cfg, { reason: "again" }, hooks as never)
    expect(events.filter((e) => e.type === "mode_changed")).toHaveLength(0)
    expect(hooks).toHaveLength(0)
  })

  test("tighten-only: no-op from another read-only posture (review) — no silent downgrade", () => {
    const { stream, events } = collectStream()
    const cfg = { stream, mode: "review" } as unknown as AgentConfig
    const hooks: unknown[] = []
    applyPendingPlanEntry(cfg, { reason: "refine" }, hooks as never)
    // review is read-only already; entry must NOT rewrite it to plan.
    expect(cfg.mode).toBe("review")
    expect(events.filter((e) => e.type === "mode_changed")).toHaveLength(0)
    expect(hooks).toHaveLength(0)
  })

  test("flips a write-capable editor posture into plan", () => {
    const { stream, events } = collectStream()
    const cfg = { stream, mode: "editor" } as unknown as AgentConfig
    applyPendingPlanEntry(cfg, { reason: "stop and plan" }, [] as never)
    expect(cfg.mode).toBe("plan")
    expect(events.filter((e) => e.type === "mode_changed")).toHaveLength(1)
  })

  test("null pending is a no-op", () => {
    const { stream, events } = collectStream()
    const cfg = { stream } as unknown as AgentConfig
    applyPendingPlanEntry(cfg, null, [] as never)
    expect(cfg.planMode).toBeUndefined()
    expect(events).toHaveLength(0)
  })
})

describe("enter_plan_mode — dispatch integration (enter, then the seam blocks a mutation)", () => {
  const perm: PermissionContext = { mode: "acceptEdits" }
  const writeStub = (): Tool =>
    ({
      name: "write",
      description: "test write stub",
      inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async function* (): AsyncIterable<ToolEvent> {
        yield { type: "result", result: { ok: true, output: "wrote" } }
      },
    }) as Tool

  test("enter_plan_mode dispatched in default mode invokes the enter thunk", async () => {
    let seen: string | undefined
    const cfg = {
      registry: new ToolRegistry([enterPlanModeTool() as Tool]),
      cwd: "/tmp",
      signal: new AbortController().signal,
      permission: perm,
      planExitPort: dummyPort,
      onPlanEnterRequest: (e: { reason: string }) => (seen = e.reason),
    } as unknown as AgentConfig
    const call: ToolUseBlock = {
      type: "tool_use",
      id: "e1",
      name: "enter_plan_mode",
      input: { reason: "investigate before editing" },
    }
    const res = await dispatchTool(call, cfg, perm)
    expect(res.ok).toBe(true)
    expect(seen).toBe("investigate before editing")
  })

  test("once planMode is active, the seam blocks a mutating write (mode-blocked)", async () => {
    const cfg = {
      registry: new ToolRegistry([writeStub()]),
      cwd: "/tmp",
      signal: new AbortController().signal,
      permission: perm,
      planMode: true,
    } as unknown as AgentConfig
    const call: ToolUseBlock = {
      type: "tool_use",
      id: "w1",
      name: "write",
      input: { path: "/tmp/x" },
    }
    const res = await dispatchTool(call, cfg, perm)
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    expect(res.block.content).toContain("blocked in plan collaboration mode")
  })
})
