/**
 * session.v1 attach flow — handshake driver + approval round-trip (S3,
 * jul-16 transport-unified SDK ticket 01).
 *
 * HOISTED (moved, not copied) from `src/apps/cli/attach/{handshake,commands,
 * attach-client}.ts` so the CLI attach client and the public SDK `connect()`
 * door consume ONE implementation of:
 *
 *   1. the discovery→adopt CONNECT HANDSHAKE (`createAttachHandshake` — the
 *      pure frame-shaping driver, byte-identical to the attach original), plus
 *      `runSessionHandshake`, the connect()-side runner that drives it over a
 *      live transport and performs the ATOMIC cursor handover (R2 F9): the
 *      (snapshot, highest-observed-seq) pair is captured under one still-
 *      subscribed listener and released to the caller in a single synchronous
 *      `handoff()` — no frame can fall between the handshake listener and the
 *      raw client the caller creates in the same tick;
 *
 *   2. the APPROVAL FLOW (`createSessionApprovalFlow`): approval.requested →
 *      prompter → `approval.respond` → marker-gated `turn.run` re-issue
 *      (ADR-0540 W1-B `serverAutoContinues`), serialized so two overlapping
 *      approvals never interleave their prompts. The decision shape is the
 *      attach surface's rich answer (`SessionApprovalAnswer`, ex
 *      `AttachApprovalAnswer`) — deliberately REUSED, not re-invented (audit
 *      M-3; it mirrors `ApprovalRespondCommand`'s wire verbs). The flow
 *      REPORTS a re-issued continuation commandId through
 *      `onContinuationIssued` — the supply side of the SessionHandle's §3.2
 *      succession contract (`reportApprovalContinuation`).
 *
 * The CLI attach client is now a CONSUMER of this module (its unit/e2e suites
 * run unmodified — the behavior-preservation proof for the move).
 */

import type {
  CapabilityManifest,
  PendingApprovalView,
  SessionCommand,
  SessionEvent,
} from "@/protocol/session"
import {
  type ApprovalRespondCommand,
  buildApprovalRespond,
  buildTurnRun,
  type CommandBuildDeps,
  type SessionSnapshotLite,
} from "@/protocol/session"
import type { SessionTransportConnectionResume } from "./client"
import { typedErrorFromRejectedMessage } from "./errors"
import type { SessionTransport, SessionTransportMessage } from "./types"

/** Matches the frontend's discovery sentinel verbatim — the bridge keys its
 *  mismatch-reject off "not the canonical id", and the sentinel is simply a
 *  non-empty placeholder that can never equal a real (uuid-shaped) id. */
export const HANDSHAKE_DISCOVERY_SESSION_ID = "ui-session"

/** Ticket 05 — door-level resume knob for {@link createAttachHandshake}. */
export interface AttachHandshakeOpts {
  /** Carry this resume cursor (plus the `resumeAck` served-marker request) on
   *  EVERY connect frame this driver mints — the initial discovery frame and
   *  the id-adoption re-handshake alike. Absent ⇒ the historical bare frames
   *  (byte-identical wire; the attach CLI stays resume-free by design). */
  readonly resumeFromSeq?: number
}

export interface AttachHandshake {
  /** Canonical, server-minted session id once learned; `undefined` until then. */
  readonly sessionId: string | undefined
  /** True once a snapshot OR (ticket 05) a `resumed` served-marker has settled
   *  the handshake (commands may now flow). */
  readonly ready: boolean
  /** Ticket 05 — how a RESUME handshake was served, derived from the
   *  `resumed` marker's authoritative `mode` (set exactly once, when the
   *  marker settles the handshake): `"replayed"` = events-only restore (empty
   *  caught-up replay included), `"snapshot_fallback"` = a snapshot frame
   *  carried/reset the state. `undefined` until settled, and always
   *  `undefined` on a non-resume handshake. */
  readonly resumeOutcome: SessionTransportConnectionResume | undefined
  /** ADR-0540 W1-B — the daemon's capability manifest, retained from the
   *  handshake snapshot (`undefined` until one arrives). The attach client
   *  gates its post-approval `turn.run` re-issue on
   *  `capabilities.serverAutoContinues` (marker true ⇒ the DAEMON re-issues). */
  readonly capabilities: CapabilityManifest | undefined
  /** AUDIT-γ H2 — the attached session's model slug, retained from the handshake
   *  snapshot (`snapshot.state.modelSlug`; `undefined` until a snapshot arrives
   *  or when the state carries none). The attach client renders the
   *  `[session · <model>]` pill from THIS once the handshake settles, because
   *  the engine no longer fans `session.created` to the transport bridge. */
  readonly modelSlug: string | undefined
  /** Build the FIRST connect frame (discovery sentinel). */
  initialConnect(): SessionTransportMessage
  /**
   * Feed an inbound transport message. Returns a `connect` frame to SEND when
   * the handshake must re-issue (canonical id just adopted), else `undefined`.
   */
  onMessage(message: SessionTransportMessage): SessionTransportMessage | undefined
}

export const createAttachHandshake = (opts: AttachHandshakeOpts = {}): AttachHandshake => {
  let sessionId: string | undefined
  let ready = false
  let capabilities: CapabilityManifest | undefined
  let modelSlug: string | undefined
  let resumeOutcome: SessionTransportConnectionResume | undefined

  // Every connect frame this driver mints carries the SAME resume posture:
  // bare (historical, byte-identical) without opts, cursor + `resumeAck`
  // served-marker request with them (ticket 05 — the id-adoption re-handshake
  // is the frame the bridge actually answers, so BOTH frames must carry it).
  const connectFrame = (sid: string): SessionTransportMessage => ({
    kind: "connect",
    sessionId: sid,
    ...(opts.resumeFromSeq !== undefined
      ? { resumeFromSeq: opts.resumeFromSeq, resumeAck: true as const }
      : {}),
  })

  // NOTE (attach scope): the CLI attach client keeps NO reconnect/resume path.
  // A joining client performs the discovery→adopt dance ONCE; a daemon-
  // initiated close exits the CLI cleanly (see attach-client.ts close/error
  // listeners) rather than silently re-dialing — it constructs this driver
  // WITHOUT opts, so its wire is byte-identical to the pre-05 handshake.
  //
  // Ticket 05 lifted the old structural KILL for the SDK door: `ready` used to
  // settle only on a SNAPSHOT frame while the bridge answers a servable resume
  // cursor with events-only (ZERO frames at cursor==tip), so a resume-carrying
  // handshake pended forever. The `resumed` served-marker (requested via the
  // connect frame's `resumeAck`, emitted by the bridge strictly AFTER the
  // whole replay answer — fallback snapshot, incremental events, or nothing)
  // is the missing ack. A RESUME handshake settles on the MARKER ONLY (a
  // fallback snapshot no longer settles it early): that makes the settle
  // point deterministic — every replay frame precedes the marker on an
  // ordered transport, so the runner's handover buffer provably holds the
  // WHOLE served window — and makes the outcome authoritative (`mode` from
  // the marker, never inferred from a possibly-stray first frame). The cost
  // is honest: a resume against a daemon shipped WITHOUT the marker cannot
  // settle — the same version-skew posture as every other capability gap.
  const resuming = opts.resumeFromSeq !== undefined

  return {
    get sessionId() {
      return sessionId
    },
    get ready() {
      return ready
    },
    get capabilities() {
      return capabilities
    },
    get modelSlug() {
      return modelSlug
    },
    get resumeOutcome() {
      return resumeOutcome
    },
    initialConnect() {
      return connectFrame(sessionId ?? HANDSHAKE_DISCOVERY_SESSION_ID)
    },
    onMessage(message) {
      switch (message.kind) {
        case "rejected": {
          // Only a CONNECT-target reject carries the canonical id for adoption;
          // a COMMAND-target reject (dedup / revision / validation) is handled
          // elsewhere and never re-drives the handshake.
          if (
            message.target === "connect" &&
            message.sessionId.length > 0 &&
            message.sessionId !== HANDSHAKE_DISCOVERY_SESSION_ID &&
            sessionId !== message.sessionId
          ) {
            sessionId = message.sessionId
            // Re-handshake to the canonical id (same resume posture as the
            // discovery frame — the bridge answers THIS one with the replay).
            return connectFrame(sessionId)
          }
          return undefined
        }
        case "snapshot": {
          // A server may answer the discovery connect with a snapshot directly
          // (no reject) — adopt the id from the snapshot in that case.
          if (sessionId === undefined || sessionId !== message.snapshot.sessionId) {
            sessionId = message.snapshot.sessionId
          }
          // ADR-0540 W1-B — retain the manifest (latest snapshot wins) so the
          // client can gate its post-approval re-issue on `serverAutoContinues`.
          capabilities = message.snapshot.capabilities
          // AUDIT-γ H2 — retain the model slug (latest snapshot wins) so the
          // client can render the connection pill from the snapshot; the engine
          // no longer fans `session.created` to the transport bridge.
          modelSlug = message.snapshot.state.modelSlug
          // Ticket 05 — a RESUME handshake does NOT settle on a snapshot (a
          // fallback answer is snapshot → tail → marker; settling here would
          // hand over before the served window finished). The marker below is
          // the only settle arm; this frame is retained as state.
          if (!resuming) ready = true
          return undefined
        }
        case "resumed": {
          // Ticket 05 — the served-marker: the bridge finished serving THIS
          // connect's replay (possibly zero frames). Only a REQUESTING
          // handshake may settle on it (a non-resume driver never asked — an
          // unsolicited marker is ignored like any other unknown-to-this-flow
          // frame). Adopt the canonical id if the reject leg was skipped and
          // take the AUTHORITATIVE outcome from the reported mode — the arm
          // that makes the caught-up (zero-frame) resume terminate instead of
          // hanging.
          if (!resuming) return undefined
          if (sessionId === undefined) {
            sessionId = message.sessionId
          }
          if (resumeOutcome === undefined) {
            resumeOutcome = message.mode === "replay" ? "replayed" : "snapshot_fallback"
          }
          ready = true
          return undefined
        }
        default:
          return undefined
      }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Answer → wire mapping (moved from attach)                                   */
/* ------------------------------------------------------------------------- */

/** UUX-1-19 (jul-10 W4) — the attach prompter's RICH decision, mirroring what
 *  the wire (`ApprovalRespondCommand`) actually carries: the kernel scheduler
 *  forwards `scope` + `steer` verbatim to `host.resolveApproval`, so the
 *  attach surface can offer [a]lways-session and deny+s[t]eer as first-class
 *  verbs instead of collapsing everything onto y/N. A plain string answer is
 *  the LEGACY shape (y/yes ⇒ approve, else deny) and stays accepted. */
export interface SessionApprovalAnswer {
  readonly decision: "approve" | "deny"
  /** Only meaningful on `approve` (the wire's standing-grant scopes). */
  readonly scope?: "once" | "session" | "session_prefix"
  /** Only meaningful on `deny` (the wire's corrective steer). */
  readonly steer?: string
}

/** Fallback clock for {@link CommandBuildDeps}. Every caller supplies an
 *  explicit `issuedAt` via builder meta, so this is dormant by construction —
 *  it exists because the deps shape (rightly) demands a clock. */
const FLOW_CLOCK: CommandBuildDeps["clock"] = { now: () => new Date() }

export interface BuildApprovalRespondArgs {
  readonly sessionId: string
  readonly approvalId: string
  /** Raw operator answer (`"y"` / `"yes"` ⇒ approve; anything else ⇒ deny). */
  readonly answer: string
  readonly commandId: string
  readonly issuedAt: string
}

const isAffirmative = (answer: string): boolean => {
  const a = answer.trim().toLowerCase()
  return a === "y" || a === "yes"
}

/** LEGACY string-answer mapping (y/yes ⇒ approve, everything else ⇒ deny —
 *  fail-safe for a dangerous op awaiting confirmation). */
export const buildApprovalRespondCommand = (
  args: BuildApprovalRespondArgs,
): ApprovalRespondCommand =>
  buildApprovalRespond(
    { sessionId: args.sessionId, clock: FLOW_CLOCK },
    args.approvalId,
    isAffirmative(args.answer) ? "approve" : "deny",
    { commandId: args.commandId, issuedAt: args.issuedAt },
  )

/** UUX-1-19 — map the prompter's answer onto the wire. A STRING answer keeps
 *  the legacy y/N mapping ({@link buildApprovalRespondCommand}, byte-identical);
 *  a rich {@link SessionApprovalAnswer} carries `scope`/`steer` verbatim — the
 *  kernel scheduler forwards both to `host.resolveApproval`. A steer is only
 *  attached to a DENY and never as an empty string (the normalizer SSOT's
 *  no-phantom-steer rule, mirrored at the wire boundary) — that policy stays
 *  HERE; `buildApprovalRespond` owns only the wire assembly. */
export const buildRespondForAnswer = (args: {
  readonly sessionId: string
  readonly approvalId: string
  readonly answer: string | SessionApprovalAnswer
  readonly commandId: string
  readonly issuedAt: string
}): ApprovalRespondCommand => {
  const { sessionId, approvalId, answer, commandId, issuedAt } = args
  if (typeof answer === "string") {
    return buildApprovalRespondCommand({ sessionId, approvalId, answer, commandId, issuedAt })
  }
  return buildApprovalRespond({ sessionId, clock: FLOW_CLOCK }, approvalId, answer.decision, {
    commandId,
    issuedAt,
    ...(answer.decision === "approve" && answer.scope !== undefined ? { scope: answer.scope } : {}),
    ...(answer.decision === "deny" && answer.steer !== undefined && answer.steer.trim().length > 0
      ? { steer: answer.steer }
      : {}),
  })
}

/* ------------------------------------------------------------------------- */
/* Approval flow (moved from attach-client's approval.requested block)         */
/* ------------------------------------------------------------------------- */

export interface SessionApprovalFlowDeps {
  /** Bounded readiness gate (the attach read-loop's `waitForReady`). Resolving
   *  `false` ⇒ the approval is structurally unanswerable (handshake never
   *  settled) and `onUnanswerable` fires — fail CLOSED, the daemon's own lease
   *  keeps the ask denied-by-silence. Already-ready callers pass
   *  `async () => true`. */
  readonly waitForReady: () => Promise<boolean>
  /** Canonical session id once adopted (`undefined` ⇒ unanswerable). */
  readonly sessionId: () => string | undefined
  /** LATEST-known ADR-0540 W1-B marker (read at respond time, not captured at
   *  subscribe time — a mid-session snapshot may update it). */
  readonly serverAutoContinues: () => boolean
  /** The operator/consumer seam. A throwing/garbage prompter fail-safes to a
   *  literal `"n"` ⇒ DENY — never approve, never hang. */
  readonly promptApproval: (
    reason: string,
    approval: PendingApprovalView,
  ) => Promise<string | SessionApprovalAnswer>
  readonly sendCommand: (command: SessionCommand) => Promise<void>
  readonly newCommandId: () => string
  readonly issuedAt: () => string
  /** The approval arrived but can never be answered (no handshake). */
  readonly onUnanswerable?: (reason: string) => void
  /** The `approval.respond` send failed (dead socket) — LOUD and terminal on
   *  the attach surface (latch sendBroken + banner); the follow-up re-issue is
   *  never attempted against the dead pipe. Receives the `approvalId` so a
   *  handle-owning caller can settle that approval's turn chain typed (jul-16
   *  audit M-1 — the decision never reached the server, so no continuation
   *  can ever exist); arity-0 consumers (the attach client) stay assignable. */
  readonly onRespondSendFailed?: (approvalId: string) => void
  /** §3.2 succession supply: the marker-OFF continuation `turn.run` was
   *  SUBMITTED as `commandId` for `approvalId` — report it into the handle's
   *  chain (`SessionHandle.reportApprovalContinuation`). */
  readonly onContinuationIssued?: (approvalId: string, commandId: string) => void
  /** The continuation could not be submitted — the chain has no successor
   *  (`SessionHandle.reportApprovalContinuationFailure` = typed hang-guard).
   *  ABSENT ⇒ the failure is swallowed (the attach client's historical
   *  behavior: its close/error listeners own the teardown). */
  readonly onContinuationFailed?: (approvalId: string, error: unknown) => void
}

export interface SessionApprovalFlow {
  /** Enqueue one approval round-trip. Serialized: two near-simultaneous
   *  requests never garble the prompt — each awaits the prior (the attach
   *  surface's `approvalChain` semantics, moved verbatim). */
  handleApprovalRequested(approval: PendingApprovalView): void
  /** Resolves when every round-trip enqueued SO FAR has settled. */
  settled(): Promise<void>
}

export const createSessionApprovalFlow = (deps: SessionApprovalFlowDeps): SessionApprovalFlow => {
  let chain: Promise<void> = Promise.resolve()

  const runOne = async (approval: PendingApprovalView): Promise<void> => {
    const reason = approval.reason
    // WS-B (jul-10, UUX-3-03) — a PRE-HANDSHAKE approval is not silently
    // dropped: wait (bounded by the caller's gate) for readiness and resolve
    // the canonical id then. Only when the handshake never completes do we
    // fail CLOSED with a visible notice.
    const ready = await deps.waitForReady()
    const sid = deps.sessionId()
    if (!ready || sid === undefined) {
      deps.onUnanswerable?.(reason)
      return
    }
    // A throwing/garbage prompter fail-safes to a literal "n" so the approval
    // is DENIED, never approved and never left hanging. (attach finding #5)
    const answer = await deps.promptApproval(reason, approval).catch(() => "n")
    const respond = buildRespondForAnswer({
      sessionId: sid,
      approvalId: approval.approvalId,
      answer,
      commandId: deps.newCommandId(),
      issuedAt: deps.issuedAt(),
    })
    // Audit R3 MED-2 — a respond send failure must be LOUD and terminal
    // (parity with the line-input path); never fire the follow-up turn.run
    // against a dead socket.
    try {
      await deps.sendCommand(respond)
    } catch {
      deps.onRespondSendFailed?.(approval.approvalId)
      return
    }
    // ADR-0512 P3 — the kernel does NOT auto-continue a resolved approval: a
    // fresh `turn.run` is what claims the grant and re-dispatches the approved
    // tool. So on APPROVE, re-run the suspended turn (a bare `turn.run`).
    // A deny aborts ⇒ no continuation.
    // ADR-0540 W1-B — UNLESS the daemon declared the `serverAutoContinues`
    // capability marker: then the DAEMON re-issues the continuation and this
    // client must not (defensive read ⇒ a legacy daemon without the field
    // keeps the client-owned re-issue, byte-identical).
    if (respond.decision === "approve" && !deps.serverAutoContinues()) {
      const continuation = buildTurnRun(
        { sessionId: sid, clock: FLOW_CLOCK },
        { commandId: deps.newCommandId(), issuedAt: deps.issuedAt() },
      )
      try {
        await deps.sendCommand(continuation)
        deps.onContinuationIssued?.(approval.approvalId, continuation.commandId)
      } catch (error) {
        deps.onContinuationFailed?.(approval.approvalId, error)
      }
    }
  }

  return {
    handleApprovalRequested(approval) {
      chain = chain.then(() => runOne(approval))
    },
    settled() {
      return chain
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Handshake runner (connect()-side) — atomic cursor handover (R2 F9)          */
/* ------------------------------------------------------------------------- */

/** What the handshake observed, released ATOMICALLY (one synchronous call
 *  that unsubscribes the handshake listener and returns the state — the
 *  caller creates its raw client in the SAME tick, so no frame can fall
 *  between the two subscriptions). */
export interface SessionHandshakeHandoff {
  readonly sessionId: string
  readonly snapshot: SessionSnapshotLite
  /** Highest seq observed across the snapshot AND any tail events that
   *  streamed while the handshake listener was still attached — seed the raw
   *  client's `resumeFromSeq` with THIS (not `snapshot.seq`) or the cursor
   *  lags by the handshake window. */
  readonly lastSeq: number
  /** M-2 (jul-16 audit) — the HANDSHAKE-WINDOW tail: event frames observed
   *  AFTER the snapshot while the handshake listener was still attached. On a
   *  stdio door the snapshot and its tail can arrive in ONE synchronously-
   *  dispatched chunk, so these frames were CONSUMED before the caller's own
   *  subscription could exist — the caller must re-deliver them (see
   *  `CreateSessionHandleOpts.replayEvents`) or they are silently lost. */
  readonly events: readonly SessionEvent[]
}

export interface RunSessionHandshakeResult {
  /** Resolves when a snapshot settled the handshake; rejects TYPED when the
   *  server refused the connect for a non-adoption reason (e.g. the S5b
   *  version-skew echo ⇒ `SessionProtocolVersionError`). */
  readonly ready: Promise<void>
  /** Atomic handover — call ONCE after `ready`; unsubscribes the handshake
   *  listener and returns the observed (sessionId, snapshot, cursor, tail). */
  handoff(): SessionHandshakeHandoff
  /** Abandon a never-settling handshake (unsubscribes; safe to call twice). */
  abort(): void
}

/** Ticket 05 — what a RESUME handshake hands over. Unlike the full-connect
 *  {@link SessionHandshakeHandoff}, `snapshot` is OPTIONAL: an events-only
 *  (or empty caught-up) replay carries NO snapshot frame — state continuity
 *  is the point — and only the fallback demotion produces one. */
export interface SessionResumeHandshakeHandoff {
  readonly sessionId: string
  /** Present ONLY when the bridge demoted the resume to a snapshot reset. */
  readonly snapshot?: SessionSnapshotLite
  /** Highest seq observed across replayed events, any fallback snapshot AND
   *  the `resumed` marker's `servedThroughSeq` — on an EMPTY caught-up replay
   *  the marker is the only carrier, seeding the cursor at the resume point. */
  readonly lastSeq: number
  /** The replayed disconnect-window events (M-2 re-delivery contract — the
   *  caller must feed them to `CreateSessionHandleOpts.replayEvents` or the
   *  gap the resume exists to deliver is silently lost). */
  readonly events: readonly SessionEvent[]
  /** How the view was restored — the R2-F5 surfacing channel's payload. */
  readonly resume: SessionTransportConnectionResume
}

export interface RunSessionResumeHandshakeResult {
  readonly ready: Promise<void>
  handoff(): SessionResumeHandshakeHandoff
  abort(): void
}

/**
 * Shared runner core. In RESUME mode (`resumeFromSeq` present) the driver's
 * connect frames carry the cursor + the `resumeAck` served-marker request, and
 * `ready` settles on a SNAPSHOT **or** a `resumed` frame — the marker is what
 * turned the jul-16 audit's structural forever-hang (events-only replay, ZERO
 * frames at cursor==tip, no ack in the protocol) into a deterministic settle.
 * Without a cursor the behavior is the historical snapshot-only handshake,
 * byte-identical on the wire.
 */
const runSessionHandshakeCore = (args: {
  readonly transport: SessionTransport
  readonly resumeFromSeq?: number
}) => {
  const resumeFromSeq = args.resumeFromSeq
  const handshake = createAttachHandshake(resumeFromSeq !== undefined ? { resumeFromSeq } : {})
  let lastSeq = resumeFromSeq ?? 0
  let snapshot: SessionSnapshotLite | undefined
  let settled = false
  const tailEvents: SessionEvent[] = []

  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      settled = true
      resolve()
    }
    rejectReady = (error) => {
      settled = true
      reject(error)
    }
  })

  // Track the cursor across EVERYTHING observed while we own the listener —
  // the atomic-handover guarantee is exactly this accumulation. Post-snapshot
  // events are ALSO buffered for the caller (M-2 — see the handoff docblock);
  // in RESUME mode every event is buffered (an events-only replay has NO
  // snapshot to key on, and those events ARE the disconnect window the resume
  // exists to deliver), and the `resumed` marker's `servedThroughSeq` feeds
  // the cursor (the ONLY carrier on an empty caught-up replay).
  const trackCursor = (message: SessionTransportMessage): void => {
    if (message.kind === "snapshot") {
      snapshot = message.snapshot
      lastSeq = Math.max(lastSeq, message.snapshot.seq)
    } else if (message.kind === "event") {
      lastSeq = Math.max(lastSeq, message.event.seq)
      if (snapshot !== undefined || resumeFromSeq !== undefined) tailEvents.push(message.event)
    } else if (message.kind === "resumed") {
      lastSeq = Math.max(lastSeq, message.servedThroughSeq)
    }
  }

  // A connect-target reject the DRIVER ignored will never settle the
  // handshake — fail TYPED instead of hanging: a non-mismatch reason (the S5b
  // version-skew echo lands here as `bad_version`), or (self-audit hang-guard)
  // a mismatch for the id we ALREADY adopted — the server refuses its own
  // canonical id, so re-connecting would loop forever.
  const rejectIfUnrecoverable = (message: SessionTransportMessage): void => {
    if (message.kind !== "rejected" || message.target !== "connect") return
    if (
      message.reason !== "session_id_mismatch" ||
      (handshake.sessionId !== undefined && message.sessionId === handshake.sessionId)
    ) {
      rejectReady(typedErrorFromRejectedMessage(message))
    }
  }

  const unsubscribe = args.transport.onMessage((message) => {
    trackCursor(message)
    const reaction = handshake.onMessage(message)
    if (reaction !== undefined) {
      void args.transport.send(reaction).catch(() => undefined)
      return
    }
    if (settled) return
    if (handshake.ready) {
      resolveReady()
      return
    }
    rejectIfUnrecoverable(message)
  })

  void args.transport.send(handshake.initialConnect()).catch((error: unknown) => {
    if (!settled) rejectReady(error)
  })

  return {
    ready,
    handoff() {
      unsubscribe()
      const sid = handshake.sessionId
      if (sid === undefined) {
        throw new Error("runSessionHandshake.handoff() called before the handshake settled")
      }
      return {
        sessionId: sid,
        snapshot,
        lastSeq,
        events: [...tailEvents],
        resumeOutcome: handshake.resumeOutcome,
      }
    },
    abort() {
      unsubscribe()
    },
  }
}

/**
 * Full-connect handshake runner (the historical, resume-free entrypoint —
 * byte-identical wire). `ready` settles on the snapshot; the handoff's
 * `snapshot` is guaranteed present.
 */
export const runSessionHandshake = (args: {
  readonly transport: SessionTransport
}): RunSessionHandshakeResult => {
  const core = runSessionHandshakeCore({ transport: args.transport })
  return {
    ready: core.ready,
    handoff(): SessionHandshakeHandoff {
      const handover = core.handoff()
      if (handover.snapshot === undefined) {
        // Unreachable on the snapshot-settled path — kept as a loud invariant.
        throw new Error("runSessionHandshake.handoff() called before the handshake settled")
      }
      return {
        sessionId: handover.sessionId,
        snapshot: handover.snapshot,
        lastSeq: handover.lastSeq,
        events: handover.events,
      }
    },
    abort: core.abort,
  }
}

/**
 * Ticket 05 — RESUME handshake runner: the door-level
 * `connect({resumeFromSeq})` path. Rides the same driver with the cursor +
 * `resumeAck` on the connect frames; `ready` settles on a snapshot OR the
 * `resumed` served-marker (the empty caught-up replay settles DETERMINISTICALLY
 * — the case the jul-16 audit killed as a structural hang). The handoff
 * additionally reports the honest resume outcome (`"replayed"` /
 * `"snapshot_fallback"` — silent demotion is banned by ticket 05 acceptance).
 */
export const runSessionResumeHandshake = (args: {
  readonly transport: SessionTransport
  readonly resumeFromSeq: number
}): RunSessionResumeHandshakeResult => {
  const core = runSessionHandshakeCore(args)
  return {
    ready: core.ready,
    handoff(): SessionResumeHandshakeHandoff {
      const handover = core.handoff()
      if (handover.resumeOutcome === undefined) {
        // Unreachable once settled: BOTH settle arms (snapshot / resumed) mint
        // an outcome on a resume handshake — kept as a loud invariant.
        throw new Error("runSessionResumeHandshake.handoff() called before the handshake settled")
      }
      return {
        sessionId: handover.sessionId,
        ...(handover.snapshot !== undefined ? { snapshot: handover.snapshot } : {}),
        lastSeq: handover.lastSeq,
        events: handover.events,
        resume: handover.resumeOutcome,
      }
    },
    abort: core.abort,
  }
}
