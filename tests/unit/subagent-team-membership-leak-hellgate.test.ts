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
 * FIX: a symmetric `maybeUnregisterChildTeam` runs in the same `finally` that
 * disposes the waker, calling `removeMember(team, childLabel)`. `removeMember` is
 * team-scoped (the registry guards `teamByAgent.get(child) === team`), so a child
 * that re-homed itself via `team_create` keeps its chosen team — only a transient
 * child that joined the parent's team here is reaped.
 *
 * Default-OFF byte-identity is preserved: no `teamRegistry` OR an un-teamed
 * parent ⇒ the helper returns `undefined` ⇒ nothing to dispose.
 */

import { describe, expect, test } from "bun:test"
import type { runAgent } from "../../src/agent/loop"
import { createSubagentRunner } from "../../src/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "../../src/agent/types"
import { createTeamRegistry } from "../../src/subagent"
import type { SubagentRequest } from "../../src/subagent/types"
import { ToolRegistry } from "../../src/tool"

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

// jul-7 audit (F2/F3): team_create/team_delete were UNAUTHENTICATED — an agent could
// re-home a teamed victim into its own team (then the cross-team send-deny "allows" the
// attacker→victim message because sameTeam is now true), or reap a team it does not belong
// to. The registry now authorizes an LLM `caller`; the host path (no caller) is unchanged.
describe("team registry — caller authorization (jul-7 audit F2/F3)", () => {
  test("F2: re-home hijack blocked — cannot drag a TEAMED victim into the caller's team", () => {
    const reg = createTeamRegistry()
    reg.create("victims", ["victimA"]) // host seeds victimA into its real team
    expect(reg.teamOf("victimA")).toBe("victims")

    // attacker (an LLM caller) tries to steal victimA into team "evil"
    reg.create("evil", ["evil", "victimA"], "evil")

    expect(reg.teamOf("victimA")).toBe("victims") // NOT re-homed — hijack blocked
    expect(reg.sameTeam("evil", "victimA")).toBe(false) // send-deny still applies
    expect(reg.teamOf("evil")).toBe("evil") // attacker only got ITSELF
  })

  test("F2: cannot JOIN an existing foreign team by name (would gain its send scope)", () => {
    const reg = createTeamRegistry()
    reg.create("secret", ["A"]) // existing team the attacker is not in
    reg.create("secret", ["evil"], "evil") // attacker tries to join it
    expect(reg.teamOf("evil")).toBeUndefined() // denied — did not join
    expect(reg.sameTeam("evil", "A")).toBe(false)
  })

  test("F3: cross-team delete blocked — cannot reap a team the caller is not in", () => {
    const reg = createTeamRegistry()
    reg.create("t1", ["A"])
    const reaped = reg.delete("t1", "evil") // attacker (not in t1) tries to reap it
    expect(reaped).toEqual([]) // nothing reaped
    expect(reg.teamOf("A")).toBe("t1") // team intact
  })

  test("legit: caller creates its OWN team with unteamed members, then deletes it", () => {
    const reg = createTeamRegistry()
    reg.create("tx", ["leader", "childA"], "leader") // both unteamed ⇒ both join
    expect(reg.teamOf("leader")).toBe("tx")
    expect(reg.teamOf("childA")).toBe("tx")
    const reaped = reg.delete("tx", "leader") // leader belongs ⇒ allowed
    expect([...reaped].sort()).toEqual(["childA", "leader"])
    expect(reg.teamOf("leader")).toBeUndefined()
  })

  test("host path (no caller) re-homes freely — byte-identical (child registration)", () => {
    const reg = createTeamRegistry()
    reg.create("a", ["X"])
    reg.create("b", ["X"]) // host re-homes X (no caller) — allowed
    expect(reg.teamOf("X")).toBe("b")
    expect(reg.delete("a")).toEqual([]) // a is now empty (X moved), host delete works
  })
})
