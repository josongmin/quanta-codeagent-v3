/**
 * ADR-0416 — In-memory `MailboxPort` implementation.
 *
 * Zero-dep reference store (only `crypto.randomUUID`). The single mutator of
 * the message log. Determinism:
 *   - frozen messages returned to callers (no post-return mutation leaks).
 *   - injected `now` clock seam (default `Date.now`) for stable timestamps.
 *
 * NO-THROW contract: every method wraps its body in a try/catch and degrades to
 * a safe value (`send` ⇒ a best-effort message; readers ⇒ `[]`; `ack` ⇒ `null`;
 * `pendingFor` ⇒ `0`) on ANY internal error or malformed input. No method throws.
 *
 * Delivery model (see ./types doc + ADR-0416):
 *   - DIRECT  (`to === agentId`): a PER-RECIPIENT delivered set
 *     (`directDelivered: recipientId → deliveredAt`). The public
 *     `MailboxMessage.deliveredAt` reflects the FIRST recipient's stamp. Per-
 *     recipient tracking (rather than a single shared `deliveredAt` stamp) is
 *     the audit-H structural fix: one recipient draining its inbox can NEVER
 *     mark another agent's DIRECT mail delivered, so multi-sibling direct
 *     routing is reliable even if two readers transiently match the same `to`.
 *   - BROADCAST(`to === "*"`): per-AGENT `lastReadAt` cursor. A broadcast is
 *     delivered ONCE PER AGENT (each reader has its own cursor) and NEVER to
 *     its own sender.
 *
 * Eviction: bounded by `maxRetained` (default 1024) + `retentionMs` (default
 * 3_600_000ms). Reclaims DELIVERED-before-UNDELIVERED, oldest-`sentAt` first.
 *
 * Per-sender quota (audit-H R2): `maxUndeliveredPerSender` (default OFF) caps
 * how many UNDELIVERED cells any single `from` may simultaneously occupy. A
 * hostile sender flooding `send({ to: "ghost-X" })` would otherwise have its
 * unread cells consume the entire global `maxRetained` budget, then force the
 * global LRU to evict legit sibling mail (which sits at the same `rank=1`
 * undelivered tier). With the knob set, a `send` that pushes the sender past
 * its quota first evicts THAT sender's own oldest undelivered cell (FIFO
 * per-sender) before falling through to global eviction — confining the blast
 * radius to the offender. Counter is purely per-`from`; no heuristics.
 */

import { randomUUID } from "node:crypto"
import { errMessage, logger } from "@/shared"
import type {
  CreateSubagentMailboxOptions,
  MailboxMessage,
  MailboxMessageKind,
  MailboxPort,
  MailboxSnapshot,
} from "./types"

const DEFAULT_MAX_RETAINED = 1024
const DEFAULT_RETENTION_MS = 3_600_000
const BROADCAST = "*"

/** Internal mutable cell. DIRECT delivery is tracked PER RECIPIENT via
 *  `directDelivered` (recipientId → deliveredAt) — the audit-H fix so one
 *  reader cannot consume another agent's direct mail. The public
 *  `MailboxMessage.deliveredAt` is projected as the EARLIEST recipient stamp.
 *  Broadcast delivery is tracked separately via per-agent cursors. */
interface Cell {
  id: string
  from: string
  to: string
  kind: MailboxMessageKind
  body: string
  correlationId?: string
  sentAt: number
  /** recipientId → first-delivery timestamp. Empty ⇒ undelivered to anyone. */
  directDelivered: Map<string, number>
}

/** Earliest per-recipient delivery stamp on a cell (the public
 *  `MailboxMessage.deliveredAt`), or `undefined` when delivered to no one. */
const earliestDelivered = (cell: Cell): number | undefined => {
  let min: number | undefined
  for (const t of cell.directDelivered.values()) {
    if (min === undefined || t < min) min = t
  }
  return min
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isString = (v: unknown): v is string => typeof v === "string"
const isKind = (v: unknown): v is MailboxMessageKind =>
  v === "request" || v === "response" || v === "broadcast"

const finiteOrUndefined = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined
const finiteOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Project a cell to the frozen public message. Omits optional keys when
 *  absent (exactOptional) so a `response` round-trips without a stray
 *  `correlationId: undefined`. */
const toMessage = (cell: Cell): MailboxMessage => {
  const deliveredAt = earliestDelivered(cell)
  return Object.freeze({
    id: cell.id,
    from: cell.from,
    to: cell.to,
    kind: cell.kind,
    body: cell.body,
    sentAt: cell.sentAt,
    ...(cell.correlationId !== undefined ? { correlationId: cell.correlationId } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
  })
}

/** Does `cell` match the (sanitized) `list` filter? Module-level so the port's
 *  `list` body stays under the cognitive-complexity cap. */
const matchesFilter = (
  cell: Cell,
  filter?: { from?: string; to?: string; kind?: MailboxMessageKind },
): boolean => {
  if (isString(filter?.from) && cell.from !== filter.from) return false
  if (isString(filter?.to) && cell.to !== filter.to) return false
  if (isKind(filter?.kind) && cell.kind !== filter.kind) return false
  return true
}

/** A broadcast is "fully seen" once at least one distinct non-sender agent has
 *  a cursor past it (it has served active readers; an entirely-unseen broadcast
 *  stays undelivered). Module-level so callers stay under the complexity cap. */
const broadcastSeen = (cell: Cell, cursors: Map<string, number>): boolean => {
  if (cell.to !== BROADCAST) return false
  for (const [agentId, cursor] of cursors) {
    if (agentId !== cell.from && cursor >= cell.sentAt) return true
  }
  return false
}

/** Eviction ordering key: 0 = delivered (evict first), 1 = undelivered. A
 *  DIRECT cell counts as delivered once ANY recipient has consumed it. */
const deliveredRank = (cell: Cell, cursors: Map<string, number>): 0 | 1 =>
  cell.directDelivered.size > 0 || broadcastSeen(cell, cursors) ? 0 : 1

/** Is `cell` an UNDELIVERED-to-anyone cell attributable to `sender`? Used by
 *  the per-sender quota: a DIRECT cell counts as long as no recipient has
 *  consumed it (`directDelivered.size === 0`); a BROADCAST counts as long as
 *  no non-sender agent's cursor has reached it. Module-level so the closure
 *  per-send predicate inlines the same definition the eviction loop uses. */
const isUndeliveredFromSender = (
  cell: Cell,
  sender: string,
  cursors: Map<string, number>,
): boolean => {
  if (cell.from !== sender) return false
  return deliveredRank(cell, cursors) === 1
}

/** Per-sender quota: ensure `sender` holds at most `cap` undelivered cells.
 *  Evicts THAT sender's oldest-`sentAt` undelivered cells (FIFO per-sender)
 *  until the cap is met. Other senders' cells are never touched — that is
 *  the audit-H R2 isolation guarantee. NO-OP when `cap` is undefined / not
 *  positive / not finite (default-OFF legacy behavior). */
const enforcePerSenderQuota = (
  cells: Map<string, Cell>,
  cursors: Map<string, number>,
  sender: string,
  cap: number | undefined,
): void => {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return
  // Tally + collect this sender's undelivered cells in insertion order
  // (Map iteration is insertion order, and `sentAt` is monotonic per
  // `clockNow`, so this IS the FIFO order). Stop at the first delivered
  // cell or non-match — we only care about the undelivered tail.
  const undelivered: Cell[] = []
  for (const c of cells.values()) {
    if (isUndeliveredFromSender(c, sender, cursors)) undelivered.push(c)
  }
  if (undelivered.length <= cap) return
  undelivered.sort((a, b) => a.sentAt - b.sentAt)
  let drop = undelivered.length - cap
  for (const c of undelivered) {
    if (drop <= 0) break
    cells.delete(c.id)
    drop--
  }
}

/** Reclaim cells past `maxRetained` (delivered-before-undelivered, oldest
 *  `sentAt` first) and any older than `retentionMs`. Mutates `cells` in place.
 *  Module-level so `createSubagentMailbox` stays under the complexity cap. */
const evict = (
  cells: Map<string, Cell>,
  cursors: Map<string, number>,
  maxRetained: number,
  retentionMs: number,
  t: number,
): void => {
  if (retentionMs > 0) {
    for (const [id, c] of cells) {
      if (t - c.sentAt > retentionMs) cells.delete(id)
    }
  }
  if (cells.size <= maxRetained) return
  const all = [...cells.values()].sort((a, b) => {
    const ra = deliveredRank(a, cursors)
    const rb = deliveredRank(b, cursors)
    return ra !== rb ? ra - rb : a.sentAt - b.sentAt
  })
  let drop = cells.size - maxRetained
  for (const c of all) {
    if (drop <= 0) break
    cells.delete(c.id)
    drop--
  }
}

/** Mark the picked cells delivered for `agentId` and advance the broadcast
 *  cursor, returning the projected messages. DIRECT cells get a PER-RECIPIENT
 *  `directDelivered[agentId]` stamp (so another recipient's delivery state is
 *  untouched — the audit-H fix); broadcast idempotency comes from advancing the
 *  agent's cursor past the newest delivered `sentAt`. Module-level so `read`
 *  stays under the complexity cap. */
const markDelivered = (
  picked: Cell[],
  agentId: string,
  cursors: Map<string, number>,
  maxSeenSentAt: number,
  t: number,
): MailboxMessage[] => {
  const out: MailboxMessage[] = []
  for (const c of picked) {
    if (c.to === agentId && !c.directDelivered.has(agentId)) c.directDelivered.set(agentId, t)
    out.push(toMessage(c))
  }
  if (maxSeenSentAt >= 0) {
    const prev = cursors.get(agentId) ?? -1
    if (maxSeenSentAt > prev) cursors.set(agentId, maxSeenSentAt)
  }
  return out
}

/** Reconstruct a mutable cell from a (possibly hostile) public message.
 *  Returns null when the record is structurally unusable. */
const cellFromMessage = (m: unknown): Cell | null => {
  if (m === null || typeof m !== "object") return null
  const rec = m as Partial<MailboxMessage>
  if (!isKind(rec.kind)) return null
  const correlationId = isString(rec.correlationId) ? rec.correlationId : undefined
  const deliveredAt = finiteOrUndefined(rec.deliveredAt)
  const to = isString(rec.to) ? rec.to : ""
  // Snapshot carries only a single public `deliveredAt`. Reconstruct the
  // per-recipient map: a delivered DIRECT message (concrete `to`, not "*")
  // re-seeds `{ [to]: deliveredAt }`; broadcasts keep an empty direct map
  // (their delivery lives in the per-agent cursor, not the snapshot).
  const directDelivered = new Map<string, number>()
  if (deliveredAt !== undefined && to.length > 0 && to !== BROADCAST) {
    directDelivered.set(to, deliveredAt)
  }
  return {
    id: isNonEmptyString(rec.id) ? rec.id : `msg_${randomUUID()}`,
    from: isString(rec.from) ? rec.from : "",
    to,
    kind: rec.kind,
    body: isString(rec.body) ? rec.body : "",
    ...(correlationId !== undefined ? { correlationId } : {}),
    sentAt: finiteOrZero(rec.sentAt),
    directDelivered,
  }
}

export const createSubagentMailbox = (opts?: CreateSubagentMailboxOptions): MailboxPort => {
  const now = opts?.now ?? Date.now
  const maxRetained =
    typeof opts?.maxRetained === "number" &&
    Number.isFinite(opts.maxRetained) &&
    opts.maxRetained > 0
      ? Math.floor(opts.maxRetained)
      : DEFAULT_MAX_RETAINED
  const retentionMs =
    typeof opts?.retentionMs === "number" &&
    Number.isFinite(opts.retentionMs) &&
    opts.retentionMs > 0
      ? opts.retentionMs
      : DEFAULT_RETENTION_MS
  /** Per-sender undelivered cap (audit-H R2). `undefined` ⇒ default-OFF
   *  (legacy behavior, byte-identical). Positive finite integer ⇒ enabled. */
  const maxUndeliveredPerSender =
    typeof opts?.maxUndeliveredPerSender === "number" &&
    Number.isFinite(opts.maxUndeliveredPerSender) &&
    opts.maxUndeliveredPerSender > 0
      ? Math.floor(opts.maxUndeliveredPerSender)
      : undefined

  /** Insertion order preserved by Map iteration; `id → Cell`. */
  const cells = new Map<string, Cell>()
  /** Per-agent broadcast read cursor: `agentId → lastReadAt (sentAt watermark)`.
   *  A broadcast with `sentAt > cursor` is undelivered for that agent. */
  const broadcastCursor = new Map<string, number>()

  const clockNow = (): number => {
    try {
      const t = now()
      return Number.isFinite(t) ? t : Date.now()
    } catch (e) {
      logger.warn(`subagent-mailbox.clockNow: ${errMessage(e)}`)
      return Date.now()
    }
  }

  /** Selection predicate: is `cell` addressed to `agentId` and not-yet-seen?
   *  DIRECT delivery is checked PER RECIPIENT (`directDelivered.has(agentId)`)
   *  so a sibling consuming its own mail never hides another sibling's. */
  const isUndeliveredFor = (cell: Cell, agentId: string): boolean => {
    if (cell.from === agentId) return false // never deliver to self
    if (cell.to === agentId) return !cell.directDelivered.has(agentId)
    if (cell.to === BROADCAST) {
      const cursor = broadcastCursor.get(agentId) ?? -1
      return cell.sentAt > cursor
    }
    return false
  }

  /** Collect undelivered messages for `agentId` honoring `since` + `limit`. */
  const collect = (
    agentId: string,
    opts2?: { limit?: number; since?: number },
  ): { cells: Cell[]; maxSeenSentAt: number } => {
    const since = finiteOrUndefined(opts2?.since)
    const limit = finiteOrUndefined(opts2?.limit)
    const out: Cell[] = []
    let maxSeenSentAt = -1
    for (const c of cells.values()) {
      if (!isUndeliveredFor(c, agentId)) continue
      if (since !== undefined && c.sentAt <= since) continue
      out.push(c)
      if (c.sentAt > maxSeenSentAt) maxSeenSentAt = c.sentAt
    }
    out.sort((a, b) => a.sentAt - b.sentAt)
    if (limit !== undefined && limit >= 0 && out.length > limit) {
      return { cells: out.slice(0, limit), maxSeenSentAt }
    }
    return { cells: out, maxSeenSentAt }
  }

  return {
    send(init): MailboxMessage {
      try {
        const t = clockNow()
        const correlationId = isString(init?.correlationId) ? init.correlationId : undefined
        const cell: Cell = {
          id: `msg_${randomUUID()}`,
          from: isString(init?.from) ? init.from : "",
          to: isString(init?.to) ? init.to : "",
          kind: isKind(init?.kind) ? init.kind : "request",
          body: isString(init?.body) ? init.body : "",
          ...(correlationId !== undefined ? { correlationId } : {}),
          sentAt: t,
          directDelivered: new Map<string, number>(),
        }
        cells.set(cell.id, cell)
        // Per-sender quota runs BEFORE the global LRU so a hostile sender's
        // excess always lands on its OWN oldest undelivered cell — never on a
        // legitimate sibling's at the same `rank=1` undelivered tier.
        enforcePerSenderQuota(cells, broadcastCursor, cell.from, maxUndeliveredPerSender)
        evict(cells, broadcastCursor, maxRetained, retentionMs, t)
        return toMessage(cell)
      } catch (e) {
        logger.warn(`subagent-mailbox.send: ${errMessage(e)}`)
        // Best-effort message even on catastrophic failure (port contract).
        return Object.freeze({
          id: `msg_${randomUUID()}`,
          from: "",
          to: "",
          kind: "request",
          body: "",
          sentAt: Date.now(),
        })
      }
    },

    read(agentId, opts2): readonly MailboxMessage[] {
      try {
        if (!isNonEmptyString(agentId)) return Object.freeze([])
        const { cells: picked, maxSeenSentAt } = collect(agentId, opts2)
        const out = markDelivered(picked, agentId, broadcastCursor, maxSeenSentAt, clockNow())
        return Object.freeze(out)
      } catch (e) {
        logger.warn(`subagent-mailbox.read: ${errMessage(e)}`)
        return Object.freeze([])
      }
    },

    peek(agentId, opts2): readonly MailboxMessage[] {
      try {
        if (!isNonEmptyString(agentId)) return Object.freeze([])
        const { cells: picked } = collect(agentId, opts2)
        return Object.freeze(picked.map(toMessage))
      } catch (e) {
        logger.warn(`subagent-mailbox.peek: ${errMessage(e)}`)
        return Object.freeze([])
      }
    },

    ack(messageId): MailboxMessage | null {
      try {
        if (!isNonEmptyString(messageId)) return null
        const c = cells.get(messageId)
        if (c === undefined) return null
        // Out-of-band acknowledge for the addressed recipient — marks the
        // DIRECT message delivered to `c.to` so a later `read(c.to)` no longer
        // surfaces it. A broadcast / empty `to` has no single recipient to ack;
        // it still round-trips the message unchanged. Idempotent per recipient.
        if (c.to.length > 0 && c.to !== BROADCAST && !c.directDelivered.has(c.to)) {
          c.directDelivered.set(c.to, clockNow())
        }
        return toMessage(c)
      } catch (e) {
        logger.warn(`subagent-mailbox.ack: ${errMessage(e)}`)
        return null
      }
    },

    list(filter): readonly MailboxMessage[] {
      try {
        const out: MailboxMessage[] = []
        for (const c of cells.values()) {
          if (matchesFilter(c, filter)) out.push(toMessage(c))
        }
        return Object.freeze(out)
      } catch (e) {
        logger.warn(`subagent-mailbox.list: ${errMessage(e)}`)
        return Object.freeze([])
      }
    },

    pendingFor(agentId): number {
      try {
        if (!isNonEmptyString(agentId)) return 0
        let n = 0
        for (const c of cells.values()) {
          if (isUndeliveredFor(c, agentId)) n++
        }
        return n
      } catch (e) {
        logger.warn(`subagent-mailbox.pendingFor: ${errMessage(e)}`)
        return 0
      }
    },

    toSnapshot(): MailboxSnapshot {
      try {
        return Object.freeze({
          messages: Object.freeze([...cells.values()].map(toMessage)),
        })
      } catch (e) {
        logger.warn(`subagent-mailbox.toSnapshot: ${errMessage(e)}`)
        return Object.freeze({ messages: Object.freeze([]) })
      }
    },

    fromSnapshot(snap): void {
      try {
        // REPLACE, not merge.
        cells.clear()
        broadcastCursor.clear()
        const messages = (snap as MailboxSnapshot | undefined)?.messages
        if (!Array.isArray(messages)) return
        for (const m of messages) {
          const cell = cellFromMessage(m)
          if (cell !== null) cells.set(cell.id, cell)
        }
      } catch (e) {
        logger.warn(`subagent-mailbox.fromSnapshot: ${errMessage(e)}`)
        // leave whatever survived; never throw
      }
    },
  }
}
