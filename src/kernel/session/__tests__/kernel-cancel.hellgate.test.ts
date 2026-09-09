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
  // ADR-0540 W1-B — additive capability marker (kernel-inert here).
  serverAutoContinues: false,
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
    let observedTurnId: string | undefined
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
      runTurn: async ({ signal, turnId }) => {
        observedSignal = signal
        observedTurnId = turnId
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
    expect(observedTurnId).toBe("run")
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
    expect(result.state.lastOutcomeReason).toBe("aborted")
    // STRENGTHENED (mutation-check blind-spot fix): `hostRan === false` alone is
    // a DEFENCE-IN-DEPTH tautology — there is a SECOND, inner abort gate inside
    // `runTurn` (it short-circuits an already-aborted turn controller before the
    // host starts), so reverting the DISPATCH-level gate (the headline H-8 fix)
    // still left this case green via the inner fallback. We now pin the
    // DISPATCH gate specifically: it settles the turn WITHOUT ever entering the
    // turn lifecycle, so the event log carries ONLY a `session.state.updated`
    // echo — no `turn.started` (the reducer's turn.run immediate event) and no
    // `turn.failed` (which the inner `onTurnAborted` fallback emits). If the
    // dispatch gate is removed, `turn.run` reduces + falls to `onTurnAborted`,
    // injecting `turn.started`/`turn.failed` and turning this RED.
    const emittedTypes = result.events.map((e) => e.type)
    expect(emittedTypes).not.toContain("turn.started")
    expect(emittedTypes).not.toContain("turn.failed")
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

describe("ALBB-04 single-classifier — return-aborted and throw-abort settle to ONE cancel terminal type", () => {
  // The dedicated cancel terminal wire type. Both a host that RETURNS
  // `outcome.reason === "aborted"` and a host that THROWS an abort must settle
  // through it — distinct from BOTH `turn.completed` (success) and `turn.failed`
  // (error). Pinning the exact string here is the SSOT for the test's intent.
  const CANCEL_TERMINAL_TYPE = "turn.aborted"

  test("(a) return-aborted host emits the cancel terminal type, NOT turn.completed", async () => {
    const { state, eventLog } = await seedRunningState("cx-ra")
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-ra",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      // Cooperative cancel: the host RETURNS aborted WITHOUT throwing.
      runTurn: async () => ({
        outcome: { reason: "aborted", turns: 1, messages: messagesOf("ping") } as AgentOutcome,
        messages: messagesOf("ping"),
      }),
      close: async () => undefined,
    }
    const result = await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-ra",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog, host },
    )
    const types = result.events.map((e) => e.type)
    // The buggy pre-fix code routes return-aborted to `onTurnCompleted` and emits
    // `turn.completed` — this assertion is RED until the success arm is fixed.
    expect(types).toContain(CANCEL_TERMINAL_TYPE)
    expect(types).not.toContain("turn.completed")
    expect(types).not.toContain("turn.failed")
    expect(result.state.status).toBe("idle")
    expect(result.state.lastOutcomeReason).toBe("aborted")
  })

  test("(a') throw-abort host emits the SAME cancel terminal type (single-classifier convergence)", async () => {
    const { state, eventLog } = await seedRunningState("cx-ta")
    let resolveTurn: (() => void) | undefined
    const turnGate = new Promise<void>((r) => {
      resolveTurn = r
    })
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-ta",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      // Mid-flight cancel via THROW: park, get aborted by turn.cancel, then throw
      // the abort reason (mirrors a real host tearing down on signal abort).
      runTurn: async ({ signal }) => {
        await turnGate
        const reason = signal?.reason ?? new DOMException("aborted", "AbortError")
        throw reason
      },
      close: async () => undefined,
    }
    const turnPromise = dispatchSessionCommand(
      state,
      {
        sessionId: "cx-ta",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog, host },
    )
    await new Promise<void>((r) => setTimeout(r, 5))
    await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-ta",
        commandId: "cancel",
        issuedAt: clock.now().toISOString(),
        type: "turn.cancel",
      },
      { clock, eventLog, host },
    )
    resolveTurn?.()
    const result = await turnPromise
    const types = result.events.map((e) => e.type)
    // Both cancel entry points converge on the SAME dedicated terminal type.
    expect(types).toContain(CANCEL_TERMINAL_TYPE)
    expect(types).not.toContain("turn.completed")
    expect(types).not.toContain("turn.failed")
    expect(result.state.status).toBe("idle")
    expect(result.state.lastOutcomeReason).toBe("aborted")
  })
})

describe("ALBB-04 P2 regression — return-aborted must SETTLE accumulated state (messages + draft)", () => {
  // A cooperative RETURN-abort (host RETURNS `outcome.reason === "aborted"` WITH
  // accumulated messages — e.g. a budget/deadline abort that still surfaces
  // output, NOT a throw) must commit those messages into kernel state and clear
  // the turn-seeding draft, EXACTLY like `onTurnCompleted` does — while STILL
  // emitting the distinct `turn.aborted` terminal. The pre-fix `onTurnAborted`
  // merely spread the PRE-turn `args.state`, silently DISCARDING `result.messages`
  // and leaving the stale `draftInput`/`draftImages` lingering.
  test("(c) return-aborted commits result.messages, clears draftInput, and still emits turn.aborted", async () => {
    const { state, eventLog } = await seedRunningState("cx-settle")
    // The NEW assistant message the aborted turn surfaced — it must land in state.
    const surfacedMessages: readonly Message[] = [
      { role: "user", content: [{ type: "text", text: "ping" }] },
      { role: "assistant", content: [{ type: "text", text: "partial-before-abort" }] },
    ]
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-settle",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      // Cooperative deadline/budget abort: RETURNS aborted WITH accumulated output.
      runTurn: async () => ({
        outcome: {
          reason: "aborted",
          turns: 1,
          messages: surfacedMessages,
        } as AgentOutcome,
        messages: surfacedMessages,
      }),
      close: async () => undefined,
    }
    // Sanity: the running state carries a non-empty draft (the turn-seeding input)
    // that a correct settlement must CLEAR — otherwise the draft-clear assertion
    // would be vacuously satisfiable.
    expect(state.draftInput).toBe("ping")

    const result = await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-settle",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog, host },
    )

    // (i) The accumulated assistant message is COMMITTED into kernel state — NOT
    // silently discarded back to the pre-turn message set.
    const hasSurfacedAssistant = result.state.messages.some(
      (m) => m.role === "assistant" && JSON.stringify(m.content).includes("partial-before-abort"),
    )
    expect(hasSurfacedAssistant).toBe(true)
    // (ii) The turn-seeding draft is CLEARED (no stale draft lingering).
    expect(result.state.draftInput).toBe("")
    expect(result.state.draftImages).toEqual([])
    // (iii) The distinct cancel terminal is STILL emitted (ALBB-04 wire-shape kept).
    const types = result.events.map((e) => e.type)
    expect(types).toContain("turn.aborted")
    expect(types).not.toContain("turn.completed")
    expect(types).not.toContain("turn.failed")
    expect(result.state.status).toBe("idle")
    expect(result.state.lastOutcomeReason).toBe("aborted")
    // (iv) The transcript reflects the surfaced messages (not the pre-turn one).
    expect(result.transcriptMessages).toBeDefined()
    expect(result.transcriptMessages?.some((m) => m.role === "assistant")).toBe(true)
  })

  test("(d) RACED completed+aborted — a host RETURNING completed while the signal fired mid-turn routes to turn.completed (NOT the cancel terminal), committing its messages", async () => {
    // classifyTerminal was narrowed to key ONLY on `outcome.reason === "aborted"`
    // (dropping the `|| args.aborted` disjunction). This pins that narrowing: a
    // turn whose signal aborts mid-flight but whose host still RETURNS
    // `reason:"completed"` (a normal completion racing a late abort) must settle
    // as a COMPLETION — commit its messages, emit turn.completed — NOT be
    // re-routed to the cancel terminal (which would DISCARD the messages).
    // RED-on-injection: restoring `|| args.aborted` re-routes this to
    // onTurnAborted ⇒ `turn.completed` absent + surfaced message lost.
    const { state, eventLog } = await seedRunningState("cx-raced")
    const surfacedMessages: readonly Message[] = [
      { role: "user", content: [{ type: "text", text: "ping" }] },
      { role: "assistant", content: [{ type: "text", text: "completed-despite-race" }] },
    ]
    let resolveTurn: (() => void) | undefined
    const turnGate = new Promise<void>((r) => {
      resolveTurn = r
    })
    let observedSignal: AbortSignal | undefined
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-raced",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({ signal }) => {
        observedSignal = signal
        await turnGate // park so a concurrent cancel aborts the signal mid-flight
        // The agent loop already produced a COMPLETED result before the abort
        // landed — the host surfaces it verbatim (reason stays "completed").
        return {
          outcome: {
            reason: "completed",
            turns: 1,
            messages: surfacedMessages,
          } as AgentOutcome,
          messages: surfacedMessages,
        }
      },
      close: async () => undefined,
    }

    const turnPromise = dispatchSessionCommand(
      state,
      {
        sessionId: "cx-raced",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog, host },
    )
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(observedSignal?.aborted).toBe(false)
    // Abort the in-flight signal mid-turn (the "race").
    await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-raced",
        commandId: "cancel",
        issuedAt: clock.now().toISOString(),
        type: "turn.cancel",
      },
      { clock, eventLog, host },
    )
    expect(observedSignal?.aborted).toBe(true)
    resolveTurn?.()
    const result = await turnPromise

    // Narrowed classifier: reason "completed" wins over the raced abort.
    const types = result.events.map((e) => e.type)
    expect(types).toContain("turn.completed")
    expect(types).not.toContain("turn.aborted")
    expect(result.state.lastOutcomeReason).toBe("completed")
    // The completed turn's messages are COMMITTED (not discarded by a cancel route).
    const hasSurfaced = result.state.messages.some(
      (m) => m.role === "assistant" && JSON.stringify(m.content).includes("completed-despite-race"),
    )
    expect(hasSurfaced).toBe(true)
  })

  test("(c') throw-abort path (no messages) stays correct — no message loss, distinct terminal", async () => {
    // The throw-abort path carries NO result.messages, so there is nothing to
    // lose. It must remain a clean `turn.aborted` that PRESERVES the pre-turn
    // messages (here the seeded single user msg) without inventing any.
    const { state, eventLog } = await seedRunningState("cx-throw-abort")
    let resolveTurn: (() => void) | undefined
    const turnGate = new Promise<void>((r) => {
      resolveTurn = r
    })
    const preTurnMessageCount = state.messages.length
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-throw-abort",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({ signal }) => {
        await turnGate
        throw signal?.reason ?? new DOMException("aborted", "AbortError")
      },
      close: async () => undefined,
    }
    const turnPromise = dispatchSessionCommand(
      state,
      {
        sessionId: "cx-throw-abort",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog, host },
    )
    await new Promise<void>((r) => setTimeout(r, 5))
    await dispatchSessionCommand(
      state,
      {
        sessionId: "cx-throw-abort",
        commandId: "cancel",
        issuedAt: clock.now().toISOString(),
        type: "turn.cancel",
      },
      { clock, eventLog, host },
    )
    resolveTurn?.()
    const result = await turnPromise
    const types = result.events.map((e) => e.type)
    expect(types).toContain("turn.aborted")
    expect(types).not.toContain("turn.failed")
    // No messages were surfaced by the throw path — the pre-turn messages are
    // preserved verbatim (no loss, no invention).
    expect(result.state.messages.length).toBe(preTurnMessageCount)
    expect(result.state.status).toBe("idle")
    expect(result.state.lastOutcomeReason).toBe("aborted")
  })
})

describe("ALBB-04 append-failure isolation — persistence failure must not drop events or flip outcome", () => {
  test("(b) an eventLog.append rejection mid-stream keeps status idle, keeps turn.completed, and later appends are still attempted", async () => {
    const { state } = await seedRunningState("cx-append")
    // Fresh log so we count appends deterministically from the turn.run onward.
    const inner = new InMemorySessionEventLog()
    // Reject the SECOND append (mid-stream) — the first stream event's append —
    // then let every later append (the second stream event + terminal events)
    // proceed. We count total append attempts to prove the chain was not poisoned.
    let appendCalls = 0
    let rejectedIndex = -1
    // The rejecting index is the 2nd append after turn.run's immediate events.
    // turn.run emits immediate events (turn.started + state.updated) via appendEvents,
    // then each stream event appends one-by-one. We reject the append at the point
    // where the FIRST stream event is persisted, and require the SECOND stream
    // event's append to STILL be attempted afterward.
    const REJECT_ON = 3 // immediate(2 appends: started+updated) then 1st stream = 3rd call
    const failingLog = {
      async append(event: Parameters<InMemorySessionEventLog["append"]>[0]): Promise<void> {
        appendCalls += 1
        if (appendCalls === REJECT_ON) {
          rejectedIndex = appendCalls
          throw new Error("event log append exploded (persistence-only failure)")
        }
        inner.append(event)
      },
      list: () => inner.list(),
    }
    const host: SessionHost = {
      describe: () => ({
        sessionId: "cx-append",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      // Emit TWO stream events, then RETURN completed (host-successful work).
      runTurn: async ({ onEvent }) => {
        onEvent?.({ type: "assistant_text.delta", delta: "po" })
        onEvent?.({ type: "assistant_text.delta", delta: "ng" })
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
        sessionId: "cx-append",
        commandId: "run",
        issuedAt: clock.now().toISOString(),
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock, eventLog: failingLog, host },
    )
    // (i) A persistence-only failure is diagnostic — the host-successful turn is
    // NOT reclassified to failed. Terminal remains turn.completed, status idle.
    const types = result.events.map((e) => e.type)
    expect(result.state.status).toBe("idle")
    expect(types).toContain("turn.completed")
    expect(types).not.toContain("turn.failed")
    // (ii) The chain was NOT poisoned: the append that rejected fired, AND a LATER
    // append (the 2nd stream event / terminal events) was still ATTEMPTED — i.e.
    // total append attempts advanced well past the rejecting index.
    expect(rejectedIndex).toBe(REJECT_ON)
    expect(appendCalls).toBeGreaterThan(REJECT_ON)
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
