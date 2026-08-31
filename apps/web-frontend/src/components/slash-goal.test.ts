import { afterEach, describe, expect, it, vi } from "vitest"
import type { GoalReadoutData } from "../types/protocol.readout.generated"
import type { ObjectiveMutationReceipt } from "../ws/session-hooks"
import type { SlashCommand } from "./SlashPalette"
import { buildGoalSlashCommands, type GoalSlashDeps, parseGoalCommand } from "./slash-goal"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const empty = (): GoalReadoutData => ({
  kind: "goal",
  revision: 0,
  freshness: "fresh",
  validationContract: "missing",
  wake: null,
  latestSettlement: null,
  objective: null,
})

const live = (over: Partial<NonNullable<GoalReadoutData["objective"]>> = {}): GoalReadoutData => ({
  kind: "goal",
  revision: 3,
  freshness: "fresh",
  validationContract: "manual-only",
  wake: null,
  latestSettlement: null,
  objective: {
    objectiveId: "objective-1",
    goal: "ship it",
    status: "active",
    budget: { turnsUsed: 0, tokensUsed: 0 },
    blockers: [],
    criteria: [],
    ...over,
  },
})

const run = async (command: SlashCommand | undefined, rest: string): Promise<void> => {
  if (command?.kind !== "local" && command?.kind !== "readout") {
    throw new Error("missing /goal action")
  }
  await command.action(rest)
}

const harness = (initial = empty(), over: Partial<GoalSlashDeps> = {}) => {
  let state = initial
  const system: string[] = []
  const errors: string[] = []
  const mutations: { mutation: unknown; revision: number }[] = []
  const work: string[] = []
  globalThis.fetch = vi.fn(async () =>
    Response.json({ name: "goal", output: "goal display", wired: true, data: state }),
  ) as typeof fetch
  const send = async (mutation: unknown, revision: number): Promise<ObjectiveMutationReceipt> => {
    mutations.push({ mutation, revision })
    const value = mutation as { kind?: string; definition?: { goal?: string } }
    if (value.kind === "create") {
      state = live({ goal: value.definition?.goal ?? "", objectiveId: "objective-created" })
    }
    state = { ...state, revision: revision + 1 }
    return { kind: "applied", commandId: "cmd-1" }
  }
  const deps: GoalSlashDeps = {
    httpUrl: "http://127.0.0.1:4096",
    token: "tok",
    appendSystem: (text) => system.push(text),
    onError: (text) => errors.push(text),
    sendObjectiveMutate: send,
    sendGoalWork: (text) => {
      work.push(text)
      return true
    },
    requestGoalVerification: async () => ({ kind: "undelivered" }),
    readGoal: async () => ({ kind: "served", output: "goal display", data: state }),
    delay: async () => undefined,
    ...over,
  }
  return {
    system,
    errors,
    mutations,
    work,
    goal: buildGoalSlashCommands(deps).find((command) => command.slug === "goal"),
  }
}

describe("/goal parser", () => {
  it("show is a read and stop is the pause alias", () => {
    expect(parseGoalCommand("show")).toEqual({ kind: "show" })
    expect(parseGoalCommand("stop")).toEqual({ kind: "pause" })
  })

  it("plain text remains create, while no-arg tails fail closed", () => {
    expect(parseGoalCommand("ship release")).toEqual({ kind: "create", text: "ship release" })
    expect(parseGoalCommand("show surprise").kind).toBe("error")
    expect(parseGoalCommand("stop surprise").kind).toBe("error")
  })
})

describe("/goal basic execution", () => {
  it("no args and explicit show only display; neither mutates", async () => {
    const h = harness(live())
    await run(h.goal, "")
    await run(h.goal, "show")
    expect(h.mutations).toHaveLength(0)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it("create sends the revision the operator read and waits for application", async () => {
    const h = harness()
    await run(h.goal, "ship release")
    expect(h.mutations).toEqual([
      { mutation: { kind: "create", definition: { goal: "ship release" } }, revision: 0 },
    ])
    expect(h.errors).toEqual([])
  })

  it("work uses the dedicated attributed-turn channel", async () => {
    const h = harness(live())
    await run(h.goal, "work fix the flake")
    expect(h.work).toEqual(["fix the flake"])
    expect(h.mutations).toHaveLength(0)
  })

  it("existing goal refuses create and points to edit without a mutation", async () => {
    const h = harness(live())
    await run(h.goal, "replace by accident")
    expect(h.mutations).toHaveLength(0)
    expect(h.errors[0]).toContain("edit")
  })
})
