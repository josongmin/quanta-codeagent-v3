/**
 * Peer/side-agent message SURFACING — host wire (jul-15 W2, Codex "Sent from
 * another task" parity). The PRODUCER bridge that turns the pure
 * `surfaceNotifyMailbox` decorator's display notice into a `peer_message`
 * AgentEvent on the EXISTING stream — the exact mirror of `progress-sink-wire.ts`
 * (`createProgressStreamSink` / `maybeWireProgressSink`), itself a clone of the
 * `createPassiveVcsStreamSink` shape. Lives in `@/host/runtime` (the composition
 * layer) so `@/agent/subagent-mailbox` stays a pure leaf (never imports `@/stream`
 * or `@/security`).
 *
 * WIRING ORDER (jul-15 W2 ordering invariant): `maybeWirePeerMessageSurface` runs
 * AFTER `maybeWireMailbox` (so a mailbox exists) but BEFORE `maybeWireSideAgent`
 * (so the daemon registry captures the DECORATED instance ⇒ findings surface) and
 * BEFORE `maybeWirePeerTeamMessaging` (so the team decorator wraps the notify
 * decorator OUTSIDE ⇒ a cross-team DENIED send never reaches the notify seam ⇒ the
 * display shows only mail that was ACTUALLY enqueued). It decorates the mailbox
 * IN PLACE, so a mailbox minted earlier by `optional-ports` (the interactive CLI
 * path) is surfaced too.
 *
 * DEFAULT-OFF / byte-identical: `QUANTA_PEER_MSG_SURFACE` unset ⇒ no decorator ⇒
 * no `peer_message` events (the stream is byte-identical). Requires a mailbox
 * (`QUANTA_SUBAGENT_MAILBOX`) — no mailbox, nothing to surface.
 */

import type { AgentConfig } from "@/agent"
import {
  type MailboxPort,
  type PeerMessageSink,
  rootMailboxRecipient,
  surfaceNotifyMailbox,
} from "@/agent/subagent-mailbox"
import { redactSecrets } from "@/security"
import { gateOn, sanitizeLogText } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import type { AssemblerEnv } from "./agent-config-assembler"

const QUANTA_PEER_MSG_SURFACE_ENV = "QUANTA_PEER_MSG_SURFACE"

/**
 * Adapt a `StreamPort` into a {@link PeerMessageSink}: a display notice → a
 * `peer_message` AgentEvent on the SAME stream the loop's other events ride.
 * `emit` is NO-THROW (a dead stream must never poison the `send` that produced
 * the notice — display is best-effort observability, mirroring
 * `createProgressStreamSink`). Optional `correlationId` is conditionally spread
 * (exactOptional — no `undefined` key on the wire). Exported so a hellgate can
 * assert the notice→AgentEvent mapping directly.
 */
export const createPeerMessageStreamSink = (stream: StreamPort): PeerMessageSink => ({
  emit(notice): void {
    const ev: AgentEvent = {
      type: "peer_message",
      from: notice.from,
      to: notice.to,
      kind: notice.kind,
      body: notice.body,
      ...(notice.correlationId !== undefined ? { correlationId: notice.correlationId } : {}),
      sentAt: notice.sentAt,
      provenance: notice.provenance,
    }
    try {
      stream.emit(ev)
    } catch {
      // best-effort display — never break the send that produced the notice.
    }
  },
})

/** Sanitize the untrusted-peer body for the emit boundary: (1) redact secrets/PII
 *  (`tool_result` origin so the patterns apply), then (2) strip ANSI escapes +
 *  C0/C1 control chars + bidi/zero-width (a hostile body must NOT forge terminal
 *  UI or alert lines — W2-SEC-1). {@link sanitizeLogText} is applied PER LINE so a
 *  legitimately multi-line body (a side-agent finding is `summary\n\ndetail`) stays
 *  readable while every line is individually neutralized. The result is safe for
 *  the stdout render, the item-stream text, AND the trajectory recorder. */
const peerBodyRedactor = (body: string): string =>
  redactSecrets(body, { origin: "tool_result" })
    .text.split("\n")
    .map(sanitizeLogText)
    .join("\n")

/**
 * Wire the surface-notify decorator onto `cfg.subagentMailbox` when
 * `QUANTA_PEER_MSG_SURFACE` is on AND a mailbox is present. Decorates IN PLACE so
 * every consumer wired later (side-agent registry, team decorator, the mailbox
 * tools) sees the notify instance. Caller-override-safe is N/A (we wrap, we don't
 * replace a slot). Knob-OFF ⇒ no-op (byte-identical).
 */
export const maybeWirePeerMessageSurface = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!gateOn(env, QUANTA_PEER_MSG_SURFACE_ENV)) return
  const slot = cfg as AgentConfig & { subagentMailbox?: MailboxPort }
  if (slot.subagentMailbox === undefined) return
  slot.subagentMailbox = surfaceNotifyMailbox(slot.subagentMailbox, {
    recipientId: rootMailboxRecipient(cfg.mailboxAgentId),
    sink: createPeerMessageStreamSink(cfg.stream),
    redact: peerBodyRedactor,
  })
}
