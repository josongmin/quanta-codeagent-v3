/**
 * ADR-0416 — Managed-subagent mailbox (types).
 *
 * quanta subagents are fork-and-forget: once spawned, a child can only report
 * back via its final result. Codex `multi_agents_v2.send_message(agent_id, msg)`
 * lets parent↔child AND sibling↔sibling exchange messages WITHOUT teardown.
 * This file defines the CLOSED port + data model for that mailbox.
 *
 * SLICE FENCE: pure leaf. Imports ONLY `@/shared` + `zod` (the store uses
 * neither — it is dependency-free apart from `crypto.randomUUID`). NO imports
 * from `@/agent` core (loop / dispatch / prompt / features / types), `@/apps`,
 * `@/subagent`, or any sibling slice. Pure data + a closed port.
 *
 * NO-THROW: EVERY public method on {@link MailboxPort} degrades gracefully on
 * hostile / malformed input — `send` always returns a message, the readers
 * return `[]`, `ack` returns `null`, `pendingFor` returns `0`. No method throws.
 *
 * exactOptional: optional fields are OMITTED when absent (never `: undefined`).
 */

/** Message intent. `request`/`response` form a correlated pair (via
 *  `correlationId`); `broadcast` fans out to every other agent. Closed enum. */
export type MailboxMessageKind = "request" | "response" | "broadcast"

/** A single inter-agent message. Immutable once produced by `send`; `read`
 *  returns a COPY stamped with `deliveredAt` (the stored record is the source
 *  of the delivered flag, never mutated in place after the caller holds it). */
export interface MailboxMessage {
  readonly id: string
  readonly from: string
  /** Target agent id, or `"*"` for a broadcast to every other agent. */
  readonly to: string
  readonly kind: MailboxMessageKind
  readonly body: string
  readonly correlationId?: string
  readonly sentAt: number
  /** Set the first time the message is delivered to a recipient via `read`.
   *  For a DIRECT message the store tracks delivery PER RECIPIENT (audit-H
   *  fix); this public field projects the EARLIEST recipient's stamp. For a
   *  broadcast it reflects the FIRST per-agent delivery (the store tracks
   *  per-agent lastReadAt for broadcast fan-out). */
  readonly deliveredAt?: number
}

/** Serializable point-in-time view of every retained message in a mailbox. */
export interface MailboxSnapshot {
  readonly messages: readonly MailboxMessage[]
}

/**
 * Closed inter-agent mailbox port. ALL methods NO-THROW.
 *
 * Delivery semantics:
 *   - `read(agentId)`  returns messages addressed to `agentId` (direct `to ===
 *     agentId` OR broadcast `to === "*"` from another agent) that the agent has
 *     not yet seen, and MARKS them delivered (advances the agent's per-agent
 *     read cursor). Re-reading is idempotent — already-seen messages do not
 *     reappear.
 *   - `peek(agentId)`  same selection WITHOUT advancing the cursor / marking
 *     delivered.
 *   - broadcast (`to:"*"`) is delivered ONCE PER AGENT: each agent has its own
 *     `lastReadAt` cursor, so a broadcast appears exactly once to each distinct
 *     reader (and never to its own sender).
 *   - `ack(messageId)` marks a specific message delivered out-of-band (e.g. a
 *     surface acknowledges receipt) and returns the (now-delivered) message, or
 *     `null` for an unknown id.
 *   - `send(to:unknown)` SUCCEEDS — an unknown / not-yet-spawned target id sits
 *     unread until that agent reads (or forever; eviction reclaims it).
 *   - `pendingFor(unknown)` is `0`.
 *
 * Retention / LRU: at most `maxRetained` messages (default 1024) are kept;
 * messages older than `retentionMs` (default 3_600_000) are also reclaimed.
 * Eviction prefers DELIVERED messages over UNDELIVERED ones (an unread message
 * is more valuable than one already consumed), oldest-`sentAt` first within a
 * class.
 *
 * `now` is an injected clock seam (default `Date.now`) for deterministic tests.
 */
export interface MailboxPort {
  send(init: {
    from: string
    to: string
    kind: MailboxMessageKind
    body: string
    correlationId?: string
  }): MailboxMessage
  /** Returns undelivered messages for `agentId` and MARKS them delivered. */
  read(agentId: string, opts?: { limit?: number; since?: number }): readonly MailboxMessage[]
  /** Returns undelivered messages for `agentId` WITHOUT marking them. */
  peek(agentId: string, opts?: { limit?: number; since?: number }): readonly MailboxMessage[]
  /** Mark a specific message delivered; returns it (or `null` if unknown). */
  ack(messageId: string): MailboxMessage | null
  /** All retained messages, optionally filtered. Read-only, no mark. */
  list(filter?: {
    from?: string
    to?: string
    kind?: MailboxMessageKind
  }): readonly MailboxMessage[]
  /** Count of currently-undelivered messages addressed to `agentId`. */
  pendingFor(agentId: string): number
  toSnapshot(): MailboxSnapshot
  /** REPLACE-not-merge: clears existing state, then loads the snapshot. */
  fromSnapshot(snap: MailboxSnapshot): void
}

/** Factory options. `now` for determinism; `retentionMs` / `maxRetained` cap
 *  retained-message growth. */
export type CreateSubagentMailboxOptions = {
  now?: () => number
  retentionMs?: number
  maxRetained?: number
}
