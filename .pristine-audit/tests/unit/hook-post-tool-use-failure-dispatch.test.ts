/**
 * Integration — ADR-0133 `post_tool_use_failure` hook is fired by `dispatch.ts`
 * AFTER a tool's `execute()` returned non-ok (or after the executor threw and
 * dispatch normalized to non-ok). Tests:
 *   - the failure event carries the EXECUTED input and the (post-redaction)
 *     error text;
 *   - on success the failure event is NOT fired (channel is failure-only);
 *   - on success the `post_tool_use` event STILL fires (legacy symmetry);
 *   - on failure BOTH events fire (post_tool_use first, then
 *     post_tool_use_failure);
 *   - matcher gating applies — a hook registered with `{matcher:'bash'}`
 *     does NOT fire for a failing `read`.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolContext } from "@/tool"
import { ToolRegistry } from "@/tool"

const okTool = (name = "echo"): Tool => ({
  name,
  description: "echo",
  inputSchema: z.object({ x: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: (input: unknown, _ctx: ToolContext) =>
    (async function* () {
      yield {
        type: "result" as const,
        result: { ok: true, output: `ran:${(input as { x: string }).x}` },
      }
    })(),
})

const failTool = (name = "fail"): Tool => ({
  name,
  description: "always fails",
  inputSchema: z.object({ x: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: (_input: unknown, _ctx: ToolContext) =>
    (async function* () {
      yield {
        type: "result" as const,
        result: { ok: false, output: "tool reported failure" },
      }
    })(),
})

const baseConfig = (over: Partial<AgentConfig> = {}, tools: Tool[] = []): AgentConfig =>
  ({
    registry: new ToolRegistry(tools.length > 0 ? tools : [okTool(), failTool()]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    stream: { emit: () => undefined },
    ...over,
  }) as AgentConfig

const callOf = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name,
  input,
})

const perm: PermissionContext = { mode: "acceptEdits" }

describe("ADR-0133 — dispatch wires post_tool_use_failure on tool failure", () => {
  test("failure path fires post_tool_use_failure with the executed input and error text", async () => {
    const seen: { name: string; input: unknown; error: string }[] = []
    const hooks = new HookBus()
    hooks.on("post_tool_use_failure", (e) => {
      seen.push({ name: e.name, input: e.input, error: e.error })
    })
    const res = await dispatchTool(callOf("fail", { x: "v" }), baseConfig({ hooks }), perm)
    expect(res.ok).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.name).toBe("fail")
    expect(seen[0]?.input).toEqual({ x: "v" })
    expect(seen[0]?.error).toContain("tool reported failure")
  })

  test("success path does NOT fire post_tool_use_failure (channel is failure-only)", async () => {
    const seen: string[] = []
    const hooks = new HookBus()
    hooks.on("post_tool_use_failure", (e) => {
      seen.push(e.name)
    })
    const res = await dispatchTool(callOf("echo", { x: "v" }), baseConfig({ hooks }), perm)
    expect(res.ok).toBe(true)
    expect(seen).toEqual([])
  })

  test("success path STILL fires post_tool_use (legacy symmetry channel)", async () => {
    const seen: { name: string; ok: boolean }[] = []
    const hooks = new HookBus()
    hooks.on("post_tool_use", (e) => {
      seen.push({ name: e.name, ok: e.ok })
    })
    const res = await dispatchTool(callOf("echo", { x: "v" }), baseConfig({ hooks }), perm)
    expect(res.ok).toBe(true)
    expect(seen).toEqual([{ name: "echo", ok: true }])
  })

  test("failure path fires BOTH post_tool_use (ok:false) AND post_tool_use_failure (ordered)", async () => {
    const order: string[] = []
    const hooks = new HookBus()
    hooks.on("post_tool_use", () => {
      order.push("post_tool_use")
    })
    hooks.on("post_tool_use_failure", () => {
      order.push("post_tool_use_failure")
    })
    const res = await dispatchTool(callOf("fail", { x: "v" }), baseConfig({ hooks }), perm)
    expect(res.ok).toBe(false)
    // Order: legacy symmetry first, then the typed failure channel.
    expect(order).toEqual(["post_tool_use", "post_tool_use_failure"])
  })

  test("matcher gating: a hook bound to 'bash' does NOT fire for a failing 'fail' tool", async () => {
    const seen: string[] = []
    const hooks = new HookBus()
    hooks.on(
      "post_tool_use_failure",
      (e) => {
        seen.push(e.name)
      },
      { matcher: ["bash"] },
    )
    await dispatchTool(callOf("fail", { x: "v" }), baseConfig({ hooks }), perm)
    expect(seen).toEqual([])
  })

  test("a throwing post_tool_use_failure handler does NOT corrupt the tool result (dispatch no-throw contract)", async () => {
    const hooks = new HookBus()
    hooks.on("post_tool_use_failure", () => {
      throw new Error("hook boom")
    })
    // dispatchTool MUST return a normal failure result, never throw.
    const res = await dispatchTool(callOf("fail", { x: "v" }), baseConfig({ hooks }), perm)
    expect(res.ok).toBe(false)
    expect(res.preview).toContain("tool reported failure")
  })
})
