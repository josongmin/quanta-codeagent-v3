/**
 * Peer teammate messaging — auto-delivery drain adapter (RFC jun-6, DELTA #1+#3).
 *
 * Builds a `PeerInboxDrain` (the duck-typed port the loop's `pollPeerInbox`
 * calls at the turn-top seam) over the EXISTING {@link MailboxPort}. On each
 * `drainFor(agentId)` it:
 *   1. `read`s the agent's undelivered mail (MARK-delivered — shares the SAME
 *      per-recipient delivery cursor as the manual `subagent_read_messages`
 *      poll, so a message is delivered exactly ONCE across push+pull and never
 *      re-injects across turns), bounded by a per-turn `limit` (the rest stays
 *      pending and drains over subsequent turns — bounded injection),
 *   2. routes each body through the injected `redact` (DELTA #3 — peer content
 *      is untrusted-as-DATA; default identity ⇒ byte-identical when unwired),
 *   3. then `escapeBodyForLine` (anti line-injection — a redacted body still
 *      can't forge a second `victim→root [response] …` line),
 *   4. renders ONE `role:"user"` message with an explicit
 *      `[teammate <from> — untrusted]` provenance header so the recipient model
 *      treats the content as DATA from a peer, not a trusted instruction —
 *      INFORMATION only, never a grant (the loop never invokes the permission
 *      decider on this).
 * Returns `null` when the inbox is empty (so the loop appends nothing).
 *
 * SLICE FENCE: imports ONLY `@/llm` (the `Message` type) + sibling `./types`.
 * The redactor is INJECTED (`redact?: (s)=>string`, default identity) so this
 * slice never imports `@/security` — the host wires the real redactor under the
 * `QUANTA_TEAM_PEER_MSG` knob. Pure, deterministic, no clock / no randomness.
 */

import type { Message } from "@/llm"
import type { MailboxMessage, MailboxPort } from "./types"

/** Default per-turn injection cap. A flooded inbox does not blow the context
 *  window in one turn — the rest stays pending (FIFO oldest-first, the store's
 *  existing order) and drains over subsequent turns. A bound, not a tuned
 *  heuristic: it caps a single turn's injection; the store's own `maxRetained`
 *  caps total memory. */
const DEFAULT_PER_TURN_LIMIT = 32

/** Identity redactor — the default when no real redactor is wired (the body
 *  passes through unchanged ⇒ byte-identical to the pre-redaction render). */
const identityRedact = (s: string): string => s

/** Collapse newlines/CR to the literal two-char `\n` so a hostile/garbled body
 *  cannot forge an additional injected line (mirrors the tool slice's
 *  `escapeBodyForLine`, applied AFTER redaction so the two compose). */
const escapeBodyForLine = (body: string): string => body.replace(/\r\n|\r|\n/g, "\\n")

/**
 * THE one peer-message sanitizer/formatter (RFC jul-18 §4.5). Redacts secrets
 * (caller-injected `redact`, default identity), newline-escapes, then stamps the
 * `[teammate <from> — untrusted] [kind] …` provenance header so the recipient
 * model treats the body as peer DATA, never a trusted instruction. Reused by the
 * queue-drain render below AND by the delivery controller's steer/interrupt
 * injection (RFC §4.5 — "one formatter across all effective modes"). A raw
 * teammate body may never enter a child's context except through this seam.
 *
 * `correlationId` renders a ` (corr: …)` suffix (queue-drain parity); the
 * controller's `PeerEnvelope` path omits it (steer carries the correlation on
 * the submission, not in the visible body).
 */
export const formatPeerBody = (
  args: {
    readonly from: string
    readonly kind: MailboxMessage["kind"]
    readonly body: string
    readonly correlationId?: string
  },
  redact: (s: string) => string = identityRedact,
): string => {
  const safeBody = escapeBodyForLine(redact(typeof args.body === "string" ? args.body : ""))
  const tail = args.correlationId !== undefined ? ` (corr: ${args.correlationId})` : ""
  return `[teammate ${args.from} — untrusted] [${args.kind}] ${safeBody}${tail}`
}

/** Render one peer message to a single provenance-tagged line. Delegates to the
 *  shared {@link formatPeerBody} so push (queue drain) and controller-side
 *  injection share ONE redact→escape→provenance path. */
const renderPeerLine = (m: MailboxMessage, redact: (s: string) => string): string =>
  formatPeerBody(
    {
      from: m.from,
      kind: m.kind,
      body: m.body,
      ...(m.correlationId !== undefined ? { correlationId: m.correlationId } : {}),
    },
    redact,
  )

export interface PeerInboxAdapterOptions {
  /** Redact secrets/PII from each (untrusted) peer body before it enters the
   *  recipient's context. Default identity ⇒ byte-identical when unwired. */
  readonly redact?: (body: string) => string
  /** Max messages injected per turn. Default {@link DEFAULT_PER_TURN_LIMIT}. */
  readonly perTurnLimit?: number
}

/**
 * Build a `PeerInboxDrain.drainFor` over `port`. The result is the function
 * shape the loop's `cfg.peerInbox` expects: `(agentId) => Message | null`.
 */
export const createPeerInboxDrain = (
  port: MailboxPort,
  opts?: PeerInboxAdapterOptions,
): { drainFor(agentId: string): Message | null } => {
  const redact = typeof opts?.redact === "function" ? opts.redact : identityRedact
  const limit =
    typeof opts?.perTurnLimit === "number" &&
    Number.isFinite(opts.perTurnLimit) &&
    opts.perTurnLimit > 0
      ? Math.floor(opts.perTurnLimit)
      : DEFAULT_PER_TURN_LIMIT

  return {
    drainFor(agentId: string): Message | null {
      if (typeof agentId !== "string" || agentId.length === 0) return null
      const messages = port.read(agentId, { limit })
      if (messages.length === 0) return null
      const text = messages.map((m) => renderPeerLine(m, redact)).join("\n")
      return { role: "user", content: [{ type: "text", text }] }
    },
  }
}
