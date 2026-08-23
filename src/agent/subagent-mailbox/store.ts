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
 *   - DIRECT  (`to === agentId`) AND BROADCAST (`to === "*"`) share ONE delivery
 *     mechanism: a PER-READER delivered set on the cell (`delivered: readerId →
 *     deliveredAt`). A message is undelivered to `agentId` exactly while
 *     `!delivered.has(agentId)`. The public `MailboxMessage.deliveredAt` projects
 *     the EARLIEST reader's stamp.
 *
 *     This per-reader model (jun-07 fix) REPLACES the prior broadcast `lastReadAt`
 *     watermark cursor. The cursor advanced to the MAX `sentAt` of a read — but a
 *     `limit`- or `since`-truncated read marks the cursor past broadcasts it did
 *     NOT return, silently losing them. A per-reader set marks ONLY the cells
 *     actually returned, so truncation (limit/since) and same-`sentAt` ties are
 *     lossless: an undelivered broadcast survives until that specific reader
 *     consumes it.
 *
 *     Idempotency is set-membership (a re-read finds `delivered.has(agentId)`);
 *     a broadcast is never delivered to its own sender (`cell.from === agentId`
 *     short-circuits selection).
 *
 * Eviction: bounded by `maxRetained` (default 1024) + `retentionMs` (default
 * 3_600_000ms). Reclaims DELIVERED-before-UNDELIVERED, oldest-`sentAt` first. A
 * cell counts as delivered (evict-first) once ANY reader has consumed it — for a
 * broadcast this is best-effort under sustained memory pressure (the documented
 * LRU bound), distinct from the lossless within-cap delivery above.
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

/** Internal mutable cell. Delivery — DIRECT and BROADCAST alike — is tracked
 *  PER READER via `delivered` (readerId → first-delivery timestamp). A message
 *  is undelivered to a given agent exactly while its id is absent from this map;
 *  marking is therefore confined to the cells actually returned by a read, so a
 *  `limit`/`since`-truncated read can never strand an unread broadcast (jun-07
 *  fix). The public `MailboxMessage.deliveredAt` projects the EARLIEST stamp. */
interface Cell {
  id: string
  from: string
  to: string
  kind: MailboxMessageKind
  body: string
  correlationId?: string
  sentAt: number
  /** readerId → first-delivery timestamp. Empty ⇒ undelivered to anyone. */
  delivered: Map<string, number>
}

/** Earliest per-reader delivery stamp on a cell (the public
 *  `MailboxMessage.deliveredAt`), or `undefined` when delivered to no one. */
const earliestDelivered = (cell: Cell): number | undefined => {
  let min: number | undefined
  for (const t of cell.delivered.values()) {
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

/** Eviction ordering key: 0 = fully delivered (evict first), 1 = still pending.
 *
 *  DIRECT cells have exactly ONE intended reader (`cell.to`), so any delivery
 *  means fully delivered. A BROADCAST has many readers but the store does not
 *  know the agent universe a-priori; instead it tracks `knownReaders` (every id
 *  observed via `read`) and treats a broadcast as fully delivered ONLY when
 *  EVERY known non-sender reader has consumed it. This is the jun-07 structural
 *  fix: the prior rank treated a broadcast as evict-first once ANY one reader
 *  read it, so under memory pressure a broadcast still PENDING for a slower
 *  sibling could be reclaimed ahead of a fully-consumed one — silent loss within
 *  the observed population. Ranking against `knownReaders` keeps a partially-read
 *  broadcast in the pending tier until every observed reader has it. (A reader
 *  that has never called `read` is not in `knownReaders`, so it cannot pin a
 *  broadcast; the retention window is the backstop for a future first-time
 *  reader. Total memory stays bounded by `maxRetained` regardless.) */
const deliveredRank = (cell: Cell, knownReaders: ReadonlySet<string>): 0 | 1 => {
  if (cell.delivered.size === 0) return 1 // nobody has read it → keep
  if (cell.to !== BROADCAST) return 0 // direct: its sole intended reader consumed
  for (const r of knownReaders) {
    if (r !== cell.from && !cell.delivered.has(r)) return 1 // pending for a known reader
  }
  return 0
}

/** Is `cell` an UNDELIVERED (still-pending) cell attributable to `sender`? Used
 *  by the per-sender quota. Mirrors the eviction `deliveredRank` so a partially-
 *  delivered broadcast (pending for some known reader) still counts toward the
 *  sender's undelivered budget. */
const isUndeliveredFromSender = (
  cell: Cell,
  sender: string,
  knownReaders: ReadonlySet<string>,
): boolean => cell.from === sender && deliveredRank(cell, knownReaders) === 1

/** Apply the per-sender quota to every distinct sender currently present in
 *  `cells`. Module-level so `fromSnapshot` stays under the cognitive-complexity
 *  cap. NO-OP when `cap` is undefined / not positive / not finite. The snapshot
 *  hole (audit-H R3): without this sweep, an adversarial snapshot can seed
 *  any number of undelivered cells past `cap` for a single sender, and the
 *  `send`-time quota would not retroactively reclaim them. */
const enforcePerSenderQuotaAll = (
  cells: Map<string, Cell>,
  cap: number | undefined,
  knownReaders: ReadonlySet<string>,
): void => {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return
  const seenSenders = new Set<string>()
  for (const c of cells.values()) seenSenders.add(c.from)
  for (const sender of seenSenders) enforcePerSenderQuota(cells, sender, cap, knownReaders)
}

/** Per-sender quota: ensure `sender` holds at most `cap` undelivered cells.
 *  Evicts THAT sender's oldest-`sentAt` undelivered cells (FIFO per-sender)
 *  until the cap is met. Other senders' cells are never touched — that is
 *  the audit-H R2 isolation guarantee. NO-OP when `cap` is undefined / not
 *  positive / not finite (default-OFF legacy behavior). */
const enforcePerSenderQuota = (
  cells: Map<string, Cell>,
  sender: string,
  cap: number | undefined,
  knownReaders: ReadonlySet<string>,
): void => {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return
  // Tally + collect this sender's undelivered cells in insertion order
  // (Map iteration is insertion order, and `sentAt` is monotonic per
  // `clockNow`, so this IS the FIFO order).
  const undelivered: Cell[] = []
  for (const c of cells.values()) {
    if (isUndeliveredFromSender(c, sender, knownReaders)) undelivered.push(c)
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
  maxRetained: number,
  retentionMs: number,
  t: number,
  knownReaders: ReadonlySet<string>,
): void => {
  if (retentionMs > 0) {
    for (const [id, c] of cells) {
      if (t - c.sentAt > retentionMs) cells.delete(id)
    }
  }
  if (cells.size <= maxRetained) return
  const all = [...cells.values()].sort((a, b) => {
    const ra = deliveredRank(a, knownReaders)
    const rb = deliveredRank(b, knownReaders)
    return ra !== rb ? ra - rb : a.sentAt - b.sentAt
  })
  let drop = cells.size - maxRetained
  for (const c of all) {
    if (drop <= 0) break
    cells.delete(c.id)
    drop--
  }
}

/** Mark the picked cells delivered for `agentId`, returning the projected
 *  messages. Each cell addressed to `agentId` (direct or broadcast) gets a
 *  PER-READER `delivered[agentId]` stamp the FIRST time it is read — another
 *  reader's delivery state is untouched, so a truncated read never strands a
 *  cell for a different reader. Module-level so `read` stays under the
 *  complexity cap. */
const markDelivered = (picked: Cell[], agentId: string, t: number): MailboxMessage[] => {
  const out: MailboxMessage[] = []
  for (const c of picked) {
    if (
      c.from !== agentId &&
      (c.to === agentId || c.to === BROADCAST) &&
      !c.delivered.has(agentId)
    ) {
      c.delivered.set(agentId, t)
    }
    out.push(toMessage(c))
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
  // per-reader map: a delivered DIRECT message (concrete `to`, not "*")
  // re-seeds `{ [to]: deliveredAt }`. A BROADCAST keeps an empty delivered map
  // (the public message cannot name WHICH agent read it), so a restored
  // broadcast is re-delivered to every reader — the same lossy-on-restore
  // posture as the prior cursor model (the cursor was cleared on `fromSnapshot`).
  const delivered = new Map<string, number>()
  if (deliveredAt !== undefined && to.length > 0 && to !== BROADCAST) {
    delivered.set(to, deliveredAt)
  }
  return {
    id: isNonEmptyString(rec.id) ? rec.id : `msg_${randomUUID()}`,
    from: isString(rec.from) ? rec.from : "",
    to,
    kind: rec.kind,
    body: isString(rec.body) ? rec.body : "",
    ...(correlationId !== undefined ? { correlationId } : {}),
    sentAt: finiteOrZero(rec.sentAt),
    delivered,
  }
}

/** The default per-sender undelivered DoS cap (audit-H R2). A single hostile
 *  sender flooding `send({to:"ghost"})` cannot occupy more than this many
 *  undelivered cells before its OWN oldest is evicted (FIFO per-sender),
 *  confining the blast radius to the offender instead of the global budget.
 *  SSOT for {@link createDefaultSubagentMailbox} — every composition root that
 *  mints a session mailbox MUST bake this cap (F2, jul-15).
 *
 *  32 = ~16× the expected steady-state sibling fan-out (subagent siblings rarely
 *  exceed 4) while still tiny vs the 1024-cell global cap, so legitimate burst
 *  traffic stays below it and a hostile flood is capped within ~1 round-trip.
 *  Hosts wiring a mailbox by hand can still override via the closed-port
 *  `maxUndeliveredPerSender` option; this constant governs the default path. */
export const DEFAULT_SUBAGENT_MAILBOX_MAX_UNDELIVERED_PER_SENDER = 32

/**
 * The mailbox's shared state: the option-derived caps, the cell map, the
 * observed-reader set, and the two selection helpers every operation needs.
 *
 * Split out of `createSubagentMailbox` (god-function burndown) so the port
 * methods can live in groups instead of one 210-line factory body.
 */
const mailboxState = (opts?: CreateSubagentMailboxOptions) => {
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
  /** Every agent id ever observed via `read` — the OBSERVED reader population a
   *  broadcast's "fully delivered" rank is computed against (see `deliveredRank`).
   *  Naturally bounded by the number of distinct agents in the session; reader
   *  ids are system-minted (the runner's mailbox labels / `ctx.agentLabel`), not
   *  arbitrary caller input via the tool surface. */
  const knownReaders = new Set<string>()

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
   *  Delivery is checked PER READER (`delivered.has(agentId)`) for BOTH direct
   *  and broadcast, so a sibling consuming its own mail never hides another
   *  sibling's, and a truncated read never strands an unseen broadcast. */
  const isUndeliveredFor = (cell: Cell, agentId: string): boolean => {
    if (cell.from === agentId) return false // never deliver to self
    if (cell.to === agentId || cell.to === BROADCAST) return !cell.delivered.has(agentId)
    return false
  }

  /** Collect undelivered messages for `agentId` honoring `since` + `limit`,
   *  oldest-`sentAt` first. The returned list is EXACTLY the set that `read`
   *  marks delivered — so a `limit`/`since` cut never advances delivery past a
   *  cell it did not return. */
  const collect = (agentId: string, opts2?: { limit?: number; since?: number }): Cell[] => {
    const since = finiteOrUndefined(opts2?.since)
    const limit = finiteOrUndefined(opts2?.limit)
    const out: Cell[] = []
    for (const c of cells.values()) {
      if (!isUndeliveredFor(c, agentId)) continue
      if (since !== undefined && c.sentAt <= since) continue
      out.push(c)
    }
    out.sort((a, b) => a.sentAt - b.sentAt)
    if (limit !== undefined && limit >= 0 && out.length > limit) return out.slice(0, limit)
    return out
  }
  return {
    now,
    maxRetained,
    retentionMs,
    maxUndeliveredPerSender,
    cells,
    knownReaders,
    clockNow,
    isUndeliveredFor,
    collect,
  }
}

/** The state every operation group shares, inferred from {@link mailboxState} so it
 *  can never drift from what that function actually builds. */
type MailboxCtx = ReturnType<typeof mailboxState>

/**
 * Delivery: enqueue a message, read (which MARKS delivered), peek (which does
 * not), and acknowledge. `read` and `collect` share one selection predicate so
 * a `limit`/`since` cut can never advance delivery past a cell it did not
 * return — the invariant that keeps a truncated read from stranding mail.
 */
const deliveryOps = (ctx: MailboxCtx): Pick<MailboxPort, "send" | "read" | "peek" | "ack"> => {
  const {
    maxRetained,
    retentionMs,
    maxUndeliveredPerSender,
    cells,
    knownReaders,
    clockNow,
    collect,
  } = ctx
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
          delivered: new Map<string, number>(),
        }
        cells.set(cell.id, cell)
        // Per-sender quota runs BEFORE the global LRU so a hostile sender's
        // excess always lands on its OWN oldest undelivered cell — never on a
        // legitimate sibling's at the same `rank=1` undelivered tier.
        enforcePerSenderQuota(cells, cell.from, maxUndeliveredPerSender, knownReaders)
        evict(cells, maxRetained, retentionMs, t, knownReaders)
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
        // Record the OBSERVED reader so a broadcast's "fully delivered" rank can
        // require every known reader to have consumed it before it is evict-first.
        knownReaders.add(agentId)
        const picked = collect(agentId, opts2)
        return Object.freeze(markDelivered(picked, agentId, clockNow()))
      } catch (e) {
        logger.warn(`subagent-mailbox.read: ${errMessage(e)}`)
        return Object.freeze([])
      }
    },

    peek(agentId, opts2): readonly MailboxMessage[] {
      try {
        if (!isNonEmptyString(agentId)) return Object.freeze([])
        return Object.freeze(collect(agentId, opts2).map(toMessage))
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
        if (c.to.length > 0 && c.to !== BROADCAST && !c.delivered.has(c.to)) {
          c.delivered.set(c.to, clockNow())
        }
        return toMessage(c)
      } catch (e) {
        logger.warn(`subagent-mailbox.ack: ${errMessage(e)}`)
        return null
      }
    },
  }
}

/** Read-only views and the snapshot codec. None of these mutate delivery
 *  state; `fromSnapshot` repopulates the shared cell map in place. */
const queryOps = (
  ctx: MailboxCtx,
): Pick<MailboxPort, "list" | "pendingFor" | "toSnapshot" | "fromSnapshot"> => {
  const { maxUndeliveredPerSender, cells, knownReaders, isUndeliveredFor } = ctx
  return {
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
        const messages = (snap as MailboxSnapshot | undefined)?.messages
        if (!Array.isArray(messages)) return
        for (const m of messages) {
          const cell = cellFromMessage(m)
          if (cell !== null) cells.set(cell.id, cell)
        }
        // Snapshot hole closeout (audit-H R3): an adversarial snapshot can
        // smuggle in undelivered cells far above the per-sender quota — the
        // quota then only applies to FUTURE `send`s, so the seeded excess
        // sits in the cells map and re-creates the R2 DoS surface. Apply
        // the quota to every distinct sender present in the imported
        // snapshot so the in-memory state is bounded the moment restore
        // completes. NO-OP when `maxUndeliveredPerSender` is OFF.
        enforcePerSenderQuotaAll(cells, maxUndeliveredPerSender, knownReaders)
      } catch (e) {
        logger.warn(`subagent-mailbox.fromSnapshot: ${errMessage(e)}`)
        // leave whatever survived; never throw
      }
    },
  }
}

export const createSubagentMailbox = (opts?: CreateSubagentMailboxOptions): MailboxPort => {
  const ctx = mailboxState(opts)
  return {
    ...deliveryOps(ctx),
    ...queryOps(ctx),
  }
}

/** Mint the DEFAULT session subagent mailbox: {@link createSubagentMailbox} with
 *  the per-sender DoS cap baked in ({@link DEFAULT_SUBAGENT_MAILBOX_MAX_UNDELIVERED_PER_SENDER}).
 *  This is the SSOT factory ALL composition roots use (the host assembler's
 *  `maybeWireMailbox` slot + the side-agent mailbox fallback, and the
 *  `optional-ports` follow-up wire) so no surface can silently get an UNCAPPED
 *  mailbox (the F2 split-brain, jul-15). Extra `opts` (e.g. a test `now`) merge
 *  over the default; an explicit `maxUndeliveredPerSender` still wins. */
export const createDefaultSubagentMailbox = (opts?: CreateSubagentMailboxOptions): MailboxPort =>
  createSubagentMailbox({
    maxUndeliveredPerSender: DEFAULT_SUBAGENT_MAILBOX_MAX_UNDELIVERED_PER_SENDER,
    ...opts,
  })
