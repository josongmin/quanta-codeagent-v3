import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolContext } from "@/tool"
import { ToolRegistry } from "@/tool"

/**
 * Feature: `pre_tool_use` hooks may REWRITE tool args (`updatedInput`, Cursor
 * `updated_input` parity). Two layers under test:
 *   1. HookBus.emit — returns the composed rewrite; rewrites chain; the key is
 *      present only when a handler actually rewrote.
 *   2. dispatch — the MUTATED input is what reaches the tool's execute.
 */
describe("HookBus updatedInput (rewrite seam)", () => {
  test("a pre_tool_use handler's updatedInput is returned by emit", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }))
    const result = await bus.emit({ type: "pre_tool_use", name: "read", input: { path: "orig" } })
    expect(result.deny).toBeNull()
    expect("updatedInput" in result).toBe(true)
    expect(result.updatedInput).toEqual({ path: "rewritten" })
  })

  test("no rewrite ⇒ emit omits the updatedInput key entirely", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => undefined)
    const result = await bus.emit({ type: "pre_tool_use", name: "read", input: { path: "orig" } })
    expect("updatedInput" in result).toBe(false)
  })

  test("rewrites compose: each handler sees the prior handler's updatedInput", async () => {
    const bus = new HookBus()
    const seen: unknown[] = []
    bus.on("pre_tool_use", (e) => {
      seen.push(e.input)
      return { updatedInput: { n: 1 } }
    })
    bus.on("pre_tool_use", (e) => {
      seen.push(e.input)
      return { updatedInput: { n: 2 } }
    })
    const result = await bus.emit({ type: "pre_tool_use", name: "x", input: { n: 0 } })
    // first handler saw original, second handler saw the first's rewrite
    expect(seen).toEqual([{ n: 0 }, { n: 1 }])
    // last rewrite wins
    expect(result.updatedInput).toEqual({ n: 2 })
  })

  test("an explicit rewrite to a falsy value is still surfaced (presence, not truthiness)", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => ({ updatedInput: null }))
    const result = await bus.emit({ type: "pre_tool_use", name: "x", input: { a: 1 } })
    expect("updatedInput" in result).toBe(true)
    expect(result.updatedInput).toBeNull()
  })

  test("matcher gating applies to rewrites too (non-matching handler does not rewrite)", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => ({ updatedInput: { rewritten: true } }), { matcher: ["write"] })
    const result = await bus.emit({ type: "pre_tool_use", name: "read", input: { x: 1 } })
    expect("updatedInput" in result).toBe(false)
  })

  test("a handler that both denies AND rewrites: deny is recorded; rewrite still surfaced (dispatch honours deny first)", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => ({ deny: "no", updatedInput: { x: 9 } }))
    const result = await bus.emit({ type: "pre_tool_use", name: "x", input: {} })
    expect(result.deny).toEqual({ deny: "no" })
    expect(result.updatedInput).toEqual({ x: 9 })
  })
})

// --- dispatch integration: the rewritten input reaches execute -------------

/** Echo tool: reflects the input it actually received into its output, so the
 *  test can assert WHICH input executed. */
const echoTool = (): Tool => ({
  name: "echo",
  description: "echo test tool",
  inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: (input: unknown, _ctx: ToolContext) =>
    (async function* () {
      yield {
        type: "result" as const,
        result: { ok: true, output: `executed:${(input as { path: string }).path}` },
      }
    })(),
})

const baseConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([echoTool()]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

const callOf = (input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name: "echo",
  input,
})

const perm: PermissionContext = { mode: "acceptEdits" }

describe("dispatchTool applies pre_tool_use updatedInput", () => {
  test("hook rewrite is the input that actually executes", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }))
    const res = await dispatchTool(callOf({ path: "original" }), baseConfig({ hooks }), perm)
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("executed:rewritten")
  })

  test("no hook ⇒ original input executes (byte-identical default path)", async () => {
    const res = await dispatchTool(callOf({ path: "original" }), baseConfig(), perm)
    expect(res.preview).toBe("executed:original")
  })

  test("a denying hook short-circuits before execute even if it also rewrote", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "blocked", updatedInput: { path: "rewritten" } }))
    const res = await dispatchTool(callOf({ path: "original" }), baseConfig({ hooks }), perm)
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("hook-denied")
    expect(res.block.content).toContain("Hook denied: blocked")
  })
})
