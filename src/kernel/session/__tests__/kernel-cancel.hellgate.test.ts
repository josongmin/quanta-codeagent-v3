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
    // Audit R1 W1: this used to be tautological — it only asserted
    // `external.signal.aborted === true` after calling `external.abort()`, which
    // proves nothing about COMPOSITION. We now park the host turn on a gate,
    // capture the exact signal handed to `host.runTurn`, abort the EXTERNAL
    // controller MID-FLIGHT, and prove the captured host signal flips to aborted
    // — i.e. the caller's signal is genuinely composed into the turn-owned one,
    // not merely held by the caller. Mirrors the cancel-propagation case but
    // drives the EXTERNAL source instead of `turn.cancel`.
    const { state, eventLog } = await seedRunningState("cx-3")
    const external = new AbortController()

    let observed: AbortSignal | undefined
    let abortedDuringTurn = false
    let resolveTurn: (() => void) | undefined
    const turnGate = new Promise<void>((r) => {
      resolveTurn = r
    })

    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-3",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({ signal }) => {
        observed = signal
        // Park so the external abort can land while this turn is in flight.
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

    // Kick the turn with the caller's external signal (do not await — it parks).
    const turnPromise = dispatchSessionCommand(
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

    // Let runTurn capture the composed signal + park.
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(observed).toBeDefined()
    expect(observed?.aborted).toBe(false)

    // Drive the EXTERNAL source mid-flight: the composed signal the host already
    // holds must flip to aborted (composition, not replacement).
    external.abort()
    expect(observed?.aborted).toBe(true)

    resolveTurn?.()
    const result = await turnPromise
    expect(abortedDuringTurn).toBe(true)
    expect(result.state.lastOutcomeReason).toBe("aborted")
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

describe("T03 controller-registration window — R2 H1: turn.cancel lands BEFORE host start", () => {
  test("turn.cancel during the pre-host event-log-write window reaches the live controller and settles aborted", async () => {
    // Audit R2 H1: a `turn.run` now PRE-REGISTERS its AbortController in
    // `activeTurnControllers` BEFORE the awaited `appendEvents`/`notifyCommitted`,
    // and `runTurn` short-circuits to aborted if that controller is already
    // aborted before the host starts. Under the OLD order (register only AFTER
    // those awaits) a `turn.cancel` dispatched in this window found NO controller,
    // fell through to `lease.runWith`, and threw `SessionSingleWriterLeaseError`
    // while the turn ran uncancelled.
    //
    // We reproduce the WINDOW by making the FIRST append AFTER seeding artificially
    // slow (~30ms), starting a `turn.run` (not awaited), then dispatching
    // `turn.cancel` after only ~5ms — i.e. INSIDE the slow append, before the host
    // is ever invoked. (The H-8 test deliberately sleeps 5ms to STEP OVER this
    // window so the controller is already adopted by the parked host; this one must
    // land while the dispatch arm is still awaiting the immediate-events append.)
    const inner = new InMemorySessionEventLog()
    let armed = false
    const slowFirstAppendLog = {
      async append(event: Parameters<InMemorySessionEventLog["append"]>[0]): Promise<void> {
        if (armed) {
          // Delay only the first armed append — this is the dispatch arm's
          // immediate-events write, the exact window the cancel must hit.
          armed = false
          await new Promise<void>((r) => setTimeout(r, 30))
        }
        inner.append(event)
      },
      list: () => inner.list(),
    }

    // Seed against the same inner log so transcript/seq stay consistent, then arm.
    const eventLog = new InMemorySessionEventLog()
    let state = createKernelSessionState({
      sessionId: "cx-win",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    let hostRan = false
    const idleHost: SessionHost = {
      describe: () => ({
        sessionId: "cx-win",
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
    state = (
      await dispatchSessionCommand(
        state,
        {
          sessionId: "cx-win",
          commandId: "seed",
          issuedAt: clock.now().toISOString(),
          type: "input.append",
          text: "ping",
        },
        { clock, eventLog, host: idleHost },
      )
    ).state

    // Arm the slow first append: the NEXT append (turn.run's immediate events) is
    // delayed ~30ms, opening the controller-registration window.
    armed = true
    const turnPromise = dispatchSessionCommand(
      state,
      {
        sessionId: "cx-win",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog: slowFirstAppendLog, host: idleHost },
    )

    // Land the cancel INSIDE the window: 5ms << the 30ms append delay, so the
    // dispatch arm is still awaiting the immediate-events append and the host has
    // not started — yet the controller is already pre-registered.
    await new Promise<void>((r) => setTimeout(r, 5))
    const cancelPromise = dispatchSessionCommand(
      state,
      {
        sessionId: "cx-win",
        commandId: "cancel",
        issuedAt: clock.now().toISOString(),
        type: "turn.cancel",
      },
      { clock, eventLog: slowFirstAppendLog, host: idleHost },
    )

    // (a) The window cancel must NOT throw (no SessionSingleWriterLeaseError):
    // it takes the live-controller fast-path, never contends on the held lease.
    await expect(cancelPromise).resolves.toBeDefined()

    // (b) The turn settles aborted: host work either never ran or was torn down.
    const result = await turnPromise
    expect(hostRan).toBe(false)
    expect(result.state.status).not.toBe("running")
    expect(result.state.status).toBe("idle")
    expect(result.state.lastOutcomeReason).toBe("aborted")
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
