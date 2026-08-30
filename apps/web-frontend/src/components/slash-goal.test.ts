/**
 * ★ HELLGATE — `/goal` in the browser: read, set, work.
 *
 * MEASURED DEFECT (2026-08-30, two audit rounds + probes): the SPA shipped the
 * whole goal-work transport — `SessionClient.sendGoalWork`, `onGoalWorkResult`,
 * a no-throw decoder, inbound dispatch, and its own eight-case suite — and no
 * component or hook called any of it. The palette had no `goal` entry at all,
 * not even one of the `unwired(...)` stubs that tell a user to run it from the
 * CLI.
 *
 * And a work verb alone would have been inert. A browser cannot create an
 * objective: a model `create` is `actor-forbidden` with the propose gate off and
 * `approval-unavailable` with it on, because the daemon composes no confirm
 * surface (both probed). The only route that works is `session.objective.mutate`,
 * which the host binds to the USER actor — a first-class session command that has
 * been generated into this package's own union since it shipped, with zero
 * callers. So set and work land together, or neither is reachable.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { SlashCommand } from "./SlashPalette"
import { buildGoalSlashCommands, type GoalSlashDeps } from "./slash-goal"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const stubReadout = (output: string) => {
  const calls: string[] = []
  globalThis.fetch = vi.fn(async (url: string) => {
    calls.push(url)
    return {
      status: 200,
      json: async () => ({ name: "goal", output, wired: true, isError: false }),
    } as unknown as Response
  }) as unknown as typeof fetch
  return calls
}

const harness = (over: Partial<GoalSlashDeps> = {}) => {
  const system: string[] = []
  const errors: string[] = []
  const mutations: unknown[] = []
  const work: string[] = []
  const deps: GoalSlashDeps = {
    httpUrl: "http://127.0.0.1:4096",
    token: "tok",
    appendSystem: (text) => system.push(text),
    onError: (msg) => errors.push(msg),
    sendObjectiveMutate: (mutation) => {
      mutations.push(mutation)
      return true
    },
    sendGoalWork: (text) => {
      work.push(text)
      return true
    },
    ...over,
  }
  const commands = buildGoalSlashCommands(deps)
  const goal = commands.find((c) => c.slug === "goal")
  return { system, errors, mutations, work, goal }
}

const run = async (cmd: SlashCommand | undefined, rest: string): Promise<string> => {
  if (cmd === undefined || (cmd.kind !== "local" && cmd.kind !== "readout")) {
    throw new Error("the /goal command must carry an action")
  }
  return await cmd.action(rest)
}

describe("/goal — the browser can read the goal", () => {
  it("with no argument it fetches the daemon readout and prints it", async () => {
    const calls = stubReadout("goal   ship it\nstatus active · rev 3 · validation manual-only\n")
    const { goal, system } = harness()

    await run(goal, "")

    expect(calls[0]).toBe("http://127.0.0.1:4096/readout/goal")
    expect(system.join("")).toContain("ship it")
    expect(system.join("")).toContain("rev 3")
  })
})

describe("/goal <text> — the browser can SET the goal", () => {
  it("sends session.objective.mutate carrying a create for the typed text", async () => {
    stubReadout("goal   ship the release\n")
    const { goal, mutations } = harness()

    await run(goal, "ship the release")

    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      kind: "create",
      definition: { goal: "ship the release" },
    })
  })

  it("reads the goal back so the operator sees what actually landed", async () => {
    const calls = stubReadout("goal   ship the release\nstatus active\n")
    const { goal, system } = harness()

    await run(goal, "ship the release")

    expect(calls).toContain("http://127.0.0.1:4096/readout/goal")
    expect(system.join("")).toContain("ship the release")
  })

  it("a socket that refuses the send is reported, never silently swallowed", async () => {
    stubReadout("")
    const { goal, errors } = harness({ sendObjectiveMutate: () => false })

    await run(goal, "ship the release")

    expect(errors.join("")).not.toBe("")
  })
})

describe("/goal work <text> — the browser can ask for one goal turn", () => {
  it("sends the goalWork frame with the instruction", async () => {
    const { goal, work } = harness()

    await run(goal, "work fix the flake")

    expect(work).toEqual(["fix the flake"])
  })

  it("PAIRED CONTROL — `work` with no instruction asks for one instead of sending a blank", async () => {
    const { goal, work, errors } = harness()

    await run(goal, "work")

    expect(work).toEqual([])
    expect(errors.join("")).toMatch(/instruction/i)
  })

  it("a socket that refuses the send is reported", async () => {
    const { goal, errors } = harness({ sendGoalWork: () => false })

    await run(goal, "work fix the flake")

    expect(errors.join("")).not.toBe("")
  })
})

describe("/goal — the palette entry is honest about the command it is", () => {
  it("clears the draft on accept, as the palette invariant requires", async () => {
    stubReadout("no goal\n")
    const { goal } = harness()

    expect(await run(goal, "")).toBe("")
  })

  it("its description names all three things it does", () => {
    const { goal } = harness()

    expect(goal?.description.toLowerCase()).toMatch(/goal/)
    expect(goal?.kind).toBe("local")
  })
})
