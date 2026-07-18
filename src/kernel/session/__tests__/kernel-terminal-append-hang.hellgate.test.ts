import { afterEach, describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  getKernelTerminalAppendFailures,
  InMemorySessionEventLog,
  type KernelDispatchContext,
  type KernelEventLogPort,
  type KernelSessionState,
  type SessionHost,
  setKernelTerminalAppendErrorSink,
} from "@/kernel/session"
import type { Message } from "@/llm"
import type { SessionEvent } from "@/protocol/session"

/**
 * B1 (jul-18 release-blocker) — durable-eventlog TERMINAL-append hang.
 *
 * γ repro: with a durable event log (QUANTA_SESSION_EVENT_LOG_DIR) ON, a turn's
 * TERMINAL append (`appendEvents(completionEvents)` and its abort/fail/errored
 * siblings) that throws on a full disk (ENOSPC) / read-only dir previously
 * propagated OUT of `dispatchSessionCommand` BEFORE the engine could publish the
 * terminal events. Result: the completed turn (LLM cost already spent) is
 * silently lost, and a wire client's `awaitTurnEnd()` hangs forever.
 *
 * INVARIANT under test: a turn's terminal event is ALWAYS RETURNED by
 * `dispatchSessionCommand` (so the engine's `publishPendingEvents` delivers it
 * to the subscriber/bridge and `awaitTurnEnd` settles) regardless of whether the
 * durable persist succeeded — AND the persistence failure is surfaced
 * (diagnostic sink + `terminalAppendFailures` counter), never silently swallowed.
 *
 * The ALBB-04 STREAM path was already isolated; this pins the TERMINAL path,
 * which the ALBB-04 test (which only fails a MID-STREAM append, letting the
 * terminal append succeed) never exercised.
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
  serverAutoContinues: false,
}

const clock = { now: () => new Date("2026-07-18T00:00:00.000Z") }

const messagesOf = (userText: string): readonly Message[] => [
  { role: "user", content: [{ type: "text", text: userText }] },
]

/** A durable-log stand-in: it is an InMemory log whose `append` throws once the
 *  configured predicate matches, modelling a disk that fills up (ENOSPC) at an
 *  arbitrary point. `list()` still reflects the successful appends so the seq
 *  bookkeeping is realistic. */
const makeFlakyLog = (
  shouldThrow: (event: SessionEvent, callIndex: number) => boolean,
): { log: KernelEventLogPort; appendCalls: () => number; throwCount: () => number } => {
  const inner = new InMemorySessionEventLog()
  let calls = 0
  let thrown = 0
  return {
    log: {
      append(event: SessionEvent): void {
        calls += 1
        if (shouldThrow(event, calls)) {
          thrown += 1
          throw new Error(`ENOSPC: no space left on device (append #${calls}, ${event.type})`)
        }
        inner.append(event)
      },
      list: () => inner.list(),
    },
    appendCalls: () => calls,
    throwCount: () => thrown,
  }
}

const seedRunningState = async (
  sessionId: string,
  log: KernelEventLogPort,
): Promise<KernelSessionState> => {
  let state = createKernelSessionState({
    sessionId,
    permissionMode: "default",
    capabilityManifest: manifest,
  })
  const idleHost: SessionHost = {
    describe: () => ({ sessionId, permissionMode: "default", capabilityManifest: manifest }),
    runTurn: async () => ({
      outcome: { reason: "completed", turns: 1, messages: messagesOf("seed") } as AgentOutcome,
      messages: messagesOf("seed"),
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
      { clock, eventLog: log, host: idleHost },
    )
  ).state
  return state
}

const turnRunCommand = (sessionId: string, revision: number) =>
  ({
    sessionId,
    commandId: "run",
    issuedAt: clock.now().toISOString(),
    expectedRevision: revision,
    type: "turn.run" as const,
  }) as const

/** A dispatch whose SUBSCRIBER publish is wired via `onCommitted`, and which
 *  ALSO records every terminal event the engine would publish via the RETURN
 *  value (`result.events`). This mirrors the real engine: stream events flow
 *  through `onCommitted`, terminal events are RETURNED and published by
 *  `publishPendingEvents`. `awaitTurnEnd` (in the wire layer) only settles once
 *  a `turn.completed|failed|aborted` is DELIVERED — return OR onCommitted. */
const dispatchAndCollect = async (
  state: KernelSessionState,
  command: Parameters<typeof dispatchSessionCommand>[1],
  ctx: KernelDispatchContext,
): Promise<{ deliveredTypes: string[]; returnedTypes: string[] }> => {
  const delivered: SessionEvent[] = []
  const result = await dispatchSessionCommand(state, command, {
    ...ctx,
    onCommitted: async ({ events }) => {
      delivered.push(...events)
    },
  })
  // The engine publishes committed (onCommitted) events + the PENDING tail of
  // result.events (those not already committed). Terminal events ride the tail.
  const committedIds = new Set(delivered.map((e) => e.eventId))
  for (const e of result.events) if (!committedIds.has(e.eventId)) delivered.push(e)
  return {
    deliveredTypes: delivered.map((e) => e.type),
    returnedTypes: result.events.map((e) => e.type),
  }
}

describe("B1 terminal-append hang — a durable terminal-append throw must still DELIVER the terminal event", () => {
  let restoreSink: (() => void) | undefined
  const sinkErrors: unknown[] = []

  afterEach(() => {
    restoreSink?.()
    restoreSink = undefined
    sinkErrors.length = 0
  })

  const captureSink = (): void => {
    const previous = setKernelTerminalAppendErrorSink((error) => {
      sinkErrors.push(error)
    })
    restoreSink = () => {
      setKernelTerminalAppendErrorSink(previous)
    }
  }

  test("turn.completed — terminal append throws (ENOSPC) but turn.completed is DELIVERED, outcome not flipped, failure surfaced", async () => {
    captureSink()
    const before = getKernelTerminalAppendFailures()
    // Throw ONLY on the terminal `turn.completed` append (not on stream / immediate).
    const flaky = makeFlakyLog((event) => event.type === "turn.completed")
    const state = await seedRunningState("b1-completed", flaky.log)
    const host: SessionHost = {
      describe: () => ({
        sessionId: "b1-completed",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({ onEvent }) => {
        onEvent?.({ type: "assistant_text.delta", delta: "pong" })
        const messages = messagesOf("done")
        return {
          outcome: { reason: "completed", turns: 1, messages } as AgentOutcome,
          messages,
        }
      },
      close: async () => undefined,
    }
    const { deliveredTypes, returnedTypes } = await dispatchAndCollect(
      state,
      turnRunCommand("b1-completed", state.revision),
      { clock, eventLog: flaky.log, host },
    )
    // (i) The terminal event REACHED the subscriber/bridge — awaitTurnEnd settles.
    expect(deliveredTypes).toContain("turn.completed")
    expect(returnedTypes).toContain("turn.completed")
    // (ii) Not reclassified — a persistence failure is diagnostic, not a turn failure.
    expect(deliveredTypes).not.toContain("turn.failed")
    // (iii) The failure is SURFACED, not swallowed: the sink saw the ENOSPC error
    //       AND the process-global failure counter advanced.
    expect(sinkErrors.length).toBeGreaterThan(0)
    expect(String(sinkErrors[0])).toContain("ENOSPC")
    expect(getKernelTerminalAppendFailures()).toBeGreaterThan(before)
    // (iv) The throwing append actually fired (guards against a vacuous predicate).
    expect(flaky.throwCount()).toBeGreaterThan(0)
  })

  test("turn.failed — host THREW and the terminal turn.failed append throws: turn.failed STILL delivered", async () => {
    captureSink()
    const flaky = makeFlakyLog((event) => event.type === "turn.failed")
    const state = await seedRunningState("b1-failed", flaky.log)
    const host: SessionHost = {
      describe: () => ({
        sessionId: "b1-failed",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      // Host throws a NON-abort error ⇒ onTurnFailed terminal.
      runTurn: async () => {
        throw new Error("host blew up mid-turn")
      },
      close: async () => undefined,
    }
    const { deliveredTypes } = await dispatchAndCollect(
      state,
      turnRunCommand("b1-failed", state.revision),
      { clock, eventLog: flaky.log, host },
    )
    expect(deliveredTypes).toContain("turn.failed")
    expect(sinkErrors.length).toBeGreaterThan(0)
    expect(flaky.throwCount()).toBeGreaterThan(0)
  })

  test("turn.failed (errored return) — host RETURNED outcome.reason=error and terminal append throws: STILL delivered", async () => {
    captureSink()
    const flaky = makeFlakyLog((event) => event.type === "turn.failed")
    const state = await seedRunningState("b1-errored", flaky.log)
    const host: SessionHost = {
      describe: () => ({
        sessionId: "b1-errored",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async () => {
        const messages = messagesOf("partial")
        return {
          outcome: { reason: "error", turns: 1, messages } as AgentOutcome,
          messages,
          errorMessage: "provider 500",
        }
      },
      close: async () => undefined,
    }
    const { deliveredTypes } = await dispatchAndCollect(
      state,
      turnRunCommand("b1-errored", state.revision),
      { clock, eventLog: flaky.log, host },
    )
    expect(deliveredTypes).toContain("turn.failed")
    expect(sinkErrors.length).toBeGreaterThan(0)
    expect(flaky.throwCount()).toBeGreaterThan(0)
  })

  test("turn.aborted — cooperative RETURN-abort and terminal turn.aborted append throws: STILL delivered", async () => {
    captureSink()
    const flaky = makeFlakyLog((event) => event.type === "turn.aborted")
    const state = await seedRunningState("b1-aborted", flaky.log)
    const host: SessionHost = {
      describe: () => ({
        sessionId: "b1-aborted",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      // Cooperative cancel: host RETURNS aborted WITHOUT throwing.
      runTurn: async () => {
        const messages = messagesOf("stopped")
        return {
          outcome: { reason: "aborted", turns: 1, messages } as AgentOutcome,
          messages,
        }
      },
      close: async () => undefined,
    }
    const { deliveredTypes } = await dispatchAndCollect(
      state,
      turnRunCommand("b1-aborted", state.revision),
      { clock, eventLog: flaky.log, host },
    )
    expect(deliveredTypes).toContain("turn.aborted")
    expect(deliveredTypes).not.toContain("turn.completed")
    expect(sinkErrors.length).toBeGreaterThan(0)
    expect(flaky.throwCount()).toBeGreaterThan(0)
  })

  test("normal path (InMemory log, no throw) is unaffected — terminal event delivered, no failure counted", async () => {
    captureSink()
    const before = getKernelTerminalAppendFailures()
    // A log that NEVER throws — the default durable-off / InMemory behaviour.
    const flaky = makeFlakyLog(() => false)
    const state = await seedRunningState("b1-normal", flaky.log)
    const host: SessionHost = {
      describe: () => ({
        sessionId: "b1-normal",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async () => {
        const messages = messagesOf("ok")
        return {
          outcome: { reason: "completed", turns: 1, messages } as AgentOutcome,
          messages,
        }
      },
      close: async () => undefined,
    }
    const { deliveredTypes } = await dispatchAndCollect(
      state,
      turnRunCommand("b1-normal", state.revision),
      { clock, eventLog: flaky.log, host },
    )
    expect(deliveredTypes).toContain("turn.completed")
    // No persistence failure ⇒ no sink hit, no counter advance, log has the event.
    expect(sinkErrors.length).toBe(0)
    expect(getKernelTerminalAppendFailures()).toBe(before)
    expect(flaky.log.list().map((e) => e.type)).toContain("turn.completed")
  })
})
