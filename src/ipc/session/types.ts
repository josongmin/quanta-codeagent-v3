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

export type SessionTransportMessage =
  | SessionTransportConnectMessage
  | { readonly kind: "command"; readonly command: SessionCommand }
  | { readonly kind: "event"; readonly event: SessionEvent }
  | SessionTransportRejectedMessage
  | { readonly kind: "snapshot"; readonly snapshot: SessionSnapshotLite }

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
