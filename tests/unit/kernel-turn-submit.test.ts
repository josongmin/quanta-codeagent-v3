import { describe, expect, test } from "bun:test"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
  type SessionHost,
} from "@/kernel/session"
import type { SessionCommand } from "@/protocol/session"
import { SessionProtocolValidationError, SessionRevisionConflictError } from "@/protocol/session"
import { capabilitiesFor } from "../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", transport: "inproc" })
const clock = { now: () => new Date("2026-08-25T00:00:00.000Z") }
const provenance = {
  kind: "goal-continuation" as const,
  objectiveId: "goal-1",
  objectiveRevision: 2,
  attemptId: "host-secret",
}

const submit = (revision: number): SessionCommand => ({
  sessionId: "turn-submit",
  commandId: "submit-1",
  issuedAt: clock.now().toISOString(),
  type: "turn.submit",
  text: "pursue the goal",
  expectedSessionRevision: revision,
  provenance,
})

interface HostOpts {
  /** `"absent"` ⇒ the host does not implement the claim seam at all. */
  readonly claim?: boolean | "absent"
  readonly trace?: string[]
}

/** Emulates the real slot: one claim, taken by runTurn, released only while
 *  still held AND for the same attemptId (the kernel releases in `finally`). */
const claimSeam = (
  opts: HostOpts,
  held: { id: string | undefined },
): Pick<SessionHost, "claimGoalAttempt" | "releaseGoalAttempt"> =>
  opts.claim === "absent"
    ? {}
    : {
        claimGoalAttempt: (attempt) => {
          opts.trace?.push(`claim:${attempt.provenance}:${attempt.attemptId}`)
          if (opts.claim === false) return false
          held.id = attempt.attemptId
          return true
        },
        releaseGoalAttempt: (attemptId) => {
          if (held.id !== attemptId) return
          held.id = undefined
          opts.trace?.push("release")
        },
      }

const host = (prompts: string[], opts: HostOpts = {}): SessionHost => {
  const held: { id: string | undefined } = { id: undefined }
  return {
    describe: () => ({
      sessionId: "turn-submit",
      permissionMode: "default",
      capabilityManifest: manifest,
    }),
    ...claimSeam(opts, held),
    runTurn: async ({ prompt }) => {
      held.id = undefined // the turn-runner takes the claim at turn start
      opts.trace?.push(`run:${prompt}`)
      prompts.push(prompt)
      return {
        outcome: { reason: "completed", turns: 1, messages: [] },
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }] },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      }
    },
    close: async () => undefined,
  }
}

const initialState = () =>
  createKernelSessionState({
    sessionId: "turn-submit",
    permissionMode: "default",
    capabilityManifest: manifest,
  })

describe("GOAL-08 round 3 — the goal claim is made INSIDE the serialized dispatch", () => {
  test("order: guards → capability → claim → runTurn; the claim carries the wire provenance", async () => {
    const prompts: string[] = []
    const trace: string[] = []
    await dispatchSessionCommand(initialState(), submit(0), {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host: host(prompts, { trace }),
      consumeTurnSubmitProvenance: (received) => received.attemptId === "host-secret",
    })
    expect(trace).toEqual(["claim:autonomous-continuation:host-secret", "run:pursue the goal"])
  })

  test("a reducer refusal (stale revision) never reaches the claim", async () => {
    const trace: string[] = []
    await expect(
      dispatchSessionCommand(initialState(), submit(7), {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: host([], { trace }),
        consumeTurnSubmitProvenance: () => true,
      }),
    ).rejects.toBeInstanceOf(SessionRevisionConflictError)
    expect(trace).toEqual([])
  })

  test("a host WITHOUT the claim seam refuses the goal turn typed, after consuming the capability, before any host work", async () => {
    const prompts: string[] = []
    let consumed = 0
    await expect(
      dispatchSessionCommand(initialState(), submit(0), {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: host(prompts, { claim: "absent" }),
        consumeTurnSubmitProvenance: () => {
          consumed += 1
          return true
        },
      }),
    ).rejects.toThrow(/goal_attempt_claim_refused/)
    expect(prompts).toEqual([])
    expect(consumed).toBe(1)
  })

  test("a host that refuses the claim (slot occupied / fail-stopped) refuses the turn before any host work", async () => {
    const prompts: string[] = []
    const trace: string[] = []
    await expect(
      dispatchSessionCommand(initialState(), submit(0), {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: host(prompts, { claim: false, trace }),
        consumeTurnSubmitProvenance: () => true,
      }),
    ).rejects.toThrow(/goal_attempt_claim_refused/)
    expect(prompts).toEqual([])
    expect(trace).toEqual(["claim:autonomous-continuation:host-secret"])
  })

  test("a persistence failure AFTER the claim releases it (no leak into the next attributed turn)", async () => {
    const prompts: string[] = []
    const trace: string[] = []
    const log = new InMemorySessionEventLog()
    const failing = Object.assign(Object.create(Object.getPrototypeOf(log)), log, {
      append: () => {
        throw new Error("disk full")
      },
    }) as InMemorySessionEventLog
    await expect(
      dispatchSessionCommand(initialState(), submit(0), {
        clock,
        eventLog: failing,
        host: host(prompts, { trace }),
        consumeTurnSubmitProvenance: () => true,
      }),
    ).rejects.toThrow(/disk full/)
    expect(prompts).toEqual([])
    expect(trace).toEqual(["claim:autonomous-continuation:host-secret", "release"])
  })

  test("lens 4 — the one-use attemptId never reaches the event stream (raw subscribers cannot replay it)", async () => {
    const result = await dispatchSessionCommand(initialState(), submit(0), {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host: host([]),
      consumeTurnSubmitProvenance: (received) => received.attemptId === "host-secret",
    })
    expect(result.events.length).toBeGreaterThan(0)
    expect(JSON.stringify(result.events)).not.toContain("host-secret")
    expect(JSON.stringify(result.state)).not.toContain("host-secret")
  })

  test("turn.run (a plain user turn) never claims", async () => {
    const trace: string[] = []
    const prompts: string[] = []
    const drafted = await dispatchSessionCommand(
      initialState(),
      {
        sessionId: "turn-submit",
        commandId: "draft",
        issuedAt: clock.now().toISOString(),
        type: "input.append",
        text: "user text",
      },
      { clock, eventLog: new InMemorySessionEventLog(), host: host(prompts, { trace }) },
    )
    await dispatchSessionCommand(
      drafted.state,
      {
        sessionId: "turn-submit",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        type: "turn.run",
      },
      { clock, eventLog: new InMemorySessionEventLog(), host: host(prompts, { trace }) },
    )
    expect(prompts).toEqual(["user text"])
    expect(trace).toEqual(["run:user text"])
  })
})

describe("turn.submit atomic goal continuation", () => {
  test("valid host capability starts one complete turn without a draft append", async () => {
    const prompts: string[] = []
    const result = await dispatchSessionCommand(initialState(), submit(0), {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host: host(prompts),
      consumeTurnSubmitProvenance: (received) => received.attemptId === "host-secret",
    })
    expect(prompts).toEqual(["pursue the goal"])
    expect(result.events.filter((event) => event.type === "turn.started")).toHaveLength(1)
    expect(result.state.draftInput).toBe("")
  })

  test("forged or reused capability rejects before persistence and host work", async () => {
    const prompts: string[] = []
    const log = new InMemorySessionEventLog()
    const state = initialState()
    await expect(
      dispatchSessionCommand(state, submit(0), {
        clock,
        eventLog: log,
        host: host(prompts),
        consumeTurnSubmitProvenance: () => false,
      }),
    ).rejects.toBeInstanceOf(SessionProtocolValidationError)
    expect(log.list()).toEqual([])
    expect(prompts).toEqual([])
    expect(state.revision).toBe(0)
  })

  test("stale revision and a user draft both reject with the draft unchanged", async () => {
    const prompts: string[] = []
    const base = initialState()
    await expect(
      dispatchSessionCommand(base, submit(1), {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: host(prompts),
        consumeTurnSubmitProvenance: () => true,
      }),
    ).rejects.toBeInstanceOf(SessionRevisionConflictError)

    const drafted = await dispatchSessionCommand(
      base,
      {
        sessionId: "turn-submit",
        commandId: "user-append",
        issuedAt: clock.now().toISOString(),
        type: "input.append",
        text: "user text",
      },
      { clock, eventLog: new InMemorySessionEventLog(), host: host(prompts) },
    )
    await expect(
      dispatchSessionCommand(drafted.state, submit(drafted.state.revision), {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: host(prompts),
        consumeTurnSubmitProvenance: () => true,
      }),
    ).rejects.toBeInstanceOf(SessionProtocolValidationError)
    expect(drafted.state.draftInput).toBe("user text")
    expect(prompts).toEqual([])
  })

  test("approval-pending submit is rejected without consuming provenance", async () => {
    const prompts: string[] = []
    const state = {
      ...initialState(),
      status: "awaiting_approval" as const,
      pendingApproval: {
        approvalId: "approval-1",
        reason: "confirm",
        requestedAt: clock.now().toISOString(),
      },
    }
    let consumed = 0
    await expect(
      dispatchSessionCommand(state, submit(0), {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: host(prompts),
        consumeTurnSubmitProvenance: () => {
          consumed += 1
          return true
        },
      }),
    ).rejects.toBeInstanceOf(SessionProtocolValidationError)
    expect(consumed).toBe(0)
    expect(state.pendingApproval?.approvalId).toBe("approval-1")
    expect(prompts).toEqual([])
  })

  test("GOAL-08 rail 2 — the dedicated approval-pending guard refuses even an idle-status state (defence in depth, not the status check)", async () => {
    const prompts: string[] = []
    const state = {
      ...initialState(),
      status: "idle" as const,
      pendingApproval: {
        approvalId: "approval-2",
        reason: "confirm",
        requestedAt: clock.now().toISOString(),
      },
    }
    let consumed = 0
    await expect(
      dispatchSessionCommand(state, submit(0), {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host: host(prompts),
        consumeTurnSubmitProvenance: () => {
          consumed += 1
          return true
        },
      }),
    ).rejects.toThrow(/turn_submit_approval_pending/)
    expect(consumed).toBe(0)
    expect(prompts).toEqual([])
  })
})
