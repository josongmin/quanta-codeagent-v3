/**
 * Hellgate — a spawned child's TEAM MEMBERSHIP must be released when its loop
 * ends (RFC jun-6 DELTA #2 lifecycle closeout).
 *
 * BUG (pre-fix): `maybeRegisterChildTeam` called `registry.addMember` on spawn,
 * but the runner's `finally` only disposed the turn-wake waker — there was NO
 * `removeMember`. Over a long session every spawn left a permanent entry in the
 * team registry's `agentId→teamId` / `teamId→Set<agentId>` maps: unbounded
 * membership growth, and a roster (`members()`) cluttered with dead children.
 *
 * FIX: `maybeRegisterChildTeam` returns a NO-THROW disposer that calls
 * `removeMember(team, childLabel)`; the runner invokes it in the same `finally`
 * that disposes the waker. `removeMember` is team-scoped (no-op if the child was
 * re-homed), so it never removes a child that joined a different team mid-flight.
 *
 * Default-OFF byte-identity is preserved: no `teamRegistry` OR an un-teamed
 * parent ⇒ the helper returns `undefined` ⇒ nothing to dispose.
 */

import { describe, expect, test } from "bun:test"
import type { runAgent } from "../../src/agent/loop"
import { createSubagentRunner } from "../../src/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "../../src/agent/types"
import { ToolRegistry } from "../../src/tool"
import { createTeamRegistry } from "../../src/subagent"
import type { SubagentRequest } from "../../src/subagent/types"

const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { stream: async function* () {} } as any,
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT SYSTEM",
    cwd: "/repo",
    maxTurns: 1,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const outcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
})

const req = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do the thing",
  depth: 1,
  ...over,
})

describe("subagent team membership — lifecycle leak (hellgate)", () => {
  test("(1) child is a team member mid-run and REMOVED when its loop ends", async () => {
    const registry = createTeamRegistry()
    registry.create("team-1", ["lead"])
    const childLabel = "lead/0" // `${mailboxAgentId}/${childOrdinal}`, first child

    let memberDuringRun: boolean | undefined
    const run = (async () => {
      memberDuringRun = registry.members("team-1").includes(childLabel)
      return outcome()
    }) as typeof runAgent

    const runner = createSubagentRunner(
      parentConfig({ mailboxAgentId: "lead", teamRegistry: registry }),
      { run },
    )
    await runner(req())

    // It joined the bus while running …
    expect(memberDuringRun).toBe(true)
    // … and left it on completion — no leaked entry.
    expect(registry.members("team-1")).toEqual(["lead"])
    expect(registry.teamOf(childLabel)).toBeUndefined()
  })

  test("(2) membership is released even when the child loop THROWS", async () => {
    const registry = createTeamRegistry()
    registry.create("team-1", ["lead"])
    const run = (async () => {
      throw new Error("child blew up")
    }) as typeof runAgent

    const runner = createSubagentRunner(
      parentConfig({ mailboxAgentId: "lead", teamRegistry: registry }),
      { run },
    )
    await expect(runner(req())).rejects.toThrow("child blew up")

    // `finally` still ran the disposer.
    expect(registry.members("team-1")).toEqual(["lead"])
    expect(registry.teamOf("lead/0")).toBeUndefined()
  })

  test("(3) many sequential spawns do not accumulate dead members (no unbounded growth)", async () => {
    const registry = createTeamRegistry()
    registry.create("team-1", ["lead"])
    const run = (async () => outcome()) as typeof runAgent
    const runner = createSubagentRunner(
      parentConfig({ mailboxAgentId: "lead", teamRegistry: registry }),
      { run },
    )
    for (let i = 0; i < 25; i++) await runner(req())
    // Only the leader remains; every transient child was reaped.
    expect(registry.members("team-1")).toEqual(["lead"])
  })

  test("(4) default-OFF: un-teamed parent ⇒ no membership churn, child runs fine", async () => {
    const registry = createTeamRegistry() // parent never joined a team
    const run = (async () => outcome()) as typeof runAgent
    const runner = createSubagentRunner(
      parentConfig({ mailboxAgentId: "lead", teamRegistry: registry }),
      { run },
    )
    const r = await runner(req())
    expect(r.ok).toBe(true)
    expect(registry.teamOf("lead/0")).toBeUndefined()
  })
})
