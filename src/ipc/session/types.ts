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
  readonly surfaceSubscription?: SurfaceSubscription
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

export type SessionTransportMessage =
  | SessionTransportConnectMessage
  | { readonly kind: "command"; readonly command: SessionCommand }
  | { readonly kind: "event"; readonly event: SessionEvent }
  | SessionTransportRejectedMessage
  | { readonly kind: "snapshot"; readonly snapshot: SessionSnapshotLite }
  | SessionTransportHeartbeatMessage

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
