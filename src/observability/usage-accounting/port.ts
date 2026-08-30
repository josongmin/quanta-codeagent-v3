/**
 * The usage-accounting authority contract (MR-02).
 *
 * ONE object per session owns "what has this session spent". Every surface
 * reads a snapshot of it rather than deriving its own total from whichever
 * feed it happens to be wired to — the failure this replaces is four
 * self-consistent surfaces that disagree with each other.
 *
 * Two invariants define the port, and both exist because the previous
 * accountant broke them:
 *
 *   1. RETENTION IS NOT ACCOUNTING. Aggregates are monotonic counters
 *      incremented once at admission. They are never recomputed from the
 *      retained record list, so bounding memory can never reduce a reported
 *      total — and can never let a spend ceiling go untripped because the
 *      crossing evidence was evicted.
 *   2. RECORDING IS IDEMPOTENT PER CALL. A model call carries a `callId`, and
 *      re-recording it is a no-op. A retry, a replayed stream, or two sinks
 *      racing the same event cannot double-bill.
 */
import type { UsageProvenance, UsageRecord } from "./types"

/** A roll-up over some slice of records. Tokens are the disjoint buckets. */
export interface UsageAggregate {
  readonly totalUsd: number
  /** The portion of `totalUsd` that came from stand-in rates. `> 0` means
   *  this number contains estimates and must be presented as such. */
  readonly estimatedUsd: number
  readonly freshInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  /** Model calls admitted into this slice. */
  readonly calls: number
  /**
   * Admitted calls whose model had NO rate-card entry and NO fallback —
   * priced at $0 with `pricingKnown:false`. Counted regardless of amount,
   * because the runtime path deliberately gives unknown models no fallback:
   * their `estimatedUsd` stays 0, so an "estimates present" signal alone
   * misses every production unknown call. `> 0` means the totals are a
   * FLOOR, and a surface must say incomplete rather than render an exact
   * figure.
   */
  readonly unpricedCalls: number
}

/** Everything a surface needs, from one read. */
export interface UsageAccountingSnapshot extends UsageAggregate {
  /** Calls admitted over the session's whole life — monotonic, never reduced
   *  by retention. Compare with `retained` to see what the log dropped. */
  readonly calls: number
  /** Records still held in the bounded log. `<= calls`. */
  readonly retained: number
  readonly byModel: ReadonlyMap<string, UsageAggregate>
  /** Per-agent roll-up — the dimension that answers "how much did the
   *  subagents cost", which no previous accountant could express. */
  readonly byAgent: ReadonlyMap<string, UsageAggregate>
  /** A5 — the sessionId this authority bound to on first admission, or
   *  `undefined` before any record. Replaces the old `bySession` map, which
   *  was structurally a singleton (one authority per session by construction)
   *  — the singleton is now a CHECKED invariant instead of a dead dimension. */
  readonly boundSessionId: string | undefined
  /** Root vs. subagent spend. Both arms always present, zeroed when unused,
   *  so a surface never has to distinguish "no subagents" from "no data". */
  readonly byKind: Readonly<Record<"root" | "subagent", UsageAggregate>>
  /** A6 — `true` when prior totals were lost to corrupt/unreadable state.
   *  Preserved through later spend and save/restore; surfaces must not claim
   *  the remaining counters cover the full session. Cleared by `reset()` or
   *  by attaching a different healthy book. */
  readonly continuityLost: boolean
}

/** Why a record was not admitted. Absent ⇒ it was. */
export type UsageRejection =
  /** A record with this `callId` was already admitted. */
  | "duplicate"
  /** A token count was NaN or Infinity. Rejected loudly rather than clamped to
   *  0, which would silently understate the bill — the whole point of letting
   *  non-finite counts survive normalization is that someone must notice. */
  | "non-finite"
  /** A5 — the record's sessionId differs from the one this authority BOUND to
   *  on first admission. One authority per session is a construction-time
   *  invariant; a wrongly-shared instance must reject rather than silently
   *  sum two sessions into one bill. */
  | "session-mismatch"

export interface UsageRecordResult {
  readonly admitted: boolean
  readonly reason?: UsageRejection
}

export interface UsageHydrateOptions {
  /** Bind restored books to the currently running session. Retained records
   *  are rebound too, so the next serialization remains internally valid. */
  readonly rebindSessionId?: string | undefined
}

export interface UsageAccountingPort {
  /**
   * A6 — mint the next call id. The SEQUENCE lives inside the authority (and
   * is persisted with it) so a resumed session's new calls continue where the
   * saved ones stopped — an external counter restarting at 1 would collide
   * with restored ids and drop real spend as "duplicate".
   */
  mintCallId(provenance: Pick<UsageProvenance, "sessionId" | "agentId">): string
  /** Admit one priced, attributed model call. Idempotent on `callId`. */
  record(record: UsageRecord): UsageRecordResult
  /**
   * A6/P2 — the durable codec pair. `serialize()` captures aggregates,
   * buckets, the retained log, the FULL exact dedup memory, the mint high-water
   * and the session binding. Authority-minted IDs use exact intervals;
   * arbitrary caller IDs remain a sparse exact set. `hydrate()` accepts legacy
   * V1 and current V2. Corrupt or wrong-shape input leaves the books EMPTY,
   * sets `continuityLost`, and returns `false` so the caller can warn — a
   * resume proceeds, but never silently as an exact $0.
   */
  serialize(): string
  hydrate(json: string, options?: UsageHydrateOptions): boolean
  /** Current totals. Cheap enough to call per render. */
  snapshot(): UsageAccountingSnapshot
  /** Most recent records, newest last, bounded by the retention limit. For
   *  drill-down views; never a source of totals. */
  recent(limit?: number): readonly UsageRecord[]
  /** Drop everything, aggregates included. Session teardown / tests only. */
  reset(): void
}
