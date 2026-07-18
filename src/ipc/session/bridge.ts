import {
  type SessionCommand,
  type SessionEvent,
  SessionProtocolValidationError,
  SessionRevisionConflictError,
  type SessionSnapshotLite,
} from "@/protocol/session"
import { SessionDispatchFailedError, SessionDuplicateCommandError } from "./errors"
import { replyToHeartbeatOnTransport } from "./heartbeat"
import type {
  SessionDurableEventLogReader,
  SessionReplayPlan,
  SessionTransport,
  SessionTransportConnectMessage,
  SessionTransportMessage,
  SessionTransportRejectedMessage,
} from "./types"

const DEFAULT_TAIL_LIMIT = 128

/** Every error class a `rejected` frame can be minted from. The dispatch-stage
 *  members (S5a) are ADDITIVE: `SessionDispatchFailedError` wraps a non-protocol
 *  dispatch throw; a `SessionProtocolValidationError` may now also ORIGINATE in
 *  the kernel reducer (e.g. `empty_turn_input`) rather than only in the bridge's
 *  own admission checks. */
type SessionRejectError =
  | SessionDuplicateCommandError
  | SessionProtocolValidationError
  | SessionRevisionConflictError
  | SessionDispatchFailedError

interface CommandRejectedArgs {
  readonly command: SessionCommand
  readonly error: SessionRejectError
}

export interface SessionTransportBridgeErrorArgs {
  readonly error: unknown
  readonly peer: SessionTransport
}

export interface CreateSessionTransportBridgeOpts {
  readonly snapshot: SessionSnapshotLite
  readonly tailLimit?: number
  /** Ticket 05 (durable resume) — optional on-disk replay feed. When present,
   *  the three snapshot-fallback paths of `planSessionReplay` (behind-window /
   *  ahead-of-tip / in-window gap) first try an INCREMENTAL event replay read
   *  from this log; the snapshot fallback remains for whatever the log cannot
   *  cover densely. Absent ⇒ byte-identical historical behavior. */
  readonly durableLog?: SessionDurableEventLogReader
  readonly onCommand?: (command: SessionCommand) => void | Promise<void>
  readonly onCommandRejected?: (args: CommandRejectedArgs) => void
  readonly onBridgeError?: (args: SessionTransportBridgeErrorArgs) => void
}

export interface ConnectedSessionTransport {
  close(): Promise<void>
}

export interface SessionTransportBridge {
  readonly sessionId: string
  connect(transport: SessionTransport): Promise<ConnectedSessionTransport>
  updateSnapshot(snapshot: SessionSnapshotLite): void
  publishSnapshot(snapshot: SessionSnapshotLite): Promise<void>
  publishEvents(events: readonly SessionEvent[]): Promise<void>
  currentSnapshot(): SessionSnapshotLite
  currentTail(): readonly SessionEvent[]
  close(): Promise<void>
}

/**
 * Ticket 05 — incremental durable replay for a resume cursor the MEMORY tail
 * cannot serve. Merges the on-disk segment (`readFrom(resumeFromSeq)`) with
 * the retained in-memory tail BY SEQ — on a seq collision the tail's own live
 * object wins (identical content by the kernel's append-before-publish
 * contract, and the tail is what the live fan-out already carries) — and
 * accepts the result ONLY when it covers `(resumeFromSeq, tip]` densely:
 * exactly one event per seq, no duplicate, no hole (kernel seqs are dense by
 * construction — the same assumption the historical `oldestTailSeq - 1` gap
 * check encodes). Anything less — a punched log, an empty read, a throwing
 * reader (pre-neutralized by the bridge's guard), a cursor at/ahead of the
 * tip — returns undefined and the caller keeps the honest snapshot fallback.
 */
const planDurableReplay = (args: {
  readonly retainedTail: readonly SessionEvent[]
  readonly resumeFromSeq: number
  readonly tip: number
  readonly durableLog: SessionDurableEventLogReader
}): SessionEvent[] | undefined => {
  const { retainedTail, resumeFromSeq, tip, durableLog } = args
  // resume == tip is already served by the memory fast path; a cursor AHEAD of
  // the tip must keep the snapshot fallback — an "empty events-only" answer
  // here would recreate the stuck-with-nothing bug the ahead-of-tip guard
  // exists for (and log events BEYOND the bridge tip are never replayed: the
  // bridge has not fanned them out yet, so serving them would duplicate the
  // imminent live publish).
  if (resumeFromSeq >= tip) return undefined
  const bySeq = new Map<number, SessionEvent>()
  for (const event of durableLog.readFrom(resumeFromSeq)) {
    if (event.seq > resumeFromSeq && event.seq <= tip) bySeq.set(event.seq, event)
  }
  for (const event of retainedTail) {
    if (event.seq > resumeFromSeq) bySeq.set(event.seq, event)
  }
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  // Dense-coverage proof by integer pigeonhole: the map holds at most one
  // event per seq, every key lies inside (resumeFromSeq, tip], and that range
  // contains exactly `tip - resumeFromSeq` integers — so a count match means
  // every seq is present exactly once (a duplicate cannot mask a hole).
  if (merged.length !== tip - resumeFromSeq) return undefined
  return merged
}

export const planSessionReplay = ({
  snapshot,
  tail,
  resumeFromSeq,
  durableLog,
}: {
  readonly snapshot: SessionSnapshotLite
  readonly tail: readonly SessionEvent[]
  readonly resumeFromSeq?: number
  /** Ticket 05 — optional durable feed; consulted ONLY on the fallback trio. */
  readonly durableLog?: SessionDurableEventLogReader
}): SessionReplayPlan => {
  const retainedTail = tail.filter((event) => event.seq > snapshot.seq)
  if (resumeFromSeq === undefined) {
    return { snapshot, tail: retainedTail }
  }
  const tip = retainedTail.at(-1)?.seq ?? snapshot.seq
  const oldestTailSeq = retainedTail[0]?.seq
  // Memory fast path — IDENTICAL to the historical planner: the cursor sits
  // inside [snapshot.seq, tip] and the retained tail reaches back to it
  // contiguously (`oldestTailSeq - 1`), so the events-only answer comes from
  // memory alone and the durable log — even when present — is NOT consulted.
  const memoryServes =
    resumeFromSeq >= snapshot.seq &&
    resumeFromSeq <= tip &&
    (oldestTailSeq === undefined || resumeFromSeq >= oldestTailSeq - 1)
  if (memoryServes) {
    return {
      tail: retainedTail.filter((event) => event.seq > resumeFromSeq),
    }
  }
  // Fallback trio, historically all snapshot resets:
  //   behind-window  (resumeFromSeq < snapshot.seq — evicted into the snapshot),
  //   ahead-of-tip   (resumeFromSeq > tip — daemon restart / seq reset; without
  //                   the guard the client would get an EMPTY events-only plan
  //                   and be stuck with nothing),
  //   in-window gap  (resumeFromSeq < oldestTailSeq - 1 — tail eviction hole).
  // Ticket 05: a durable log rescues the rescuable ones with an incremental
  // event replay; whatever it cannot cover densely keeps the snapshot reset.
  const rescued =
    durableLog === undefined
      ? undefined
      : planDurableReplay({ retainedTail, resumeFromSeq, tip, durableLog })
  if (rescued !== undefined) {
    return { tail: rescued }
  }
  return { snapshot, tail: retainedTail }
}

const cloneSnapshot = (snapshot: SessionSnapshotLite): SessionSnapshotLite => ({
  ...snapshot,
  state: { ...snapshot.state },
  capabilities: { ...snapshot.capabilities },
  pendingApproval: snapshot.pendingApproval === null ? null : { ...snapshot.pendingApproval },
  openArtifacts: snapshot.openArtifacts.map((artifact) => ({ ...artifact })),
})

const trimTail = (
  snapshot: SessionSnapshotLite,
  tail: readonly SessionEvent[],
  tailLimit: number,
): SessionEvent[] => {
  const retained = tail.filter((event) => event.seq > snapshot.seq)
  return retained.length <= tailLimit ? [...retained] : retained.slice(retained.length - tailLimit)
}

const toEventMessages = (events: readonly SessionEvent[]): SessionTransportMessage[] =>
  events.map((event) => ({ kind: "event", event }))

const toRejectedMessage = (args: {
  readonly sessionId: string
  readonly target: SessionTransportRejectedMessage["target"]
  readonly reason: SessionTransportRejectedMessage["reason"]
  readonly command?: SessionCommand
  readonly error: SessionRejectError
}): SessionTransportRejectedMessage => ({
  kind: "rejected",
  sessionId: args.sessionId,
  target: args.target,
  reason: args.reason,
  ...(args.command !== undefined ? { commandId: args.command.commandId } : {}),
  ...(args.error instanceof SessionRevisionConflictError
    ? {
        expectedRevision: args.error.expectedRevision,
        actualRevision: args.error.actualRevision,
      }
    : {}),
  ...(args.error instanceof SessionProtocolValidationError ||
  args.error instanceof SessionDispatchFailedError
    ? { issue: args.error.issue }
    : {}),
})

/** Single source of the error→wire-reason mapping (shared by the admission
 *  rejects and the S5a dispatch-failure promotion). NOTE the reason set is
 *  CLOSED at 4 on the wire (old peers hard-check it — codec.ts), which is why
 *  dispatch failures ride `protocol_validation` instead of a new value. */
const rejectReasonOf = (error: SessionRejectError): SessionTransportRejectedMessage["reason"] =>
  error instanceof SessionDuplicateCommandError
    ? "duplicate_command"
    : error instanceof SessionRevisionConflictError
      ? "revision_conflict"
      : error instanceof SessionProtocolValidationError && error.issue === "session_id_mismatch"
        ? "session_id_mismatch"
        : "protocol_validation"

const currentRevisionOf = (snapshot: SessionSnapshotLite, tail: readonly SessionEvent[]): number =>
  tail.at(-1)?.revision ?? snapshot.revision

const rebuildCommandReplayIndex = (
  tail: readonly SessionEvent[],
): Map<string, readonly SessionEvent[]> => {
  const next = new Map<string, SessionEvent[]>()
  for (const event of tail) {
    if (event.causedByCommandId === undefined) continue
    const prior = next.get(event.causedByCommandId) ?? []
    prior.push(event)
    next.set(event.causedByCommandId, prior)
  }
  return next
}

export const createSessionTransportBridge = (
  opts: CreateSessionTransportBridgeOpts,
): SessionTransportBridge => {
  let closed = false
  let snapshot = cloneSnapshot(opts.snapshot)
  let tail = trimTail(snapshot, [], opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
  let commandReplayIndex = rebuildCommandReplayIndex(tail)
  // M18(a): the command-dedup window. Previously this Map only ever GREW —
  // a long-lived daemon session accumulated one entry per accepted command
  // forever, and the dedup window silently diverged from the BOUNDED replay
  // window (`commandReplayIndex`, derived from a `tailLimit`-capped tail). We
  // now bound the dedup window to the same magnitude (`tailLimit`) with FIFO
  // eviction. `pending` entries are pruned the moment the command reaches a
  // terminal transition (accepted → keep for dedup; errored → delete), and the
  // whole Map is capped so it cannot outgrow the replay window it guards.
  const commandStateCap = Math.max(1, opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
  const commandStates = new Map<string, "pending" | "accepted">()
  const recordCommandState = (commandId: string, state: "pending" | "accepted"): void => {
    // Re-insert to refresh FIFO recency on the accepted-terminal transition.
    commandStates.delete(commandId)
    while (commandStates.size >= commandStateCap) {
      const oldest = commandStates.keys().next().value
      if (oldest === undefined) break
      commandStates.delete(oldest)
    }
    commandStates.set(commandId, state)
  }
  type Peer = {
    readonly transport: SessionTransport
    unsubscribe: (() => void) | undefined
    closed: boolean
    connected: boolean
    /**
     * J-MED-1 (jul-16 종합/J audit) — the per-peer SEND-SERIALIZATION tail.
     * Every frame this peer receives — the connect handshake's replay answer
     * (snapshot / tail / durable rescue + the ticket-05 `resumed` marker), a
     * command's rejected/resync reply, and every live `publishEvents` /
     * `publishSnapshot` fan-out — is emitted inside a task threaded through
     * `enqueueSend`, so frames leave in strict enqueue order down a single
     * channel.
     *
     * WHY (the audited out-of-order bug): `connect` flips `connected = true`
     * SYNCHRONOUSLY and then `handleConnect` serves the replay through a chain
     * of `await peer.send(...)`; on an async transport a concurrent
     * `publishEvents` saw the peer already connected and interleaved its live
     * frames BETWEEN the replay frames (e.g. 12, 14, 13, resumed). Serializing
     * every emission makes the whole replay answer complete before any live
     * frame enqueued after the connect can run — WITHOUT the naive "flip
     * connected after replay" fix, which would instead DROP the live events
     * that arrive during the replay (they gate out and are never re-served):
     * here they simply queue behind the replay and flush after it.
     *
     * IDLE FAST-PATH: `enqueueSend` runs a task INLINE (no `.then` deferral)
     * when the channel is quiescent (`pendingSends === 0`), so the uncontended
     * case — the overwhelmingly common one, e.g. a reject reply with no
     * concurrent handshake — keeps its pre-fix same-tick send timing. The tail
     * only interposes when a send is genuinely in flight; that is exactly (and
     * only) when an interleave could otherwise occur.
     *
     * The tail is `.catch`-guarded (engine.ts `transportDispatchQueue`
     * precedent) so one poisoned send can never wedge the channel. Only frame
     * EMISSION rides it — command DISPATCH (`handleCommand` → `onCommand` →
     * kernel, which re-enters via `publishEvents`) stays OFF, so a dispatch
     * that publishes cannot deadlock waiting on its own enqueued fan-out
     * (ADR-0540 web-inline deadlock class).
     */
    sendChain: Promise<void>
    /** Count of send tasks currently queued-or-running on `sendChain`. Zero ⇒
     *  the channel is idle and `enqueueSend` may run the next task inline. */
    pendingSends: number
  }

  const peers = new Set<Peer>()

  /** Look up the live `Peer` record for a transport — the send helpers are
   *  handed the raw `SessionTransport`, but per-peer serialization needs the
   *  record's `sendChain`. A closed/unknown transport (none in `peers`) falls
   *  back to a direct send so teardown-time diagnostics are never swallowed. */
  const peerOf = (transport: SessionTransport): Peer | undefined => {
    for (const peer of peers) if (peer.transport === transport) return peer
    return undefined
  }

  /**
   * Emit `task`'s frames on the peer's serialized send channel and return the
   * awaitable run. When the channel is idle the task starts INLINE (preserving
   * the pre-J-MED-1 same-tick timing every send previously had); when a send is
   * already in flight the task chains onto the tail so it lands strictly after
   * it. `pendingSends` gates the two; the stored-back tail swallows the task's
   * own rejection so a failed send can never wedge the channel (the caller
   * still observes THIS task's outcome through the returned, un-caught promise).
   * A transport that is not a tracked peer (teardown race) runs the task
   * directly — there is no peer state left to keep ordered.
   */
  const enqueueSend = (transport: SessionTransport, task: () => Promise<void>): Promise<void> => {
    const peer = peerOf(transport)
    if (peer === undefined) return task()
    peer.pendingSends += 1
    const decrement = (): void => {
      peer.pendingSends -= 1
    }
    // Idle ⇒ run inline (this task IS the head of the chain); busy ⇒ chain.
    const run = peer.pendingSends === 1 ? task() : peer.sendChain.then(task)
    // The tail always advances so the NEXT enqueue serializes behind this one;
    // `.finally(decrement)` keeps `pendingSends` honest whichever branch ran.
    peer.sendChain = run.catch(() => undefined).finally(decrement)
    return run
  }

  const updateSnapshotState = (nextSnapshot: SessionSnapshotLite): void => {
    snapshot = cloneSnapshot(nextSnapshot)
    tail = trimTail(snapshot, tail, opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
    commandReplayIndex = rebuildCommandReplayIndex(tail)
  }

  const reportBridgeError = (peer: SessionTransport, error: unknown): void => {
    opts.onBridgeError?.({ peer, error })
  }

  const sendMessages = async (
    peer: SessionTransport,
    messages: readonly SessionTransportMessage[],
  ): Promise<void> => {
    for (const message of messages) {
      try {
        await peer.send(message)
      } catch (error) {
        reportBridgeError(peer, error)
        break
      }
    }
  }

  // Ticket 05 — the bridge owns the durable feed's ERROR POLICY: a throwing
  // reader is reported to `onBridgeError` and answers with an empty segment,
  // which can never pass the planner's dense-coverage check (the memory tail
  // alone always misses at least the snapshot's own seq on the fallback
  // paths) — so a broken port degrades to the snapshot fallback, loudly
  // surfaced client-side as `resume: "snapshot_fallback"`, instead of
  // crashing the connect path or silently pretending to have replayed.
  const durablePort = opts.durableLog
  const guardedDurableLog =
    durablePort === undefined
      ? undefined
      : (peer: SessionTransport): SessionDurableEventLogReader => ({
          readFrom: (afterSeq) => {
            try {
              return durablePort.readFrom(afterSeq)
            } catch (error) {
              reportBridgeError(peer, error)
              return []
            }
          },
        })

  /** Serve a replay plan and report HOW the peer's view was restored — the
   *  raw material of the ticket-05 `resumed` served-marker:
   *   - `mode`             — `"snapshot"` when a snapshot frame carried/reset
   *                          the state, `"replay"` for an events-only answer
   *                          (which includes the EMPTY caught-up answer);
   *   - `servedThroughSeq` — the seq the peer is current through once the
   *                          served frames are applied (the resume cursor
   *                          itself when the replay was empty — the trailing
   *                          `?? snapshot.seq` arm covers the no-cursor plan,
   *                          whose snapshot branch already answered). */
  const sendReplay = async (
    peer: SessionTransport,
    resumeFromSeq?: number,
  ): Promise<{ mode: "replay" | "snapshot"; servedThroughSeq: number }> => {
    const plan = planSessionReplay({
      snapshot,
      tail,
      ...(resumeFromSeq !== undefined ? { resumeFromSeq } : {}),
      ...(guardedDurableLog !== undefined ? { durableLog: guardedDurableLog(peer) } : {}),
    })
    const messages: SessionTransportMessage[] = []
    if (plan.snapshot !== undefined) {
      messages.push({ kind: "snapshot", snapshot: plan.snapshot })
    }
    messages.push(...toEventMessages(plan.tail))
    await sendMessages(peer, messages)
    return {
      mode: plan.snapshot !== undefined ? "snapshot" : "replay",
      servedThroughSeq:
        plan.tail.at(-1)?.seq ?? plan.snapshot?.seq ?? resumeFromSeq ?? snapshot.seq,
    }
  }

  const rejectCommand = async (
    peer: SessionTransport,
    command: SessionCommand,
    error:
      | SessionDuplicateCommandError
      | SessionProtocolValidationError
      | SessionRevisionConflictError,
  ): Promise<void> => {
    opts.onCommandRejected?.({ command, error })
    await sendMessages(peer, [
      toRejectedMessage({
        sessionId: snapshot.sessionId,
        target: "command",
        reason: rejectReasonOf(error),
        command,
        error,
      }),
    ])
    if (error instanceof SessionDuplicateCommandError) {
      const replay = commandReplayIndex.get(command.commandId)
      if (replay !== undefined && replay.length > 0) {
        await sendMessages(peer, toEventMessages(replay))
        return
      }
    }
    await sendReplay(peer)
  }

  /**
   * S5a (jul-16 ticket 01) — promote a DISPATCH-stage failure to a `rejected`
   * frame. Previously an accepted command whose dispatch threw (kernel reducer
   * validation like `empty_turn_input`, or a host crash) was only reported to
   * the SERVER-side `onBridgeError` hook: the issuing wire peer received no
   * frame at all and hung undiagnosed (the pre-existing silent bug this
   * closes). Encoding is S0-3: the CLOSED-4 reason `protocol_validation` +
   * the error's issue string (kernel issue verbatim; `dispatch_failed` for
   * non-protocol errors) — the only shape an already-shipped peer decodes.
   *
   * Deliberately FRAME-ONLY (contrast `rejectCommand`, which appends a resync
   * replay): a dispatch failure does not mean the peer's view is stale — the
   * command was admitted against the CURRENT revision — so no snapshot/tail
   * rides along (rejected-flood ⇒ no replay amplification).
   */
  const rejectDispatchFailure = async (
    peer: SessionTransport,
    command: SessionCommand,
    error: unknown,
  ): Promise<void> => {
    const rejection: SessionRejectError =
      error instanceof SessionProtocolValidationError ||
      error instanceof SessionRevisionConflictError
        ? error
        : new SessionDispatchFailedError({ commandId: command.commandId, cause: error })
    opts.onCommandRejected?.({ command, error: rejection })
    await sendMessages(peer, [
      toRejectedMessage({
        sessionId: snapshot.sessionId,
        target: "command",
        reason: rejectReasonOf(rejection),
        command,
        error: rejection,
      }),
    ])
  }

  const rejectConnect = async (
    peer: SessionTransport,
    error: SessionProtocolValidationError,
  ): Promise<void> => {
    await sendMessages(peer, [
      toRejectedMessage({
        sessionId: snapshot.sessionId,
        target: "connect",
        reason:
          error.issue === "session_id_mismatch" ? "session_id_mismatch" : "protocol_validation",
        error,
      }),
    ])
  }

  const handleConnect = async (
    peer: SessionTransport,
    message: SessionTransportConnectMessage,
  ): Promise<void> => {
    if (message.sessionId !== snapshot.sessionId) {
      await rejectConnect(peer, new SessionProtocolValidationError("session_id_mismatch"))
      return
    }
    const served = await sendReplay(peer, message.resumeFromSeq)
    // Ticket 05 — the `resumed` served-marker, EXACTLY ONCE per requesting
    // connect, strictly AFTER the whole replay answer (snapshot fallback,
    // incremental events, or an EMPTY caught-up replay — the zero-frame case
    // that made an ack-less resume handshake a structural forever-hang).
    // OPT-IN by the connect frame's `resumeAck`: every non-requesting flow
    // (attach CLI, raw-client resume, web frontends) keeps a byte-identical
    // wire; an already-shipped client that somehow received it would drop the
    // unknown kind silently (additive discipline, heartbeat precedent).
    if (message.resumeAck === true) {
      await sendMessages(peer, [
        {
          kind: "resumed",
          sessionId: snapshot.sessionId,
          servedThroughSeq: served.servedThroughSeq,
          mode: served.mode,
        },
      ])
    }
  }

  const handleCommand = async (peer: SessionTransport, command: SessionCommand): Promise<void> => {
    // J-MED-1 scope: command REPLIES (reject / dispatch-failure frames) send
    // DIRECT — they target only the issuing peer, and a command is only
    // processed AFTER that peer's handshake settled (the `connected` gate), so
    // a reply can never land mid-replay for a conforming client (sending a
    // command before the handshake completes is a protocol violation). The
    // ordering fix that J-MED-1 needs is on the fan-out that reaches OTHER peers
    // (`publishEvents` / `publishSnapshot` — those ride the per-peer send tail),
    // NOT on this peer's own reply. Command DISPATCH also stays off the tail (it
    // re-enters via `publishEvents`) to avoid the self-wait deadlock.
    if (command.sessionId !== snapshot.sessionId) {
      await rejectCommand(peer, command, new SessionProtocolValidationError("session_id_mismatch"))
      return
    }

    if (commandStates.has(command.commandId)) {
      await rejectCommand(peer, command, new SessionDuplicateCommandError(command.commandId))
      return
    }

    const actualRevision = currentRevisionOf(snapshot, tail)
    const expectedRevision = command.expectedRevision
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
      await rejectCommand(
        peer,
        command,
        new SessionRevisionConflictError(expectedRevision, actualRevision),
      )
      return
    }

    recordCommandState(command.commandId, "pending")
    try {
      await opts.onCommand?.(command)
      // Terminal transition: keep the accepted id in the (bounded) dedup window.
      recordCommandState(command.commandId, "accepted")
    } catch (error) {
      // Terminal transition: a failed command is pruned so a retry can re-run.
      commandStates.delete(command.commandId)
      // Server-side diagnostic channel is PRESERVED (additive change)…
      reportBridgeError(peer, error)
      // …and S5a promotes the failure to the issuing peer as a `rejected` frame
      // — the wire is no longer silent about a dispatch-stage error.
      await rejectDispatchFailure(peer, command, error)
    }
  }

  const closePeer = async (peer: Peer): Promise<void> => {
    if (peer.closed) return
    peer.closed = true
    peer.unsubscribe?.()
    peer.unsubscribe = undefined
    peers.delete(peer)
    try {
      await peer.transport.close()
    } catch (error) {
      reportBridgeError(peer.transport, error)
    }
  }

  return {
    sessionId: snapshot.sessionId,
    async connect(transport) {
      if (closed) {
        await transport.close()
        return { close: async () => undefined }
      }

      const peer: Peer = {
        transport,
        closed: false,
        connected: false,
        unsubscribe: undefined as Peer["unsubscribe"],
        sendChain: Promise.resolve(),
        pendingSends: 0,
      }
      // Track the peer BEFORE wiring `onMessage`, so a `connect` frame that
      // arrives synchronously inside `onMessage` can already resolve its
      // `Peer` record (and thus enqueue onto the real `sendChain`).
      peers.add(peer)
      peer.unsubscribe = transport.onMessage((message) => {
        switch (message.kind) {
          case "connect":
            // J-MED-1: flip `connected` AND enqueue the whole replay answer in
            // the SAME synchronous tick. Any `publishEvents` that later sees
            // `connected === true` necessarily enqueues its fan-out AFTER this
            // handshake task, so the replay (incl. the `resumed` marker) always
            // completes before the peer's first live frame — no interleave, and
            // no loss (the live frame is queued, not dropped). `handleConnect`
            // runs as ONE task so replay + resumed stay contiguous.
            peer.connected = true
            return enqueueSend(transport, () => handleConnect(transport, message))
          case "command":
            if (!peer.connected) {
              return enqueueSend(transport, () =>
                rejectConnect(transport, new SessionProtocolValidationError("handshake_required")),
              )
            }
            // Command DISPATCH + its issuing-peer REPLIES both send DIRECT (see
            // `handleCommand`): a command is post-handshake for a conforming
            // peer, so its reply never races that peer's replay. Only the
            // cross-peer fan-out (`publishEvents`/`publishSnapshot`) rides the
            // send tail — that is where J-MED-1's ordering guarantee lives.
            return handleCommand(transport, message.command)
          case "heartbeat":
            // jul-16 heartbeat hoist — a client keepalive `ping` is answered
            // with a typed `pong` (fire-and-forget) so EVERY session.v1 server
            // reachable through this bridge (serve --stdio + any attach) keeps
            // an idle client's liveness deadline reset. Consumed here (never
            // forwarded), so the bridge's connect/command contract is unchanged.
            // No handshake gate: a keepalive must work before/independent of a
            // connect (mirrors the web-daemon WS pump, which pongs pre-bridge).
            replyToHeartbeatOnTransport(transport, message)
            return
          default:
            return
        }
      })
      return {
        close: async () => closePeer(peer),
      }
    },
    updateSnapshot(nextSnapshot) {
      updateSnapshotState(nextSnapshot)
    },
    async publishSnapshot(nextSnapshot) {
      updateSnapshotState(nextSnapshot)
      const frame: SessionTransportMessage = { kind: "snapshot", snapshot }
      await Promise.all(
        [...peers]
          .filter((peer) => !peer.closed)
          // J-MED-1: fan out through the per-peer send tail so a snapshot push
          // cannot cut into a peer's in-flight handshake replay either.
          .map((peer) => enqueueSend(peer.transport, () => sendMessages(peer.transport, [frame]))),
      )
    },
    async publishEvents(events) {
      if (events.length === 0) return
      tail = trimTail(snapshot, [...tail, ...events], opts.tailLimit ?? DEFAULT_TAIL_LIMIT)
      commandReplayIndex = rebuildCommandReplayIndex(tail)
      const messages = toEventMessages(events)
      await Promise.all(
        [...peers]
          // Gate the live event fan-out on `peer.connected` — mirror the command
          // gate so a peer that has NOT completed its `connect` handshake never
          // receives a pre-handshake stray event (it gets its state via the
          // snapshot/replay path when its `connect` arrives, where the event is
          // already reflected in the retained tail). Already-connected peers
          // still receive every live event (fan-out unchanged for them).
          .filter((peer) => !peer.closed && peer.connected)
          // J-MED-1: enqueue the live fan-out onto the per-peer send tail. A
          // peer whose `connect` was accepted this same tick has its handshake
          // replay ALREADY on the tail (the dispatcher enqueues it before any
          // await), so this live frame lands strictly AFTER the whole replay
          // answer — the interleave is closed, and because the frame is QUEUED
          // (not gated out) nothing is lost.
          .map((peer) => enqueueSend(peer.transport, () => sendMessages(peer.transport, messages))),
      )
    },
    currentSnapshot() {
      return cloneSnapshot(snapshot)
    },
    currentTail() {
      return [...tail]
    },
    async close() {
      if (closed) return
      closed = true
      await Promise.all([...peers].map((peer) => closePeer(peer)))
    },
  }
}
