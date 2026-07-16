/**
 * S2b unit coverage — `createSessionHandle` over a fully-controlled fake
 * transport (jul-16 SDK ticket 01).
 *
 * The load-bearing contracts under test:
 *   - RECEIPT IMMEDIACY (§3.1): a verb resolves `{commandId, submitted:true}`
 *     the moment the transport send resolves — with NO inbound frame at all
 *     (a server that never answers cannot park a verb); and a receipt is
 *     NEVER minted once the connection is terminal (no receipts into a dead
 *     pipe).
 *   - `lastSeq()` cursor: the raw client's resume cursor under its public
 *     name — seeded at creation, advanced by event AND snapshot frames.
 *   - `awaitTurnEnd()` §3.2 correlation: own-chain terminal matching, foreign
 *     `causedByCommandId` crosstalk immunity, EXPLICIT succession
 *     (`reportApprovalContinuation`), marker-ON ADOPTION (daemon-minted
 *     continuation), and every correlation-LOSS arm failing TYPED instead of
 *     hanging: no_turn_run / approval_denied / continuation_failed /
 *     connection_closed / handle_closed / correlated `rejected`.
 *   - `onCommandRejected`: the S5 typed side-channel
 *     (`typedErrorFromRejectedMessage` SSOT mapping).
 *   - `snapshot()`: latest-received cache + freshness, never a dispatch.
 *
 * Every would-be-hang assertion uses a settle-probe (Promise.race against an
 * already-settled marker after a flush) — the suite can never hang on a
 * regression; it fails loud.
 */

import { describe, expect, test } from "bun:test"
import {
  createSessionHandle,
  createSessionTransportClient,
  createTurnEndCorrelator,
  SessionDispatchFailedError,
  SessionHandleClosedError,
  type SessionTransport,
  type SessionTransportCloseInfo,
  type SessionTransportMessage,
  SessionTurnCorrelationLostError,
} from "@/ipc/session"
import type { SessionEvent } from "@/protocol/session"
import { SessionProtocolValidationError } from "@/protocol/session"
import { makeSnapshot, makeStateUpdatedEvent } from "./session-transport-conformance-fixtures"

/** Fully-controlled wire: captures outbound frames, delivers inbound frames,
 *  and can die on command. `send` resolves WITHOUT delivering anything —
 *  receipt immediacy is observable directly. */
const makeWire = () => {
  const handlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const closeHandlers = new Set<(info: SessionTransportCloseInfo) => void>()
  const sent: SessionTransportMessage[] = []
  let dead = false
  const transport: SessionTransport = {
    async send(message) {
      if (dead) throw new Error("send on dead wire")
      sent.push(message)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
    async close() {
      // Local close — the close-signal contract is exercised via die();
      // the client layers its own local_close fallback.
    },
  }
  const deliver = (message: SessionTransportMessage): void => {
    for (const handler of [...handlers]) void handler(message)
  }
  const die = (reason: string): void => {
    dead = true
    for (const handler of [...closeHandlers]) handler({ reason })
  }
  return { transport, sent, deliver, die }
}

const makeHandle = (opts?: { resumeFromSeq?: number }) => {
  const wire = makeWire()
  const client = createSessionTransportClient({
    transport: wire.transport,
    sessionId: "session-1",
    ...(opts?.resumeFromSeq !== undefined ? { resumeFromSeq: opts.resumeFromSeq } : {}),
  })
  const handle = createSessionHandle(client, {
    initialSnapshot: makeSnapshot("websocket"),
    now: () => 1_000,
  })
  return { ...wire, client, handle }
}

const event = (overrides: Partial<Extract<SessionEvent, { type: "turn.completed" }>>) =>
  ({
    eventId: "e-end",
    seq: 50,
    revision: 9,
    emittedAt: "t",
    type: "turn.completed",
    outcomeReason: "completed",
    ...overrides,
  }) as Extract<SessionEvent, { type: "turn.completed" }>

const approvalRequested = (args: {
  approvalId: string
  causedByCommandId: string
  seq: number
}): SessionTransportMessage => ({
  kind: "event",
  event: {
    eventId: `e-${args.approvalId}`,
    seq: args.seq,
    revision: 5,
    emittedAt: "t",
    causedByCommandId: args.causedByCommandId,
    type: "approval.requested",
    approval: { approvalId: args.approvalId, reason: "danger", requestedAt: "t" },
  },
})

const approvalResolved = (args: {
  approvalId: string
  decision: "approve" | "deny"
  seq: number
}): SessionTransportMessage => ({
  kind: "event",
  event: {
    eventId: `e-res-${args.approvalId}`,
    seq: args.seq,
    revision: 6,
    emittedAt: "t",
    type: "approval.resolved",
    approvalId: args.approvalId,
    decision: args.decision,
  },
})

const turnStarted = (args: {
  causedByCommandId: string
  seq: number
}): SessionTransportMessage => ({
  kind: "event",
  event: {
    eventId: `e-started-${args.seq}`,
    seq: args.seq,
    revision: 6,
    emittedAt: "t",
    causedByCommandId: args.causedByCommandId,
    type: "turn.started",
    prompt: "p",
  },
})

/** A `session.state.updated` frame with a chosen status — the HIGH-1 void
 *  detector's input (the kernel's turn.cancel emits exactly this and nothing
 *  else when it discards a parked approval). */
const stateUpdated = (args: {
  status: "idle" | "running" | "awaiting_approval"
  seq: number
  causedByCommandId?: string
}): SessionTransportMessage => ({
  kind: "event",
  event: makeStateUpdatedEvent({
    eventId: `e-state-${args.seq}`,
    seq: args.seq,
    revision: 6,
    state: {
      status: args.status,
      draftInput: "",
      permissionMode: "default",
      messageCount: 0,
    },
    ...(args.causedByCommandId !== undefined ? { causedByCommandId: args.causedByCommandId } : {}),
  }),
})

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

/** Settle-probe: `undefined` = still pending (the would-be hang, observed
 *  WITHOUT hanging the suite). */
const probe = async <T>(
  p: Promise<T>,
): Promise<
  { state: "pending" } | { state: "resolved"; value: T } | { state: "rejected"; error: unknown }
> => {
  const marker = Symbol("pending")
  try {
    const raced = await Promise.race([p, flush().then(() => marker)])
    if (raced === marker) return { state: "pending" }
    return { state: "resolved", value: raced as T }
  } catch (error) {
    return { state: "rejected", error }
  }
}

describe("SessionHandle — receipt immediacy (§3.1)", () => {
  test("a verb resolves {commandId, submitted:true} on send success with ZERO inbound frames", async () => {
    const { handle, sent } = makeHandle()
    // The wire NEVER answers — a completion-waiting implementation would park.
    const receipt = await handle.input.append("hello", { commandId: "cmd-1" })
    expect(receipt).toEqual({ commandId: "cmd-1", submitted: true })
    // And the frame on the wire is exactly that command.
    const frame = sent.find((m) => m.kind === "command")
    if (frame?.kind !== "command") throw new Error("narrow")
    expect(frame.command.commandId).toBe("cmd-1")
    expect(frame.command.type).toBe("input.append")
    expect(frame.command.sessionId).toBe("session-1")
  })

  test("every verb of the surface mints a receipt (turn.cancel included)", async () => {
    const { handle } = makeHandle()
    const receipts = [
      await handle.identity.set("focused"),
      await handle.toolProfile.set("min"),
      await handle.permission.set("bypass"),
      await handle.turn.cancel(),
      await handle.approval.respond("ap-1", "approve"),
      await handle.transcript.replace([]),
    ]
    for (const receipt of receipts) {
      expect(receipt.submitted).toBe(true)
      expect(typeof receipt.commandId).toBe("string")
    }
  })

  test("after transport death a verb REJECTS typed — no submitted-receipt lie into a dead pipe", async () => {
    const { handle, die } = makeHandle()
    die("socket_close")
    await expect(handle.input.append("x")).rejects.toBeInstanceOf(SessionHandleClosedError)
    // The reason is carried for diagnostics.
    const err = await handle.turn.run().catch((e: unknown) => e)
    expect((err as SessionHandleClosedError).reason).toBe("socket_close")
  })

  test("after local close() a verb rejects typed", async () => {
    const { handle } = makeHandle()
    await handle.close()
    await expect(handle.permission.set("bypass")).rejects.toBeInstanceOf(SessionHandleClosedError)
  })
})

describe("SessionHandle — lastSeq() cursor", () => {
  test("starts at the creation-time cursor and advances with event AND snapshot frames", async () => {
    const { handle, deliver } = makeHandle({ resumeFromSeq: 10 })
    expect(handle.lastSeq()).toBe(10)
    deliver({ kind: "event", event: makeStateUpdatedEvent({ seq: 12 }) })
    expect(handle.lastSeq()).toBe(12)
    deliver({ kind: "snapshot", snapshot: makeSnapshot("websocket", { seq: 20 }) })
    expect(handle.lastSeq()).toBe(20)
    // Regressions never move it backwards (max semantics).
    deliver({ kind: "event", event: makeStateUpdatedEvent({ eventId: "old", seq: 3 }) })
    expect(handle.lastSeq()).toBe(20)
  })
})

describe("SessionHandle — snapshot() cache + freshness", () => {
  test("serves the seeded snapshot, then the LATEST received frame, with the live cursor attached", async () => {
    const { handle, deliver } = makeHandle({ resumeFromSeq: 1 })
    const first = await handle.snapshot()
    expect(first?.snapshot.seq).toBe(1)
    expect(first?.receivedAtMs).toBe(1_000)
    deliver({ kind: "snapshot", snapshot: makeSnapshot("websocket", { seq: 30, revision: 7 }) })
    deliver({ kind: "event", event: makeStateUpdatedEvent({ seq: 31 }) })
    const second = await handle.snapshot()
    expect(second?.snapshot.seq).toBe(30)
    expect(second?.snapshot.revision).toBe(7)
    // Freshness: the live cursor has already advanced past the cached view.
    expect(second?.lastSeenSeq).toBe(31)
  })
})

describe("SessionHandle — awaitTurnEnd correlation (§3.2)", () => {
  test("no turn.run ever issued ⇒ IMMEDIATE typed rejection (no_turn_run), not a hang", async () => {
    const { handle } = makeHandle()
    const err = await handle.awaitTurnEnd().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((err as SessionTurnCorrelationLostError).reason).toBe("no_turn_run")
  })

  test("resolves the terminal event of MY chain; a FOREIGN peer's terminal never settles it (crosstalk ban)", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "mine" })
    const wait = handle.awaitTurnEnd()

    // Another peer's turn ends — MUST NOT be claimed as ours.
    deliver({ kind: "event", event: event({ causedByCommandId: "theirs", seq: 40 }) })
    expect((await probe(wait)).state).toBe("pending")

    // My own terminal arrives — resolves with THE event.
    deliver({ kind: "event", event: event({ causedByCommandId: "mine", seq: 41 }) })
    const end = await wait
    expect(end.type).toBe("turn.completed")
    expect(end.causedByCommandId).toBe("mine")
  })

  test("turn.failed and turn.aborted are terminals too", async () => {
    for (const type of ["turn.failed", "turn.aborted"] as const) {
      const { handle, deliver } = makeHandle()
      await handle.turn.run({ commandId: "c" })
      deliver({
        kind: "event",
        event: {
          eventId: "e",
          seq: 42,
          revision: 5,
          emittedAt: "t",
          causedByCommandId: "c",
          type,
          message: "boom",
        },
      })
      const end = await handle.awaitTurnEnd()
      expect(end.type).toBe(type)
    }
  })

  test("EXPLICIT succession: approval mid-turn + reported continuation commandId carries the chain to the new terminal", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()

    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-1", seq: 10 }))
    deliver(approvalResolved({ approvalId: "ap-1", decision: "approve", seq: 11 }))
    // The flow re-issued and REPORTED (the §3.2 contract supply side).
    handle.reportApprovalContinuation("ap-1", "run-2")
    expect((await probe(wait)).state).toBe("pending") // not settled by the report itself

    deliver({ kind: "event", event: event({ causedByCommandId: "run-2", seq: 12 }) })
    const end = await wait
    expect(end.causedByCommandId).toBe("run-2")
  })

  test("ADOPTION succession (marker ON): after MY approval approves, the next unclaimed turn.started (daemon-minted id) joins the chain", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()

    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-1", seq: 10 }))
    deliver(approvalResolved({ approvalId: "ap-1", decision: "approve", seq: 11 }))
    // Daemon-minted continuation this client never sent:
    deliver(turnStarted({ causedByCommandId: "daemon-77", seq: 12 }))
    deliver({ kind: "event", event: event({ causedByCommandId: "daemon-77", seq: 13 }) })
    const end = await wait
    expect(end.causedByCommandId).toBe("daemon-77")
  })

  test("adoption window is NOT armed without my approval: a stray turn.started is never claimed", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    // No approval of mine resolved — a foreign turn starting must not be adopted.
    deliver(turnStarted({ causedByCommandId: "foreign-1", seq: 10 }))
    deliver({ kind: "event", event: event({ causedByCommandId: "foreign-1", seq: 11 }) })
    expect((await probe(wait)).state).toBe("pending")
    // My own terminal still settles it.
    deliver({ kind: "event", event: event({ causedByCommandId: "run-1", seq: 12 }) })
    await wait
  })

  test("a FOREIGN approval's continuation report is ignored (no chain corruption)", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    handle.reportApprovalContinuation("not-my-approval", "someone-elses-run")
    deliver({ kind: "event", event: event({ causedByCommandId: "someone-elses-run", seq: 10 }) })
    expect((await probe(wait)).state).toBe("pending")
    deliver({ kind: "event", event: event({ causedByCommandId: "run-1", seq: 11 }) })
    await wait
  })

  test("an explicit NEW turn.run closes stale adoption windows (old chain can no longer claim later turns)", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-1", seq: 10 }))
    deliver(approvalResolved({ approvalId: "ap-1", decision: "approve", seq: 11 }))
    // Consumer moved on: a brand-new explicit turn.
    await handle.turn.run({ commandId: "run-9" })
    const wait = handle.awaitTurnEnd()
    // An unclaimed turn.started now must NOT be adopted by the stale ap-1 arm
    // (if it were, run-9's chain would never see its own terminal below as
    // "first" — and the stale chain would wrongly claim daemon-88's turn).
    deliver(turnStarted({ causedByCommandId: "daemon-88", seq: 12 }))
    deliver({ kind: "event", event: event({ causedByCommandId: "run-9", seq: 13 }) })
    const end = await wait
    expect(end.causedByCommandId).toBe("run-9")
  })
})

describe("SessionHandle — typed hang-guards (§3.2 correlation loss)", () => {
  test("DENY orphans the chain: typed approval_denied rejection (kernel emits no terminal after a deny — wire fact)", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-1", seq: 10 }))
    deliver(approvalResolved({ approvalId: "ap-1", decision: "deny", seq: 11 }))
    const err = await wait.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((err as SessionTurnCorrelationLostError).reason).toBe("approval_denied")
  })

  test("continuation submit failure: typed continuation_failed rejection", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-1", seq: 10 }))
    deliver(approvalResolved({ approvalId: "ap-1", decision: "approve", seq: 11 }))
    handle.reportApprovalContinuationFailure("ap-1", new Error("send exploded"))
    const err = await wait.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((err as SessionTurnCorrelationLostError).reason).toBe("continuation_failed")
  })

  test("transport death mid-wait: typed connection_closed rejection", async () => {
    const { handle, die } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    die("socket_error (peer reset)")
    const err = await wait.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((err as SessionTurnCorrelationLostError).reason).toBe("connection_closed")
  })

  test("local close() mid-wait: typed handle_closed rejection", async () => {
    const { handle } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    await handle.close()
    const err = await wait.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((err as SessionTurnCorrelationLostError).reason).toBe("handle_closed")
  })

  test("a CORRELATED rejected frame settles the chain with the S5 typed error", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    deliver({
      kind: "rejected",
      sessionId: "session-1",
      target: "command",
      reason: "protocol_validation",
      commandId: "run-1",
      issue: "empty_turn_input",
    })
    const err = await wait.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionProtocolValidationError)
    expect((err as SessionProtocolValidationError).issue).toBe("empty_turn_input")
  })

  test("a turn.run whose SEND throws settles its chain with that error — a later awaitTurnEnd replays it typed (no hang)", async () => {
    // A transport whose send fails WITHOUT a liveness signal (broken pipe that
    // raced ahead of the close event): the verb rejects AND the chain must be
    // settled, or awaitTurnEnd would wait forever for a never-submitted turn.
    const handlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
    const brokenTransport = {
      async send() {
        throw new Error("EPIPE")
      },
      onMessage(handler: (m: SessionTransportMessage) => void | Promise<void>) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      async close() {
        handlers.clear()
      },
    }
    const client = createSessionTransportClient({
      transport: brokenTransport,
      sessionId: "session-1",
    })
    const handle = createSessionHandle(client)
    const verbError = await handle.turn.run({ commandId: "run-1" }).catch((e: unknown) => e)
    expect((verbError as Error).message).toBe("EPIPE")
    const waitError = await handle.awaitTurnEnd().catch((e: unknown) => e)
    expect((waitError as Error).message).toBe("EPIPE")
  })

  test("awaitTurnEnd on an ALREADY-settled chain replays the settlement (no re-arm hang)", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    deliver({ kind: "event", event: event({ causedByCommandId: "run-1", seq: 10 }) })
    // First await after the fact — and a second one — both resolve.
    expect((await handle.awaitTurnEnd()).causedByCommandId).toBe("run-1")
    expect((await handle.awaitTurnEnd()).causedByCommandId).toBe("run-1")
  })
})

describe("SessionHandle — parked-approval void (HIGH-1, jul-16 audit)", () => {
  test("turn.cancel on a PARKED approval: the session leaves awaiting_approval with NO approval.resolved — awaitTurnEnd rejects typed approval_voided (was: permanent hang)", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()

    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-1", seq: 10 }))
    deliver(stateUpdated({ status: "awaiting_approval", seq: 11, causedByCommandId: "run-1" }))
    expect((await probe(wait)).state).toBe("pending") // parked, correctly waiting

    // The handle's OWN cancel verb (kernel accepts turn.cancel while
    // awaiting_approval) — receipt minted normally.
    const cancelReceipt = await handle.turn.cancel({ commandId: "cancel-1" })
    expect(cancelReceipt).toEqual({ commandId: "cancel-1", submitted: true })

    // KERNEL FACT (reducer.ts turn.cancel): the ONLY emission is the state
    // echo leaving awaiting_approval — no approval.resolved, no turn.aborted.
    deliver(stateUpdated({ status: "idle", seq: 12, causedByCommandId: "cancel-1" }))

    const err = await wait.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((err as SessionTurnCorrelationLostError).reason).toBe("approval_voided")
    expect(String((err as Error).message)).toContain("ap-1")
  })

  test("paired control: the NORMAL approve path crosses the same awaiting_approval→idle transition WITHOUT voiding (approval.resolved precedes the echo)", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()

    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-1", seq: 10 }))
    deliver(stateUpdated({ status: "awaiting_approval", seq: 11, causedByCommandId: "run-1" }))
    // Kernel ordering on approval.respond: resolved FIRST, then the idle echo.
    deliver(approvalResolved({ approvalId: "ap-1", decision: "approve", seq: 12 }))
    deliver(stateUpdated({ status: "idle", seq: 13 }))
    // NOT voided — the chain is armed for its continuation.
    expect((await probe(wait)).state).toBe("pending")

    deliver(turnStarted({ causedByCommandId: "daemon-77", seq: 14 }))
    deliver({ kind: "event", event: event({ causedByCommandId: "daemon-77", seq: 15 }) })
    const end = await wait
    expect(end.causedByCommandId).toBe("daemon-77")
  })

  test("a lone running→idle transition (no approval in flight) voids nothing", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    deliver(stateUpdated({ status: "running", seq: 10, causedByCommandId: "run-1" }))
    deliver(stateUpdated({ status: "idle", seq: 11 }))
    expect((await probe(wait)).state).toBe("pending")
    deliver({ kind: "event", event: event({ causedByCommandId: "run-1", seq: 12 }) })
    await wait
  })

  test("2nd-order path: a LATE deny respond after the void is answered by unknown_approval — nothing left unsettled, the void settlement replays", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-1", seq: 10 }))
    deliver(stateUpdated({ status: "awaiting_approval", seq: 11 }))
    deliver(stateUpdated({ status: "idle", seq: 12 })) // the silent cancel
    await wait.catch(() => undefined) // settled typed (approval_voided)

    // The operator's deny lands AFTER the void: the kernel rejects it
    // unknown_approval (pendingApproval is gone). The respond command is not
    // a chain member — the rejected frame reaches the side-channel and no
    // chain is disturbed.
    const rejections: string[] = []
    handle.onCommandRejected((rejection) => {
      rejections.push(rejection.message.reason)
    })
    await handle.approval.respond("ap-1", "deny", { commandId: "late-deny" })
    deliver({
      kind: "rejected",
      sessionId: "session-1",
      target: "command",
      reason: "protocol_validation",
      commandId: "late-deny",
      issue: "unknown_approval",
    })
    expect(rejections).toEqual(["protocol_validation"])
    // The chain's settlement is stable: a later awaitTurnEnd REPLAYS the
    // typed void (settled, not resurrect-able, not hanging).
    const replayed = await handle.awaitTurnEnd().catch((e: unknown) => e)
    expect((replayed as SessionTurnCorrelationLostError).reason).toBe("approval_voided")
  })
})

describe("SessionHandle — begin() supersede + commandId reuse (HIGH-2/L-3, jul-16 audit)", () => {
  test("HIGH-2: chain A approved (adoption ARMED) then an explicit turn.run(B) — A's existing waiter rejects typed superseded (was: orphaned hang)", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-a" })
    const waitA = handle.awaitTurnEnd() // waiter attached BEFORE the supersede
    deliver(approvalRequested({ approvalId: "ap-1", causedByCommandId: "run-a", seq: 10 }))
    deliver(approvalResolved({ approvalId: "ap-1", decision: "approve", seq: 11 })) // arm

    await handle.turn.run({ commandId: "run-b" }) // the consumer moved on

    const errA = await waitA.catch((e: unknown) => e)
    expect(errA).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((errA as SessionTurnCorrelationLostError).reason).toBe("superseded")

    // And B correlates normally — the supersede never leaks into the new chain.
    const waitB = handle.awaitTurnEnd()
    deliver({ kind: "event", event: event({ causedByCommandId: "run-b", seq: 12 }) })
    expect((await waitB).causedByCommandId).toBe("run-b")
  })

  test("L-3: a REUSED commandId settles the prior live chain typed (superseded) instead of silently clobbering its waiter", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "dup" })
    const first = handle.awaitTurnEnd()
    await handle.turn.run({ commandId: "dup" }) // same id, new chain
    const err = await first.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((err as SessionTurnCorrelationLostError).reason).toBe("superseded")
    // The NEW chain under the id still correlates its terminal.
    const second = handle.awaitTurnEnd()
    deliver({ kind: "event", event: event({ causedByCommandId: "dup", seq: 10 }) })
    expect((await second).causedByCommandId).toBe("dup")
  })
})

describe("TurnEndCorrelator — retention bound (M-4, jul-16 audit)", () => {
  const terminalFor = (commandId: string, seq: number): SessionEvent =>
    ({
      eventId: `e-${commandId}`,
      seq,
      revision: 5,
      emittedAt: "t",
      causedByCommandId: commandId,
      type: "turn.completed",
      outcomeReason: "completed",
    }) as SessionEvent

  test("settled prior generations are pruned on begin(): chain count stays O(1) across many turns (was: unbounded growth)", () => {
    const correlator = createTurnEndCorrelator()
    for (let i = 0; i < 200; i++) {
      correlator.begin(`run-${i}`)
      correlator.onEvent(terminalFor(`run-${i}`, i + 1))
    }
    // Retained: the current chain + at most the immediately-previous
    // generation — never the 200-chain history.
    expect(correlator.chainCount()).toBeLessThanOrEqual(2)
  })

  test("UNSETTLED chains are NEVER pruned — a slow terminal still finds its waiter after many later turns", async () => {
    const correlator = createTurnEndCorrelator()
    correlator.begin("slow")
    const wait = correlator.awaitEnd() // waiter on the slow chain
    for (let i = 0; i < 50; i++) {
      correlator.begin(`fast-${i}`)
      correlator.onEvent(terminalFor(`fast-${i}`, i + 1))
    }
    // The slow chain survived every prune sweep (unsettled ⇒ retained)…
    correlator.onEvent(terminalFor("slow", 999))
    const end = await wait
    expect(end.causedByCommandId).toBe("slow")
    // …and the retained set stays bounded regardless.
    expect(correlator.chainCount()).toBeLessThanOrEqual(3)
  })
})

describe("SessionHandle — rejected channel + connection state", () => {
  test("onCommandRejected delivers EVERY rejected frame with its typed error (dispatch_failed mapping included)", async () => {
    const { handle, deliver } = makeHandle()
    const seen: Array<{ reason: string; errorName: string; isDispatchFailed: boolean }> = []
    handle.onCommandRejected((rejection) => {
      seen.push({
        reason: rejection.message.reason,
        errorName: rejection.error.name,
        // Class identity through the barrel — not just a name string.
        isDispatchFailed: rejection.error instanceof SessionDispatchFailedError,
      })
    })
    deliver({
      kind: "rejected",
      sessionId: "session-1",
      target: "command",
      reason: "protocol_validation",
      commandId: "c-1",
      issue: "dispatch_failed",
    })
    deliver({
      kind: "rejected",
      sessionId: "session-1",
      target: "command",
      reason: "duplicate_command",
      commandId: "c-2",
    })
    expect(seen).toEqual([
      {
        reason: "protocol_validation",
        errorName: "SessionDispatchFailedError",
        isDispatchFailed: true,
      },
      {
        reason: "duplicate_command",
        errorName: "SessionDuplicateCommandError",
        isDispatchFailed: false,
      },
    ])
  })

  test("onConnectionState replays the CURRENT state (connected) and then the terminal close once", async () => {
    const { handle, die } = makeHandle()
    const states: string[] = []
    handle.onConnectionState((state) => {
      states.push(state.status === "closed" ? `closed:${state.reason}` : state.status)
    })
    expect(states).toEqual(["connected"])
    die("socket_close")
    expect(states).toEqual(["connected", "closed:socket_close"])
  })

  test("a rejected frame with no commandId (connect-target) never poisons a live chain", async () => {
    const { handle, deliver } = makeHandle()
    await handle.turn.run({ commandId: "run-1" })
    const wait = handle.awaitTurnEnd()
    deliver({
      kind: "rejected",
      sessionId: "session-1",
      target: "connect",
      reason: "session_id_mismatch",
    })
    expect((await probe(wait)).state).toBe("pending")
    deliver({ kind: "event", event: event({ causedByCommandId: "run-1", seq: 12 }) })
    await wait
  })
})
