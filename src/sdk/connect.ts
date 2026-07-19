/**
 * `connect({ transport })` — the PUBLIC wire door onto session.v1
 * (S2c, jul-16 transport-unified SDK ticket 01; design SSOT: MASTER §3).
 *
 * One call, three layers composed from the EXISTING substrate (re-use, no
 * re-invention):
 *
 *   1. transport   — `transports.ws(...)` (the daemon's attach endpoint,
 *      same auth + same handshake as `quanta attach`) or
 *      `transports.stdio(...)` (the Codex-sidecar shape — spawn-owning
 *      transport, ticket 01 S4; the child's `serve --stdio` maturity gate is
 *      ticket 02's and is NEVER auto-injected here);
 *   2. handshake   — the hoisted attach flow (`runSessionHandshake`):
 *      discovery sentinel → rejected(canonical id) → re-connect → snapshot.
 *      The raw client is created AFTER the handshake with the canonical id
 *      and the ATOMICALLY handed-over cursor (R2 F9 — `lastSeq()` never lags
 *      the handshake window);
 *   3. handle      — `createSessionHandle` (verbs → submitted receipts,
 *      `awaitTurnEnd` §3.2 succession, liveness, typed rejected channel).
 *
 * `onApproval` delegates to the SAME hoisted approval flow the CLI attach
 * client runs (approval.requested → decision → `approval.respond` →
 * ADR-0540 marker-gated `turn.run` re-issue), with the re-issued commandId
 * REPORTED into the handle's succession chain. The decision type is the
 * existing `ApprovalDecisionResult` SSOT (`@/runner/orchestrate`) — no fourth
 * decision shape (audit M-3); it is normalized through the SSOT normalizer,
 * and a throwing/garbage `onApproval` fail-safes to DENY (never approve,
 * never hang).
 *
 * Deliberately NOT provided (honest v1, ticket 01 §1): in-process transports
 * (external in-process = `createAnalysisAgent`; `toSessionHandle` is an
 * internal conformance oracle, MASTER §3.3) · automatic reconnect.
 *
 * RESUME (ticket 05 — the jul-16 descope, now properly closed): a
 * `resumeFromSeq`-carrying connect() rides `runSessionResumeHandshake`, whose
 * connect frames carry the cursor + the `resumeAck` served-marker request.
 * The original KILL was structural — the handshake could only settle on a
 * snapshot frame while the bridge answers a servable cursor with events-only
 * (ZERO frames at cursor==tip), and ack-less session.v1 had no way to say
 * "caught up" — so the option was a guaranteed forever-pending connect().
 * The additive `resumed` frame IS that ack: the bridge emits it once per
 * requesting connect, strictly after the whole replay answer (empty replay
 * included), so `ready` now settles deterministically on snapshot OR resumed.
 * The outcome is surfaced on the connected payload (`resume: "replayed" |
 * "snapshot_fallback"` — same semantics as the raw client's resume watcher,
 * which stays untouched); replayed disconnect-window events are re-delivered
 * through the handle's M-2 replay buffer (loss == 0). `lastSeq()` is the
 * cursor a subsequent resume feeds.
 */

import {
  createSessionApprovalFlow,
  createSessionHandle,
  createSessionStdioSpawnTransport,
  createSessionTransportClient,
  runSessionHandshake,
  runSessionResumeHandshake,
  type SessionApprovalAnswer,
  type SessionHandle,
  SessionHandleClosedError,
  type SessionTransport,
  type SessionTransportConnectionState,
  type SessionWebSocketLike,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import type { PendingApprovalView } from "@/protocol/session"
import { type ApprovalDecisionResult, normalizeApprovalDecision } from "@/runner/orchestrate"

/* ------------------------------------------------------------------------- */
/* Transport specs                                                            */
/* ------------------------------------------------------------------------- */

/** A deferred transport recipe — `connect()` owns WHEN the live transport is
 *  created (and tears it down again when the handshake fails). */
export interface SessionTransportSpec {
  readonly kind: "ws" | "stdio"
  create(): Promise<SessionTransport>
}

/** The WebSocket surface `transports.ws` drives: the message-only
 *  `SessionWebSocketLike` the shared wrap consumes, plus the lifecycle events
 *  needed to await OPEN / observe death. The global Bun/WHATWG `WebSocket`
 *  satisfies it; tests inject a fake ctor (same seam as `quanta attach`). */
export interface ConnectWebSocket extends SessionWebSocketLike {
  readonly readyState: number
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void
  addEventListener(type: "open" | "close" | "error", handler: () => void): void
}

export type ConnectWebSocketCtor = new (url: string) => ConnectWebSocket

export interface WsTransportOptions {
  /** WS URL of the daemon session endpoint, e.g. `ws://127.0.0.1:4096/`. */
  readonly url: string
  /** Bearer token — appended as `?token=…` (the daemon accepts header or
   *  query; a raw ctor cannot set headers, so query is the reliable carrier). */
  readonly authToken?: string
  /** Override the WebSocket ctor (defaults to the global `WebSocket`). */
  readonly webSocketCtor?: ConnectWebSocketCtor
}

export type StdioTransportOptions =
  | {
      /** argv — `command[0]` is the executable. The transport OWNS the child
       *  lifecycle (SIGTERM→SIGKILL reap on close, exit → connection-closed). */
      readonly command: readonly string[]
      /** ENTIRE child environment when provided — passed VERBATIM, nothing is
       *  auto-injected (ticket 02's maturity gate must be the caller's
       *  explicit, visible act; MASTER §6). */
      readonly env?: Readonly<Record<string, string>>
      readonly cwd?: string
    }
  | {
      /** Bring-your-own transport (e.g. a pre-spawned
       *  `createSessionStdioSpawnTransport`) — lifecycle stays with you. */
      readonly transport: SessionTransport
    }

const withAuthQuery = (url: string, token: string | undefined): string => {
  if (token === undefined || token.length === 0) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

const resolveWebSocketCtor = (override: ConnectWebSocketCtor | undefined): ConnectWebSocketCtor => {
  if (override !== undefined) return override
  const g = globalThis as { WebSocket?: ConnectWebSocketCtor }
  if (g.WebSocket === undefined) {
    throw new Error(
      "transports.ws: no WebSocket constructor available — pass `webSocketCtor` explicitly.",
    )
  }
  return g.WebSocket
}

/** Await socket OPEN; a close/error BEFORE open rejects typed (fail-fast —
 *  the classic "daemon not running" first-hour experience must be an error,
 *  not a silent park). */
const waitForOpen = (socket: ConnectWebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (socket.readyState === 1 /* OPEN */) {
      resolve()
      return
    }
    if (socket.readyState === 2 || socket.readyState === 3 /* CLOSING/CLOSED */) {
      reject(new SessionHandleClosedError(undefined, "socket_closed_before_open"))
      return
    }
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("close", () =>
      reject(new SessionHandleClosedError(undefined, "socket_closed_before_open")),
    )
    socket.addEventListener("error", () =>
      reject(new SessionHandleClosedError(undefined, "socket_error_before_open")),
    )
  })

export const transports = {
  ws(opts: WsTransportOptions): SessionTransportSpec {
    return {
      kind: "ws",
      async create() {
        const Ctor = resolveWebSocketCtor(opts.webSocketCtor)
        const socket = new Ctor(withAuthQuery(opts.url, opts.authToken))
        await waitForOpen(socket)
        return wrapWebSocketLikeAsSessionTransport(socket)
      },
    }
  },
  stdio(opts: StdioTransportOptions): SessionTransportSpec {
    return {
      kind: "stdio",
      async create() {
        if ("transport" in opts) return opts.transport
        return createSessionStdioSpawnTransport({
          command: opts.command,
          ...(opts.env !== undefined ? { env: opts.env } : {}),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        })
      },
    }
  },
} as const

/* ------------------------------------------------------------------------- */
/* connect()                                                                  */
/* ------------------------------------------------------------------------- */

export interface ConnectOptions {
  readonly transport: SessionTransportSpec
  /** HITL seam — resolve the operator's decision for an `approval.requested`.
   *  The type is the existing `ApprovalDecisionResult` SSOT (bare
   *  "approve"/"deny" or the rich scope/steer object). Throwing / returning
   *  garbage fail-safes to DENY. ABSENT + an approval arriving = the turn
   *  PARKS awaiting another peer (document §3.4: unattended runs should
   *  `permission.set("bypass"|"acceptEdits")` instead). */
  readonly onApproval?: (approval: PendingApprovalView) => Promise<ApprovalDecisionResult>
  /** Connection liveness (S4): called with `connected` once the handshake
   *  settled — carrying `resume: "replayed" | "snapshot_fallback"` when this
   *  connect resumed (ticket 05; silent demotion is banned) — then `closed`
   *  (with the transport's reason) at most once. */
  readonly onConnectionState?: (state: SessionTransportConnectionState) => void
  /**
   * Ticket 05 — resume this view from a prior connection's `lastSeq()` cursor.
   * The handshake carries the cursor + the `resumeAck` served-marker request;
   * the server answers with an incremental event replay of the disconnect
   * window when it can serve it (memory tail, or the on-disk event log across
   * a daemon restart — ADR-0540 W4-b) and an honest full-snapshot reset when
   * it cannot. The outcome is surfaced on the connected payload (`resume`)
   * and replayed events reach `subscribe()` via the handshake replay buffer.
   * ⚠ Against a daemon shipped BEFORE the `resumed` marker the caught-up
   * (zero-frame) resume cannot be acknowledged — treat an unexplained resume
   * hang against an old daemon as version skew (same posture as §6's
   * bad_version note) and reconnect fresh.
   */
  readonly resumeFromSeq?: number
}

/** Map the SSOT decision onto the hoisted flow's rich answer shape. Garbage
 *  throws (`ApprovalDecisionResultError`) — the flow's catch turns that into
 *  the fail-safe DENY. */
const toApprovalAnswer = (decision: ApprovalDecisionResult): SessionApprovalAnswer => {
  const normalized = normalizeApprovalDecision(decision)
  return {
    decision: normalized.decision,
    ...(normalized.scope !== undefined ? { scope: normalized.scope } : {}),
    ...(normalized.steer !== undefined ? { steer: normalized.steer } : {}),
  }
}

export const connect = async (opts: ConnectOptions): Promise<SessionHandle> => {
  const transport = await opts.transport.create()

  // Death-during-handshake guard: a transport that dies before the snapshot
  // fails connect() TYPED (never a silent forever-pending promise). Transports
  // without an `onClose` channel simply cannot arm this guard.
  const closeWatch = new Promise<never>((_, reject) => {
    transport.onClose?.((info) => {
      reject(new SessionHandleClosedError(undefined, info.reason))
    })
  })

  // Ticket 05: a resume cursor routes through the RESUME handshake (cursor +
  // `resumeAck` on the connect frames; ready settles on snapshot OR the
  // `resumed` served-marker). Without one, the historical full handshake —
  // byte-identical wire.
  const resumeFromSeq = opts.resumeFromSeq
  const handshake =
    resumeFromSeq === undefined
      ? runSessionHandshake({ transport })
      : runSessionResumeHandshake({ transport, resumeFromSeq })
  try {
    await Promise.race([handshake.ready, closeWatch])
  } catch (error) {
    handshake.abort()
    await transport.close().catch(() => undefined)
    throw error
  }

  // ATOMIC handover (R2 F9): one synchronous block — the handshake listener
  // detaches, the raw client subscribes with the canonical id + the observed
  // cursor, and the handle seeds its snapshot cache + re-delivers the
  // handshake-window tail (M-2 — on a stdio door those frames arrived in the
  // SAME chunk as the snapshot and would otherwise be silently lost; on a
  // resume they ARE the replayed disconnect window). No frame can fall in
  // between (single-threaded; no await inside the block). On an events-only
  // resume there is NO snapshot: the cache stays honestly empty until the
  // next live snapshot frame, and the resume outcome rides the connected
  // payload instead.
  const handover = handshake.handoff()
  const resumeOutcome = "resume" in handover ? handover.resume : undefined
  const client = createSessionTransportClient({
    transport,
    sessionId: handover.sessionId,
    resumeFromSeq: handover.lastSeq,
  })
  // ADR-0540 W1-B marker, LATEST-snapshot-wins (same semantics as attach).
  // An events-only resume carries no snapshot ⇒ defensive false until the
  // next snapshot frame updates it (same read a legacy daemon gets). Tracked
  // BEFORE the handle so B-MED-7 can thread it into the turn-end correlator:
  // a marker-aware server ⇒ EXACT-commandId adoption of the daemon's stamped
  // continuation (no foreign-peer turn.started guess).
  let serverAutoContinues = handover.snapshot?.capabilities.serverAutoContinues === true
  client.onMessage((message) => {
    if (message.kind === "snapshot") {
      serverAutoContinues = message.snapshot.capabilities.serverAutoContinues === true
    }
  })
  const handle = createSessionHandle(client, {
    ...(handover.snapshot !== undefined ? { initialSnapshot: handover.snapshot } : {}),
    replayEvents: handover.events,
    ...(resumeOutcome !== undefined ? { resumeOutcome } : {}),
    serverAutoContinues: () => serverAutoContinues,
  })

  if (opts.onConnectionState !== undefined) {
    // The handle replays the CURRENT state ("connected" — it exists only
    // post-handshake) and then forwards transitions (`closed` once).
    handle.onConnectionState(opts.onConnectionState)
  }

  if (opts.onApproval !== undefined) {
    const onApproval = opts.onApproval
    const flow = createSessionApprovalFlow({
      waitForReady: async () => true, // the handle exists only post-handshake
      sessionId: () => handover.sessionId,
      serverAutoContinues: () => serverAutoContinues,
      promptApproval: async (_reason, approval) => toApprovalAnswer(await onApproval(approval)),
      sendCommand: (command) => client.sendCommand(command),
      newCommandId: () => crypto.randomUUID(),
      issuedAt: () => new Date().toISOString(),
      // §3.2 succession contract: the marker-OFF continuation re-issue is
      // reported into the handle's chain; a failed re-issue fails the chain
      // TYPED instead of leaving awaitTurnEnd() hanging.
      onContinuationIssued: (approvalId, commandId) =>
        handle.reportApprovalContinuation(approvalId, commandId),
      onContinuationFailed: (approvalId, error) =>
        handle.reportApprovalContinuationFailure(approvalId, error),
      // M-1 (jul-16 audit): a FAILED `approval.respond` send is not just the
      // flow's private problem — the decision never reached the server, so no
      // continuation can ever exist and awaitTurnEnd() would hang. Settle the
      // approval's chain typed (continuation_failed carries the detail).
      onRespondSendFailed: (approvalId) =>
        handle.reportApprovalContinuationFailure(
          approvalId,
          new Error(
            `approval.respond for ${approvalId} could not be sent — the decision never reached the server`,
          ),
        ),
    })
    // Dedup guard: an approval reaches the flow EXACTLY once whether it
    // arrives as a live event, inside the handshake-window replay (M-2), or
    // as the snapshot's already-parked seed (M-3).
    const dispatched = new Set<string>()
    const dispatchApproval = (approval: PendingApprovalView): void => {
      if (dispatched.has(approval.approvalId)) return
      dispatched.add(approval.approvalId)
      flow.handleApprovalRequested(approval)
    }
    handle.subscribe((event) => {
      if (event.type === "approval.requested") {
        dispatchApproval(event.approval)
      }
    })
    // M-3 (jul-16 audit): an approval that parked BEFORE this connection has
    // no future `approval.requested` event — the snapshot is its only carrier.
    // Seed it once so `onApproval` can answer it instead of it parking forever.
    // (An events-only resume has no snapshot; a parked approval reaches the
    // flow through the replayed `approval.requested` event instead.)
    if (handover.snapshot !== undefined && handover.snapshot.pendingApproval !== null) {
      dispatchApproval(handover.snapshot.pendingApproval)
    }
  }

  return handle
}
