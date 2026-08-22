/**
 * RFC-01 A3 — attention PRODUCER hellgate RED rail.
 *
 * The producer is the `request_user_input` path adapted THROUGH the
 * `UserQuestionBroker` (`@/session/user-question`): when the attention gate is
 * ON, the dispatch seam (`@/agent/dispatch/tool-context`) builds
 * `ctx.requestUserInput` from `AgentConfig.questionBroker`, binding the owner
 * from the EXPLICIT `AgentConfig.spawnedAsTaskId` (never inferred). The broker's
 * published pending is what A2's `AttentionReader`
 * (`@/runner/assemble/session-authorities`) joins into a fleet row.
 *
 * This drives the REAL producer seam (`buildToolContext` + the real
 * `request_user_input` tool) + the REAL A2 reader — not a stub. It proves:
 *
 *   1. a questioning child publishes a TASK-owned pending bound to its EXACT
 *      `spawnedAsTaskId`, and A2's reader surfaces exactly that row;
 *   2. a clean (parked) child that never asks produces NO row;
 *   3. a ROOT question (no `spawnedAsTaskId`) is NEVER a fleet row;
 *   4. the answer resolves the original tool call and clears the pending;
 *   5. abort cancels the pending in `finally` (no leak);
 *   6. RED-on-injection — the exact-taskId correlation is load-bearing: a
 *      root-bound owner makes the child row disappear (never reassigned to the
 *      newest task);
 *   7. cross-case byte-identity — attention OFF (no broker) even with the
 *      subagent panel wired (`onSubagentEvent` + `spawnedAsTaskId` present)
 *      publishes NO pending and routes through the legacy `userInputPort`.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildToolContext } from "@/agent/dispatch/tool-context"
import {
  type AttentionReader,
  buildSessionAuthorities,
} from "@/runner/assemble/session-authorities"
import { createUserQuestionBroker, type UserQuestionBroker } from "@/session/user-question"
import { TaskRegistry } from "@/subagent"
import {
  requestUserInputTool,
  type Tool,
  type ToolContext,
  type ToolEvent,
  ToolRegistry,
  type UserInputOutcome,
  type UserInputRequester,
} from "@/tool"

const baseCfg = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    registry: new ToolRegistry([]),
    stream: {} as AgentConfig["stream"],
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "t",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    llm: {} as AgentConfig["llm"],
    ...over,
  }) as AgentConfig

/** Build the REAL dispatch-seam ToolContext for a given config. */
const ctxFor = (config: AgentConfig): ToolContext =>
  buildToolContext({ config, workingState: undefined, collabMode: "default", toolCallId: "call-1" })

/** Register a lineage child TaskRecord and return its id. */
const registerChild = (tasks: TaskRegistry, description: string, parentTaskId?: string): string => {
  const id = tasks.newId()
  tasks.register({
    id,
    description,
    depth: 1,
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
  })
  return id
}

/** Pump microtasks until the broker holds at least `n` pending records (the
 *  tool reaches the synchronous publish across a few async-generator ticks). */
const waitPending = async (broker: UserQuestionBroker, n: number): Promise<void> => {
  for (let i = 0; i < 100 && broker.listPending().length < n; i++) await Promise.resolve()
}

/** Drive the real request_user_input tool with a ctx; return the in-flight
 *  result promise (the tool publishes to the broker synchronously first). */
const askViaTool = (ctx: ToolContext, prompt: string): Promise<ToolEvent> => {
  const tool: Tool = requestUserInputTool() as Tool
  const gen = tool.execute({ prompt }, ctx)
  // Drain progress + result. The tool yields a "progress" event, then awaits
  // the requester (which publishes to the broker synchronously), then yields the
  // final "result" once the broker settles.
  return (async () => {
    let last: ToolEvent | undefined
    for await (const e of gen) last = e
    if (last === undefined) throw new Error("tool yielded nothing")
    return last
  })()
}

describe("RFC-01 A3 — child question → attention projection (producer)", () => {
  test("questioning child publishes a task-owned pending A2's reader surfaces by exact id", async () => {
    const tasks = new TaskRegistry()
    const broker = createUserQuestionBroker()
    const root: AttentionReader | undefined = buildSessionAuthorities({
      tasks,
      env: { QUANTA_ATTENTION_NAV: "1" },
      questions: broker,
    }).attention
    expect(root).toBeDefined()
    if (root === undefined) return
    const reader = root

    const childA = registerChild(tasks, "questioning child")
    registerChild(tasks, "clean parked child") // B — never asks

    // Drive the producer through the REAL dispatch seam (broker present + this
    // child's own spawnedAsTaskId).
    const ctx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: childA }))
    const resultP = askViaTool(ctx, "Which framework?")

    // The broker publishes synchronously inside the requester call, but the tool
    // reaches that call across a few async-generator microtasks; pump until the
    // pending record appears.
    await waitPending(broker, 1)
    const pending = broker.listPending()
    expect(pending).toHaveLength(1)
    const p0 = pending[0]
    expect(p0).toBeDefined()
    if (!p0) return
    expect(p0.owner).toEqual({ kind: "task", taskId: childA })

    // A2 reader join surfaces EXACTLY the questioning child, by exact id.
    const snap = reader.snapshot()
    expect(snap.map((a) => a.id)).toEqual([childA])
    expect(snap[0]?.pendingQuestion?.requestId).toBe(p0.requestId)
    // The clean parked child (B) does NOT appear.
    expect(snap).toHaveLength(1)

    // next(ownRootId) picks it (a direct child's rootId is its own id).
    expect(reader.next(childA)?.id).toBe(childA)

    // Answer via the broker (A4's future front door) → tool resolves + clears.
    const res = broker.answer(p0.requestId, { text: "Remix" }, broker.revision())
    expect(res.ok).toBe(true)
    const ev = await resultP
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toBe("Remix")
    }
    expect(broker.listPending()).toHaveLength(0)
    expect(reader.snapshot()).toHaveLength(0)
  })

  test("ROOT question (no spawnedAsTaskId) is never a fleet row", async () => {
    const tasks = new TaskRegistry()
    const broker = createUserQuestionBroker()
    const reader = buildSessionAuthorities({
      tasks,
      env: { QUANTA_ATTENTION_NAV: "1" },
      questions: broker,
    }).attention
    expect(reader).toBeDefined()
    if (reader === undefined) return

    const ctx = ctxFor(baseCfg({ questionBroker: broker /* no spawnedAsTaskId */ }))
    const resultP = askViaTool(ctx, "Root question?")
    await waitPending(broker, 1)

    const pending = broker.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.owner).toEqual({ kind: "root" })
    // Root questions are session-level — never a subagent fleet row.
    expect(reader.snapshot()).toHaveLength(0)

    broker.cancelAll("teardown")
    await resultP
  })

  test("abort cancels the pending in finally (no leak)", async () => {
    const tasks = new TaskRegistry()
    const broker = createUserQuestionBroker()
    const childA = registerChild(tasks, "child")
    const ac = new AbortController()
    const ctx = ctxFor(
      baseCfg({ questionBroker: broker, spawnedAsTaskId: childA, signal: ac.signal }),
    )
    const resultP = askViaTool(ctx, "blocking?")
    await waitPending(broker, 1)
    expect(broker.listPending()).toHaveLength(1)

    ac.abort()
    const ev = await resultP
    // Cancelled outcome surfaces as a rejected tool result.
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(broker.listPending()).toHaveLength(0)
  })

  test("RED-on-injection: exact-taskId correlation is load-bearing", async () => {
    // If the producer bound the owner to ROOT instead of the explicit
    // spawnedAsTaskId, the child row would DISAPPEAR (never reassigned to the
    // newest task). This asserts the task binding, not a root fallback.
    const tasks = new TaskRegistry()
    const broker = createUserQuestionBroker()
    const reader = buildSessionAuthorities({
      tasks,
      env: { QUANTA_ATTENTION_NAV: "1" },
      questions: broker,
    }).attention
    if (reader === undefined) throw new Error("reader")
    const childA = registerChild(tasks, "child")
    const ctx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: childA }))
    const resultP = askViaTool(ctx, "q?")
    await waitPending(broker, 1)
    // The producer MUST bind {task, childA} — proven by the row existing.
    expect(reader.snapshot().map((a) => a.id)).toEqual([childA])
    expect(broker.listPending()[0]?.owner).toEqual({ kind: "task", taskId: childA })
    broker.cancelAll("teardown")
    await resultP
  })

  test("cross-case byte-identity: attention OFF + panel ON publishes no pending", async () => {
    // Panel ON is modeled by onSubagentEvent + spawnedAsTaskId being present;
    // attention OFF is modeled by NO questionBroker. The producer must route
    // through the legacy userInputPort and touch no broker.
    const tasks = new TaskRegistry()
    const broker = createUserQuestionBroker() // a broker exists but is NOT wired to config
    const childA = registerChild(tasks, "child")
    const seen: string[] = []
    const legacyPort: UserInputRequester = async (req) => {
      seen.push(req.prompt)
      return { decision: "answer", text: "legacy" } satisfies UserInputOutcome
    }
    const ctx = ctxFor(
      baseCfg({
        spawnedAsTaskId: childA,
        onSubagentEvent: () => {},
        userInputPort: legacyPort,
        // questionBroker intentionally ABSENT (attention OFF)
      }),
    )
    // ctx.requestUserInput must be the legacy port verbatim (byte-identical).
    expect(ctx.requestUserInput).toBe(legacyPort)
    const ev = await askViaTool(ctx, "cross-case?")
    expect(seen).toEqual(["cross-case?"])
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.output).toBe("legacy")
    // No broker interaction whatsoever.
    expect(broker.listPending()).toHaveLength(0)
  })
})
