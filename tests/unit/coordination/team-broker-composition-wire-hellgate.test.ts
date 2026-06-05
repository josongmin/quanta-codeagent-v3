/**
 * ★ HELLGATE — Capability B composition wiring. Proves the `createSubagentRunner`
 *   composition root injects the leader-mediated escalation broker onto a CHILD
 *   subagent's admissibility bundle ONLY when `QUANTA_TEAM_BROKER` is on AND the
 *   parent carries an `onConfirm` (the leader's HITL authority), and that the
 *   wired broker actually drives the leader's onConfirm end-to-end.
 *
 * Source under test: src/agent/subagent-runner.ts (maybeWireCoordinationBroker)
 *   + src/agent/coordination-broker-wire.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { runAgent } from "@/agent/loop"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

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

const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { stream: async function* () {} } as any,
    registry: new ToolRegistry([fakeTool("read")]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const outcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
})

/** Capture the child config the runner forks. */
const capturing = (): { run: typeof runAgent; seen: AgentConfig[] } => {
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    return outcome()
  }) as typeof runAgent
  return { run, seen }
}

const childOf = async (parent: AgentConfig): Promise<AgentConfig> => {
  const { run, seen } = capturing()
  const runner = createSubagentRunner(parent, { run })
  await runner({ prompt: "x", depth: 1 })
  const child = seen[0]
  if (child === undefined) throw new Error("child never forked")
  return child
}

const original = process.env.QUANTA_TEAM_BROKER
beforeEach(() => {
  __resetRuntimeConfig()
})
afterEach(() => {
  if (original === undefined) delete process.env.QUANTA_TEAM_BROKER
  else process.env.QUANTA_TEAM_BROKER = original
  __resetRuntimeConfig()
})

describe("HELLGATE B wiring — coordinationBroker injected only when armed", () => {
  test("knob ON + parent.onConfirm ⇒ child carries admissibility.coordinationBroker", async () => {
    process.env.QUANTA_TEAM_BROKER = "1"
    __resetRuntimeConfig()
    const child = await childOf(parentConfig({ onConfirm: async () => true }))
    expect(child.admissibility?.coordinationBroker).toBeDefined()
    // INVARIANT (robustness): the child's admissibility bundle carries ONLY the
    // broker — the wire must never clobber/leak other admissibility axes
    // (reviewerPort / rulesStore / permissionStore) into a worker. If a future
    // change makes the child inherit the parent's admissibility, this fails
    // loudly so the merge is made conscious rather than silently dropping the
    // broker or widening the worker's gate surface.
    expect(Object.keys(child.admissibility ?? {})).toEqual(["coordinationBroker"])
  })

  test("knob OFF ⇒ child has NO coordinationBroker (byte-identical legacy)", async () => {
    delete process.env.QUANTA_TEAM_BROKER
    __resetRuntimeConfig()
    const child = await childOf(parentConfig({ onConfirm: async () => true }))
    expect(child.admissibility?.coordinationBroker).toBeUndefined()
  })

  test("knob ON but NO parent.onConfirm ⇒ no broker (no leader authority to escalate to)", async () => {
    process.env.QUANTA_TEAM_BROKER = "1"
    __resetRuntimeConfig()
    const child = await childOf(parentConfig())
    expect(child.admissibility?.coordinationBroker).toBeUndefined()
  })

  test("the wired broker drives the LEADER's onConfirm end-to-end (approve ⇒ approved)", async () => {
    process.env.QUANTA_TEAM_BROKER = "1"
    __resetRuntimeConfig()
    let confirmSeen: unknown
    const child = await childOf(
      parentConfig({
        onConfirm: async (action) => {
          confirmSeen = action
          return true
        },
      }),
    )
    const verdict = await child.admissibility?.coordinationBroker?.escalate({
      tool: "bash",
      scope: "rm dist",
      reason: "cleanup",
    })
    expect(verdict?.approved).toBe(true)
    // The leader's onConfirm saw the escalation as a tool action.
    expect((confirmSeen as { tool?: string })?.tool).toBe("bash")
  })

  test("leader onConfirm DENIES ⇒ broker reports not-approved", async () => {
    process.env.QUANTA_TEAM_BROKER = "1"
    __resetRuntimeConfig()
    const child = await childOf(parentConfig({ onConfirm: async () => false }))
    const verdict = await child.admissibility?.coordinationBroker?.escalate({
      tool: "bash",
      scope: "x",
      reason: "y",
    })
    expect(verdict?.approved).toBe(false)
  })
})
