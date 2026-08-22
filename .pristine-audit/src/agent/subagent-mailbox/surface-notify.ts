/**
 * Peer/side-agent message SURFACING — display-notify decorator (jul-15 W2, Codex
 * "Sent from another task" parity).
 *
 * A pure DECORATOR over the EXISTING {@link MailboxPort} (NOT a new store — the
 * delivery cursor, LRU, per-sender quota, snapshot are load-bearing and stay
 * UNTOUCHED). It adds ONE thing: at `send` time, when the message is addressed to
 * the SESSION OWNER (`to === recipientId`, or a broadcast `to === "*"` that
 * reaches everyone including the owner), it emits a display NOTICE onto the
 * injected {@link PeerMessageSink} — so the USER sees inter-agent mail the MOMENT
 * it is enqueued, while the MODEL still receives it at its next turn-top drain
 * (no forced turn — exactly Codex `send_message` semantics: "delivered promptly,
 * does not trigger a new turn").
 *
 * LAYERING (jul-15 W2 ordering invariant): this wraps the RAW store; the
 * team-scoped decorator wraps THIS (outer). So a cross-team send DENIED by the
 * team gate never reaches `send` here ⇒ the display shows only mail that was
 * ACTUALLY enqueued. The side-agent registry captures this decorated instance
 * BEFORE the team wrap, so a daemon finding is surfaced without being team-gated.
 *
 * TRUST: the emitted `body` is REDACTED (untrusted-peer content) at this boundary
 * — the notice is INFORMATION for display, never a grant. `provenance` (carried
 * on the `send` init, consumed HERE, NEVER stored on `MailboxMessage`)
 * distinguishes ordinary peer mail from a side-agent daemon finding.
 *
 * SLICE FENCE: imports ONLY sibling `./types`. The sink + redactor are INJECTED
 * (duck-typed) so this slice never imports `@/stream` or `@/security` — the host
 * wires the real stream sink + `redactSecrets`. NO-THROW: a throwing sink/redact
 * can never break `send` (display is best-effort observability).
 */

import type {
  MailboxMessage,
  MailboxMessageKind,
  MailboxPort,
  MailboxSendProvenance,
} from "./types"

/** Provenance of a surfaced message (re-exported alias of the shared
 *  {@link MailboxSendProvenance} for display-side call sites). */
export type PeerMessageProvenance = MailboxSendProvenance

/** The plane-agnostic display notice the decorator pushes onto the sink. The host
 *  adapts this to a `peer_message` AgentEvent (this slice never imports `@/stream`). */
export interface PeerMessageNotice {
  readonly from: string
  readonly to: string
  readonly kind: MailboxMessageKind
  /** Passed through the injected `redact` at the emit boundary. The host composes
   *  secret-redaction + per-line control/ANSI sanitization into that function, so
   *  the surfaced body is safe to record / render verbatim (default identity when
   *  unwired — direct/test usage only; production always injects the real one). */
  readonly body: string
  readonly correlationId?: string
  readonly sentAt: number
  readonly provenance: PeerMessageProvenance
}

/** The duck-typed display sink (the host wires a stream-backed implementation). */
export interface PeerMessageSink {
  emit(notice: PeerMessageNotice): void
}

const BROADCAST = "*"

/** Identity redactor — the default when no real redactor is wired (byte-identical
 *  to the pre-redaction body). */
const identityRedact = (s: string): string => s

export interface SurfaceNotifyOptions {
  /** Emit a display notice for sends addressed to this id (the session owner) or
   *  a broadcast. */
  readonly recipientId: string
  /** The display sink (host wires a stream-backed adapter). */
  readonly sink: PeerMessageSink
  /** Redact secrets/PII from the (untrusted-peer) body before it is surfaced.
   *  Default identity ⇒ byte-identical when unwired. */
  readonly redact?: (body: string) => string
}

/**
 * Wrap `inner` so a `send` addressed to the session owner emits a display notice.
 * Every other method delegates UNCHANGED. Absent options ⇒ never used (the host
 * only installs this decorator under the surface knob).
 */
export const surfaceNotifyMailbox = (
  inner: MailboxPort,
  opts: SurfaceNotifyOptions,
): MailboxPort => {
  const redact = typeof opts.redact === "function" ? opts.redact : identityRedact
  const recipientId = opts.recipientId

  /** Should this send be surfaced to the session owner? It must be addressed to
   *  the owner (direct or broadcast) AND NOT be the owner's OWN send — the
   *  delivery store never delivers a message to its own sender (`from === agentId`
   *  self-guard), so surfacing an owner-authored send would display mail the model
   *  will NEVER receive, self-attributed as "from another task" (W2-A1). */
  const surfacedFor = (from: string, to: string): boolean =>
    from !== recipientId && (to === recipientId || to === BROADCAST)

  return {
    send(init): MailboxMessage {
      // Enqueue FIRST (the team decorator sits OUTSIDE us, so reaching here means
      // the send was ALLOWED — it WILL be stored). Then surface what was queued.
      const m = inner.send(init)
      if (surfacedFor(m.from, m.to)) {
        try {
          // `provenance` rides the send init (set by the side-agent adapter),
          // consumed here, NEVER stored on the MailboxMessage. Default = peer.
          const provenance: PeerMessageProvenance = init.provenance ?? { source: "peer" }
          opts.sink.emit({
            from: m.from,
            to: m.to,
            kind: m.kind,
            body: redact(m.body),
            ...(m.correlationId !== undefined ? { correlationId: m.correlationId } : {}),
            sentAt: m.sentAt,
            provenance,
          })
        } catch {
          // Display is best-effort — a throwing sink/redact must NEVER break send.
        }
      }
      return m
    },
    read(agentId, o): readonly MailboxMessage[] {
      return inner.read(agentId, o)
    },
    peek(agentId, o): readonly MailboxMessage[] {
      return inner.peek(agentId, o)
    },
    ack(messageId): MailboxMessage | null {
      return inner.ack(messageId)
    },
    list(filter): readonly MailboxMessage[] {
      return inner.list(filter)
    },
    pendingFor(agentId): number {
      return inner.pendingFor(agentId)
    },
    toSnapshot() {
      return inner.toSnapshot()
    },
    fromSnapshot(snap): void {
      inner.fromSnapshot(snap)
    },
  }
}
