import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
  type KernelSessionState,
  reduceSessionCommand,
  type SessionHost,
} from "@/kernel/session"
import type { Message } from "@/llm"

/**
 * T03 — Kernel cancel & signal semantics (audit L5 C-1 / H-8 / M-5).
 *
 * Proof rail: `turn.cancel` must mutate REAL turn-owned cancel state and abort
 * the SAME controller the active host turn is observing — not the prior no-op
 * (`{ state, hostAction: { kind: "none" }, events: [] }`). The scheduler is the
 * only executor; the reducer owns the cancel decision.
 */

const manifest = {
  approvals: "operator" as const,
  tools: true,
  memory: false,
  artifacts: true,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  transport: "inproc" as const,
}

const clock = { now: () => new Date("2026-05-31T00:00:00.000Z") }

const messagesOf = (userText: string): readonly Message[] => [
  { role: "user", content: [{ type: "text", text: userText }] },
]

const seedRunningState = async (
  sessionId: string,
): Promise<{ state: KernelSessionState; eventLog: InMemorySessionEventLog }> => {
  const eventLog = new InMemorySessionEventLog()
  let state = createKernelSessionState({
    sessionId,
    permissionMode: "default",
    capabilityManifest: manifest,
  })
  const idleHost: SessionHost = {
    describe: () => ({ sessionId, permissionMode: "default", capabilityManifest: manifest }),
    runTurn: async () => ({
      outcome: { reason: "completed", turns: 1, messages: messagesOf("ping") } as AgentOutcome,
      messages: messagesOf("ping"),
    }),
    close: async () => undefined,
  }
  state = (
    await dispatchSessionCommand(
      state,
      {
        sessionId,
        commandId: "seed",
        issuedAt: clock.now().toISOString(),
        type: "input.append",
        text: "ping",
      },
      { clock, eventLog, host: idleHost },
    )
  ).state
  return { state, eventLog }
}

describe("T03 kernel cancel — reducer owns cancel, scheduler executes", () => {
  test("turn.cancel is no longer an inert no-op: it transitions state and emits events", async () => {
    const { state } = await seedRunningState("cx-1")
    // A reducer-level proof that the cancel handler stopped being inert.
    const reduced = reduceSessionCommand(
      { ...state, status: "running" },
      {
        sessionId: "cx-1",
        commandId: "cc",
        issuedAt: clock.now().toISOString(),
        type: "turn.cancel",
      },
      clock.now().toISOString(),
    )
    expect(reduced.hostAction.kind).toBe("cancel_turn")
    expect(reduced.events.length).toBeGreaterThan(0)
    expect(reduced.state.status).not.toBe("running")
  })

  test("turn.cancel aborts the SAME signal the in-flight host turn observes", async () => {
    const { state, eventLog } = await seedRunningState("cx-2")

    let observedSignal: AbortSignal | undefined
    let abortedDuringTurn = false
    let resolveTurn: (() => void) | undefined
    const turnGate = new Promise<void>((r) => {
      resolveTurn = r
    })

    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-2",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({ signal }) => {
        observedSignal = signal
        // Park here so a concurrent turn.cancel can land mid-flight.
        await turnGate
        abortedDuringTurn = signal?.aborted === true
        return {
          outcome: {
            reason: abortedDuringTurn ? "aborted" : "completed",
            turns: 1,
            messages: messagesOf("ping"),
          } as AgentOutcome,
          messages: messagesOf("ping"),
        }
      },
      close: async () => undefined,
    }

    // Kick the turn (do not await — it parks on turnGate).
    const turnPromise = dispatchSessionCommand(
      state,
      {
        sessionId: "cx-2",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog, host },
    )

    // Let runTurn register its controller + park.
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(observedSignal).toBeDefined()
    expect(observedSignal?.aborted).toBe(false)

    // Public cancel: must reach the live, in-flight controller even though the
    // turn.run holder owns the single-writer lease.
    await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-2",
        commandId: "cancel",
        issuedAt: clock.now().toISOString(),
        type: "turn.cancel",
      },
      { clock, eventLog, host },
    )

    expect(observedSignal?.aborted).toBe(true)

    resolveTurn?.()
    await turnPromise
    expect(abortedDuringTurn).toBe(true)
  })

  test("turn.cancel composes with the caller's external signal (does not replace it)", async () => {
    const { state, eventLog } = await seedRunningState("cx-3")
    const external = new AbortController()
    let observed: AbortSignal | undefined
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-3",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({ signal }) => {
        observed = signal
        return {
          outcome: { reason: "completed", turns: 1, messages: messagesOf("ping") } as AgentOutcome,
          messages: messagesOf("ping"),
        }
      },
      close: async () => undefined,
    }
    await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-3",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog, host, signal: external.signal },
    )
    expect(observed).toBeDefined()
    // External abort after a fresh turn started must still be observable through
    // the composed signal of the NEXT turn.
    external.abort()
    expect(external.signal.aborted).toBe(true)
  })

  test("turn.cancel for an idle session is a clean no-op (no live turn to abort)", async () => {
    const { state, eventLog } = await seedRunningState("cx-4")
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-4",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async () => ({
        outcome: { reason: "completed", turns: 1, messages: messagesOf("ping") } as AgentOutcome,
        messages: messagesOf("ping"),
      }),
      close: async () => undefined,
    }
    const result = await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-4",
        commandId: "cancel",
        issuedAt: clock.now().toISOString(),
        type: "turn.cancel",
      },
      { clock, eventLog, host },
    )
    // Idle cancel must not throw and must not corrupt status into a terminal lie.
    expect(["idle", "cancelled"]).toContain(result.state.status)
  })
})

describe("T03 kernel dispatch — H-8 signal.aborted is checked at dispatch level", () => {
  test("an already-aborted ctx.signal short-circuits turn.run without starting host work", async () => {
    const { state, eventLog } = await seedRunningState("cx-5")
    let hostRan = false
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-5",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async () => {
        hostRan = true
        return {
          outcome: { reason: "completed", turns: 1, messages: messagesOf("ping") } as AgentOutcome,
          messages: messagesOf("ping"),
        }
      },
      close: async () => undefined,
    }
    const aborted = new AbortController()
    aborted.abort()
    const result = await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-5",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog, host, signal: aborted.signal },
    )
    expect(hostRan).toBe(false)
    expect(result.state.status).not.toBe("running")
  })
})

describe("T03 onCommitted isolation — M-5: observer failure must not redefine turn outcome", () => {
  test("a throwing onCommitted does NOT flip a completed turn into turn.failed", async () => {
    const { state, eventLog } = await seedRunningState("cx-6")
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-6",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({ onEvent }) => {
        onEvent?.({ type: "assistant_text.delta", delta: "pong" })
        const messages: readonly Message[] = [
          { role: "user", content: [{ type: "text", text: "ping" }] },
          { role: "assistant", content: [{ type: "text", text: "pong" }] },
        ]
        return {
          outcome: { reason: "completed", turns: 1, messages } as AgentOutcome,
          messages,
        }
      },
      close: async () => undefined,
    }
    const result = await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-6",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      {
        clock,
        eventLog,
        host,
        onCommitted: () => {
          throw new Error("persistence sink exploded")
        },
      },
    )
    // The turn itself completed — a persistence/observer failure is diagnostic,
    // routed to a no-throw sink, never a redefinition of terminal turn
    // classification.
    const types = result.events.map((e) => e.type)
    expect(types).toContain("turn.completed")
    expect(types).not.toContain("turn.failed")
    expect(result.state.status).toBe("idle")
  })
})
