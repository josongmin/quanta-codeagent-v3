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
 * Cursor `preToolUse.updated_input` absorption — a `pre_tool_use` hook may
 * REWRITE the tool args before execution, alongside the existing deny path.
 *
 * Contract under test (canonical (a)-(g) matrix):
 *   (a) no hook            ⇒ byte-identical (original input executes)
 *   (b) {updatedInput}     ⇒ execute sees the mutated input
 *   (c) {deny}             ⇒ still denies (unchanged)
 *   (d) deny + mutate (different handlers) ⇒ deny WINS (deny > mutate)
 *   (e) multiple mutators  ⇒ documented order: rewrites COMPOSE, last wins
 *   (f) mutated input that fails zod ⇒ normal validation error (NO bypass:
 *       the rewrite still flows through registry.run's safeParse)
 *   (g) ToolMatcher scoping ⇒ a handler only sees / rewrites matched tools
 *
 * Precedence: deny from ANY handler short-circuits before execute, even when
 * the same (or another) handler also rewrote — the rewrite is moot because the
 * call never runs. Mutation applies ONLY to pre_tool_use (never post).
 */

/** Echo tool: reflects the input it actually received into its output, so a
 *  test can assert WHICH input reached execute. Schema requires `path:string`
 *  so an out-of-shape rewrite is rejected by registry.run's safeParse. */
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

/** Second read-only tool so a matcher scoped to "echo" can be shown NOT to
 *  fire for "echo2" (and vice-versa) at the dispatch seam. */
const echo2Tool = (): Tool => ({
  name: "echo2",
  description: "second echo test tool",
  inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: (input: unknown, _ctx: ToolContext) =>
    (async function* () {
      yield {
        type: "result" as const,
        result: { ok: true, output: `echo2:${(input as { path: string }).path}` },
      }
    })(),
})

const baseConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([echoTool(), echo2Tool()]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

const callOf = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name,
  input,
})

const perm: PermissionContext = { mode: "acceptEdits" }

describe("pre_tool_use updated_input (Cursor absorption) — dispatch seam", () => {
  // (a) -----------------------------------------------------------------
  test("(a) no hook ⇒ byte-identical: original input executes", async () => {
    const res = await dispatchTool(callOf("echo", { path: "original" }), baseConfig(), perm)
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("executed:original")
  })

  test("(a') a hook that rewrites NOTHING ⇒ original input executes", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => undefined)
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    expect(res.preview).toBe("executed:original")
  })

  // (b) -----------------------------------------------------------------
  test("(b) {updatedInput} ⇒ execute sees the mutated input", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }))
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("executed:rewritten")
  })

  // (c) -----------------------------------------------------------------
  test("(c) {deny} ⇒ still denies (unchanged deny-only path)", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "blocked" }))
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("hook-denied")
    expect(res.block.content).toContain("Hook denied: blocked")
  })

  // (d) -----------------------------------------------------------------
  test("(d) deny + mutate from DIFFERENT handlers ⇒ deny wins (no execute)", async () => {
    const hooks = new HookBus()
    // registration order: a mutator first, then a denier. The deny must win
    // regardless — the call never reaches execute, so the rewrite is moot.
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }))
    hooks.on("pre_tool_use", () => ({ deny: "policy" }))
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("hook-denied")
    expect(res.block.content).toContain("Hook denied: policy")
    // critically NOT "executed:rewritten"
    expect(res.block.content).not.toContain("executed")
  })

  test("(d') single handler that BOTH denies AND rewrites ⇒ deny wins", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "blocked", updatedInput: { path: "rewritten" } }))
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("hook-denied")
  })

  // (e) -----------------------------------------------------------------
  test("(e) multiple mutators ⇒ rewrites COMPOSE in registration order, last wins", async () => {
    const hooks = new HookBus()
    const seen: unknown[] = []
    hooks.on("pre_tool_use", (e) => {
      seen.push(e.input)
      return { updatedInput: { path: "step1" } }
    })
    hooks.on("pre_tool_use", (e) => {
      seen.push(e.input)
      return { updatedInput: { path: "step2" } }
    })
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    // handler #1 saw the original; handler #2 saw handler #1's rewrite.
    expect(seen).toEqual([{ path: "original" }, { path: "step1" }])
    // last rewrite is what executes.
    expect(res.preview).toBe("executed:step2")
  })

  // (f) -----------------------------------------------------------------
  test("(f) mutated input that fails zod ⇒ normal validation error, NO bypass", async () => {
    const hooks = new HookBus()
    // rewrite to a shape the echo schema rejects (path must be string).
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: 123 } }))
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    // The rewrite flowed through registry.run's safeParse like any input would,
    // so the schema violation is a normal error tool_result — not a silent
    // bypass and not an unhandled throw.
    expect(res.ok).toBe(false)
    expect(res.preview).toContain("Invalid input for echo")
  })

  test("(f') rewrite to a VALID alternate shape still validates and executes", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "valid-rewrite" } }))
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("executed:valid-rewrite")
  })

  // (g) -----------------------------------------------------------------
  test("(g) ToolMatcher scoping ⇒ handler scoped to 'echo' does NOT rewrite 'echo2'", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }), { matcher: ["echo"] })
    // dispatch echo2 — the matcher rejects it, so the original input executes.
    const res = await dispatchTool(
      callOf("echo2", { path: "untouched" }),
      baseConfig({ hooks }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("echo2:untouched")
  })

  test("(g') ToolMatcher scoping ⇒ same handler DOES rewrite the matched 'echo'", async () => {
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }), { matcher: ["echo"] })
    const res = await dispatchTool(
      callOf("echo", { path: "original" }),
      baseConfig({ hooks }),
      perm,
    )
    expect(res.preview).toBe("executed:rewritten")
  })
})
