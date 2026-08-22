/**
 * P1 cleanup #2 — Permission stack × Hook RPC ordering lock.
 *
 * Documents and ENFORCES the dispatch ordering described in `dispatch.ts`
 * `dispatchTool` header comment (see also `runAdmissibilityGate` in
 * `admissibility-gate.ts`). These tests do NOT introduce new behavior — they
 * pin EXISTING behavior so a future refactor that reorders the pipeline
 * trips a red light.
 *
 * Coverage (ordering invariants — see dispatch.ts header):
 *
 *  1. Plan-mode mutating tool → mode-blocked BEFORE permission AND hook
 *  2. HARD_DENY → permission AND hook both skipped
 *  3. Permission deny (declined) → `pre_tool_use` hook NEVER fires
 *  4. Permission allow + hook updatedInput → execute runs MUTATED input
 *     (no re-permission on the rewrite — intentional ADR-0133 trust model)
 *  5. Hook deny (last gate) → execute() not called, post-hooks skipped
 *  6. Successful tool → post_tool_use fires; post_tool_use_failure does NOT
 *  7. Failing tool → post_tool_use FIRST, post_tool_use_failure SECOND
 *  8. Tool that throws → post_tool_use AND post_tool_use_failure both fire
 *     (dispatch normalizes the throw to ok:false)
 *  9. Hook updatedInput value VISIBLE to post_tool_use (pre/post symmetry)
 * 10. Concurrent dispatches preserve per-call ordering (no cross-talk)
 * 11. A throwing pre_tool_use handler does NOT corrupt dispatch (no-throw)
 * 12. Permission allow + 2 chained hooks: 2nd sees 1st's rewrite (compose)
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

// ---------------------------------------------------------------------------
// Tiny scripted-tool harness (mirrors dispatch.test.ts shape so the tests
// here read identically to the rest of the dispatch suite).
// ---------------------------------------------------------------------------

const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    run: () => AsyncIterable<ToolEvent>
    extractShellCommand?: (input: unknown) => string | null
  },
): Tool => {
  const tool: Tool = {
    name,
    description: `${name} test tool`,
    inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: () => opts.run(),
  }
  if (opts.extractShellCommand !== undefined) {
    tool.extractShellCommand = opts.extractShellCommand
  }
  return tool
}

const okTool = makeTool("ok", {
  readOnly: true,
  schema: z.object({ value: z.string() }),
  run: async function* () {
    yield { type: "result", result: { ok: true, output: "ok-ran" } }
  },
})

const config = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([okTool]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

const call = (name: string, input: unknown, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const perm: PermissionContext = { mode: "acceptEdits" }
const perm_default: PermissionContext = { mode: "default" }

// ---------------------------------------------------------------------------
// 1. Plan-mode mutating tool → mode-blocked BEFORE permission AND hook
// ---------------------------------------------------------------------------

describe("ORDERING #1 — plan mode blocks before permission AND hook", () => {
  test("plan-mode mutating tool → mode-blocked, hook NEVER fires, tool NEVER runs", async () => {
    let executed = false
    let hookFired = false
    const mutating = makeTool("write", {
      readOnly: false,
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "should-not-run" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => {
      hookFired = true
    })
    const res = await dispatchTool(
      call("write", {}),
      config({ registry: new ToolRegistry([mutating]), hooks, planMode: true }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    expect(executed).toBe(false)
    expect(hookFired).toBe(false)
  })

  test("plan-mode READ-ONLY tool → admitted normally (mode block does not apply)", async () => {
    const hookFired: string[] = []
    const hooks = new HookBus()
    hooks.on("pre_tool_use", (e) => {
      hookFired.push(e.name)
    })
    const res = await dispatchTool(
      call("ok", { value: "x" }),
      config({ hooks, planMode: true }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(hookFired).toEqual(["ok"]) // pre-hook fires for admitted call
  })
})

// ---------------------------------------------------------------------------
// 2. HARD_DENY → permission AND hook both skipped
// ---------------------------------------------------------------------------

describe("ORDERING #2 — HARD_DENY skips permission AND hook", () => {
  test("HARD_DENY bash command → deny, hook NEVER fires, tool NEVER runs", async () => {
    let executed = false
    let hookFired = false
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "x" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => {
      hookFired = true
    })
    const res = await dispatchTool(
      call("bash", { command: "rm -rf /" }),
      config({ registry: new ToolRegistry([bash]), hooks }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("denied")
    expect(res.block.content).toContain("Permission denied")
    expect(executed).toBe(false)
    expect(hookFired).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Permission deny → pre_tool_use hook NEVER fires
// ---------------------------------------------------------------------------

describe("ORDERING #3 — permission denial precludes pre_tool_use hook", () => {
  test("mode='default' + no onConfirm + mutating tool → declined, hook NEVER fires", async () => {
    let executed = false
    let hookFired = false
    const mutate = makeTool("mutate", {
      readOnly: false,
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "x" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => {
      hookFired = true
    })
    const res = await dispatchTool(
      call("mutate", {}),
      config({ registry: new ToolRegistry([mutate]), hooks, permission: perm_default }),
      perm_default,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("declined")
    expect(hookFired).toBe(false)
    expect(executed).toBe(false)
  })

  test("mode='default' + onConfirm returning false → declined, hook NEVER fires", async () => {
    let hookFired = false
    const mutate = makeTool("mutate", {
      readOnly: false,
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "x" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => {
      hookFired = true
    })
    const res = await dispatchTool(
      call("mutate", {}),
      config({
        registry: new ToolRegistry([mutate]),
        hooks,
        permission: perm_default,
        onConfirm: async () => false,
      }),
      perm_default,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("declined")
    expect(hookFired).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Permission allow + hook updatedInput → execute runs MUTATED input
// ---------------------------------------------------------------------------

describe("ORDERING #4 — hook updatedInput is applied POST-permission", () => {
  test("permission allows + hook rewrites input → tool sees MUTATED input (no re-permission)", async () => {
    let seenInput: unknown
    const probe = makeTool("ok", {
      readOnly: true,
      schema: z.object({ value: z.string() }),
      run: async function* () {
        // not used — we capture via execute
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    // Replace probe.execute to capture input (the harness scripts a fixed
    // result via `run`, but we need the actual input the registry passed).
    probe.execute = (input) => {
      seenInput = input
      return (async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      })()
    }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { value: "REWRITTEN" } }))
    const res = await dispatchTool(
      call("ok", { value: "original" }),
      config({ registry: new ToolRegistry([probe]), hooks }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(seenInput).toEqual({ value: "REWRITTEN" })
  })
})

// ---------------------------------------------------------------------------
// 5. Hook deny (last gate) → execute() not called, post-hooks skipped
// ---------------------------------------------------------------------------

describe("ORDERING #5 — hook deny skips execute AND post-hooks", () => {
  test("pre_tool_use deny → execute NEVER runs; post_tool_use{,_failure} NEVER fire", async () => {
    let executed = false
    let postFired = false
    let postFailureFired = false
    const probe = makeTool("ok", {
      readOnly: true,
      schema: z.object({ value: z.string() }),
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "x" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "nope" }))
    hooks.on("post_tool_use", () => {
      postFired = true
    })
    hooks.on("post_tool_use_failure", () => {
      postFailureFired = true
    })
    const res = await dispatchTool(
      call("ok", { value: "x" }),
      config({ registry: new ToolRegistry([probe]), hooks }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("hook-denied")
    expect(executed).toBe(false)
    expect(postFired).toBe(false)
    expect(postFailureFired).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6/7/8. post_tool_use vs post_tool_use_failure fire by outcome
// ---------------------------------------------------------------------------

describe("ORDERING #6-8 — post-hook fanout matches tool outcome", () => {
  test("#6: ok=true → post_tool_use fires; post_tool_use_failure does NOT", async () => {
    const fired: string[] = []
    const hooks = new HookBus()
    hooks.on("post_tool_use", () => {
      fired.push("post")
    })
    hooks.on("post_tool_use_failure", () => {
      fired.push("post_failure")
    })
    const res = await dispatchTool(call("ok", { value: "x" }), config({ hooks }), perm)
    expect(res.ok).toBe(true)
    expect(fired).toEqual(["post"])
  })

  test("#7: ok=false → post_tool_use FIRST, post_tool_use_failure SECOND (ordered)", async () => {
    const fired: string[] = []
    const failing = makeTool("ng", {
      readOnly: false,
      run: async function* () {
        yield { type: "result", result: { ok: false, output: "boom" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("post_tool_use", (e) => {
      fired.push(`post:${e.ok}`)
    })
    hooks.on("post_tool_use_failure", (e) => {
      fired.push(`post_failure:${e.error}`)
    })
    const res = await dispatchTool(
      call("ng", {}),
      config({ registry: new ToolRegistry([failing]), hooks, permission: { mode: "bypass" } }),
      { mode: "bypass" },
    )
    expect(res.ok).toBe(false)
    // Order is: post (with ok:false), THEN post_failure (with error text).
    expect(fired).toEqual(["post:false", "post_failure:boom"])
  })

  test("#8: tool THROWS → dispatch normalizes to ok:false; BOTH post-hooks fire", async () => {
    const fired: string[] = []
    const exploding = makeTool("boom", {
      readOnly: false,
      run: async function* () {
        // Generator must syntactically contain a `yield` (biome useYield) —
        // we yield a progress event THEN throw so the test exercises the
        // throw-mid-execution path the harness is here to cover.
        yield { type: "progress", message: "before-throw" }
        throw new Error("kaboom")
      },
    })
    const hooks = new HookBus()
    hooks.on("post_tool_use", (e) => {
      fired.push(`post:${e.ok}`)
    })
    hooks.on("post_tool_use_failure", () => {
      fired.push("post_failure")
    })
    const res = await dispatchTool(
      call("boom", {}),
      config({ registry: new ToolRegistry([exploding]), hooks, permission: { mode: "bypass" } }),
      { mode: "bypass" },
    )
    expect(res.ok).toBe(false)
    expect(fired).toEqual(["post:false", "post_failure"])
  })
})

// ---------------------------------------------------------------------------
// 9. Hook updatedInput is visible to post_tool_use (pre/post symmetry)
// ---------------------------------------------------------------------------

describe("ORDERING #9 — post_tool_use sees the EXECUTED (rewritten) input", () => {
  test("pre hook rewrites input → post hook input field equals the rewrite", async () => {
    let postInput: unknown
    const probe = makeTool("ok", {
      readOnly: true,
      schema: z.object({ value: z.string() }),
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { value: "REWRITTEN" } }))
    hooks.on("post_tool_use", (e) => {
      postInput = e.input
    })
    await dispatchTool(
      call("ok", { value: "original" }),
      config({ registry: new ToolRegistry([probe]), hooks }),
      perm,
    )
    expect(postInput).toEqual({ value: "REWRITTEN" })
  })
})

// ---------------------------------------------------------------------------
// 10. Concurrent dispatches preserve per-call ordering
// ---------------------------------------------------------------------------

describe("ORDERING #10 — concurrent dispatches preserve per-call ordering", () => {
  test("3 parallel dispatches each see pre→exec→post in order; no cross-talk", async () => {
    // Each call records into a per-call log keyed by call.id. We assert each
    // call's log is in canonical order, independently.
    const logs = new Map<string, string[]>()
    const tagged = makeTool("ok", {
      readOnly: true,
      schema: z.object({ value: z.string() }),
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    tagged.execute = (input) => {
      const id = (input as { value: string }).value
      logs.get(id)?.push("exec")
      return (async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      })()
    }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", (e) => {
      const id = (e.input as { value: string }).value
      logs.get(id)?.push("pre")
    })
    hooks.on("post_tool_use", (e) => {
      const id = (e.input as { value: string }).value
      logs.get(id)?.push("post")
    })
    const cfg = config({ registry: new ToolRegistry([tagged]), hooks })
    const ids = ["a", "b", "c"] as const
    for (const id of ids) logs.set(id, [])
    await Promise.all(
      ids.map((id) => dispatchTool(call("ok", { value: id }, `id-${id}`), cfg, perm)),
    )
    for (const id of ids) {
      expect(logs.get(id)).toEqual(["pre", "exec", "post"])
    }
  })
})

// ---------------------------------------------------------------------------
// 11. Throwing pre_tool_use handler does NOT corrupt dispatch
// ---------------------------------------------------------------------------

describe("ORDERING #11 — throwing pre_tool_use handler is isolated", () => {
  test("a throwing pre hook does NOT throw out of dispatchTool; tool still runs", async () => {
    // HookBus isolates per-handler throws (caught + logged). The dispatch's
    // no-throw contract is independent of the hook's correctness.
    let executed = false
    const probe = makeTool("ok", {
      readOnly: true,
      schema: z.object({ value: z.string() }),
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => {
      throw new Error("handler-boom")
    })
    const res = await dispatchTool(
      call("ok", { value: "x" }),
      config({ registry: new ToolRegistry([probe]), hooks }),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(executed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 12. Multi-handler pre_tool_use: composed rewrites are visible downstream
// ---------------------------------------------------------------------------

describe("ORDERING #12 — pre_tool_use rewrites COMPOSE in registration order", () => {
  test("2 chained pre hooks: 2nd sees 1st's rewrite; tool sees 2nd's rewrite", async () => {
    let seenByH2: unknown
    let seenByTool: unknown
    const probe = makeTool("ok", {
      readOnly: true,
      schema: z.object({ value: z.string() }),
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    probe.execute = (input) => {
      seenByTool = input
      return (async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      })()
    }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { value: "step1" } }))
    hooks.on("pre_tool_use", (e) => {
      seenByH2 = e.input
      return { updatedInput: { value: "step2" } }
    })
    await dispatchTool(
      call("ok", { value: "original" }),
      config({ registry: new ToolRegistry([probe]), hooks }),
      perm,
    )
    expect(seenByH2).toEqual({ value: "step1" }) // 2nd handler saw the 1st rewrite
    expect(seenByTool).toEqual({ value: "step2" }) // tool sees the final rewrite
  })
})
