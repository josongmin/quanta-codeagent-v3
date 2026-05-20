import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig, AgentOutcome } from "@/agent"
import { createSubagentRunner } from "@/agent"
import { buildSessionFeatures } from "@/agent/features"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { SubagentRequest, TaskRegistry as TaskRegistryType } from "@/subagent"
import type { Tool, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"

/**
 * Integration tests for `buildSessionFeatures` subagent wiring. Closes the
 * MEDIUM gaps around:
 *   1. extraTools shape + same-TaskRegistry-instance identity.
 *   2. compaction propagation into the child (via `buildChildConfig`).
 *   3. toolFilter nuance: the child's `agent` tool registration is gated by
 *      the propagated `config.subagent`, NOT by toolFilter. `toolFilter`
 *      filters the INHERITED parent registry; then `buildSessionFeatures`
 *      ADDS `agent`/`task_output`/`task_stop` again if `config.subagent` is
 *      set on the child. So a child's ability to spawn grandchildren depends
 *      on whether `subagent` is in the child's config, NOT on whether `agent`
 *      survived the toolFilter step.
 */

/** Inert LLM stub — features never streams; it only stores the port. */
const inertLLM: LLMPort = {
  // biome-ignore lint/correctness/useYield: never invoked in this test
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream() call")
  },
}

const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: inertLLM,
    registry: new ToolRegistry(defaultTools),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const names = (tools: Tool[]): string[] => tools.map((t) => t.name).sort()

describe("buildSessionFeatures — subagent wiring (E2E)", () => {
  test("config.subagent set ⇒ exactly agent/task_output/task_stop + non-undefined taskRegistry", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: { maxDepth: 3 } }))
    expect(names(f.extraTools)).toEqual(["agent", "task_output", "task_stop"])
    expect(f.taskRegistry).toBeDefined()
  })

  test("all three tools share the SAME TaskRegistry instance as features.taskRegistry", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: {} }))
    const taskRegistry = f.taskRegistry
    if (!taskRegistry) throw new Error("expected taskRegistry")

    const agentTool = f.extraTools.find((t) => t.name === "agent") as Tool & {
      registry: TaskRegistryType
    }
    // The agent tool exposes its registry via the `.registry` field; identity
    // must match the one returned on features.
    expect(agentTool.registry).toBe(taskRegistry)

    // End-to-end probe: register a task DIRECTLY on the registry, then call
    // `task_output` and observe the record — proves the Task* tools see it.
    const id = taskRegistry.newId()
    taskRegistry.register({ id, description: "probe-from-wiring-test" })
    const out = f.extraTools.find((t) => t.name === "task_output")
    if (!out) throw new Error("missing task_output")
    let observed = ""
    for await (const ev of out.execute({ task_id: id } as Parameters<typeof out.execute>[0], {
      cwd: "/repo",
      signal: new AbortController().signal,
    })) {
      if (ev.type === "result") observed = ev.result.output
    }
    expect(observed).toContain(id)
    expect(observed).toContain("running")
  })

  test("config.subagent undefined ⇒ extraTools omits agent/task_output/task_stop; taskRegistry undefined", async () => {
    const f = await buildSessionFeatures(baseCfg())
    expect(f.extraTools.find((t) => t.name === "agent")).toBeUndefined()
    expect(f.extraTools.find((t) => t.name === "task_output")).toBeUndefined()
    expect(f.extraTools.find((t) => t.name === "task_stop")).toBeUndefined()
    expect(f.taskRegistry).toBeUndefined()
  })
})

/** Capture every child AgentConfig handed to the injected `run`. */
const capturingRun = (): {
  run: (c: AgentConfig) => Promise<AgentOutcome>
  seen: AgentConfig[]
} => {
  const seen: AgentConfig[] = []
  const run = async (c: AgentConfig): Promise<AgentOutcome> => {
    seen.push(c)
    return {
      reason: "completed",
      turns: 1,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    }
  }
  return { run, seen }
}

const req = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do the thing",
  depth: 1,
  ...over,
})

describe("buildChildConfig — compaction propagation", () => {
  test("parent.compaction is propagated byte-identical into the child", async () => {
    const compaction = {
      thresholdTokens: 12_000,
      keepRecentTurns: 3,
    }
    const parent = baseCfg({ compaction })
    const { run, seen } = capturingRun()
    const runner = createSubagentRunner(parent, { run: run as never })
    await runner(req())
    expect(seen.length).toBe(1)
    const child = seen[0]
    if (!child) throw new Error("expected child config")
    // Identity-equal: spread does not deep-clone, so it is the exact same
    // object reference the parent held.
    expect(child.compaction).toBe(parent.compaction)
    // Defensive: byte-identical structure.
    expect(child.compaction).toEqual(compaction)
  })

  test("parent.compaction absent ⇒ child.compaction key is OMITTED (not undefined)", async () => {
    const parent = baseCfg()
    expect(parent.compaction).toBeUndefined()
    const { run, seen } = capturingRun()
    const runner = createSubagentRunner(parent, { run: run as never })
    await runner(req())
    const child = seen[0]
    if (!child) throw new Error("expected child config")
    expect(child.compaction).toBeUndefined()
    // exactOptionalPropertyTypes contract: the key isn't even present.
    expect("compaction" in child).toBe(false)
  })
})

describe("buildChildConfig — toolFilter interaction with the agent tool", () => {
  // The audit's nuance: `toolFilter` filters the INHERITED parent registry
  // ONLY. The child's `agent`/`task_output`/`task_stop` tools come from the
  // child's OWN `buildSessionFeatures` invocation, gated purely on
  // `config.subagent` being present in the CHILD (which `buildChildConfig`
  // propagates from the parent unconditionally). So:
  //
  //   - toolFilter excluding "agent": the child's *inherited* registry has
  //     `agent` filtered out, but if `config.subagent` is still propagated,
  //     the child's `buildSessionFeatures` re-registers `agent` anyway.
  //   - toolFilter including "agent": same outcome — `agent` is registered
  //     via `buildSessionFeatures`, not preserved from the parent.
  //
  // What the subagent-runner does today: it ALWAYS propagates `subagent`. So
  // a child can spawn grandchildren irrespective of toolFilter (until
  // maxDepth bounds it). The tests below pin this behavior.

  test("child config carries the parent's subagent block regardless of toolFilter", async () => {
    const parent = baseCfg({
      subagent: { maxDepth: 3 },
      registry: new ToolRegistry([fakeTool("read"), fakeTool("agent"), fakeTool("write")]),
    })
    const { run, seen } = capturingRun()
    const runner = createSubagentRunner(parent, { run: run as never })

    // Branch A: child's inherited registry EXCLUDES "agent" via toolFilter.
    await runner(req({ toolFilter: ["read"] }))
    const childA = seen[0]
    if (!childA) throw new Error("expected childA")
    // Registry was filtered: agent is gone from the INHERITED set.
    expect(
      childA.registry
        .specs()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["read"])
    // But config.subagent is propagated ⇒ a buildSessionFeatures call on this
    // child would re-add `agent`. Pin that.
    expect(childA.subagent).toEqual({ maxDepth: 3 })
    const fA = await buildSessionFeatures(childA)
    expect(fA.extraTools.find((t) => t.name === "agent")).toBeDefined()

    // Branch B: child's inherited registry INCLUDES "agent" via toolFilter.
    await runner(req({ toolFilter: ["read", "agent"] }))
    const childB = seen[1]
    if (!childB) throw new Error("expected childB")
    expect(
      childB.registry
        .specs()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["agent", "read"])
    expect(childB.subagent).toEqual({ maxDepth: 3 })
    const fB = await buildSessionFeatures(childB)
    expect(fB.extraTools.find((t) => t.name === "agent")).toBeDefined()
  })

  test("toolFilter does NOT control the child's ability to spawn grandchildren — config.subagent does", async () => {
    // To DENY grandchildren you must strip `subagent` from the child config —
    // and the runner doesn't expose that knob (subagent always propagates).
    // So we directly construct a child without `subagent` to prove the gate:
    // a child without `subagent` ⇒ no `agent` tool ⇒ cannot spawn.
    const parent = baseCfg({
      subagent: { maxDepth: 2 },
      registry: new ToolRegistry([fakeTool("read"), fakeTool("agent")]),
    })
    const { run, seen } = capturingRun()
    const runner = createSubagentRunner(parent, { run: run as never })
    await runner(req({ toolFilter: ["read", "agent"] }))
    const child = seen[0]
    if (!child) throw new Error("expected child")
    // Forge a hypothetical child WITHOUT subagent propagation (this is NOT
    // what the runner does; it's a counterfactual to lock in the gate).
    const childWithoutSubagent: AgentConfig = (() => {
      const c = { ...child } as AgentConfig & { subagent?: AgentConfig["subagent"] }
      delete (c as { subagent?: AgentConfig["subagent"] }).subagent
      return c as AgentConfig
    })()
    const fNo = await buildSessionFeatures(childWithoutSubagent)
    expect(fNo.extraTools.find((t) => t.name === "agent")).toBeUndefined()
    expect(fNo.taskRegistry).toBeUndefined()

    // And the actual child (with subagent propagated) CAN spawn grandchildren:
    const fYes = await buildSessionFeatures(child)
    expect(fYes.extraTools.find((t) => t.name === "agent")).toBeDefined()
    expect(fYes.taskRegistry).toBeDefined()
  })
})
