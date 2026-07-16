/**
 * `createSessionHandle` — the WIRE implementation of the generic verb surface
 * (S2b, jul-16 transport-unified SDK ticket 01; design SSOT: MASTER §3.1–3.2).
 *
 * A `SessionHandle` wraps a raw `SessionTransportClient` with:
 *  - typed verbs (`SessionVerbSurface<CommandReceipt>`): protocol builders
 *    assemble the command, `client.sendCommand` submits it, and the verb
 *    resolves `{commandId, submitted: true}` IMMEDIATELY on transport-send
 *    success — never awaiting server processing (the dispatch queue is serial
 *    server-side; awaiting completion here is the web-inline deadlock class,
 *    ticket 01 §3.1);
 *  - `awaitTurnEnd()` — correlation of MY turn chain to its terminal event
 *    (turn.completed / turn.failed / turn.aborted) with §3.2 SUCCESSION:
 *    an approval mid-turn hands the chain to the re-issued continuation
 *    commandId (reported by the attach-flow, or adopted from the next
 *    `turn.started` when the daemon owns the continuation). Every correlation
 *    LOSS is a typed rejection, never a hang;
 *  - `subscribe` (event frames), `snapshot()` (latest received cache +
 *    freshness — NOT a dispatch), `lastSeq()` (the raw client's resume cursor
 *    under its public name), `onConnectionState` (S4 liveness re-exposed),
 *    `onCommandRejected` (S5 typed rejected channel).
 *
 * This module is transport-agnostic: everything speaks through the raw client.
 * The in-process twin (`toSessionHandle`, `@/sdk/runtime/handle-adapter`)
 * reuses `createTurnEndCorrelator` so both doors share ONE §3.2 semantics.
 */

import type {
  SessionCommand,
  SessionEvent,
  SessionSnapshotLite,
  SessionVerbSurface,
} from "@/protocol/session"
import {
  buildApprovalRespond,
  buildIdentitySet,
  buildInputAppend,
  buildPermissionSet,
  buildToolProfileSet,
  buildTranscriptReplace,
  buildTurnCancel,
  buildTurnRun,
  type CommandBuildDeps,
  type CommandReceipt,
  SessionProtocolError,
} from "@/protocol/session"
import type {
  SessionTransportClient,
  SessionTransportClientRejection,
  SessionTransportConnectionState,
} from "./client"
import { typedErrorFromRejectedMessage } from "./errors"
import type { SessionTransportRejectedMessage } from "./types"

/* ------------------------------------------------------------------------- */
/* Typed hang-guard errors (§3.2 — "hang 대신 typed error")                     */
/* ------------------------------------------------------------------------- */

/** A verb / wait was attempted on a handle whose connection is gone (local
 *  `close()` or transport death). Verbs must never mint a `submitted: true`
 *  receipt into a dead pipe — that receipt would be a lie. Also thrown by
 *  `connect()` when the transport dies BEFORE the handshake settled — in that
 *  window no canonical session id exists yet, hence `sessionId` is optional. */
export class SessionHandleClosedError extends SessionProtocolError {
  constructor(
    readonly sessionId: string | undefined,
    /** The connection's terminal reason (`local_close`, `socket_close`, …). */
    readonly reason: string,
  ) {
    super(
      sessionId === undefined
        ? `session connection closed before the handshake settled (${reason})`
        : `session handle for ${sessionId} is closed (${reason})`,
    )
    this.name = "SessionHandleClosedError"
  }
}

/** Why an `awaitTurnEnd()` correlation target was structurally lost. */
export type SessionTurnCorrelationLossReason =
  | "no_turn_run"
  | "approval_denied"
  | "approval_voided"
  | "continuation_failed"
  | "connection_closed"
  | "handle_closed"
  | "superseded"

/**
 * `awaitTurnEnd()`'s correlation target is STRUCTURALLY gone — no terminal
 * event for the awaited chain can ever arrive, so the wait fails typed instead
 * of hanging forever (§3.2):
 *  - `no_turn_run`         — the handle never issued a `turn.run`;
 *  - `approval_denied`     — the chain's approval was denied: the kernel
 *                            clears the draft and settles idle WITHOUT any
 *                            turn terminal event (wire fact, reducer.ts);
 *  - `approval_voided`     — the session LEFT `awaiting_approval` without the
 *                            chain's approval ever being resolved: the kernel's
 *                            `turn.cancel` on a parked approval clears
 *                            `pendingApproval` silently and emits ONLY a
 *                            `session.state.updated` — no `approval.resolved`,
 *                            no turn terminal (wire fact, reducer.ts
 *                            `turn.cancel`; jul-16 audit HIGH-1);
 *  - `continuation_failed` — the post-approval re-issue could not be
 *                            submitted (the succession chain has no successor),
 *                            or the `approval.respond` itself never left the
 *                            client (send failure — the decision cannot reach
 *                            the server, so no continuation can ever exist);
 *  - `connection_closed`   — the transport died while waiting;
 *  - `handle_closed`       — the local owner closed the handle mid-wait;
 *  - `superseded`          — the consumer issued a NEW explicit `turn.run`
 *                            while this chain's post-approval adoption window
 *                            was still open (or reused its commandId): the new
 *                            turn claims the session's single draft, so this
 *                            chain's continuation can never start (jul-16
 *                            audit HIGH-2/L-3).
 */
export class SessionTurnCorrelationLostError extends SessionProtocolError {
  constructor(
    readonly reason: SessionTurnCorrelationLossReason,
    detail?: string,
  ) {
    super(`session turn correlation lost (${reason})${detail === undefined ? "" : `: ${detail}`}`)
    this.name = "SessionTurnCorrelationLostError"
  }
}

/* ------------------------------------------------------------------------- */
/* Turn-end correlator (§3.2) — shared by the wire handle and the in-process   */
/* adapter                                                                     */
/* ------------------------------------------------------------------------- */

/** The three terminal turn events `awaitTurnEnd()` resolves with. */
export type SessionTurnEndEvent = Extract<
  SessionEvent,
  { type: "turn.completed" } | { type: "turn.failed" } | { type: "turn.aborted" }
>

const TURN_END_TYPES: ReadonlySet<SessionEvent["type"]> = new Set([
  "turn.completed",
  "turn.failed",
  "turn.aborted",
])

type ChainSettlement =
  | { readonly kind: "end"; readonly event: SessionTurnEndEvent }
  | { readonly kind: "error"; readonly error: unknown }

interface TurnChain {
  /** Every commandId in the succession chain (original turn.run + re-issues). */
  readonly ids: Set<string>
  /** Approvals raised BY this chain's turn (correlated via causedByCommandId). */
  readonly approvalIds: Set<string>
  /** Approvals of this chain not yet seen `approval.resolved` — the HIGH-1
   *  void detector's evidence: the session leaving `awaiting_approval` while
   *  one of these is still open means the kernel silently discarded it. */
  readonly unresolvedApprovalIds: Set<string>
  /** Armed when this chain's approval was APPROVED: the next `turn.started`
   *  whose commandId is not already claimed is this turn's continuation —
   *  daemon-minted (`serverAutoContinues`) or issued by another peer's flow.
   *  An EXPLICIT succession report (`succeed`) clears it first (report wins). */
  awaitingAdoption: boolean
  settlement: ChainSettlement | undefined
  readonly waiters: Array<{
    readonly resolve: (event: SessionTurnEndEvent) => void
    readonly reject: (error: unknown) => void
  }>
}

export interface TurnEndCorrelator {
  /** Register a fresh `turn.run` commandId — becomes the CURRENT chain. MUST
   *  be called BEFORE the command is submitted (an in-memory transport can
   *  deliver the terminal event inside the send await). */
  begin(commandId: string): void
  /** Feed every observed session event (wire event frames / in-proc stream). */
  onEvent(event: SessionEvent): void
  /** §3.2 succession report: the post-approval continuation `turn.run` for
   *  `approvalId` was submitted with `commandId`. Unknown approvalIds are
   *  ignored (a foreign peer's approval — never crosstalk into my chain). */
  succeed(approvalId: string, commandId: string): void
  /** The continuation for `approvalId` could NOT be submitted — the chain has
   *  no successor and would hang: settle it typed. */
  failContinuation(approvalId: string, error: unknown): void
  /** A correlated `rejected` frame — settle that command's chain typed. */
  rejectCommand(commandId: string, error: unknown): void
  /** Terminal sweep (transport death / handle close): settle EVERY live chain. */
  failAll(error: unknown): void
  /** Await the CURRENT chain's terminal event (typed rejection on loss). */
  awaitEnd(): Promise<SessionTurnEndEvent>
  /** Number of DISTINCT chains currently retained — introspection for the
   *  M-4 growth guard (settled prior generations are pruned on `begin()`;
   *  a long-lived handle must stay O(1), not O(turns)). */
  chainCount(): number
}

const settleChain = (chain: TurnChain, settlement: ChainSettlement): void => {
  if (chain.settlement !== undefined) return
  chain.settlement = settlement
  chain.awaitingAdoption = false
  const waiters = chain.waiters.splice(0)
  for (const waiter of waiters) {
    if (settlement.kind === "end") waiter.resolve(settlement.event)
    else waiter.reject(settlement.error)
  }
}

/** Swallowing fan-out: a throwing observer must never poison its siblings
 *  (the raw client's rule, kept identical at the handle layer). */
const notifyAll = <T>(listeners: ReadonlySet<(value: T) => void>, value: T): void => {
  for (const listener of [...listeners]) {
    try {
      listener(value)
    } catch {
      // Swallow per-listener errors.
    }
  }
}

/** The correlator's shared mutable state — handlers are hoisted to module
 *  level over this record (god-FN ratchet, jul-16 audit HIGH-3). */
interface CorrelatorState {
  readonly byCommandId: Map<string, TurnChain>
  readonly byApprovalId: Map<string, TurnChain>
  /** The chain `awaitEnd()` targets (the latest explicit `begin`). */
  current: TurnChain | undefined
  /** Last `session.state.updated` status observed — the HIGH-1 void detector
   *  keys on the TRANSITION away from `awaiting_approval`, never on a lone
   *  status value (a `running` echo between `approval.requested` and the
   *  `awaiting_approval` echo must not void anything). */
  lastObservedStatus: string | undefined
}

const adoptInto = (state: CorrelatorState, chain: TurnChain, commandId: string): void => {
  chain.ids.add(commandId)
  state.byCommandId.set(commandId, chain)
  chain.awaitingAdoption = false
}

const handleTurnStarted = (
  state: CorrelatorState,
  event: SessionEvent & { type: "turn.started" },
): void => {
  const causedBy = event.causedByCommandId
  if (causedBy === undefined) return
  const own = state.byCommandId.get(causedBy)
  if (own !== undefined) {
    // My own (or already-reported successor) turn started — nothing to adopt.
    own.awaitingAdoption = false
    return
  }
  // §3.2 marker-ON arm: exactly the chain whose approval was just approved
  // may adopt the next unclaimed turn.started as its continuation. A foreign
  // turn can only be adopted if it starts INSIDE the approve→continuation
  // window — in which case it also consumed this session's pending draft,
  // i.e. it literally ran this chain's prompt (single-draft session).
  for (const chain of state.byCommandId.values()) {
    if (chain.awaitingAdoption && chain.settlement === undefined) {
      adoptInto(state, chain, causedBy)
      return
    }
  }
}

const handleApprovalResolved = (
  state: CorrelatorState,
  event: SessionEvent & { type: "approval.resolved" },
): void => {
  const chain = state.byApprovalId.get(event.approvalId)
  if (chain === undefined) return
  // Resolved (either decision) ⇒ no longer void-evidence. Kernel ordering
  // guarantees this event precedes the leaving-state echo of the SAME
  // dispatch (reducer emits approval.resolved, then session.state.updated).
  chain.unresolvedApprovalIds.delete(event.approvalId)
  if (chain.settlement !== undefined) return
  if (event.decision === "deny") {
    // Wire fact (kernel reducer): a deny clears the draft and settles idle
    // WITHOUT any turn terminal event — the correlation target is gone.
    settleChain(chain, {
      kind: "error",
      error: new SessionTurnCorrelationLostError(
        "approval_denied",
        `approval ${event.approvalId} was denied; the suspended turn emits no terminal event`,
      ),
    })
    return
  }
  chain.awaitingAdoption = true
}

const handleApprovalRequested = (
  state: CorrelatorState,
  event: SessionEvent & { type: "approval.requested" },
): void => {
  const chain =
    event.causedByCommandId === undefined
      ? undefined
      : state.byCommandId.get(event.causedByCommandId)
  if (chain !== undefined && chain.settlement === undefined) {
    chain.approvalIds.add(event.approval.approvalId)
    chain.unresolvedApprovalIds.add(event.approval.approvalId)
    state.byApprovalId.set(event.approval.approvalId, chain)
  }
}

/**
 * HIGH-1 (jul-16 audit) — the parked-approval VOID detector. Kernel fact
 * (reducer.ts `turn.cancel`): cancelling a turn parked on an approval emits
 * ONLY `session.state.updated` (status leaves `awaiting_approval`) — the
 * pending approval is discarded with NO `approval.resolved` and NO turn
 * terminal event. A chain still holding an unresolved approval across that
 * transition has structurally lost its correlation target: settle it typed
 * (`approval_voided`) instead of letting `awaitTurnEnd()` hang forever.
 */
const handleStateUpdated = (
  state: CorrelatorState,
  event: SessionEvent & { type: "session.state.updated" },
): void => {
  const previous = state.lastObservedStatus
  state.lastObservedStatus = event.state.status
  if (previous !== "awaiting_approval" || event.state.status === "awaiting_approval") return
  for (const chain of new Set(state.byCommandId.values())) {
    if (chain.settlement !== undefined || chain.unresolvedApprovalIds.size === 0) continue
    const voided = [...chain.unresolvedApprovalIds].join(", ")
    settleChain(chain, {
      kind: "error",
      error: new SessionTurnCorrelationLostError(
        "approval_voided",
        `the session left awaiting_approval without resolving approval(s) ${voided} ` +
          "(e.g. turn.cancel on a parked approval — the kernel discards it silently)",
      ),
    })
  }
}

const handleTerminal = (state: CorrelatorState, event: SessionEvent): void => {
  const chain =
    event.causedByCommandId === undefined
      ? undefined
      : state.byCommandId.get(event.causedByCommandId)
  if (chain !== undefined) {
    settleChain(chain, { kind: "end", event: event as SessionTurnEndEvent })
  }
}

/**
 * `begin(commandId)` — register a fresh explicit turn chain, sweeping the
 * prior generation first:
 *  1. HIGH-2 (jul-16 audit): an ARMED, unsettled chain is not merely
 *     disarmed — its adoption window was its ONLY remaining path to a
 *     terminal event (the approved continuation), and the new turn claims
 *     the session's single draft. Disarm-only would orphan its waiters
 *     forever — settle them typed (`superseded`) instead.
 *  2. L-3: reusing a live chain's commandId must not silently clobber it —
 *     the old chain would become unreachable (map repointed) and its waiters
 *     would hang. Settle it typed first.
 *  3. M-4: prune SETTLED chains of prior generations so a long-lived handle
 *     stays O(1). Only the immediately-previous current chain is retained
 *     (its settlement may still be replayed by a late `awaitEnd()` caller
 *     holding it as "the previous turn").
 */
const beginChain = (state: CorrelatorState, commandId: string): void => {
  for (const prior of new Set(state.byCommandId.values())) {
    if (prior.awaitingAdoption && prior.settlement === undefined) {
      settleChain(prior, {
        kind: "error",
        error: new SessionTurnCorrelationLostError(
          "superseded",
          "a new explicit turn.run was issued while this chain's post-approval " +
            "adoption window was open — its continuation can never start",
        ),
      })
    } else {
      prior.awaitingAdoption = false
    }
  }
  const reused = state.byCommandId.get(commandId)
  if (reused !== undefined && reused.settlement === undefined) {
    settleChain(reused, {
      kind: "error",
      error: new SessionTurnCorrelationLostError(
        "superseded",
        `commandId ${commandId} was reused by a new turn.run — the previous chain under it is unreachable`,
      ),
    })
  }
  for (const [id, chain] of state.byCommandId) {
    if (chain.settlement !== undefined && chain !== state.current) state.byCommandId.delete(id)
  }
  for (const [id, chain] of state.byApprovalId) {
    if (chain.settlement !== undefined && chain !== state.current) state.byApprovalId.delete(id)
  }
  const chain: TurnChain = {
    ids: new Set([commandId]),
    approvalIds: new Set(),
    unresolvedApprovalIds: new Set(),
    awaitingAdoption: false,
    settlement: undefined,
    waiters: [],
  }
  state.byCommandId.set(commandId, chain)
  state.current = chain
}

export const createTurnEndCorrelator = (): TurnEndCorrelator => {
  const state: CorrelatorState = {
    byCommandId: new Map(),
    byApprovalId: new Map(),
    current: undefined,
    lastObservedStatus: undefined,
  }

  return {
    begin(commandId) {
      beginChain(state, commandId)
    },
    onEvent(event) {
      if (event.type === "turn.started") {
        handleTurnStarted(state, event)
      } else if (event.type === "approval.requested") {
        handleApprovalRequested(state, event)
      } else if (event.type === "approval.resolved") {
        handleApprovalResolved(state, event)
      } else if (event.type === "session.state.updated") {
        handleStateUpdated(state, event)
      } else if (TURN_END_TYPES.has(event.type)) {
        handleTerminal(state, event)
      }
    },
    succeed(approvalId, commandId) {
      const chain = state.byApprovalId.get(approvalId)
      if (chain === undefined || chain.settlement !== undefined) return
      adoptInto(state, chain, commandId)
    },
    failContinuation(approvalId, error) {
      const chain = state.byApprovalId.get(approvalId)
      if (chain === undefined || chain.settlement !== undefined) return
      settleChain(chain, {
        kind: "error",
        error: new SessionTurnCorrelationLostError(
          "continuation_failed",
          error instanceof Error ? error.message : String(error),
        ),
      })
    },
    rejectCommand(commandId, error) {
      const chain = state.byCommandId.get(commandId)
      if (chain === undefined) return
      settleChain(chain, { kind: "error", error })
    },
    failAll(error) {
      for (const chain of new Set(state.byCommandId.values())) {
        settleChain(chain, { kind: "error", error })
      }
    },
    awaitEnd() {
      const chain = state.current
      if (chain === undefined) {
        return Promise.reject(
          new SessionTurnCorrelationLostError(
            "no_turn_run",
            "awaitTurnEnd() was called before any turn.run was issued through this handle",
          ),
        )
      }
      if (chain.settlement !== undefined) {
        const settlement = chain.settlement
        return settlement.kind === "end"
          ? Promise.resolve(settlement.event)
          : Promise.reject(settlement.error)
      }
      return new Promise<SessionTurnEndEvent>((resolve, reject) => {
        chain.waiters.push({ resolve, reject })
      })
    },
    chainCount() {
      return new Set(state.byCommandId.values()).size
    },
  }
}

/* ------------------------------------------------------------------------- */
/* The wire handle                                                            */
/* ------------------------------------------------------------------------- */

/** `snapshot()`'s answer — a CACHE of the most recent snapshot FRAME the
 *  server sent (connect/replay/publish), plus freshness so a consumer can see
 *  how far the live tail has advanced past it. It is NOT a dispatch-backed
 *  re-query (ticket 01 §1 — the wire has no snapshot-request verb). */
export interface SessionHandleSnapshot {
  readonly snapshot: SessionSnapshotLite
  /** Epoch-ms when the frame was received (handle clock). */
  readonly receivedAtMs: number
  /** The handle's live cursor at READ time — `lastSeenSeq > snapshot.seq`
   *  means events have already advanced past this cached view. */
  readonly lastSeenSeq: number | undefined
}

/** The public wire session handle (ticket 01 §1). */
export interface SessionHandle extends SessionVerbSurface<CommandReceipt> {
  readonly sessionId: string
  /** Live event frames (post-handshake). Snapshot frames are NOT events —
   *  they refresh `snapshot()` instead. A subscriber attaching before the
   *  first live frame also receives the HANDSHAKE-WINDOW events synchronously
   *  (M-2 — frames the handshake consumed before the handle existed). */
  subscribe(listener: (event: SessionEvent) => void): () => void
  snapshot(): Promise<SessionHandleSnapshot | undefined>
  /** §3.2 — the current turn chain's terminal event, succession-correlated
   *  across approval re-issues. Typed rejection on every correlation loss. */
  awaitTurnEnd(): Promise<SessionTurnEndEvent>
  onConnectionState(handler: (state: SessionTransportConnectionState) => void): () => void
  /** Every inbound `rejected` frame, paired with its typed error (S5 SSOT
   *  mapping — `typedErrorFromRejectedMessage`). */
  onCommandRejected(handler: (rejection: SessionTransportClientRejection) => void): () => void
  /** Manual-reconnect cursor (ticket 01 §1 naming): the raw client's
   *  `currentResumeFromSeq`, i.e. the highest seq observed on this handle. */
  lastSeq(): number | undefined
  /** §3.2 succession contract (supplied by the hoisted attach-flow): the
   *  post-approval continuation `turn.run` for `approvalId` was submitted
   *  with `commandId` — the awaited chain follows it. */
  reportApprovalContinuation(approvalId: string, commandId: string): void
  /** The continuation could NOT be submitted — fail the chain typed
   *  (hang-guard) instead of leaving `awaitTurnEnd()` waiting forever. */
  reportApprovalContinuationFailure(approvalId: string, error: unknown): void
  close(): Promise<void>
}

export interface CreateSessionHandleOpts {
  /** Seed for `snapshot()` — the handshake's snapshot, handed over atomically
   *  with the cursor (ticket 01 S2 R2-F9). */
  readonly initialSnapshot?: SessionSnapshotLite
  /** M-2 (jul-16 audit) — HANDSHAKE-WINDOW events: frames the handshake
   *  listener consumed after the snapshot but before this handle existed
   *  (a stdio door can deliver snapshot + tail in ONE synchronously-dispatched
   *  chunk). They are re-fed to the correlator at construction and replayed
   *  to every subscriber that attaches before the first LIVE event frame —
   *  exactly what a ws door (per-frame macrotasks) would have delivered live. */
  readonly replayEvents?: readonly SessionEvent[]
  /** Injected wall clock for snapshot freshness stamps (testability). */
  readonly now?: () => number
  /** Fresh unique command id — defaults to `crypto.randomUUID`. */
  readonly newCommandId?: () => string
  /** `issuedAt` clock for the command builders. */
  readonly clock?: CommandBuildDeps["clock"]
}

/** A `rejected` frame → typed error pairing + chain settlement + fan-out
 *  (hoisted from the factory — god-FN ratchet, jul-16 audit HIGH-3). */
const dispatchRejectedFrame = (
  message: SessionTransportRejectedMessage,
  correlator: TurnEndCorrelator,
  rejectionListeners: ReadonlySet<(rejection: SessionTransportClientRejection) => void>,
): void => {
  const rejection: SessionTransportClientRejection = {
    message,
    error: typedErrorFromRejectedMessage(message),
  }
  if (message.commandId !== undefined) {
    correlator.rejectCommand(message.commandId, rejection.error)
  }
  notifyAll(rejectionListeners, rejection)
}

/** M-2 — the handshake-window replay buffer (see `replayEvents`). Per-listener
 *  delivery on subscribe until the first live frame invalidates it: a late
 *  subscriber (post-live) rejoins via `snapshot()` + `lastSeq()` freshness,
 *  the same contract as missing any other live frame. */
const createHandshakeReplayBuffer = (events: readonly SessionEvent[] | undefined) => {
  let pending: readonly SessionEvent[] | undefined =
    events !== undefined && events.length > 0 ? [...events] : undefined
  return {
    deliverTo(listener: (event: SessionEvent) => void): void {
      if (pending === undefined) return
      for (const event of pending) {
        try {
          listener(event)
        } catch {
          // Same swallow rule as the live fan-out.
        }
      }
    },
    invalidate(): void {
      pending = undefined
    },
  }
}

/** The wire verb table (§3.1) — hoisted from `createSessionHandle` (god-FN
 *  ratchet, jul-16 audit HIGH-3). Every verb routes through the ONE `submit`
 *  (receipt on transport-send success); `turn.run` additionally registers its
 *  chain with the correlator BEFORE the send (an in-memory transport can
 *  deliver the whole turn inside the send await) and settles it typed when
 *  the send itself throws. */
const buildWireVerbSurface = (args: {
  readonly deps: CommandBuildDeps
  readonly submit: (command: SessionCommand) => Promise<CommandReceipt>
  readonly mintId: (meta: { readonly commandId?: string } | undefined) => string
  readonly correlator: TurnEndCorrelator
  readonly guardOpen: () => void
}): SessionVerbSurface<CommandReceipt> => {
  const { deps, submit, mintId, correlator, guardOpen } = args
  return {
    input: {
      append: (text, meta) =>
        submit(buildInputAppend(deps, text, { ...meta, commandId: mintId(meta) })),
    },
    turn: {
      async run(meta) {
        guardOpen()
        const commandId = mintId(meta)
        // Register BEFORE the send: an in-memory transport can deliver the
        // whole turn (terminal included) inside the send await.
        correlator.begin(commandId)
        try {
          return await submit(buildTurnRun(deps, { ...meta, commandId }))
        } catch (error) {
          // The chain never reached the server — settle it so a later
          // awaitTurnEnd() fails typed instead of waiting forever.
          correlator.rejectCommand(commandId, error)
          throw error
        }
      },
      cancel: (meta) => submit(buildTurnCancel(deps, { ...meta, commandId: mintId(meta) })),
    },
    identity: {
      set: (mode, meta) =>
        submit(buildIdentitySet(deps, mode, { ...meta, commandId: mintId(meta) })),
    },
    toolProfile: {
      set: (profile, meta) =>
        submit(buildToolProfileSet(deps, profile, { ...meta, commandId: mintId(meta) })),
    },
    permission: {
      set: (mode, meta) =>
        submit(buildPermissionSet(deps, mode, { ...meta, commandId: mintId(meta) })),
    },
    approval: {
      respond: (approvalId, decision, meta) =>
        submit(
          buildApprovalRespond(deps, approvalId, decision, { ...meta, commandId: mintId(meta) }),
        ),
    },
    transcript: {
      replace: (messages, meta) =>
        submit(buildTranscriptReplace(deps, messages, { ...meta, commandId: mintId(meta) })),
    },
  }
}

export const createSessionHandle = (
  client: SessionTransportClient,
  opts: CreateSessionHandleOpts = {},
): SessionHandle => {
  const now = opts.now ?? (() => Date.now())
  const newCommandId = opts.newCommandId ?? (() => crypto.randomUUID())
  const deps: CommandBuildDeps = {
    sessionId: client.sessionId,
    clock: opts.clock ?? { now: () => new Date() },
  }
  const correlator = createTurnEndCorrelator()
  const eventListeners = new Set<(event: SessionEvent) => void>()
  const rejectionListeners = new Set<(rejection: SessionTransportClientRejection) => void>()

  let closed = false
  let terminalReason: string | undefined
  let cachedSnapshot: { snapshot: SessionSnapshotLite; receivedAtMs: number } | undefined =
    opts.initialSnapshot === undefined
      ? undefined
      : { snapshot: opts.initialSnapshot, receivedAtMs: now() }

  // M-2 — handshake-window events: correlation state is correct from birth
  // (fed synchronously), and subscribers attaching before the first live
  // frame receive them on subscribe (see `createHandshakeReplayBuffer`).
  const replay = createHandshakeReplayBuffer(opts.replayEvents)
  for (const event of opts.replayEvents ?? []) {
    correlator.onEvent(event)
  }

  const unsubscribeMessages = client.onMessage((message) => {
    if (message.kind === "snapshot") {
      cachedSnapshot = { snapshot: message.snapshot, receivedAtMs: now() }
    } else if (message.kind === "rejected") {
      dispatchRejectedFrame(message, correlator, rejectionListeners)
    } else if (message.kind === "event") {
      replay.invalidate() // the live stream has moved on — replay window over
      correlator.onEvent(message.event)
      notifyAll(eventListeners, message.event)
    }
  })

  // Liveness: a transport death fails every awaiting chain typed (hang-guard)
  // and flips the handle terminal so later verbs reject instead of minting
  // receipts into a dead pipe.
  const unsubscribeState = client.onConnectionState((state) => {
    if (state.status === "closed" && terminalReason === undefined) {
      terminalReason = state.reason
      correlator.failAll(new SessionTurnCorrelationLostError("connection_closed", state.reason))
    }
  })

  const guardOpen = (): void => {
    if (closed) {
      throw new SessionHandleClosedError(client.sessionId, terminalReason ?? "local_close")
    }
    if (terminalReason !== undefined) {
      throw new SessionHandleClosedError(client.sessionId, terminalReason)
    }
  }

  /** Submit a built command; resolve the receipt on transport-send success —
   *  IMMEDIATELY, never awaiting server processing (§3.1). */
  const submit = async (command: SessionCommand): Promise<CommandReceipt> => {
    guardOpen()
    await client.sendCommand(command)
    return { commandId: command.commandId, submitted: true }
  }

  const mintId = (meta: { readonly commandId?: string } | undefined): string =>
    meta?.commandId ?? newCommandId()

  return {
    sessionId: client.sessionId,
    ...buildWireVerbSurface({ deps, submit, mintId, correlator, guardOpen }),
    subscribe(listener) {
      eventListeners.add(listener)
      // M-2 — a pre-live subscriber receives the handshake-window events it
      // could never have observed (they were consumed before this handle
      // existed); a no-op once the live stream has advanced.
      replay.deliverTo(listener)
      return () => {
        eventListeners.delete(listener)
      }
    },
    async snapshot() {
      if (cachedSnapshot === undefined) return undefined
      return {
        snapshot: cachedSnapshot.snapshot,
        receivedAtMs: cachedSnapshot.receivedAtMs,
        lastSeenSeq: client.currentResumeFromSeq(),
      }
    },
    awaitTurnEnd() {
      return correlator.awaitEnd()
    },
    onConnectionState(handler) {
      // The handle exists only post-handshake, so a live subscriber first
      // receives the CURRENT state ("connected") synchronously, then
      // transitions. A terminal client already replays its `closed` inside
      // `client.onConnectionState` (once-latch semantics preserved).
      let deliveredTerminal = false
      const unsub = client.onConnectionState((state) => {
        if (state.status === "closed") deliveredTerminal = true
        handler(state)
      })
      if (!deliveredTerminal && !closed) {
        try {
          handler({ status: "connected" })
        } catch {
          // Same swallow rule as the raw client's fan-out.
        }
      }
      return unsub
    },
    onCommandRejected(handler) {
      rejectionListeners.add(handler)
      return () => {
        rejectionListeners.delete(handler)
      }
    },
    lastSeq() {
      return client.currentResumeFromSeq()
    },
    reportApprovalContinuation(approvalId, commandId) {
      correlator.succeed(approvalId, commandId)
    },
    reportApprovalContinuationFailure(approvalId, error) {
      correlator.failContinuation(approvalId, error)
    },
    async close() {
      if (closed) return
      closed = true
      correlator.failAll(
        new SessionTurnCorrelationLostError("handle_closed", "the handle was closed locally"),
      )
      unsubscribeMessages()
      unsubscribeState()
      replay.invalidate()
      eventListeners.clear()
      rejectionListeners.clear()
      await client.close()
    },
  }
}
