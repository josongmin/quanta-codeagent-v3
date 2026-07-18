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
import { typedErrorFromRejectedMessage } from "./errors"
import type { SessionTransport, SessionTransportMessage } from "./types"

/** Matches the frontend's discovery sentinel verbatim — the bridge keys its
 *  mismatch-reject off "not the canonical id", and the sentinel is simply a
 *  non-empty placeholder that can never equal a real (uuid-shaped) id. */
export const HANDSHAKE_DISCOVERY_SESSION_ID = "ui-session"

export interface AttachHandshake {
  /** Canonical, server-minted session id once learned; `undefined` until then. */
  readonly sessionId: string | undefined
  /** True once a snapshot has settled the handshake (commands may now flow). */
  readonly ready: boolean
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

const connectFrame = (sessionId: string): SessionTransportMessage => ({
  kind: "connect",
  sessionId,
})

export const createAttachHandshake = (): AttachHandshake => {
  let sessionId: string | undefined
  let ready = false
  let capabilities: CapabilityManifest | undefined
  let modelSlug: string | undefined

  // NOTE (v1 scope): this driver has NO reconnect/resume path. A joining client
  // performs the discovery→adopt dance ONCE; a daemon-initiated close exits the
  // CLI cleanly (see attach-client.ts close/error listeners) rather than
  // silently re-dialing. The frontend's resume-cursor (`resumeFromSeq`) is
  // therefore deliberately omitted — both the initial AND the re-handshake
  // (id-adoption) connect frames are bare. `runSessionHandshake` below is
  // equally resume-free BY STRUCTURE (jul-16 audit KILL): its `ready` settles
  // only on a SNAPSHOT frame, while the bridge answers a servable resume
  // cursor with events-only — zero frames when the cursor is already at tip
  // (`planSessionReplay`) — so a resume-carrying handshake would pend forever.
  // session.v1 has no ack frame that could signal "caught up"; door-level
  // resume is ticket 05's, riding the raw client's `connect({resumeFromSeq})`
  // resume watcher instead of this handshake.

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
            // Re-handshake to the canonical id — bare (no resume cursor; the
            // discovery bootstrap never resumes and there is no reconnect path).
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

/**
 * NO RESUME CURSOR by design (jul-16 audit KILL — honest descope): this
 * runner's `ready` can only settle on a SNAPSHOT frame, but the bridge
 * answers a servable `resumeFromSeq` with an EVENTS-ONLY replay — zero frames
 * when the cursor is already at tip (`planSessionReplay`), which is exactly
 * the "reconnect right after a drop" base case. session.v1 carries no ack
 * frame that could tell a caught-up resume apart from a dead server, so a
 * resume-carrying handshake is a STRUCTURAL forever-hang, not a feature gap.
 * Door-level resume is ticket 05's, riding the raw client's
 * `connect({resumeFromSeq})` resume watcher (arm→send + resume-outcome
 * surfacing) — not this handshake.
 */
export const runSessionHandshake = (args: {
  readonly transport: SessionTransport
}): RunSessionHandshakeResult => {
  const handshake = createAttachHandshake()
  let lastSeq = 0
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
  // events are ALSO buffered for the caller (M-2 — see the handoff docblock).
  const trackCursor = (message: SessionTransportMessage): void => {
    if (message.kind === "snapshot") {
      snapshot = message.snapshot
      lastSeq = Math.max(lastSeq, message.snapshot.seq)
    } else if (message.kind === "event") {
      lastSeq = Math.max(lastSeq, message.event.seq)
      if (snapshot !== undefined) tailEvents.push(message.event)
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
      if (sid === undefined || snapshot === undefined) {
        throw new Error("runSessionHandshake.handoff() called before the handshake settled")
      }
      return { sessionId: sid, snapshot, lastSeq, events: [...tailEvents] }
    },
    abort() {
      unsubscribe()
    },
  }
}
