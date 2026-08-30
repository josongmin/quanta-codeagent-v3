import { afterEach, describe, expect, it, vi } from "vitest"
import type { GoalReadoutData } from "../types/protocol.readout.generated"
import type { ObjectiveMutationReceipt } from "../ws/session-hooks"
import type { SlashCommand } from "./SlashPalette"
import {
  buildGoalSlashCommands,
  type GoalSlashDeps,
  parseCheckArgv,
  parseGoalCommand,
} from "./slash-goal"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const state = (): GoalReadoutData => ({
  kind: "goal",
  revision: 8,
  validationContract: "checked",
  objective: {
    objectiveId: "objective-8",
    goal: "ship safely",
    status: "active",
    budget: { turnsUsed: 1, tokensUsed: 20, maxTurns: 9, maxTokens: 5_000 },
    blockers: [],
    criteria: [
      { id: "manual-1", kind: "manual", text: "reviewed", met: false },
      {
        id: "checked-1",
        kind: "checked",
        text: "tests pass",
        met: false,
        check: {
          id: "check-1",
          kind: "command",
          argv: ["bun", "test"],
          timeoutMs: 3_000,
          successExitCodes: [0, 2],
          cwdPolicy: "thread",
        },
      },
    ],
  },
})

const run = async (command: SlashCommand | undefined, rest: string): Promise<void> => {
  if (command?.kind !== "local" && command?.kind !== "readout") {
    throw new Error("missing /goal action")
  }
  await command.action(rest)
}

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T

const harness = (
  initial = state(),
  receipt:
    | ObjectiveMutationReceipt
    | ((mutation: Record<string, unknown>) => ObjectiveMutationReceipt) = {
    kind: "applied",
    commandId: "cmd",
  },
  verification:
    | Awaited<ReturnType<GoalSlashDeps["requestGoalVerification"]>>
    | GoalSlashDeps["requestGoalVerification"] = { kind: "undelivered" },
) => {
  let current = structuredClone(initial) as Mutable<GoalReadoutData>
  const system: string[] = []
  const errors: string[] = []
  const sent: { mutation: Record<string, unknown>; revision: number }[] = []
  globalThis.fetch = vi.fn(async () =>
    Response.json({ output: "goal display", wired: true, data: current }),
  ) as typeof fetch

  const applyReplace = (
    definition: {
      goal: string
      budget?: { maxTurns?: number; maxTokens?: number }
      criteria?: { text: string; check?: Record<string, unknown> }[]
    },
    revision: number,
  ): void => {
    current.objective = {
      objectiveId: `objective-${revision + 1}`,
      goal: definition.goal,
      status: "active",
      budget: { turnsUsed: 0, tokensUsed: 0, ...definition.budget },
      blockers: [],
      criteria: (definition.criteria ?? []).map((criterion, index) =>
        criterion.check === undefined
          ? { id: `manual-new-${index}`, kind: "manual", text: criterion.text, met: false }
          : {
              id: `checked-new-${index}`,
              kind: "checked",
              text: criterion.text,
              met: false,
              check: {
                id: `check-new-${index}`,
                kind: "command",
                argv: criterion.check.argv as string[],
                timeoutMs: criterion.check.timeoutMs as number,
                successExitCodes: criterion.check.successExitCodes as number[],
                cwdPolicy: "thread",
              },
            },
      ),
    }
  }

  const apply = (mutation: Record<string, unknown>, revision: number): void => {
    const objective = current.objective
    switch (mutation.kind) {
      case "setExplicitStatus":
        if (objective !== null) objective.status = mutation.status as "active" | "paused"
        break
      case "clear":
        current.objective = null
        break
      case "amendBudget":
        if (objective !== null) Object.assign(objective.budget, mutation.budget)
        break
      case "clearBlocker":
        if (objective !== null) {
          objective.blockers = objective.blockers.filter(
            (blocker) => blocker.id !== mutation.blockerId,
          )
        }
        break
      case "markCriterion":
        if (objective !== null) {
          objective.criteria = objective.criteria.map((criterion) =>
            criterion.id === mutation.criterionId ? { ...criterion, met: true } : criterion,
          )
        }
        break
      case "replace": {
        applyReplace(
          mutation.definition as {
            goal: string
            budget?: { maxTurns?: number; maxTokens?: number }
            criteria?: { text: string; check?: Record<string, unknown> }[]
          },
          revision,
        )
        break
      }
    }
    current = { ...current, revision: revision + 1 }
  }

  const deps: Omit<GoalSlashDeps, "readGoal"> & {
    readGoal: NonNullable<GoalSlashDeps["readGoal"]>
  } = {
    httpUrl: "http://127.0.0.1:4096",
    appendSystem: (text) => system.push(text),
    onError: (text) => errors.push(text),
    sendGoalWork: () => true,
    requestGoalVerification: async (revision) =>
      typeof verification === "function" ? verification(revision) : verification,
    sendObjectiveMutate: async (value, revision) => {
      const mutation = value as Record<string, unknown>
      sent.push({ mutation, revision })
      const result = typeof receipt === "function" ? receipt(mutation) : receipt
      if (result.kind === "applied") apply(mutation, revision)
      return result
    },
    readGoal: async () => ({ kind: "served", output: "goal display", data: current }),
    delay: async () => undefined,
  }
  return {
    deps,
    sent,
    system,
    errors,
    current: () => current,
    goal: buildGoalSlashCommands(deps).find((command) => command.slug === "goal"),
  }
}

describe("structured goal control safety", () => {
  it("malformed payload is not absence and sends no clear", async () => {
    const h = harness()
    h.deps.readGoal = async () => ({ kind: "malformed", status: 200 })
    await run(h.goal, "clear")
    expect(h.sent).toHaveLength(0)
    expect(h.errors[0]).toContain("malformed")
  })

  it("no-op clear/abandon/pause/budget send zero mutations", async () => {
    const absent = structuredClone(state()) as Mutable<GoalReadoutData>
    absent.objective = null
    const clear = harness(absent)
    await run(clear.goal, "clear")
    expect(clear.sent).toHaveLength(0)

    const h = harness()
    await run(h.goal, "abandon")
    await run(h.goal, "pause")
    await run(h.goal, "resume")
    await run(h.goal, "budget --max-turns=9")
    // pause applies; resume applies. abandon and budget are no-ops.
    expect(h.sent.map((entry) => entry.mutation.kind)).toEqual([
      "setExplicitStatus",
      "setExplicitStatus",
    ])
  })

  it("rejection is not converted to success and action adds no duplicate refusal", async () => {
    const frame = {
      target: "command",
      reason: "protocol_validation",
      commandId: "cmd-stale",
      issue: "objective:stale",
    } as const
    const h = harness(state(), { kind: "rejected", commandId: "cmd-stale", frame })
    await run(h.goal, "clear")
    expect(h.current().objective).not.toBeNull()
    expect(h.errors).toEqual([])
  })

  it("edit preserves only budget caps and intentionally resets criteria/evidence", async () => {
    const h = harness()
    await run(h.goal, "edit ship differently")
    expect(h.sent[0]).toMatchObject({
      revision: 8,
      mutation: {
        kind: "replace",
        definition: {
          goal: "ship differently",
          budget: { maxTurns: 9, maxTokens: 5_000 },
        },
      },
    })
    expect((h.sent[0]?.mutation.definition as Record<string, unknown>).criteria).toBeUndefined()
  })
})

describe("criterion/check controls", () => {
  it("criterion add preserves declarations and budget while resetting generation", async () => {
    const h = harness()
    await run(h.goal, "criterion add release tagged")
    const definition = h.sent[0]?.mutation.definition as {
      budget: unknown
      criteria: { text: string; check?: { argv: string[] } }[]
    }
    expect(definition.budget).toEqual({ maxTurns: 9, maxTokens: 5_000 })
    expect(definition.criteria).toHaveLength(3)
    expect(definition.criteria[1]?.check?.argv).toEqual(["bun", "test"])
    expect(definition.criteria[2]).toEqual({ text: "release tagged" })
  })

  it("check add preserves exact argv boundaries and canonical defaults", async () => {
    expect(parseCheckArgv(`bun test "a b" '' --flag\\ value`)).toEqual([
      "bun",
      "test",
      "a b",
      "",
      "--flag value",
    ])
    const h = harness()
    await run(h.goal, `check add smoke suite -- bun test "a b" ''`)
    const definition = h.sent[0]?.mutation.definition as {
      criteria: { check?: Record<string, unknown> }[]
    }
    expect(definition.criteria.at(-1)?.check).toMatchObject({
      argv: ["bun", "test", "a b", ""],
      timeoutMs: 120_000,
      successExitCodes: [0],
    })
  })

  it("preserves escaped quotes inside double-quoted argv", () => {
    expect(parseCheckArgv(String.raw`printf "a\"b" 'c\d'`)).toEqual(["printf", 'a"b', "c\\d"])
  })

  it("criterion done resolves 1-based/manual ID and refuses checked criteria", async () => {
    const manual = harness()
    await run(manual.goal, "criterion done 1")
    expect(manual.sent[0]?.mutation).toEqual({
      kind: "markCriterion",
      criterionId: "manual-1",
      met: true,
    })

    const checked = harness()
    await run(checked.goal, "criterion done checked-1")
    expect(checked.sent).toHaveLength(0)
    expect(checked.errors[0]).toContain("checked-criterion-needs-verify")
  })

  it("unknown criterion never mutates", async () => {
    const h = harness()
    await run(h.goal, "criterion done 99")
    expect(h.sent).toHaveLength(0)
  })
})

describe("unblock freezes identity", () => {
  it("uses the initially viewed revision for the first blocker CAS", async () => {
    const initial = structuredClone(state()) as Mutable<GoalReadoutData>
    if (initial.objective === null) throw new Error("fixture")
    initial.objective.blockers = [{ id: "b1", reason: "one", waitingOn: "user" }]
    const h = harness(initial, {
      kind: "rejected",
      commandId: "stale-unblock",
      frame: {
        target: "command",
        reason: "revision_conflict",
        commandId: "stale-unblock",
        expectedRevision: 8,
        actualRevision: 9,
      },
    })
    let reads = 0
    h.deps.readGoal = async () => {
      reads += 1
      const data = structuredClone(initial) as Mutable<GoalReadoutData>
      data.revision = reads === 1 ? 8 : 9
      return { kind: "served", output: "goal display", data }
    }

    await run(h.goal, "unblock")

    expect(h.sent.map((entry) => entry.revision)).toEqual([8])
  })

  it("clears only blocker IDs present at command start", async () => {
    const initial = structuredClone(state()) as Mutable<GoalReadoutData>
    if (initial.objective === null) throw new Error("fixture")
    initial.objective.blockers = [
      { id: "b1", reason: "one", waitingOn: "user" },
      { id: "b2", reason: "two", waitingOn: "network" },
    ]
    const h = harness(initial, (mutation) => {
      if (mutation.blockerId === "b1" && h.current().objective !== null) {
        h.current().objective?.blockers.push({
          id: "b-new",
          reason: "arrived later",
          waitingOn: "tool",
        })
      }
      return { kind: "applied", commandId: String(mutation.blockerId) }
    })
    await run(h.goal, "unblock")
    expect(h.sent.map((entry) => entry.mutation.blockerId)).toEqual(["b1", "b2"])
    expect(h.current().objective?.blockers.map((blocker) => blocker.id)).toEqual(["b-new"])
  })
})

describe("parser coverage", () => {
  it("recognizes every completed control family", () => {
    expect(parseGoalCommand("unblock")).toEqual({ kind: "unblock" })
    expect(parseGoalCommand("criterion add done means done")).toEqual({
      kind: "criterion-add",
      text: "done means done",
    })
    expect(parseGoalCommand("criterion done abc")).toEqual({
      kind: "criterion-done",
      target: "abc",
    })
    expect(parseGoalCommand("verify")).toEqual({ kind: "verify" })
  })
})

describe("verify", () => {
  it("sends viewed revision and renders the correlated verified outcome", async () => {
    const requested: number[] = []
    const h = harness(state(), { kind: "applied", commandId: "unused" }, async (revision) => {
      requested.push(revision)
      return {
        kind: "result",
        frame: {
          requestId: "verify-8",
          status: "completed",
          outcome: { kind: "verified", passed: 1, failed: 0, revision: 9 },
        },
      }
    })
    await run(h.goal, "verify")
    expect(requested).toEqual([8])
    expect(h.system[0]).toContain("1 passed, 0 failed")
    expect(h.sent).toHaveLength(0)
  })
})
