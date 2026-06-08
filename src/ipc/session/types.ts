import type { SessionCommand, SessionEvent, SessionSnapshotLite } from "@/protocol/session"

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

export interface SessionTransport {
  send(message: SessionTransportMessage): Promise<void>
  onMessage(handler: SessionTransportHandler): () => void
  close(): Promise<void>
}

export interface SessionReplayPlan {
  readonly snapshot?: SessionSnapshotLite
  readonly tail: readonly SessionEvent[]
}
