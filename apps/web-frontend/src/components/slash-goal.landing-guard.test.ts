/**
 * ★ HELLGATE — a control verb's LANDED predicate is load-bearing.
 *
 * MEASURED DEFECT (2026-09-01 audit): `awaitGoalState` accepts a read-back only
 * when the revision moved AND the verb's own `landed(data)` holds. The suite
 * exercised it against a stub that APPLIES the mutation, so every read-back
 * satisfied both conditions — and the `landed` half was doing no work. Proof:
 * replacing the predicate with `() => true` for pause, resume, clear, abandon or
 * create left the entire component suite green (366/366). A predicate that
 * checked the wrong field would have shipped silently, and `/goal pause` would
 * report success on a goal that is still active.
 *
 * The gap is specifically "the revision MOVED but not to what was asked": a
 * concurrent edit from another surface, or a mutation the authority reinterpreted.
 * That is the one shape the revision check alone cannot catch, so it is the shape
 * this file drives — the daemon acknowledges, the revision advances, and the
 * requested end state never appears.
 *
 * Every case is a NEGATIVE with a paired positive, because a guard that only
 * asserts the happy path is how this hole was opened.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { GoalReadoutData } from "../types/protocol.readout.generated"
import type { SlashCommand } from "./SlashPalette"
import type { GoalSlashDeps } from "./slash-goal"
import { buildGoalSlashCommands } from "./slash-goal"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const baseState = (): GoalReadoutData => ({
  kind: "goal",
  revision: 8,
  freshness: "fresh",
  validationContract: "checked",
  wake: null,
  latestSettlement: null,
  objective: {
    objectiveId: "objective-8",
    goal: "ship safely",
    status: "active",
    budget: { turnsUsed: 1, tokensUsed: 20, maxTurns: 9, maxTokens: 5_000 },
    blockers: [{ id: "blocker-1", reason: "waiting on deploy", waitingOn: "user" }],
    criteria: [{ id: "manual-1", kind: "manual", text: "reviewed", met: false }],
    // A stuck attempt, so `abandon` has something to free — without it the verb
    // short-circuits as a no-op and proves nothing about its predicate.
    startedAttemptId: "attempt-stuck",
  },
})

/**
 * A daemon that ACKS every mutation and advances the revision, while the goal
 * itself is whatever `nextState` says. With `nextState` unchanged this is exactly
 * "the revision moved, the request did not land".
 */
const harness = (nextState: (from: GoalReadoutData) => GoalReadoutData = (from) => from) => {
  let current = baseState()
  const errors: string[] = []
  const system: string[] = []
  const sent: Record<string, unknown>[] = []
  globalThis.fetch = vi.fn(async () =>
    Response.json({ output: "goal display", wired: true, data: current }),
  ) as unknown as typeof fetch

  const deps = {
    httpUrl: "http://127.0.0.1:4096",
    appendSystem: (text: string) => system.push(text),
    onError: (text: string) => errors.push(text),
    sendGoalWork: () => true,
    requestGoalVerification: async () => ({ kind: "undelivered" }) as never,
    sendObjectiveMutate: async (mutation: unknown) => {
      sent.push(mutation as Record<string, unknown>)
      const advanced = nextState(current)
      current = { ...advanced, revision: current.revision + 1 }
      return { kind: "applied", commandId: "cmd" } as never
    },
    readGoal: async () => ({ kind: "served", output: "goal display", data: current }) as never,
    delay: async () => undefined,
  } as unknown as GoalSlashDeps

  return {
    errors,
    system,
    sent,
    goal: buildGoalSlashCommands(deps).find((command) => command.slug === "goal"),
  }
}

const run = async (command: SlashCommand | undefined, rest: string): Promise<void> => {
  if (command?.kind !== "local" && command?.kind !== "readout") {
    throw new Error("missing /goal action")
  }
  await command.action(rest)
}

/** The end state each verb is asking for, applied to the stub's goal. */
const LANDS: Readonly<Record<string, (from: GoalReadoutData) => GoalReadoutData>> = {
  pause: (from) =>
    from.objective === null
      ? from
      : { ...from, objective: { ...from.objective, status: "paused" } },
  clear: (from) => ({ ...from, objective: null }),
  abandon: (from) =>
    from.objective === null
      ? from
      : { ...from, objective: { ...from.objective, startedAttemptId: undefined } },
  unblock: (from) =>
    from.objective === null ? from : { ...from, objective: { ...from.objective, blockers: [] } },
}

const COMMANDS: readonly { readonly verb: string; readonly input: string }[] = [
  { verb: "pause", input: "pause" },
  { verb: "clear", input: "clear" },
  { verb: "unblock", input: "unblock" },
  { verb: "abandon", input: "abandon" },
]

describe("control verbs — a moved revision is not a landing", () => {
  for (const { verb, input } of COMMANDS) {
    it(`${verb}: an acked mutation whose end state never appears is REPORTED, not called success`, async () => {
      // The revision advances on every send; the goal never changes.
      const h = harness()

      await run(h.goal, input)

      expect(h.sent.length).toBeGreaterThanOrEqual(1)
      expect(h.errors.join("")).not.toBe("")
    })

    it(`${verb}: PAIRED CONTROL — the same command lands cleanly when the end state DOES appear`, async () => {
      const apply = LANDS[verb]
      if (apply === undefined) throw new Error(`no end state defined for ${verb}`)
      const h = harness(apply)

      await run(h.goal, input)

      expect(h.sent.length).toBeGreaterThanOrEqual(1)
      expect(h.errors.join("")).toBe("")
    })
  }
})

describe("control verbs — the predicate reads the field the verb is about", () => {
  it("pause is not satisfied by a goal that merely changed in some other way", async () => {
    // A concurrent edit moved the revision AND the goal text, but not the status.
    // A predicate looking at the wrong field would call this a pause.
    const h = harness((from) =>
      from.objective === null
        ? from
        : { ...from, objective: { ...from.objective, goal: "someone else edited this" } },
    )

    await run(h.goal, "pause")

    expect(h.errors.join("")).not.toBe("")
  })

  it("clear is not satisfied by a goal that is merely paused", async () => {
    const h = harness((from) =>
      from.objective === null
        ? from
        : { ...from, objective: { ...from.objective, status: "paused" } },
    )

    await run(h.goal, "clear")

    expect(h.errors.join("")).not.toBe("")
  })
})
