/**
 * S3 unit coverage — the HOISTED attach flow (`@/ipc/session/attach-flow`),
 * jul-16 SDK ticket 01.
 *
 * The pure handshake DRIVER + the CLI-observable approval behavior are pinned
 * by the unmodified attach suites (`tests/unit/apps/cli/attach/*` — the
 * behavior-preservation proof of the move). THIS file covers what is NEW at
 * the hoisted seam:
 *
 *   - `runSessionHandshake` — the connect()-side runner: ATOMIC cursor
 *     handover (R2 F9: tail events observed DURING the handshake fold into
 *     `lastSeq` AND are buffered for re-delivery — M-2, jul-16 audit), typed
 *     rejection on a non-adoption connect reject (the S5b version-skew echo),
 *     and the UNSUPPORTED-resume pin (jul-16 audit KILL — the runner takes no
 *     cursor and emits bare connect frames; see the src docblock for why an
 *     ack-less protocol makes handshake-level resume a structural hang);
 *   - `createSessionApprovalFlow` — the §3.2 succession SUPPLY seams
 *     (`onContinuationIssued` / `onContinuationFailed` /
 *     `onRespondSendFailed(approvalId)`) and the ADR-0540 marker gate, driven
 *     directly (the attach client never wires the reporting seams;
 *     connect() does).
 */

import { describe, expect, test } from "bun:test"
import {
  createSessionApprovalFlow,
  runSessionHandshake,
  type SessionTransport,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionCommand } from "@/protocol/session"
import { SessionProtocolVersionError } from "@/protocol/session"
import { makeSnapshot, makeStateUpdatedEvent } from "./session-transport-conformance-fixtures"

/** Scripted transport: reacts to outbound frames with a canned inbound
 *  sequence, capturing everything sent. */
const makeScriptedTransport = (
  react: (message: SessionTransportMessage, deliver: (m: SessionTransportMessage) => void) => void,
) => {
  const handlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const sent: SessionTransportMessage[] = []
  const deliver = (message: SessionTransportMessage): void => {
    for (const handler of [...handlers]) void handler(message)
  }
  const transport: SessionTransport = {
    async send(message) {
      sent.push(message)
      react(message, deliver)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    async close() {
      handlers.clear()
    },
  }
  return { transport, sent, deliver }
}

describe("runSessionHandshake — atomic cursor handover (R2 F9)", () => {
  test("tail events streamed DURING the handshake fold into lastSeq (a client seeded from snapshot.seq alone would lag)", async () => {
    const { transport, deliver } = makeScriptedTransport((message, send) => {
      if (message.kind !== "connect") return
      if (message.sessionId === "ui-session") {
        send({
          kind: "rejected",
          sessionId: "session-1",
          target: "connect",
          reason: "session_id_mismatch",
        })
        return
      }
      // Canonical re-connect → snapshot + an immediate live tail.
      send({ kind: "snapshot", snapshot: makeSnapshot("websocket", { seq: 10 }) })
      send({ kind: "event", event: makeStateUpdatedEvent({ eventId: "t-11", seq: 11 }) })
      send({ kind: "event", event: makeStateUpdatedEvent({ eventId: "t-12", seq: 12 }) })
    })

    const handshake = runSessionHandshake({ transport })
    await handshake.ready
    // MORE tail lands between ready and handoff — the runner's still-attached
    // listener must fold it in (this window is exactly the R2 F9 lag bug).
    deliver({ kind: "event", event: makeStateUpdatedEvent({ eventId: "t-13", seq: 13 }) })

    const handoff = handshake.handoff()
    expect(handoff.sessionId).toBe("session-1")
    expect(handoff.snapshot.seq).toBe(10)
    // The LOAD-BEARING assertion: the cursor is the max OBSERVED seq, not the
    // snapshot's.
    expect(handoff.lastSeq).toBe(13)
    // M-2 (jul-16 audit): the window events are HANDED OVER, not merely
    // counted — the caller re-delivers them (the handshake listener consumed
    // frames its owner's subscription never saw).
    expect(handoff.events.map((e) => e.seq)).toEqual([11, 12, 13])
  })

  test("a NON-adoption connect reject (S5b bad_version echo) rejects `ready` TYPED instead of hanging", async () => {
    const { transport } = makeScriptedTransport((message, send) => {
      if (message.kind !== "connect") return
      send({
        kind: "rejected",
        sessionId: "session-1",
        target: "connect",
        reason: "protocol_validation",
        issue: "bad_version",
      })
    })
    const handshake = runSessionHandshake({ transport })
    const err = await handshake.ready.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionProtocolVersionError)
    handshake.abort()
  })

  test("UNSUPPORTED pin (jul-16 audit KILL): the runner takes NO resume cursor and emits BARE connect frames on BOTH legs", async () => {
    // WHY (structural, attacker-repro'd): `ready` settles only on a SNAPSHOT
    // frame, but the bridge answers a servable cursor with events-only —
    // ZERO frames at cursor==tip (`planSessionReplay`) — so a resume-carrying
    // handshake pends forever; session.v1 has no "caught up" ack. Ticket 05
    // owns door resume via the raw client's `connect({resumeFromSeq})` resume
    // watcher, NOT this handshake. (The old test here scripted an
    // always-snapshot fake server — vacuous against the real bridge.)
    const { transport, sent } = makeScriptedTransport((message, send) => {
      if (message.kind !== "connect") return
      if (message.sessionId === "ui-session") {
        send({
          kind: "rejected",
          sessionId: "session-1",
          target: "connect",
          reason: "session_id_mismatch",
        })
        return
      }
      send({ kind: "snapshot", snapshot: makeSnapshot("websocket", { seq: 10 }) })
    })
    // Type-level pin (CI tests-typecheck): the arg is GONE.
    // @ts-expect-error — resumeFromSeq was removed from runSessionHandshake (descope; excess-property TS2353)
    const rejectedShape = () => runSessionHandshake({ transport, resumeFromSeq: 7 })
    void rejectedShape
    const handshake = runSessionHandshake({ transport })
    await handshake.ready
    const handoff = handshake.handoff()
    const connects = sent.filter(
      (m): m is Extract<SessionTransportMessage, { kind: "connect" }> => m.kind === "connect",
    )
    expect(connects.length).toBe(2)
    for (const frame of connects) {
      expect("resumeFromSeq" in frame).toBe(false)
    }
    // The handed-over cursor reflects what was actually observed (snapshot).
    expect(handoff.lastSeq).toBe(10)
  })

  test("handoff() before the handshake settled throws (misuse guard)", () => {
    const { transport } = makeScriptedTransport(() => undefined)
    const handshake = runSessionHandshake({ transport })
    expect(() => handshake.handoff()).toThrow(/before the handshake settled/)
    handshake.abort()
  })

  test("a server that mismatch-rejects its OWN canonical id fails typed instead of re-connect-looping forever (self-audit hang-guard)", async () => {
    const { transport } = makeScriptedTransport((message, send) => {
      if (message.kind !== "connect") return
      // The broken/hostile server: EVERY connect (sentinel AND adopted id) is
      // rejected with the same canonical id — an infinite adoption loop.
      send({
        kind: "rejected",
        sessionId: "session-1",
        target: "connect",
        reason: "session_id_mismatch",
      })
    })
    const handshake = runSessionHandshake({ transport })
    const err = await handshake.ready.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe("SessionProtocolValidationError")
    handshake.abort()
  })
})

describe("createSessionApprovalFlow — §3.2 succession supply seams", () => {
  const approval = { approvalId: "ap-1", reason: "danger", requestedAt: "t" }

  const makeFlow = (overrides: {
    serverAutoContinues?: boolean
    sendCommand?: (command: SessionCommand) => Promise<void>
    promptApproval?: () => Promise<never> | Promise<string>
  }) => {
    const sent: SessionCommand[] = []
    const issued: Array<{ approvalId: string; commandId: string }> = []
    const failed: Array<{ approvalId: string; error: unknown }> = []
    const respondSendFailed: string[] = []
    let ids = 0
    const flow = createSessionApprovalFlow({
      waitForReady: async () => true,
      sessionId: () => "session-1",
      serverAutoContinues: () => overrides.serverAutoContinues ?? false,
      promptApproval: overrides.promptApproval ?? (async () => ({ decision: "approve" as const })),
      sendCommand:
        overrides.sendCommand ??
        (async (command) => {
          sent.push(command)
        }),
      newCommandId: () => `cmd-${++ids}`,
      issuedAt: () => "2026-07-16T00:00:00.000Z",
      onContinuationIssued: (approvalId, commandId) => {
        issued.push({ approvalId, commandId })
      },
      onContinuationFailed: (approvalId, error) => {
        failed.push({ approvalId, error })
      },
      onRespondSendFailed: (approvalId) => {
        respondSendFailed.push(approvalId)
      },
    })
    return { flow, sent, issued, failed, respondSendFailed }
  }

  test("approve + marker OFF: respond then turn.run re-issue, and the NEW commandId is REPORTED (the handle chain's supply)", async () => {
    const { flow, sent, issued } = makeFlow({ serverAutoContinues: false })
    flow.handleApprovalRequested(approval)
    await flow.settled()
    expect(sent.map((c) => c.type)).toEqual(["approval.respond", "turn.run"])
    const reissue = sent[1]
    if (reissue?.type !== "turn.run") throw new Error("narrow")
    expect(issued).toEqual([{ approvalId: "ap-1", commandId: reissue.commandId }])
  })

  test("approve + marker ON: respond only — the daemon owns the continuation, nothing is reported", async () => {
    const { flow, sent, issued } = makeFlow({ serverAutoContinues: true })
    flow.handleApprovalRequested(approval)
    await flow.settled()
    expect(sent.map((c) => c.type)).toEqual(["approval.respond"])
    expect(issued).toEqual([])
  })

  test("continuation send failure feeds onContinuationFailed (the typed hang-guard's trigger)", async () => {
    const sent: SessionCommand[] = []
    const { flow, issued, failed } = makeFlow({
      serverAutoContinues: false,
      sendCommand: async (command) => {
        if (command.type === "turn.run") throw new Error("pipe burst")
        sent.push(command)
      },
    })
    flow.handleApprovalRequested(approval)
    await flow.settled()
    expect(issued).toEqual([])
    expect(failed.length).toBe(1)
    expect(failed[0]?.approvalId).toBe("ap-1")
    expect((failed[0]?.error as Error).message).toBe("pipe burst")
  })

  test("M-1 (jul-16 audit): a RESPOND send failure feeds onRespondSendFailed WITH the approvalId — and never attempts the continuation", async () => {
    const { flow, issued, failed, respondSendFailed } = makeFlow({
      serverAutoContinues: false,
      sendCommand: async (command) => {
        if (command.type === "approval.respond") throw new Error("pipe burst on respond")
      },
    })
    flow.handleApprovalRequested(approval)
    await flow.settled()
    // The approvalId is the payload a handle-owning caller needs to settle
    // THAT chain typed (connect() wires it to
    // reportApprovalContinuationFailure — the decision never reached the
    // server, so no continuation can ever exist).
    expect(respondSendFailed).toEqual(["ap-1"])
    expect(issued).toEqual([])
    expect(failed).toEqual([])
  })

  test("a THROWING prompter fail-safes to a plain DENY — no continuation, nothing reported", async () => {
    const { flow, sent, issued, failed } = makeFlow({
      serverAutoContinues: false,
      promptApproval: async () => {
        throw new Error("prompter exploded")
      },
    })
    flow.handleApprovalRequested(approval)
    await flow.settled()
    expect(sent.length).toBe(1)
    const respond = sent[0]
    if (respond?.type !== "approval.respond") throw new Error("narrow")
    expect(respond.decision).toBe("deny")
    expect(issued).toEqual([])
    expect(failed).toEqual([])
  })
})
