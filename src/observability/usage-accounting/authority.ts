/**
 * In-memory usage accounting (MR-02).
 *
 * The shape of this file is the whole point: `record` folds each admitted call
 * into monotonic counters ONCE, and the retained record list is a separate,
 * bounded concern that `snapshot` never reads. There is deliberately no code
 * path that derives a total by iterating the log — that is what let eviction
 * shrink a bill and un-trip a ceiling in the accountant this replaces.
 */
import type {
  UsageAccountingPort,
  UsageAccountingSnapshot,
  UsageAggregate,
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
interface Bucket {
  totalUsd: number
  estimatedUsd: number
  unpricedCalls: number
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  calls: number
}

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

export const createUsageAccounting = (opts: UsageAccountingOpts = {}): UsageAccountingPort => {
  const maxRetained = Math.max(1, Math.floor(opts.maxRetainedRecords ?? DEFAULT_RETAINED_RECORDS))

  let total = emptyBucket()
  let byModel = new Map<string, Bucket>()
  let byAgent = new Map<string, Bucket>()
  let boundSessionId: string | undefined
  // A6 — the mint sequence and the continuity flag, both part of the durable
  // state. The sequence is authority-owned so a resume CONTINUES it; an
  // external counter restarting at 1 would collide with restored ids.
  let seq = 0
  let continuityLost = false
  let byKind: Record<"root" | "subagent", Bucket> = { root: emptyBucket(), subagent: emptyBucket() }
  // Admitted call ids. Grows with the session; a call id is small and the
  // alternative — forgetting one — is a double-billed retry.
  let seen = new Set<string>()
  let retained: UsageRecord[] = []

  const clearBooks = (): void => {
    total = emptyBucket()
    byModel = new Map()
    byAgent = new Map()
    boundSessionId = undefined
    byKind = { root: emptyBucket(), subagent: emptyBucket() }
    seen = new Set()
    retained = []
    seq = 0
  }

  return {
    mintCallId(provenance): string {
      seq += 1
      return `${provenance.sessionId}:${provenance.agentId}:${seq}`
    },

    record(record: UsageRecord): UsageRecordResult {
      if (seen.has(record.callId)) return { admitted: false, reason: "duplicate" }
      if (!isFinitelyCounted(record.usage, record.cost)) {
        return { admitted: false, reason: "non-finite" }
      }
      // A5 — bind to the first admitted session; reject strangers instead of
      // silently summing two sessions into one bill.
      if (boundSessionId === undefined) {
        boundSessionId = record.provenance.sessionId
      } else if (record.provenance.sessionId !== boundSessionId) {
        return { admitted: false, reason: "session-mismatch" }
      }
      seen.add(record.callId)

      const { usage, cost, provenance } = record
      add(total, usage, cost)
      add(bucketIn(byModel, usage.model), usage, cost)
      add(bucketIn(byAgent, provenance.agentId), usage, cost)
      add(byKind[provenance.agentKind], usage, cost)

      retained.push(record)
      if (retained.length > maxRetained) retained.splice(0, retained.length - maxRetained)
      return { admitted: true }
    },

    snapshot(): UsageAccountingSnapshot {
      // Read straight off the counters. Nothing here walks `retained`.
      return {
        ...freeze(total),
        continuityLost,
        retained: retained.length,
        byModel: frozenMap(byModel),
        byAgent: frozenMap(byAgent),
        boundSessionId,
        byKind: { root: freeze(byKind.root), subagent: freeze(byKind.subagent) },
      }
    },

    recent(limit?: number): readonly UsageRecord[] {
      if (limit === undefined) return [...retained]
      const n = Math.max(0, Math.floor(limit))
      return retained.slice(Math.max(0, retained.length - n))
    },

    serialize(): string {
      // v1. The FULL dedup memory rides along — rebuilding `seen` from the
      // retained slice would re-bill exactly the callIds old enough to have
      // been evicted from it.
      return JSON.stringify({
        v: 1,
        boundSessionId,
        seq,
        seen: [...seen],
        retained,
        total,
        byModel: [...byModel.entries()],
        byAgent: [...byAgent.entries()],
        byKind,
      })
    },

    hydrate(json: string): boolean {
      // Corrupt or wrong-shape state: the books stay EMPTY and SAY so — a
      // resume proceeds, but never silently as an exact $0.
      let parsed: unknown
      try {
        parsed = JSON.parse(json)
      } catch {
        clearBooks()
        continuityLost = true
        return false
      }
      const d = parsed as {
        v?: number
        boundSessionId?: string
        seq?: number
        seen?: unknown
        retained?: unknown
        total?: Bucket
        byModel?: Array<[string, Bucket]>
        byAgent?: Array<[string, Bucket]>
        byKind?: Record<"root" | "subagent", Bucket>
      }
      const sane =
        d !== null &&
        typeof d === "object" &&
        d.v === 1 &&
        Array.isArray(d.seen) &&
        Array.isArray(d.retained) &&
        typeof d.total === "object" &&
        d.total !== null &&
        Number.isFinite(d.total.totalUsd) &&
        typeof d.seq === "number" &&
        Number.isFinite(d.seq) &&
        Array.isArray(d.byModel) &&
        Array.isArray(d.byAgent) &&
        typeof d.byKind === "object" &&
        d.byKind !== null
      if (!sane) {
        clearBooks()
        continuityLost = true
        return false
      }
      boundSessionId = d.boundSessionId
      seq = Math.max(0, Math.floor(d.seq as number))
      seen = new Set((d.seen as unknown[]).filter((x): x is string => typeof x === "string"))
      retained = (d.retained as UsageRecord[]).slice(-maxRetained)
      total = { ...emptyBucket(), ...(d.total as Bucket) }
      byModel = new Map(
        (d.byModel as Array<[string, Bucket]>).map(([k, b]) => [k, { ...emptyBucket(), ...b }]),
      )
      byAgent = new Map(
        (d.byAgent as Array<[string, Bucket]>).map(([k, b]) => [k, { ...emptyBucket(), ...b }]),
      )
      const kinds = d.byKind as Record<"root" | "subagent", Bucket>
      byKind = {
        root: { ...emptyBucket(), ...kinds.root },
        subagent: { ...emptyBucket(), ...kinds.subagent },
      }
      continuityLost = false
      return true
    },

    reset(): void {
      clearBooks()
      continuityLost = false
    },
  }
}
