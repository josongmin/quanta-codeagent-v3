/**
 * ★ HELLGATE — `node_repl` gated agent tool (ADR-0249 kernel → tool wiring).
 *
 * Proves the tool is a CORRECT, SECURE, DEFAULT-OFF front door to the persistent
 * Node REPL kernel, and that it is DISTINCT from `code_cell` (code-mode):
 *
 *   OFF byte-identical:
 *     - `runtimeConfig().nodeRepl === false` when QUANTA_NODE_REPL unset;
 *     - `node_repl` NOT in the default tool menu (no port ⇒ not registered);
 *     - the full default menu is byte-identical (the ONE new registration is the
 *       ONLY delta — proven by set-difference).
 *   ON:
 *     - wiring `DefaultToolPorts.nodeRepl` registers exactly `node_repl`;
 *     - it is NOT read-only and its HITL tier is `always-confirm` (arbitrary
 *       Node code exec — full host access, like bash/debug_inspect).
 *   Behavior (over the deterministic headlessStub — no real subprocess):
 *     - a REPL cell round-trips PERSISTENT state: `let x = 42` then a LATER
 *       `x` exec returns "42" (the code_cell one-shot sandbox CANNOT do this);
 *     - red-on-injection: a SECOND fresh kernel does NOT see the first's `x`
 *       (proves the persistence assertion is not vacuous — it is bound to the
 *       session's own live kernel, not a global);
 *     - hadError evals (`throw`) surface as ok:false, never a host throw;
 *     - list / kill ops work; killing the session kernel re-spawns on next exec.
 *   Fence / distinctness:
 *     - `node_repl` and `code_cell` are BOTH-distinct names in the menu when both
 *       are wired (neither subsumes the other).
 */

import { describe, expect, test } from "bun:test"
import { createDefaultNodeReplKernel, headlessStub, type NodeReplKernel } from "@/runtime/node-repl"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { buildDefaultTools } from "@/tool"
import { withTempDir } from "../../_helpers/temp-dir"

const withEnv = <T>(key: string, value: string | undefined, fn: () => T): T => {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  __resetRuntimeConfig()
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
    __resetRuntimeConfig()
  }
}

const ctx = (): ToolContext =>
  ({ cwd: "/tmp", signal: new AbortController().signal, turnId: "t1" }) as ToolContext

/** Drive a tool's async-iterable execute to its terminal `result` event. */
const run = async (
  tool: Tool,
  input: unknown,
): Promise<{ ok: boolean; output: string; sourceClass?: string }> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input, ctx())) last = ev
  if (last === undefined || last.type !== "result") throw new Error("no result event")
  return {
    ok: last.result.ok,
    output: last.result.output,
    ...(last.result.source !== undefined ? { sourceClass: last.result.source.class } : {}),
  }
}

const nodeReplTool = (kernel: NodeReplKernel): Tool => {
  const tool = buildDefaultTools({ nodeRepl: kernel }).find((t) => t.name === "node_repl")
  if (tool === undefined) throw new Error("node_repl not registered")
  return tool
}

describe("node_repl — default-OFF byte-identity", () => {
  test("runtimeConfig().nodeRepl is false when QUANTA_NODE_REPL unset", () => {
    withEnv("QUANTA_NODE_REPL", undefined, () => {
      expect(runtimeConfig().nodeRepl).toBe(false)
    })
  })

  test("knob parse — strict gateOn vocab ('1' on, '0' off)", () => {
    withEnv("QUANTA_NODE_REPL", "1", () => expect(runtimeConfig().nodeRepl).toBe(true))
    withEnv("QUANTA_NODE_REPL", "0", () => expect(runtimeConfig().nodeRepl).toBe(false))
  })

  test("node_repl is NOT in the default tool menu (no port ⇒ not registered)", () => {
    expect(buildDefaultTools().map((t) => t.name)).not.toContain("node_repl")
  })

  test("wiring nodeRepl adds EXACTLY node_repl — the rest of the menu is byte-identical", () => {
    const off = new Set(buildDefaultTools().map((t) => t.name))
    const on = buildDefaultTools({ nodeRepl: headlessStub() }).map((t) => t.name)
    const added = on.filter((n) => !off.has(n))
    expect(added).toEqual(["node_repl"])
    // No name is REMOVED either (pure superset by exactly one).
    for (const n of off) expect(on).toContain(n)
  })
})

describe("node_repl — security posture", () => {
  test("registered tool is NOT read-only and is always-confirm (arbitrary code exec)", () => {
    const tool = nodeReplTool(headlessStub())
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe({} as never)).toBe(false)
    expect(tool.hitlTier?.({} as never)).toBe("always-confirm")
  })

  test("exec source classification covers env and secret-file reads", () => {
    const tool = nodeReplTool(headlessStub())
    expect(tool.classifySource?.({ op: "exec", code: "process.env.API_KEY" })).toBe("secret")
    expect(tool.classifySource?.({ op: "exec", code: `require("fs").readFileSync(".env")` })).toBe(
      "secret",
    )
    const benign = nodeReplTool(headlessStub())
    expect(benign.classifySource?.({ op: "exec", code: "1 + 1" })).toBe("public")
    expect(tool.classifySource?.({ op: "status", id: "node:1" })).toBeNull()
  })

  test("persistent session sensitivity is sticky across later variable reads", () => {
    const tool = nodeReplTool(headlessStub())
    expect(
      tool.classifySource?.({
        op: "exec",
        code: `globalThis.cachedSecret = require("fs").readFileSync(".env")`,
      }),
    ).toBe("secret")
    expect(tool.classifySource?.({ op: "exec", code: "cachedSecret" })).toBe("secret")

    const fresh = nodeReplTool(headlessStub())
    expect(fresh.classifySource?.({ op: "exec", code: "cachedSecret" })).toBe("public")
  })

  test("exec result carries producer-owned source even without dispatch classification", async () => {
    const result = await run(nodeReplTool(headlessStub()), {
      op: "exec",
      code: "process.env.API_KEY",
    })
    expect(result.ok).toBe(true)
    expect(result.sourceClass).toBe("secret")
  })
})

describe("node_repl — persistent-state round-trip (the code_cell distinction)", () => {
  test("variables PERSIST across exec calls in the session kernel", async () => {
    const tool = nodeReplTool(headlessStub())
    const assign = await run(tool, { op: "exec", code: "let x = 42" })
    expect(assign.ok).toBe(true)
    // A LATER exec on the SAME session kernel sees the binding — the persistence
    // a one-shot QuickJS code_cell can NOT provide.
    const read = await run(tool, { op: "exec", code: "x" })
    expect(read.ok).toBe(true)
    expect(read.output).toContain("42")
  })

  test("RED-ON-INJECTION: a SEPARATE kernel/tool does NOT see the first's binding", async () => {
    // Two independent tool instances = two independent live kernels. If the tool
    // leaked state through a global (a vacuous persistence proof), the second
    // would see `x`. It must not.
    const first = nodeReplTool(headlessStub())
    await run(first, { op: "exec", code: "let x = 42" })
    const second = nodeReplTool(headlessStub())
    const read = await run(second, { op: "exec", code: "x" })
    // The stub returns the unsupported marker for an unbound identifier lookup;
    // the load-bearing assertion is that it is NOT the first kernel's "42".
    expect(read.output).not.toContain("42")
  })
})

describe("node_repl — no-throw failure modes", () => {
  test("a throwing eval surfaces ok:false, never a host throw", async () => {
    const tool = nodeReplTool(headlessStub())
    const res = await run(tool, { op: "exec", code: 'throw new Error("boom")' })
    expect(res.ok).toBe(false)
  })

  test("op:'exec' with empty code fails with a typed message (never a crash)", async () => {
    const tool = nodeReplTool(headlessStub())
    const res = await run(tool, { op: "exec", code: "" })
    expect(res.ok).toBe(false)
    expect(res.output).toContain("requires non-empty")
  })

  test("op:'kill' without id fails cleanly", async () => {
    const tool = nodeReplTool(headlessStub())
    const res = await run(tool, { op: "kill" })
    expect(res.ok).toBe(false)
    expect(res.output).toContain("requires `id`")
  })

  test("aborted-before-start returns ok:false", async () => {
    const tool = nodeReplTool(headlessStub())
    const ac = new AbortController()
    ac.abort()
    let last: ToolEvent | undefined
    for await (const ev of tool.execute({ op: "exec", code: "1+1" }, {
      cwd: "/tmp",
      signal: ac.signal,
    } as ToolContext))
      last = ev
    expect(last?.type === "result" && last.result.ok).toBe(false)
  })
})

describe("node_repl — list / kill lifecycle", () => {
  test("list shows the session kernel after an exec spawns it; kill removes it", async () => {
    const kernel = headlessStub()
    const tool = nodeReplTool(kernel)
    await run(tool, { op: "exec", code: "let x = 1" })
    const listed = await run(tool, { op: "list" })
    expect(listed.ok).toBe(true)
    // Exactly one live kernel spawned by the session.
    expect(kernel.list().length).toBe(1)
    const id = kernel.list()[0]?.spec.id as string
    const killed = await run(tool, { op: "kill", id })
    expect(killed.ok).toBe(true)
    expect(kernel.status(id as never)).toBe("dead")
  })

  test("killing the SESSION kernel re-spawns a fresh one on the next exec", async () => {
    const kernel = headlessStub()
    const tool = nodeReplTool(kernel)
    await run(tool, { op: "exec", code: "let x = 7" })
    const firstId = kernel.list()[0]?.spec.id as string
    await run(tool, { op: "kill", id: firstId })
    // Next exec must spawn a NEW kernel (the session forgot the dead one).
    await run(tool, { op: "exec", code: "1+1" })
    const live = kernel.list().filter((k) => k.state !== "dead")
    expect(live.length).toBe(1)
    expect(live[0]?.spec.id).not.toBe(firstId)
  })
})

describe("node_repl — every exec is bounded", () => {
  // 6d976eedc made the tool always pass a deadline; reverting to "no timeout unless given"
  // kept three node-repl suites green (round-10 audit, 42/0). The kernel sees 120 s when the
  // call names none, and the caller's value when it does.
  test("an exec with no timeoutMs reaches the kernel with the 120 s default", async () => {
    const stub = headlessStub()
    const seen: (number | undefined)[] = []
    const recording: NodeReplKernel = {
      ...stub,
      spawn: (o) => stub.spawn(o),
      status: (id) => stub.status(id),
      kill: (id) => stub.kill(id),
      list: () => stub.list(),
      exec: (id, code, opts) => {
        seen.push(opts?.timeoutMs)
        return stub.exec(id, code, opts)
      },
    }
    const tool = nodeReplTool(recording)
    await run(tool, { op: "exec", code: "1+1" })
    await run(tool, { op: "exec", code: "2+2", timeoutMs: 700 })
    expect(seen).toEqual([120_000, 700])
  })
})

describe("node_repl — a dead session kernel is replaced, on the REAL kernel", () => {
  // The session slot kept a dead kernel's id: after one timeout every later call answered
  // "is dead (process exited). Re-run to spawn a fresh one." and re-running changed nothing
  // (round-10 audit, reproduced). The stub arm above covers only an explicit kill.
  test("after an exec times out, it says so, and the next exec runs on a fresh kernel", async () => {
    await withTempDir("qnr-tool-timeout-", async (home) => {
      const kernel = createDefaultNodeReplKernel({ home })
      const tool = nodeReplTool(kernel)
      try {
        expect((await run(tool, { op: "exec", code: "let kept = 1" })).ok).toBe(true)
        const timedOut = await run(tool, { op: "exec", code: "while (true) {}", timeoutMs: 500 })
        expect(timedOut.ok).toBe(false)
        expect(timedOut.output).toContain("timed out after 500ms")
        const next = await run(tool, { op: "exec", code: "typeof kept + ' ' + (1 + 1)" })
        expect(next).toMatchObject({ ok: true, output: "'undefined 2'" })
      } finally {
        for (const row of kernel.list()) await kernel.kill(row.spec.id)
      }
    })
  }, 60_000)
})

describe("node_repl — distinct from code_cell (neither subsumes the other)", () => {
  test("both names present when both are wired", () => {
    const names = buildDefaultTools({ nodeRepl: headlessStub(), codeMode: true }).map((t) => t.name)
    expect(names).toContain("node_repl")
    expect(names).toContain("code_cell")
  })
})
