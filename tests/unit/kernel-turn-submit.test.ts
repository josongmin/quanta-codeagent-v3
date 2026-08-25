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

const host = (prompts: string[]): SessionHost => ({
  describe: () => ({
    sessionId: "turn-submit",
    permissionMode: "default",
    capabilityManifest: manifest,
  }),
  runTurn: async ({ prompt }) => {
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
})

const initialState = () =>
  createKernelSessionState({
    sessionId: "turn-submit",
    permissionMode: "default",
    capabilityManifest: manifest,
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
})
