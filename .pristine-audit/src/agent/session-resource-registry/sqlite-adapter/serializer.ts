/**
 * ADR-0361 — row ↔ object serializers + Codex-parity byte estimators.
 *
 * The `estimated_bytes` column mirrors Codex `logs_2.sqlite` migration
 * #2: it is the producer's best estimate of the on-disk cost of the
 * row's payload, used purely by the sliding-window GC. The estimate
 * does NOT need to be exact — it needs to be MONOTONIC (a row with 2×
 * the payload should produce ~2× the estimate) so the cumulative-sum
 * GC bounds total bytes within ~2× of the configured cap.
 *
 * Our estimator is the byte-length of the JSON-encoded payload. This is
 * cheap, deterministic, and a tight upper bound on the encoded size
 * SQLite pays for the TEXT column. It under-counts the row overhead
 * (PK, index, btree fanout) but Codex's empirical 14 GB target already
 * incorporates that overhead, so the cap is in the right ballpark.
 *
 * # Slice-fence note
 *
 * The 8-variant `TypedHistoryEvent` discriminated union from
 * `@/memory/typed-event` (ADR-0320 + ADR-0324 + ADR-0335) round-trips
 * through `JSON.stringify` without loss because every variant's shape
 * uses only primitive + `readonly` array fields. We deliberately
 * preserve `kind` as a top-level column for cheap filtering (future
 * ADR may add a `kind` index) — the rest of the payload lives in
 * `payload` as JSON text.
 *
 * # Closed-kind validator
 *
 * The deserializer validates `kind` against the same 8-element closed
 * set the JSONL sibling adapter uses (`disk-adapter/serializer.ts`).
 * Unknown-kind rows return `null` (NO-THROW degrade); the row stays
 * on disk so an observer can post-mortem it.
 */

import { asCacheKey, type CachedPrompt, type SystemPromptCacheKey } from "@/llm/system-prompt-cache"
import type { TypedHistoryEvent } from "@/memory/typed-event"

/** Closed 8-element set of valid `TypedHistoryEvent.kind` values. Drift
 *  from `@/memory/typed-event/types.ts` is detected by the
 *  typed-event hellgate suite (closed-port pattern). Kept as a literal
 *  array here so we do not pay a runtime import of the discriminator. */
const VALID_KINDS: ReadonlySet<string> = new Set([
  "context_update",
  "skill_activation",
  "repo_rules_change",
  "mode_change",
  "reasoning_echo",
  "compaction_event",
  "plugin_activation",
  "app_activation",
])

/** Row shape for the `events` table. */
export interface EventRow {
  readonly session_id: string
  readonly seq: number
  readonly kind: string
  readonly at: number
  readonly estimated_bytes: number
  readonly payload: string
}

/** Row shape for the `cache_entries` table. */
export interface CacheRow {
  readonly session_id: string
  readonly cache_key: string
  readonly text: string
  readonly content_hash: string
  readonly built_at: number
  readonly estimated_bytes: number
}

/**
 * Estimate the on-disk byte cost of a typed event.
 *
 * Implementation: JSON-encode the event and take the resulting string's
 * `Buffer.byteLength` under UTF-8. We use `Buffer.byteLength` rather
 * than `.length` because JSON-encoded text can contain multi-byte
 * sequences (unicode in `prev`/`next` payloads, free-form `signature`
 * strings, etc.) and the SQLite TEXT column is bytes, not code-units.
 *
 * MONOTONIC by construction. Cheap (a single JSON.stringify pass).
 * NO-THROW: a circular reference (which the closed-port producer
 * SHOULD never emit) falls back to a coarse upper bound.
 */
export const estimateEventBytes = (event: TypedHistoryEvent): number => {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8")
  } catch {
    // Defensive — the producer is responsible for serialisable payloads.
    return 128
  }
}

/**
 * Estimate the on-disk byte cost of a cached prompt.
 *
 * The `text` field is the load-bearing payload; `key` / `contentHash` /
 * `builtAt` add a fixed ~80 bytes of envelope. We track the envelope
 * explicitly so the cumulative sum stays accurate for thousands of
 * tiny `text` payloads.
 */
export const estimateCacheBytes = (text: string): number => Buffer.byteLength(text, "utf8") + 80

/**
 * Encode a {@link TypedHistoryEvent} into the columns of an `events`
 * row. The `payload` column carries the JSON-encoded full event (kind
 * included, so the row is self-describing for ad-hoc DB inspection).
 *
 * NO-THROW: serialisation failure on a hostile payload returns a row
 * whose `payload` is `"{}"` (deserializer drops it as unknown-kind).
 */
export const eventToRow = (sessionId: string, seq: number, event: TypedHistoryEvent): EventRow => {
  let payload: string
  try {
    payload = JSON.stringify(event)
  } catch {
    payload = "{}"
  }
  return {
    session_id: sessionId,
    seq,
    kind: event.kind,
    at: event.at,
    estimated_bytes: estimateEventBytes(event),
    payload,
  }
}

/**
 * Decode an `events` row back into a {@link TypedHistoryEvent}.
 *
 * NO-THROW on a corrupt / unknown-kind `payload`: returns `null` so the
 * caller can skip the row instead of failing the entire `snapshot`
 * call. The corrupt row stays in place — observability surfaces report
 * the loss out-of-band (the corrupt row is NOT auto-deleted).
 */
export const rowToEvent = (row: EventRow): TypedHistoryEvent | null => {
  try {
    const parsed: unknown = JSON.parse(row.payload)
    if (parsed === null || typeof parsed !== "object") return null
    const obj = parsed as Record<string, unknown>
    const kind = obj.kind
    if (typeof kind !== "string" || !VALID_KINDS.has(kind)) return null
    const at = obj.at
    if (typeof at !== "number" || !Number.isFinite(at)) return null
    return parsed as TypedHistoryEvent
  } catch {
    return null
  }
}

/**
 * Encode a {@link CachedPrompt} into the columns of a `cache_entries`
 * row. `cache_key` is the surrogate key the registry uses to locate
 * the entry; the prompt's own branded `key` is dropped on encode
 * because the registry-level `cache_key` IS that brand stripped of its
 * compile-time tag.
 */
export const cacheToRow = (sessionId: string, cacheKey: string, entry: CachedPrompt): CacheRow => ({
  session_id: sessionId,
  cache_key: cacheKey,
  text: entry.text,
  content_hash: entry.contentHash,
  built_at: entry.builtAt,
  estimated_bytes: estimateCacheBytes(entry.text),
})

/**
 * Decode a `cache_entries` row back into a {@link CachedPrompt} +
 * registry key tuple. NO-THROW.
 */
export const rowToCache = (
  row: CacheRow,
): { readonly key: SystemPromptCacheKey; readonly entry: CachedPrompt } => {
  const branded = asCacheKey(row.cache_key)
  return {
    key: branded,
    entry: {
      key: branded,
      text: row.text,
      builtAt: row.built_at,
      contentHash: row.content_hash,
    },
  }
}
