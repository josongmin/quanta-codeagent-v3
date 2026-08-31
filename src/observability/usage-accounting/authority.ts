/**
 * In-memory usage accounting (MR-02).
 *
 * The shape of this file is the whole point: `record` folds each admitted call
 * into monotonic counters ONCE, and the retained record list is a separate,
 * bounded concern that `snapshot` never reads. There is deliberately no code
 * path that derives a total by iterating the log — that is what let eviction
 * shrink a bill and un-trip a ceiling in the accountant this replaces.
 */

import {
  addSequenceToRanges,
  type DecodedDurableUsage,
  type DurableUsageBucket,
  decodeDurableUsage,
  encodeMintedCallId,
  type MintedSequenceRange,
  parseMintedCallId,
  sequenceInRanges,
} from "./durable-codec"
import type {
  PreparedUsageHydrate,
  UsageAccountingPort,
  UsageAccountingSnapshot,
  UsageAggregate,
  UsageHydrateOptions,
  UsageRecordResult,
} from "./port"
import type { NormalizedUsage, UsageCost, UsageRecord } from "./types"

/** Default cap on RETAINED records. Bounds the drill-down log only; totals are
 *  unaffected by it, so this number can be lowered without losing a cent. */
export const DEFAULT_RETAINED_RECORDS = 1_000

export interface UsageAccountingOpts {
  /** Max records kept for `recent()`. Clamped to >= 1. */
  readonly maxRetainedRecords?: number
}

/** A mutable counter set. One per aggregation key. */
type Bucket = DurableUsageBucket

const emptyBucket = (): Bucket => ({
  totalUsd: 0,
  estimatedUsd: 0,
  unpricedCalls: 0,
  freshInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  calls: 0,
})

const freeze = (b: Bucket): UsageAggregate => ({
  totalUsd: b.totalUsd,
  estimatedUsd: b.estimatedUsd,
  unpricedCalls: b.unpricedCalls,
  freshInputTokens: b.freshInputTokens,
  cacheReadTokens: b.cacheReadTokens,
  cacheWriteTokens: b.cacheWriteTokens,
  outputTokens: b.outputTokens,
  calls: b.calls,
})

const add = (b: Bucket, usage: NormalizedUsage, cost: UsageCost): void => {
  b.totalUsd += cost.totalUsd
  // An estimate is tracked as its own running total rather than a boolean, so a
  // surface can say HOW MUCH of a number is guesswork instead of condemning the
  // whole figure because one unpriced call slipped in.
  if (!cost.pricingKnown) {
    b.estimatedUsd += cost.totalUsd
    // Counted regardless of amount: a $0 unpriced call is the case the
    // runtime path actually produces, and it must not vanish into "exact $0".
    b.unpricedCalls += 1
  }
  b.freshInputTokens += usage.freshInputTokens
  b.cacheReadTokens += usage.cacheReadTokens
  b.cacheWriteTokens += usage.cacheWriteTokens
  b.outputTokens += usage.outputTokens
  b.calls += 1
}

const bucketIn = (map: Map<string, Bucket>, key: string): Bucket => {
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const fresh = emptyBucket()
  map.set(key, fresh)
  return fresh
}

const frozenMap = (map: Map<string, Bucket>): ReadonlyMap<string, UsageAggregate> => {
  const out = new Map<string, UsageAggregate>()
  for (const [key, bucket] of map) out.set(key, freeze(bucket))
  return out
}

/** Every token bucket that participates in a total must be a real number. */
const isFinitelyCounted = (u: NormalizedUsage, c: UsageCost): boolean =>
  Number.isFinite(u.freshInputTokens) &&
  Number.isFinite(u.cacheReadTokens) &&
  Number.isFinite(u.cacheWriteTokens) &&
  Number.isFinite(u.outputTokens) &&
  Number.isFinite(c.totalUsd)

/** All mutable authority books move together on reset/hydrate. Keeping this
 * state as one replaceable owner prevents a corrupt restore from leaving one
 * counter map from the old session beside another from the new session. */
interface UsageBooks {
  total: Bucket
  byModel: Map<string, Bucket>
  byAgent: Map<string, Bucket>
  boundSessionId: string | undefined
  mintNamespace: string
  mintHighWater: number
  mintedRanges: MintedSequenceRange[]
  externalSeen: Set<string>
  continuityLost: boolean
  byKind: Record<"root" | "subagent", Bucket>
  retained: UsageRecord[]
}

const freshUsageBooks = (): UsageBooks => ({
  total: emptyBucket(),
  byModel: new Map(),
  byAgent: new Map(),
  boundSessionId: undefined,
  mintNamespace: crypto.randomUUID(),
  mintHighWater: 0,
  mintedRanges: [],
  externalSeen: new Set(),
  continuityLost: false,
  byKind: { root: emptyBucket(), subagent: emptyBucket() },
  retained: [],
})

/** Build every mutable owner before the attach boundary. Decoded state already
 * owns fresh validated objects; no temporary authority or JSON round trip. */
const restoredUsageBooks = (
  durable: DecodedDurableUsage,
  options: UsageHydrateOptions,
  maxRetained: number,
): UsageBooks => ({
  total: durable.total,
  byModel: new Map(durable.byModel),
  byAgent: new Map(durable.byAgent),
  boundSessionId:
    durable.total.calls === 0 ? undefined : (options.rebindSessionId ?? durable.boundSessionId),
  mintNamespace: durable.version === 2 ? durable.mint.namespace : crypto.randomUUID(),
  mintHighWater: durable.version === 2 ? durable.mint.highWater : 0,
  mintedRanges:
    durable.version === 2 ? durable.mint.admitted.map(([start, end]) => [start, end]) : [],
  // Legacy V1 has no authenticated mint namespace; retain all its IDs exactly.
  externalSeen: new Set(durable.version === 2 ? durable.externalSeen : durable.seen),
  continuityLost: durable.continuityLost,
  byKind: { root: durable.byKind.root, subagent: durable.byKind.subagent },
  retained: durable.retained
    .slice(-maxRetained)
    .map((record) =>
      options.rebindSessionId === undefined
        ? record
        : { ...record, provenance: { ...record.provenance, sessionId: options.rebindSessionId } },
    ),
})

export const createUsageAccounting = (opts: UsageAccountingOpts = {}): UsageAccountingPort => {
  const maxRetained = Math.max(1, Math.floor(opts.maxRetainedRecords ?? DEFAULT_RETAINED_RECORDS))
  let books = freshUsageBooks()

  const prepareHydrate = (
    json: string | undefined,
    options: UsageHydrateOptions = {},
  ): PreparedUsageHydrate => {
    const durable = json === undefined ? undefined : decodeDurableUsage(json)
    const restored = json === undefined || durable !== undefined
    const prepared =
      durable === undefined ? freshUsageBooks() : restoredUsageBooks(durable, options, maxRetained)
    if (!restored) prepared.continuityLost = true
    let committed = false
    return {
      restored,
      commit: () => {
        if (committed) return
        books = prepared
        committed = true
      },
    }
  }

  return {
    mintCallId(_provenance): string {
      // Provenance remains on the record itself. The opaque private namespace
      // lets durable dedup prove which IDs are compressible without parsing
      // caller-controlled session/agent strings.
      do {
        if (books.mintHighWater === Number.MAX_SAFE_INTEGER) {
          throw new Error("usage-accounting call-id sequence exhausted")
        }
        books.mintHighWater += 1
      } while (books.externalSeen.has(encodeMintedCallId(books.mintNamespace, books.mintHighWater)))
      return encodeMintedCallId(books.mintNamespace, books.mintHighWater)
    },

    record(record: UsageRecord): UsageRecordResult {
      const mintedSequence = parseMintedCallId(record.callId, books.mintNamespace)
      const isMinted = mintedSequence !== undefined && mintedSequence <= books.mintHighWater
      if (
        books.externalSeen.has(record.callId) ||
        (isMinted && sequenceInRanges(books.mintedRanges, mintedSequence))
      ) {
        return { admitted: false, reason: "duplicate" }
      }
      if (!isFinitelyCounted(record.usage, record.cost)) {
        return { admitted: false, reason: "non-finite" }
      }
      // A5 — bind to the first admitted session; reject strangers instead of
      // silently summing two sessions into one bill.
      if (books.boundSessionId === undefined) {
        books.boundSessionId = record.provenance.sessionId
      } else if (record.provenance.sessionId !== books.boundSessionId) {
        return { admitted: false, reason: "session-mismatch" }
      }
      if (isMinted) addSequenceToRanges(books.mintedRanges, mintedSequence)
      else books.externalSeen.add(record.callId)

      const { usage, cost, provenance } = record
      add(books.total, usage, cost)
      add(bucketIn(books.byModel, usage.model), usage, cost)
      add(bucketIn(books.byAgent, provenance.agentId), usage, cost)
      add(books.byKind[provenance.agentKind], usage, cost)

      books.retained.push(record)
      if (books.retained.length > maxRetained)
        books.retained.splice(0, books.retained.length - maxRetained)
      return { admitted: true }
    },

    snapshot(): UsageAccountingSnapshot {
      // Read straight off the counters. Nothing here walks `retained`.
      return {
        ...freeze(books.total),
        continuityLost: books.continuityLost,
        retained: books.retained.length,
        byModel: frozenMap(books.byModel),
        byAgent: frozenMap(books.byAgent),
        boundSessionId: books.boundSessionId,
        byKind: { root: freeze(books.byKind.root), subagent: freeze(books.byKind.subagent) },
      }
    },

    recent(limit?: number): readonly UsageRecord[] {
      if (limit === undefined) return [...books.retained]
      const n = Math.max(0, Math.floor(limit))
      return books.retained.slice(Math.max(0, books.retained.length - n))
    },

    serialize(): string {
      // V2. Authority-minted monotonic IDs serialize as exact intervals;
      // arbitrary caller IDs remain a sparse exact set. Neither is rebuilt
      // from the bounded retained log.
      return JSON.stringify({
        v: 2,
        continuityLost: books.continuityLost,
        boundSessionId: books.boundSessionId,
        mint: {
          namespace: books.mintNamespace,
          highWater: books.mintHighWater,
          admitted: books.mintedRanges,
        },
        externalSeen: [...books.externalSeen],
        retained: books.retained,
        total: books.total,
        byModel: [...books.byModel.entries()],
        byAgent: [...books.byAgent.entries()],
        byKind: books.byKind,
      })
    },

    prepareHydrate,

    hydrate(json: string, options = {}): boolean {
      const prepared = prepareHydrate(json, options)
      prepared.commit()
      return prepared.restored
    },

    reset(): void {
      books = freshUsageBooks()
    },
  }
}
