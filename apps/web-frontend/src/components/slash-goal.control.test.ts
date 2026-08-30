/**
 * ★ HELLGATE — the browser can CONTROL the goal it can already read, set and work.
 *
 * The web reached read/create/work and stopped there, so an operator who set a
 * wrong goal from the browser had no way to pause, fix or drop it without opening
 * the CLI. Nothing new is needed underneath: the USER actor is allowed
 * `replace` / `clear` / `setExplicitStatus` in the policy table, and the host
 * binds `session.objective.mutate` to that actor and to THIS session. This is a
 * caller, not a mechanism.
 *
 * Two things this pins that the first cut of `/goal <text>` got wrong:
 *
 *  1. READ-BACK IS EXACT. `body.includes(text)` reads a goal's own words out of a
 *     blocker line, a criterion or a next-action and calls that success. The
 *     readout is parsed and the GOAL LINE and STATUS are compared.
 *  2. READ-BACK IS BOUNDED, NOT INSTANT. The write goes over the session socket
 *     and the read over HTTP; "sent" is not "landed". `/model` learned this and
 *     polls; so does this.
 *
 * Read-back proves the OBSERVED END STATE, never that the command was accepted.
 * A refusal is a rejected frame on the session channel and shows up there.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { SlashCommand } from "./SlashPalette"
import { buildGoalSlashCommands, type GoalSlashDeps, parseGoalReadout } from "./slash-goal"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const GOAL_BODY = (goal: string, status = "active"): string =>
  `goal   ${goal}\nstatus ${status} · rev 3 · validation manual-only\ncriteria 0/1 met   remaining: tests pass\nbudget 0/∞ turns · 0/∞ tokens\nlast attempt: none\n`

const EMPTY_BODY =
  "No goal is set for this session.\nAsk the agent to set one, or run `/goal <objective>` from the quanta CLI.\n"

/** `fetchReadoutBody` (the printing path) always answers with the LAST body. */
const stubPrintingFetch = (bodyRef: { current: string }) => {
  const printed: string[] = []
  globalThis.fetch = vi.fn(async () => ({
    status: 200,
    json: async () => ({ name: "goal", output: bodyRef.current, wired: true, isError: false }),
  })) as unknown as typeof fetch
  return printed
}

const harness = (over: Partial<GoalSlashDeps> = {}) => {
  const system: string[] = []
  const errors: string[] = []
  const mutations: unknown[] = []
  const work: string[] = []
  const bodyRef = { current: EMPTY_BODY }
  const reads: string[] = []
  stubPrintingFetch(bodyRef)
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
    readReadout: async (name) => {
      reads.push(name)
      return bodyRef.current
    },
    delay: async () => undefined,
    ...over,
  }
  const goal = buildGoalSlashCommands(deps).find((c) => c.slug === "goal")
  return { system, errors, mutations, work, bodyRef, reads, goal }
}

const run = async (cmd: SlashCommand | undefined, rest: string): Promise<void> => {
  if (cmd === undefined || (cmd.kind !== "local" && cmd.kind !== "readout")) {
    throw new Error("the /goal command must carry an action")
  }
  await cmd.action(rest)
}

// ─────────────────────────────────────────────────────────────────────────────

describe("parseGoalReadout — the readout is parsed, not string-searched", () => {
  it("reads the goal line and the status", () => {
    expect(parseGoalReadout(GOAL_BODY("ship the release", "paused"))).toEqual({
      present: true,
      goal: "ship the release",
      status: "paused",
      attemptInFlight: false,
      maxTurns: "∞",
      maxTokens: "∞",
    })
  })

  it("reports absence for the empty body", () => {
    expect(parseGoalReadout(EMPTY_BODY)).toEqual({ present: false })
  })

  it("a goal's own words appearing ELSEWHERE do not become the goal", () => {
    // The exact false positive `body.includes()` produced: the typed text shows
    // up in a blocker line while the real goal is something else.
    const body =
      "goal   ship the release\nstatus active · rev 3 · validation manual-only\nblockers:\n  - [user] waiting on deploy the hotfix\n"

    expect(parseGoalReadout(body)).toEqual({
      present: true,
      goal: "ship the release",
      status: "active",
      attemptInFlight: false,
      maxTurns: "∞",
      maxTokens: "∞",
    })
  })

  it("an unparseable body is absence, never a confident wrong answer", () => {
    expect(parseGoalReadout("")).toEqual({ present: false })
    expect(parseGoalReadout("something the daemon has never rendered")).toEqual({ present: false })
  })
})

describe("parseGoalReadout — the fields a control verb needs to see it land", () => {
  it("reads a RUNNING attempt, the thing that refuses a definition change", () => {
    const body = `${GOAL_BODY("ship it")}attempt: running attempt-77\n`

    const readout = parseGoalReadout(body)

    expect(readout.present && readout.attemptInFlight).toBe(true)
  })

  it("reads the declared budget caps", () => {
    const body =
      "goal   ship it\nstatus active · rev 3 · validation manual-only\nbudget 2/50 turns · 10/9000 tokens\n"

    const readout = parseGoalReadout(body)

    expect(readout.present && readout.maxTurns).toBe("50")
    expect(readout.present && readout.maxTokens).toBe("9000")
  })
})

describe("/goal abandon — free a stuck attempt from the browser", () => {
  it("sends abandonAttempt and waits for the attempt to be gone", async () => {
    const h = harness()
    h.bodyRef.current = GOAL_BODY("ship it")

    await run(h.goal, "abandon")

    expect(h.mutations).toEqual([{ kind: "abandonAttempt" }])
    expect(h.errors).toEqual([])
  })

  it("an attempt that is STILL running is reported, not called success", async () => {
    const stuck = `${GOAL_BODY("ship it")}attempt: running attempt-77\n`
    const h = harness({ readReadout: async () => stuck })
    h.bodyRef.current = stuck

    await run(h.goal, "abandon")

    expect(h.errors.join("")).not.toBe("")
  })
})

describe("/goal budget — raise the cap without leaving the browser", () => {
  it("parses the CLI's own flag syntax and sends amendBudget", async () => {
    const h = harness()
    h.bodyRef.current =
      "goal   ship it\nstatus active · rev 3 · validation manual-only\nbudget 0/50 turns · 0/∞ tokens\n"

    await run(h.goal, "budget --max-turns=50")

    expect(h.mutations).toEqual([{ kind: "amendBudget", budget: { maxTurns: 50 } }])
    expect(h.errors).toEqual([])
  })

  it("both caps at once", async () => {
    const h = harness()
    h.bodyRef.current =
      "goal   ship it\nstatus active · rev 3 · validation manual-only\nbudget 0/5 turns · 0/1000 tokens\n"

    await run(h.goal, "budget --max-turns=5 --max-tokens=1000")

    expect(h.mutations).toEqual([
      { kind: "amendBudget", budget: { maxTurns: 5, maxTokens: 1000 } },
    ])
  })

  it("PAIRED CONTROL — no flags asks for the syntax instead of sending an empty amendment", async () => {
    const h = harness()

    await run(h.goal, "budget")

    expect(h.mutations).toEqual([])
    expect(h.errors.join("")).toMatch(/--max-turns/)
  })

  it("a malformed flag is refused, never guessed at", async () => {
    const h = harness()

    await run(h.goal, "budget bigger please")

    expect(h.mutations).toEqual([])
    expect(h.errors.join("")).toMatch(/--max-turns/)
  })
})

describe("/goal pause | resume | clear — exact mutations", () => {
  it("pause sends setExplicitStatus paused", async () => {
    const h = harness()
    h.bodyRef.current = GOAL_BODY("ship it", "paused")

    await run(h.goal, "pause")

    expect(h.mutations).toEqual([{ kind: "setExplicitStatus", status: "paused" }])
    expect(h.errors).toEqual([])
  })

  it("resume sends setExplicitStatus active", async () => {
    const h = harness()
    h.bodyRef.current = GOAL_BODY("ship it", "active")

    await run(h.goal, "resume")

    expect(h.mutations).toEqual([{ kind: "setExplicitStatus", status: "active" }])
  })

  it("clear sends clear and waits for ABSENCE, not for a string", async () => {
    const h = harness()
    h.bodyRef.current = EMPTY_BODY

    await run(h.goal, "clear")

    expect(h.mutations).toEqual([{ kind: "clear" }])
    expect(h.errors).toEqual([])
  })

  it("edit sends replace with the new definition", async () => {
    const h = harness()
    h.bodyRef.current = GOAL_BODY("ship v2")

    await run(h.goal, "edit ship v2")

    expect(h.mutations).toEqual([{ kind: "replace", definition: { goal: "ship v2" } }])
  })
})

describe("/goal — the verb table does not swallow a goal", () => {
  it("PAIRED CONTROL — plain text is still a create", async () => {
    const h = harness()
    h.bodyRef.current = GOAL_BODY("ship v2")

    await run(h.goal, "ship v2")

    expect(h.mutations).toEqual([{ kind: "create", definition: { goal: "ship v2" } }])
  })

  it("a no-argument verb with a tail is refused and points at edit", async () => {
    const h = harness()

    await run(h.goal, "pause the rollout")

    expect(h.mutations).toEqual([])
    expect(h.errors.join("")).toMatch(/edit/)
  })

  it("edit with no text asks for it instead of replacing with nothing", async () => {
    const h = harness()

    await run(h.goal, "edit")

    expect(h.mutations).toEqual([])
    expect(h.errors.join("")).toMatch(/edit/i)
  })
})

describe("/goal — read-back is bounded, and honest when it does not land", () => {
  it("an old body on the first read is polled until the new state appears", async () => {
    const h = harness()
    h.bodyRef.current = GOAL_BODY("ship it", "active")
    let reads = 0
    const deps = harness({
      readReadout: async () => {
        reads += 1
        return reads < 3 ? GOAL_BODY("ship it", "active") : GOAL_BODY("ship it", "paused")
      },
    })

    await run(deps.goal, "pause")

    expect(reads).toBeGreaterThanOrEqual(3)
    expect(deps.errors).toEqual([])
    void h
  })

  it("a state that never lands reports it, and still prints the real readout", async () => {
    const h = harness({ readReadout: async () => GOAL_BODY("ship it", "active") })
    h.bodyRef.current = GOAL_BODY("ship it", "active")

    await run(h.goal, "pause")

    expect(h.errors.join("")).not.toBe("")
    // The operator still sees the truth rather than only an error.
    expect(h.system.join("")).toContain("ship it")
  })

  it("a socket that refuses the send is reported and NOT polled", async () => {
    let reads = 0
    const h = harness({
      sendObjectiveMutate: () => false,
      readReadout: async () => {
        reads += 1
        return EMPTY_BODY
      },
    })

    await run(h.goal, "pause")

    expect(h.errors.join("")).not.toBe("")
    expect(reads).toBe(0)
  })
})
