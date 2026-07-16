import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
} from "@/kernel/session"

const manifest = {
  approvals: "operator" as const,
  tools: true,
  memory: false,
  artifacts: true,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  serverAutoContinues: false,
  transport: "inproc" as const,
}

const makeOutcome = (reason: AgentOutcome["reason"]) =>
  ({
    reason,
    turns: 1,
    messages: [
      { role: "user", content: [{ type: "text", text: "ping" }] },
      { role: "assistant", content: [{ type: "text", text: "pong" }] },
    ],
  }) as AgentOutcome

const fixedClock = {
  now: () => new Date("2026-05-26T00:00:00.000Z"),
}

describe("kernel single-writer lease", () => {
  test("rejects concurrent commands against the same state authority and releases after completion", async () => {
    let releaseTurn!: () => void
    let markStarted!: () => void
    const turnStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })

    let state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const eventLog = new InMemorySessionEventLog()
    // Faithful posture-SSOT host: `dispatchSessionCommand` applies a
    // `session.identity.set` by calling `host.setIdentityMode(mode)` and then
    // RECONCILING the kernel state from `host.describe()` (the host owns runtime
    // posture; the reducer's optimistic value is overwritten by the reconcile).
    // The mock must therefore track the mode through that roundtrip, or the
    // reconcile strips identityMode back to undefined.
    let hostIdentityMode: string | undefined
    const host = {
      describe: () => ({
        sessionId: "s1",
        permissionMode: "default",
        ...(hostIdentityMode !== undefined ? { identityMode: hostIdentityMode } : {}),
        capabilityManifest: manifest,
      }),
      setIdentityMode: async (mode: string) => {
        hostIdentityMode = mode
      },
      runTurn: async () => {
        markStarted()
        await turnGate
        return { outcome: makeOutcome("completed"), messages: makeOutcome("completed").messages }
      },
      close: async () => undefined,
    }

    state = (
      await dispatchSessionCommand(
        state,
        {
          sessionId: "s1",
          commandId: "c1",
          issuedAt: "2026-05-26T00:00:00.000Z",
          type: "input.append",
          text: "ping",
        },
        { clock: fixedClock, eventLog, host },
      )
    ).state

    const inFlight = dispatchSessionCommand(
      state,
      {
        sessionId: "s1",
        commandId: "c2",
        issuedAt: "2026-05-26T00:00:01.000Z",
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock: fixedClock, eventLog, host },
    )

    await turnStarted

    await expect(
      dispatchSessionCommand(
        state,
        {
          sessionId: "s1",
          commandId: "c3",
          issuedAt: "2026-05-26T00:00:02.000Z",
          type: "session.identity.set",
          mode: "review",
        },
        { clock: fixedClock, eventLog, host },
      ),
    ).rejects.toMatchObject({ issue: "single_writer_lease_held" })

    expect(state.lease.currentHolder()).toBe("c2")

    releaseTurn()
    const completed = await inFlight

    expect(completed.state.lease.currentHolder()).toBeUndefined()

    const next = await dispatchSessionCommand(
      completed.state,
      {
        sessionId: "s1",
        commandId: "c4",
        issuedAt: "2026-05-26T00:00:03.000Z",
        expectedRevision: completed.state.revision,
        type: "session.identity.set",
        mode: "review",
      },
      { clock: fixedClock, eventLog, host },
    )

    expect(next.state.identityMode).toBe("review")
    expect(next.state.lease.currentHolder()).toBeUndefined()
  })
})
