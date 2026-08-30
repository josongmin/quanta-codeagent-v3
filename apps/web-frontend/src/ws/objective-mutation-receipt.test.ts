import { describe, expect, it, vi } from "vitest"
import type { SessionEvent, SessionRejectedFrame } from "../types/protocol"
import type { SessionClient } from "./client"
import { sendObjectiveMutation } from "./session-hooks"

const event = (commandId: string): SessionEvent =>
  ({ type: "session.state.updated", causedByCommandId: commandId }) as SessionEvent

const harness = (delivered = true) => {
  let onEvent: ((event: SessionEvent) => void) | undefined
  let onRejected: ((frame: SessionRejectedFrame) => void) | undefined
  const sent: unknown[] = []
  const unsubs = { events: vi.fn(), rejected: vi.fn() }
  const client = {
    onAny: (handler: (event: SessionEvent) => void) => {
      onEvent = handler
      return unsubs.events
    },
    onRejected: (handler: (frame: SessionRejectedFrame) => void) => {
      onRejected = handler
      return unsubs.rejected
    },
    send: (command: unknown) => {
      sent.push(command)
      return delivered
    },
  } as unknown as SessionClient
  return {
    client,
    sent,
    unsubs,
    emitEvent: (value: SessionEvent) => onEvent?.(value),
    emitRejected: (value: SessionRejectedFrame) => onRejected?.(value),
  }
}

describe("objective mutation command receipt", () => {
  it("sends viewed-revision CAS and resolves only its matching state event", async () => {
    const h = harness()
    const pending = sendObjectiveMutation(h.client, "s1", { kind: "clear" }, 17, {
      makeCommandId: () => "cmd-owned",
      timeoutMs: 500,
    })
    h.emitEvent(event("cmd-unrelated"))
    h.emitRejected({ target: "command", reason: "duplicate_command", commandId: "cmd-other" })
    h.emitEvent(event("cmd-owned"))

    await expect(pending).resolves.toEqual({ kind: "applied", commandId: "cmd-owned" })
    expect(h.sent[0]).toMatchObject({
      commandId: "cmd-owned",
      expectedObjectiveRevision: 17,
      mutation: { kind: "clear" },
    })
    expect(h.unsubs.events).toHaveBeenCalledOnce()
    expect(h.unsubs.rejected).toHaveBeenCalledOnce()
  })

  it("returns the correlated rejection without waiting for coincidental state", async () => {
    const h = harness()
    const pending = sendObjectiveMutation(h.client, "s1", { kind: "clear" }, 4, {
      makeCommandId: () => "cmd-rejected",
      timeoutMs: 500,
    })
    const frame: SessionRejectedFrame = {
      target: "command",
      reason: "protocol_validation",
      commandId: "cmd-rejected",
      issue: "objective:stale-revision",
    }
    h.emitRejected(frame)
    h.emitEvent(event("cmd-rejected"))
    await expect(pending).resolves.toEqual({ kind: "rejected", commandId: "cmd-rejected", frame })
  })

  it("closed/pre-handshake/send-throw truth returns undelivered immediately", async () => {
    const h = harness(false)
    await expect(
      sendObjectiveMutation(h.client, "s1", { kind: "clear" }, 1, {
        makeCommandId: () => "cmd-drop",
      }),
    ).resolves.toEqual({ kind: "undelivered" })
    expect(h.unsubs.events).toHaveBeenCalledOnce()
    expect(h.unsubs.rejected).toHaveBeenCalledOnce()
  })
})
