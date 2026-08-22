import type {
  SessionCommand,
  SessionEvent,
  SessionSnapshotLite,
  SurfaceSubscription,
} from "@/protocol/session"

export type SessionTransportRejectTarget = "connect" | "command"

export type SessionTransportRejectReason =
  | "duplicate_command"
  | "protocol_validation"
  | "revision_conflict"
  | "session_id_mismatch"

export interface SessionTransportConnectMessage {
  readonly kind: "connect"
  readonly sessionId: string
  readonly resumeFromSeq?: number
  /**
   * Ticket 05 (door-level resume) — request the {@link
   * SessionTransportResumedMessage `resumed`} served-marker in the answer.
   * ADDITIVE OPT-IN: an already-shipped bridge ignores the unknown field (its
   * connect decoder drops unrecognized keys), and a bridge only emits the
   * marker when this field is `true` — so every existing flow (attach CLI,
   * raw-client resume, web frontends) keeps a byte-identical wire. Only the
   * SDK door's resume handshake sets it (it is the only consumer whose
   * readiness needs the ack — see the `resumed` docblock).
   */
  readonly resumeAck?: true
  readonly surfaceSubscription?: SurfaceSubscription
  /**
   * Ticket 04 (wire fidelity opt-in) — request the FULL model-visible tool
   * args/result on this peer's wire. Closed single-value enum (`"full"`); absent
   * = the current preview-only behavior. ADDITIVE OPT-IN: an already-shipped
   * bridge ignores the unknown field (its connect decoder drops unrecognized
   * keys) and never grants, so every existing flow keeps a byte-identical wire.
   * The bridge answers a requesting connect with a {@link
   * SessionTransportFidelityMessage `fidelity`} ack (granted true/false) BEFORE
   * the replay, so a client never has to time out to learn the outcome.
   */
  readonly requestedFidelity?: "full"
}

export interface SessionTransportRejectedMessage {
  readonly kind: "rejected"
  readonly sessionId: string
  readonly target: SessionTransportRejectTarget
  readonly reason: SessionTransportRejectReason
  readonly commandId?: string
  readonly expectedRevision?: number
  readonly actualRevision?: number
  readonly issue?: string
}

/**
 * App-level keepalive frame. ADDITIVE 6th transport kind (the original 5 —
 * connect / command / event / rejected / snapshot — are untouched in meaning).
 *
 * WHY: an idle WS connection carries no frames, and load balancers / reverse
 * proxies silently drop sockets that go quiet past their idle timeout — the
 * TCP-level close is often never surfaced, so a client thinks it is still
 * connected while the daemon has long since evicted it. A periodic
 * application-level `ping` keeps the path warm AND, when the peer never
 * answers with a `pong`, lets either side detect a dead socket and reconnect.
 *
 * `phase` is the discriminator: a client emits `ping` on its keepalive timer,
 * the daemon answers `pong`. The frame carries no payload — its sole purpose
 * is to put a byte on the wire and prove liveness.
 */
export interface SessionTransportHeartbeatMessage {
  readonly kind: "heartbeat"
  readonly phase: "ping" | "pong"
}

/**
 * Replay served-marker. ADDITIVE 7th transport kind (same discipline as the
 * heartbeat 6th — the original kinds are untouched in meaning; an
 * already-shipped peer's closed-kind decoder drops this frame silently via
 * `tryDecodeSessionTransportMessage`, so it is wire-compatible additive).
 *
 * WHY (jul-16 adversarial audit, ticket 05): session.v1 was ACK-LESS — the
 * bridge answers a servable resume cursor with an events-only replay, which is
 * ZERO frames when the cursor is already at tip. A handshake that may only
 * settle on a snapshot frame therefore had no way to tell a caught-up resume
 * apart from a dead server: `connect({resumeFromSeq})` was a structural
 * forever-hang and had to be descoped. This frame closes the gap: the bridge
 * emits it EXACTLY ONCE per `resumeAck`-requesting connect, strictly AFTER the
 * whole replay answer (incremental events, snapshot fallback, or an EMPTY
 * replay), so "caught up" is now a deterministic wire fact.
 *
 *  - `servedThroughSeq` — the seq the peer's view is current through once the
 *    preceding replay is applied (== the resume cursor itself when the replay
 *    was empty);
 *  - `mode` — how the view was restored: `"replay"` = incremental events only
 *    (memory tail or durable-log rescue), `"snapshot"` = a snapshot frame
 *    carried/reset the state (the resume was demoted, or the connect was a
 *    plain full restore).
 */
export interface SessionTransportResumedMessage {
  readonly kind: "resumed"
  readonly sessionId: string
  readonly servedThroughSeq: number
  readonly mode: "replay" | "snapshot"
}

/**
 * Fidelity negotiation ACK. ADDITIVE 8th transport kind (same discipline as the
 * heartbeat 6th / resumed 7th — the original kinds are untouched in meaning; an
 * already-shipped peer's closed-kind decoder drops this frame silently via
 * `tryDecodeSessionTransportMessage`, so it is wire-compatible additive).
 *
 * WHY (ticket 04, RFC §2): a peer opts into wire full fidelity via
 * `connect.requestedFidelity`. The bridge is the SOLE authority on whether the
 * production gate is on, so it answers each REQUESTING connect with EXACTLY ONE
 * `fidelity` frame — `granted:true` when full is served on this peer, `false`
 * when refused (gate OFF) — sent strictly BEFORE the replay answer. A client
 * that requested but sees no `fidelity` frame by the time the snapshot/replay
 * arrives is talking to an OLD server and settles on preview (no timer). The
 * explicit `granted:false` distinguishes "server refused" from "server did not
 * understand" (an honest diagnostic, RFC §2.1).
 */
export interface SessionTransportFidelityMessage {
  readonly kind: "fidelity"
  readonly sessionId: string
  readonly granted: boolean
}

export type SessionTransportMessage =
  | SessionTransportConnectMessage
  | { readonly kind: "command"; readonly command: SessionCommand }
  | { readonly kind: "event"; readonly event: SessionEvent }
  | SessionTransportRejectedMessage
  | { readonly kind: "snapshot"; readonly snapshot: SessionSnapshotLite }
  | SessionTransportHeartbeatMessage
  | SessionTransportResumedMessage
  | SessionTransportFidelityMessage

export type SessionTransportHandler = (message: SessionTransportMessage) => void | Promise<void>

/**
 * Terminal-close notification payload (S4 — jul-16 transport-unified SDK,
 * ticket 01). `reason` is a short human-readable slug describing WHY the
 * transport died: stable prefixes in the in-tree implementations are
 * `local_close` (owner called `close()`), `socket_close` / `socket_error`
 * (WS peer death), `writer_error` (stdio broken pipe), `frame_too_large`
 * (wedge-guard teardown) and `child_exit code=… signal=…` (spawn-owned child
 * terminated — may carry a bounded stderr tail as fail-fast raw material).
 * It is diagnostic text, not a closed enum — consumers must not switch on it.
 */
export interface SessionTransportCloseInfo {
  readonly reason: string
}

export interface SessionTransport {
  send(message: SessionTransportMessage): Promise<void>
  onMessage(handler: SessionTransportHandler): () => void
  /**
   * OPTIONAL liveness channel (S4, additive — R1 audit HIGH-5: pre-S4 the
   * abstraction had NO way to say "the connection died", so consumers either
   * hung forever or worked around it with raw socket listeners outside the
   * abstraction, e.g. the CLI attach client).
   *
   * Contract for implementers:
   *  - fires AT MOST ONCE, on the FIRST terminal transition (owner `close()`,
   *    peer death, wedge-guard teardown, child exit) — later transitions are
   *    swallowed by the once-latch;
   *  - a handler subscribed AFTER the transport already closed is invoked
   *    immediately (synchronously) with the recorded info, so late subscribers
   *    cannot miss the death notice;
   *  - per-handler throws are swallowed (same rule as `onMessage` fan-out).
   *
   * Optional so existing minimal implementations and test fixtures stay
   * structurally valid; the in-tree ws / stdio / stdio-spawn transports all
   * implement it.
   */
  onClose?(handler: (info: SessionTransportCloseInfo) => void): () => void
  close(): Promise<void>
}

export interface SessionReplayPlan {
  readonly snapshot?: SessionSnapshotLite
  readonly tail: readonly SessionEvent[]
}

/**
 * Ticket 05 (durable resume) — the bridge's read-only view of a DURABLE
 * session event log: `readFrom(afterSeq)` returns every logged event with
 * `seq > afterSeq`, in seq order. Structural ON PURPOSE: the transport slice
 * stays kernel-free (`@/kernel` already imports `@/ipc`, so a nominal import
 * here would open a cross-slice cycle). `@/kernel/session`'s
 * `DurableSessionEventLog` (the on-disk JSONL log, W4-b) satisfies it as-is;
 * the SDK engine injects it behind the `isDurableSessionEventLog` guard — the
 * InMemory log exposes no durable surface, so nothing is injected and the
 * bridge's snapshot-fallback behavior stays byte-identical (default-OFF).
 */
export interface SessionDurableEventLogReader {
  readFrom(afterSeq: number): readonly SessionEvent[]
}
