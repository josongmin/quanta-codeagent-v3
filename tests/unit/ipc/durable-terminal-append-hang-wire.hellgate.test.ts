/**
 * B1 (jul-18 release-blocker) — WIRE e2e for the durable-eventlog TERMINAL
 * append hang.
 *
 * γ repro at the wire level: a session runs with a DURABLE event log
 * (QUANTA_SESSION_EVENT_LOG_DIR shape — here a durable-shaped log injected
 * directly) whose TERMINAL append (`turn.completed`) throws (disk full /
 * read-only dir). A REMOTE client that issued the turn calls `awaitTurnEnd()`.
 *
 * BEFORE the fix: the terminal handler's `await appendEvents(completionEvents)`
 * rejected, propagated out of `dispatchSessionCommand` before the engine ever
 * published the terminal events, so the `turn.completed` frame never reached the
 * client and `awaitTurnEnd()` hung forever (bounded here ⇒ RED timeout).
 *
 * AFTER the fix: the terminal event is published to the subscriber/bridge
 * regardless of persistence outcome, so the remote `awaitTurnEnd()` SETTLES with
 * the `turn.completed` terminal — a typed resolution, not a hang — while the
 * persistence failure is surfaced on the diagnostic sink + counter.
 *
 * This is the OWNER-LOCAL kernel test's (kernel-terminal-append-hang.hellgate)
 * end-to-end companion: it proves the delivery all the way to a real wire
 * client's `awaitTurnEnd`, through the real engine + bridge + transport + handle.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createSessionHandle,
  createSessionTransportClient,
  type SessionTransport,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { DurableSessionEventLog, KernelEventLogPort, SessionHost } from "@/kernel/session"
import {
  getKernelTerminalAppendFailures,
  setKernelTerminalAppendErrorSink,
  systemClock,
} from "@/kernel/session"
import type { Message } from "@/llm"
import type { SessionEvent } from "@/protocol/session"
import { createRuntimeSession } from "@/sdk/runtime/session"

const CAPABILITIES = {
  approvals: "none" as const,
  tools: false,
  memory: false,
  artifacts: false,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  serverAutoContinues: false,
  transport: "inproc" as const,
}

const messagesOf = (text: string): readonly Message[] => [
  { role: "user", content: [{ type: "text", text }] },
]

/** A DURABLE-shaped event log (so `isDurableSessionEventLog` sees it as durable,
 *  exactly like the on-disk JSONL log) whose `append` THROWS on the configured
 *  terminal event type — modelling a full disk (ENOSPC) exactly at the terminal
 *  write. Successful appends are retained so `tip`/`readFrom`/`list` are honest. */
const makeThrowingDurableLog = (
  shouldThrow: (event: SessionEvent) => boolean,
): DurableSessionEventLog & {
  throwCount: () => number
} => {
  const events: SessionEvent[] = []
  let tip = 0
  let thrown = 0
  return {
    append(event: SessionEvent): void {
      if (shouldThrow(event)) {
        thrown += 1
        throw new Error(`ENOSPC: no space left on device (${event.type})`)
      }
      events.push(event)
      if (event.seq > tip) tip = event.seq
    },
    list: () => [...events],
    tip: () => tip,
    readFrom: (afterSeq: number) => events.filter((e) => e.seq > afterSeq),
    close: () => undefined,
    throwCount: () => thrown,
  }
}

/** The genuine ENOSPC crash model: EVERY append after the turn starts throws
 *  (the disk is full). Under the bug this is the TRUE forever-hang — the
 *  terminal handler throws, `runTurn`'s catch reclassifies to `turn.failed`
 *  whose append ALSO throws, so `dispatchSessionCommand` rejects with NO
 *  terminal event ever published. */
const TURN_TERMINAL_TYPES: ReadonlySet<SessionEvent["type"]> = new Set([
  "turn.completed",
  "turn.failed",
  "turn.aborted",
])

const makeStubHost = (sessionId: string): SessionHost => ({
  describe: () => ({
    sessionId,
    permissionMode: "default",
    capabilityManifest: CAPABILITIES,
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
})

/** In-memory duplex transport pair — `send` AWAITS remote handlers so a command
 *  send observes the full bridge dispatch (deterministic, no sleeps). Mirrors
 *  the pair in tests/unit/sdk/durable-resume-restart.test.ts. */
const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const build = (
    local: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(m: SessionTransportMessage) => void | Promise<void>>,
  ): SessionTransport => ({
    async send(message) {
      for (const handler of [...remote]) await handler(message)
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      local.clear()
    },
  })
  return {
    client: build(clientHandlers, serverHandlers),
    server: build(serverHandlers, clientHandlers),
  }
}

/** Bounded diagnostic race — a hang FAILS with a label (RED) instead of hanging
 *  the whole suite. The happy path resolves event-driven well under the bound. */
const bounded = async <T>(p: Promise<T>, label: string, ms = 5_000): Promise<T> =>
  await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ])

describe("B1 wire e2e — durable terminal-append throw must SETTLE a remote awaitTurnEnd (not hang)", () => {
  let restoreSink: (() => void) | undefined
  const sinkErrors: unknown[] = []
  afterEach(() => {
    restoreSink?.()
    restoreSink = undefined
    sinkErrors.length = 0
  })

  const run = async (args: { readonly sessionId: string; readonly log: KernelEventLogPort }) => {
    const session = createRuntimeSession({
      hostSession: makeStubHost(args.sessionId),
      kernel: { clock: systemClock, eventLog: args.log },
    })
    const pair = createTransportPair()
    await session.attachSessionTransport(pair.server)
    const client = createSessionTransportClient({
      transport: pair.client,
      sessionId: args.sessionId,
    })
    await client.connect()
    const handle = createSessionHandle(client)
    return { session, client, handle }
  }

  test("durable log throws on turn.completed append: remote awaitTurnEnd RESOLVES turn.completed (was: permanent hang) + failure surfaced", async () => {
    const previous = setKernelTerminalAppendErrorSink((error) => {
      sinkErrors.push(error)
    })
    restoreSink = () => setKernelTerminalAppendErrorSink(previous)
    const before = getKernelTerminalAppendFailures()

    const log = makeThrowingDurableLog((e) => e.type === "turn.completed")
    const { session, client, handle } = await run({ sessionId: "b1-wire-completed", log })

    await handle.input.append("do the thing")
    await handle.turn.run({ commandId: "run-1" })
    // THE crown assertion: the terminal reaches the remote client despite the
    // persistence throw — awaitTurnEnd settles typed, not a forever-hang.
    const end = await bounded(handle.awaitTurnEnd(), "remote awaitTurnEnd (durable terminal throw)")
    expect(end.type).toBe("turn.completed")

    // The persistence failure was SURFACED (sink + counter), never swallowed.
    expect(log.throwCount()).toBeGreaterThan(0)
    expect(sinkErrors.length).toBeGreaterThan(0)
    expect(String(sinkErrors[0])).toContain("ENOSPC")
    expect(getKernelTerminalAppendFailures()).toBeGreaterThan(before)

    await handle.close()
    await client.close()
    await session.close()
  })

  test("FULL ENOSPC (every terminal append throws) — the genuine forever-hang: remote awaitTurnEnd STILL settles turn.completed", async () => {
    const previous = setKernelTerminalAppendErrorSink((error) => {
      sinkErrors.push(error)
    })
    restoreSink = () => setKernelTerminalAppendErrorSink(previous)

    // Every terminal-turn append throws — under the bug NO terminal event is
    // ever published, so the remote awaitTurnEnd hangs forever (bounded ⇒ RED
    // timeout). The fix delivers the FIRST-classified terminal (turn.completed)
    // regardless of the throw.
    const log = makeThrowingDurableLog((e) => TURN_TERMINAL_TYPES.has(e.type))
    const { session, client, handle } = await run({ sessionId: "b1-wire-enospc", log })

    await handle.input.append("do the thing")
    await handle.turn.run({ commandId: "run-1" })
    const end = await bounded(handle.awaitTurnEnd(), "remote awaitTurnEnd (full ENOSPC)")
    // Not reclassified to failed: the completed classification stands, delivered.
    expect(end.type).toBe("turn.completed")
    expect(log.throwCount()).toBeGreaterThan(0)
    expect(sinkErrors.length).toBeGreaterThan(0)

    await handle.close()
    await client.close()
    await session.close()
  })
})
