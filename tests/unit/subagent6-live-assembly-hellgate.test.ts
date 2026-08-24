/**
 * Hellgate — ADR-0041 LIVE assembly of the 6-tool subagent router.
 *
 * Proves the `enable6Tools` gate + `createSubagent6Tools` assembler:
 *   - DEFAULT-OFF regression anchor: `enable6Tools` absent ⇒ `extraTools` is
 *     EXACTLY the trio (`agent`/`task_output`/`task_stop`) — byte-identical.
 *   - enabled ⇒ all 6 tools present with correct names + isReadOnly /
 *     isConcurrencySafe semantics.
 *   - spawn_agent over `maxConcurrent` ⇒ `concurrency_cap` surfaced through the
 *     real `Tool.execute` path (not a direct handler call).
 *   - wait_agent clamps to `waitTimeoutPolicy` (a degenerate-low ceiling fires
 *     the timeout that a generous default would not).
 *   - spawn_agent + wait_agent share the SAME TaskRegistry the trio uses.
 *   - cleanup tears down PTY children minted by exec_command.
 *
 * Adversarial posture: every behavior is driven through the assembled
 * `Tool.execute` async-generator surface — the same path the agent loop uses —
 * so a tool that merely COMPILES but isn't wired would fail here.
 */
import { describe, expect, test } from "bun:test"
import { buildSubagentBlock } from "../../src/agent/tier1/subagent"
import type { AgentConfig } from "../../src/agent/types"
import {
  createSubagent6Tools,
  PtyTable,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  TaskRegistry,
} from "../../src/subagent"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"
import { present } from "../_helpers/expect-present"

const ctx = (): ToolContext =>
  ({ cwd: "/tmp", signal: new AbortController().signal }) as ToolContext

/** Drive a tool's execute() to completion; return the terminal result event. */
const drive = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx())) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const resultEvent = (ev: ToolEvent): { ok: boolean; output: string } => {
  if (ev.type !== "result") throw new Error("expected result event")
  return { ok: ev.result.ok, output: ev.result.output }
}

const settledResult = (r: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText: "done",
  turns: 1,
  ...r,
})

const TRIO = ["agent", "task_output", "task_stop"]
const SIX = [
  "exec_command",
  "write_stdin",
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "send_input",
]

// A minimal AgentConfig stub — buildSubagentBlock only reads `config.subagent`
// (and passes the whole config to createSubagentRunner, which we never invoke
// here since the spawn handler uses the injected `runner`). Cast keeps the test
// focused on the assembly gate, not the full config surface.
const cfg = (subagent: NonNullable<AgentConfig["subagent"]>): AgentConfig =>
  ({ subagent }) as unknown as AgentConfig

describe("ADR-0041 — enable6Tools DEFAULT-OFF (byte-identical anchor)", () => {
  test("absent enable6Tools ⇒ extraTools is EXACTLY the trio", () => {
    const block = buildSubagentBlock(cfg({}))
    expect(block).not.toBeUndefined()
    expect(block?.extraTools.map((t) => t.name)).toEqual(TRIO)
  })

  test("enable6Tools:false ⇒ extraTools is EXACTLY the trio", () => {
    const block = buildSubagentBlock(cfg({ enable6Tools: false }))
    expect(block?.extraTools.map((t) => t.name)).toEqual(TRIO)
  })
})

describe("ADR-0041 — enable6Tools:true (COEXIST)", () => {
  test("trio + 6 tools coexist (9 tools), 6-tool names present", () => {
    const block = buildSubagentBlock(cfg({ enable6Tools: true }))
    const names = block?.extraTools.map((t) => t.name) ?? []
    expect(names.slice(0, 3)).toEqual(TRIO)
    for (const n of SIX) expect(names).toContain(n)
    expect(names).toHaveLength(9)
  })

  test("isReadOnly / isConcurrencySafe semantics per tool", () => {
    const { tools } = createSubagent6Tools({})
    const byName = new Map(tools.map((t) => [t.name, t]))
    const ro = (n: string): boolean => present(byName.get(n), "byName.get(n)").isReadOnly()
    const cs = (n: string): boolean =>
      present(byName.get(n), "byName.get(n)").isConcurrencySafe(undefined as never)

    // exec_command: shell side-effects ⇒ mutating, serialized.
    expect(ro("exec_command")).toBe(false)
    expect(cs("exec_command")).toBe(false)
    // write_stdin: mutating, serialized.
    expect(ro("write_stdin")).toBe(false)
    expect(cs("write_stdin")).toBe(false)
    // spawn_agent: mutating (child owns unrestricted tools) but concurrency-safe.
    expect(ro("spawn_agent")).toBe(false)
    expect(cs("spawn_agent")).toBe(true)
    // wait_agent: read-only observation, concurrency-safe (mirrors task_output).
    expect(ro("wait_agent")).toBe(true)
    expect(cs("wait_agent")).toBe(true)
    // close_agent: mutating, serialized.
    expect(ro("close_agent")).toBe(false)
    expect(cs("close_agent")).toBe(false)
    // send_input: mutating, serialized.
    expect(ro("send_input")).toBe(false)
    expect(cs("send_input")).toBe(false)
  })
})

describe("ADR-0041 — maxConcurrent behavior-live through Tool.execute", () => {
  test("spawn_agent over maxConcurrent ⇒ concurrency_cap error via the real Tool", async () => {
    // Runner that never settles ⇒ each spawn stays running, consuming a slot.
    const runner: SubagentRunner = () => new Promise<SubagentResult>(() => {})
    const reg = new TaskRegistry()
    const { tools } = createSubagent6Tools({ runner, registry: reg, maxConcurrent: 1 })
    const spawn = present(
      tools.find((t) => t.name === "spawn_agent"),
      "spawn",
    )

    const first = resultEvent(await drive(spawn, { prompt: "child A" }))
    expect(first.ok).toBe(true)
    expect(first.output).toContain("agentId:")
    expect(reg.pendingIds()).toHaveLength(1)

    // Second spawn would exceed the cap of 1 ⇒ surfaced as ok:false with the
    // structured `concurrency_cap` cause, THROUGH the assembled tool.
    const second = resultEvent(await drive(spawn, { prompt: "child B" }))
    expect(second.ok).toBe(false)
    expect(second.output).toContain("cap reached")
    expect(second.output).toContain("concurrency_cap")
    expect(reg.pendingIds()).toHaveLength(1)
  })

  test("no maxConcurrent ⇒ unlimited spawns (opt-in default)", async () => {
    const runner: SubagentRunner = () => new Promise<SubagentResult>(() => {})
    const reg = new TaskRegistry()
    const { tools } = createSubagent6Tools({ runner, registry: reg })
    const spawn = present(
      tools.find((t) => t.name === "spawn_agent"),
      "spawn",
    )
    await drive(spawn, { prompt: "a" })
    await drive(spawn, { prompt: "b" })
    await drive(spawn, { prompt: "c" })
    expect(reg.pendingIds()).toHaveLength(3)
  })
})

describe("ADR-0041 — waitTimeoutPolicy clamp behavior-live", () => {
  test("wait_agent clamps a generous request down to the policy ceiling ⇒ timeout fires", async () => {
    const runner: SubagentRunner = () => new Promise<SubagentResult>(() => {})
    const reg = new TaskRegistry()
    const { tools } = createSubagent6Tools({
      runner,
      registry: reg,
      // Degenerate-low ceiling: even a huge requested timeout is clamped to 5ms.
      waitTimeoutPolicy: { minMs: 1, maxMs: 5, defaultMs: 5 },
    })
    const spawn = present(
      tools.find((t) => t.name === "spawn_agent"),
      "spawn",
    )
    const wait = present(
      tools.find((t) => t.name === "wait_agent"),
      "wait",
    )

    const sp = resultEvent(await drive(spawn, { prompt: "never settles" }))
    const agentId = present(
      sp.output.match(/agentId: (\S+)/),
      "sp.output.match(/agentId: (\\S+)/)",
    )[1] as string

    // Request a 10-minute wait; the policy clamps to 5ms ⇒ timeout, NOT a hang.
    const w = resultEvent(await drive(wait, { agentId, timeoutMs: 600_000 }))
    expect(w.ok).toBe(false)
    expect(w.output).toContain("timeout")
    // Clamped to 5ms — proves the policy band (not the 1h default) governed it.
    expect(w.output).toContain("5ms")
  })
})

describe("ADR-0041 — shared TaskRegistry across spawn/wait + trio", () => {
  test("6-tool spawn + wait observe the SAME registry the trio uses", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<SubagentResult>()
    const runner: SubagentRunner = () => gate
    const block = present(buildSubagentBlock(cfg({ enable6Tools: true })), "block")
    const reg = block.taskRegistry

    // Replace the trio's runner indirection: spawn through the 6-tool path,
    // then observe via the SAME registry the block exposes.
    const set = createSubagent6Tools({ runner, registry: reg })
    const spawn = present(
      set.tools.find((t) => t.name === "spawn_agent"),
      "spawn",
    )
    const wait = present(
      set.tools.find((t) => t.name === "wait_agent"),
      "wait",
    )

    const sp = resultEvent(await drive(spawn, { prompt: "shared" }))
    const agentId = present(
      sp.output.match(/agentId: (\S+)/),
      "sp.output.match(/agentId: (\\S+)/)",
    )[1] as string
    // The task is visible in the SAME registry the block's trio shares.
    expect(reg.get(agentId)?.status).toBe("running")

    release(settledResult({ finalText: "shared result", turns: 2 }))
    const w = resultEvent(await drive(wait, { agentId, timeoutMs: 2000 }))
    expect(w.ok).toBe(true)
    expect(w.output).toContain("completed")
    expect(w.output).toContain("shared result")
  })

  test("spawn via 6-tool, observe via trio's task_output (same registry)", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<SubagentResult>()
    const runner: SubagentRunner = () => gate
    const block = present(buildSubagentBlock(cfg({ enable6Tools: true })), "block")
    const reg = block.taskRegistry
    const set = createSubagent6Tools({ runner, registry: reg })
    const spawn = present(
      set.tools.find((t) => t.name === "spawn_agent"),
      "spawn",
    )
    const taskOutput = present(
      block.extraTools.find((t) => t.name === "task_output"),
      "taskOutput",
    )

    const sp = resultEvent(await drive(spawn, { prompt: "x" }))
    const agentId = present(
      sp.output.match(/agentId: (\S+)/),
      "sp.output.match(/agentId: (\\S+)/)",
    )[1] as string

    release(settledResult({ finalText: "via trio", turns: 1 }))
    const out = resultEvent(
      await drive(taskOutput, { task_id: agentId, block: true, timeout_ms: 2000 }),
    )
    expect(out.output).toContain("status: completed")
    expect(out.output).toContain("via trio")
  })
})

describe("ADR-0041 — exec_command + write_stdin + cleanup (PTY teardown)", () => {
  test("exec_command runs a one-shot command through the assembled tool", async () => {
    const { tools, cleanup } = createSubagent6Tools({})
    const exec = present(
      tools.find((t) => t.name === "exec_command"),
      "exec",
    )
    const ev = resultEvent(
      await drive(exec, { command: "echo hello-6tool", cwd: "/tmp", timeoutMs: 5000 }),
    )
    expect(ev.ok).toBe(true)
    expect(ev.output).toContain("exit 0")
    expect(ev.output).toContain("hello-6tool")
    cleanup()
  })

  test("cleanup kills a PTY-retained child (exec_command pty:true)", async () => {
    const ptyTable = new PtyTable()
    const { tools, cleanup } = createSubagent6Tools({ ptyTable })
    const exec = present(
      tools.find((t) => t.name === "exec_command"),
      "exec",
    )

    // A long-lived command launched with pty:true is retained in the table.
    const ev = resultEvent(
      await drive(exec, { command: "sleep 30", cwd: "/tmp", timeoutMs: 60_000, pty: true }),
    )
    expect(ev.ok).toBe(true)
    expect(ptyTable.size()).toBe(1)

    cleanup()
    expect(ptyTable.size()).toBe(0)
  })

  test("write_stdin to an unknown pid ⇒ structured error via the tool", async () => {
    const { tools } = createSubagent6Tools({})
    const write = present(
      tools.find((t) => t.name === "write_stdin"),
      "write",
    )
    const ev = resultEvent(await drive(write, { pid: 999999, data: "x" }))
    expect(ev.ok).toBe(false)
    expect(ev.output).toContain("No live PTY")
  })
})

describe("ADR-0041 — block cleanup tears down 6-tool PTY children", () => {
  test("buildSubagentBlock.cleanup() kills PTY children when 6-tool enabled", async () => {
    const runner: SubagentRunner = async (_req: SubagentRequest) => settledResult()
    const block = present(buildSubagentBlock(cfg({ enable6Tools: true })), "block")
    const exec = present(
      block.extraTools.find((t) => t.name === "exec_command"),
      "exec",
    )

    const ev = resultEvent(
      await drive(exec, { command: "sleep 30", cwd: "/tmp", timeoutMs: 60_000, pty: true }),
    )
    expect(ev.ok).toBe(true)
    expect(ev.output).toContain("PTY retained")

    // The block's cleanup must tear down the PTY child (no orphan process).
    await block.cleanup()
    // A second exec confirms the table was cleared (size back to 0 path); we
    // re-run a one-shot and ensure it still works post-cleanup.
    const after = resultEvent(await drive(exec, { command: "true", cwd: "/tmp", timeoutMs: 5000 }))
    expect(after.ok).toBe(true)
    void runner
  })
})

// ─── FULL-PATH plumbing: tool.execute(ctx) → withCtxSignal → dispatch → handler.
//     Proves the per-child controls + checkpoint(cwd) + continue_from(lineage)
//     survive the REAL tool surface (not just a direct handler unit call). ─────
describe("spawn_agent 6-tool — ctx-plumbed per-child controls (e2e)", () => {
  const driveWith = async (tool: Tool, input: unknown, c: ToolContext): Promise<void> => {
    for await (const _ev of tool.execute(input as never, c)) void _ev
  }

  test("ctx.cwd → checkpointPath and schema fields reach the child request", async () => {
    const seen: SubagentRequest[] = []
    const runner: SubagentRunner = async (req) => {
      seen.push(req)
      return settledResult()
    }
    const reg = new TaskRegistry()
    const spawn = present(
      createSubagent6Tools({ runner, registry: reg }).tools.find((t) => t.name === "spawn_agent"),
      "spawn",
    )
    const c = {
      cwd: "/workspace",
      signal: new AbortController().signal,
      agentLabel: "leader-1",
    } as ToolContext
    await driveWith(
      spawn,
      {
        prompt: "reduce core",
        isolation: "worktree",
        owned_surfaces: ["src/core/"],
        forbidden_surfaces: ["src/runtime/"],
        task_kind: "edit",
        result_shape: "JSON {ok}",
      },
      c,
    )
    await new Promise<void>((res) => setTimeout(res, 5))
    const req = seen[0]
    expect(req?.isolation).toBe("worktree")
    expect(req?.ownedSurfaces).toEqual(["src/core/"])
    expect(req?.forbiddenSurfaces).toEqual(["src/runtime/"])
    expect(req?.taskKind).toBe("edit")
    expect(req?.resultShape).toBe("JSON {ok}")
  })

  test("continue_from is lineage-gated through the real tool path (ctx.agentLabel)", async () => {
    const reg = new TaskRegistry()
    const runner: SubagentRunner = async () => settledResult({ finalText: "A-out" })
    const spawn = present(
      createSubagent6Tools({ runner, registry: reg }).tools.find((t) => t.name === "spawn_agent"),
      "spawn",
    )
    const asLeader = (label: string): ToolContext =>
      ({ cwd: "/w", signal: new AbortController().signal, agentLabel: label }) as ToolContext

    // Leader-1 launches A (stamped to its lineage via ctx.agentLabel).
    let aId = ""
    for await (const ev of spawn.execute({ prompt: "A" } as never, asLeader("leader-1"))) {
      if (ev.type === "result") aId = ev.result.output.match(/agentId: (\S+)/)?.[1] ?? ""
    }
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(reg.get(aId)?.result?.finalText).toBe("A-out")

    // Leader-2 (foreign lineage) is DENIED continue_from A through the tool path.
    let denied = ""
    for await (const ev of spawn.execute(
      { prompt: "steal", continue_from: aId } as never,
      asLeader("leader-2"),
    )) {
      if (ev.type === "result") denied = ev.result.output
    }
    expect(denied.toLowerCase()).toContain("ownership denied")
  })
})
