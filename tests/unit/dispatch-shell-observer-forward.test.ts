/**
 * ADR-0081 L3 wire — verify the dispatch seam threads
 * `AgentConfig.onShellEvent` into `ToolContext.onShellEvent` (and ONLY then),
 * so the bash tool can forward it to `runShell`.
 *
 * Two invariants:
 *  1. Observer set on AgentConfig ⇒ same reference reaches ctx.onShellEvent.
 *  2. Observer absent ⇒ ctx.onShellEvent stays UNDEFINED (no `onShellEvent:
 *     undefined` key — `exactOptionalPropertyTypes` honoured, byte-identical
 *     default-OFF posture preserved).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import type { ShellExecObserver } from "@/tool/shell-exec-types"

/** A read-only tool whose only job is to record the ctx it received. */
const ctxProbe = (capturedCtx: { value?: ToolContext }): Tool => ({
  name: "ctx_probe",
  description: "captures the ToolContext for assertion",
  inputSchema: z.object({}) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(_input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    capturedCtx.value = ctx
    yield { type: "result", result: { ok: true, output: "probed" } }
  },
})

const perm: PermissionContext = { mode: "acceptEdits" }
const cuse = (input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name: "ctx_probe",
  input,
})

const baseConfig = (
  probeCapture: { value?: ToolContext },
  over: Partial<AgentConfig> = {},
): AgentConfig =>
  ({
    registry: new ToolRegistry([ctxProbe(probeCapture)]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
    ...over,
  }) as AgentConfig

describe("dispatchTool · AgentConfig.onShellEvent → ToolContext.onShellEvent", () => {
  test("observer set on AgentConfig flows through to the tool's ctx by reference", async () => {
    const calls: Array<Parameters<ShellExecObserver>[0]> = []
    const observer: ShellExecObserver = (e) => {
      calls.push(e)
    }
    const captured: { value?: ToolContext } = {}
    await dispatchTool(cuse({}), baseConfig(captured, { onShellEvent: observer }), perm)
    expect(captured.value).toBeDefined()
    expect(captured.value?.onShellEvent).toBe(observer)
    // calling it actually invokes the original (sanity — same function ref).
    captured.value?.onShellEvent?.({
      kind: "start",
      pid: 1,
      command: "echo",
      cwd: "/",
      startedAt: 0,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.kind).toBe("start")
  })

  test("observer absent on AgentConfig ⇒ ctx.onShellEvent is undefined (default-OFF byte-identical)", async () => {
    const captured: { value?: ToolContext } = {}
    await dispatchTool(cuse({}), baseConfig(captured), perm)
    expect(captured.value).toBeDefined()
    // The key MUST be omitted entirely, not present-with-undefined — the
    // dispatch seam uses a conditional spread to honour
    // `exactOptionalPropertyTypes`.
    expect(captured.value && "onShellEvent" in captured.value).toBe(false)
  })
})
