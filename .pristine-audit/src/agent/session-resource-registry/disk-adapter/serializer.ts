/**
 * ADR-0348 — JSONL serializer / deserializer for the disk registry.
 *
 * Pure functions. NO IO. NO-THROW: every error path swallows + degrades
 * (serialize ⇒ `""`, deserialize ⇒ `null`) so a single bad line cannot
 * crash the registry or poison subsequent reads. Matches the existing
 * `JsonlRecorder` discipline (`src/stream/adapters/jsonl-recorder.ts`)
 * where serialization failures are converted to degraded observability
 * lines rather than throws.
 *
 * # Line shape
 *
 * Each `events.jsonl` line is one `TypedHistoryEvent` JSON object.
 * Each `prompt-cache.jsonl` line is one `CacheLine` JSON object.
 *
 * # Slice fence
 *
 * Imports only from sibling slice (`./types`) + `@/memory/typed-event`
 * + `@/llm/system-prompt-cache` (sibling-port reads — same dependency
 * graph as `../in-memory-registry.ts`). No `node:fs` here — keeping
 * the serializer pure leaves I/O concerns to `./disk-store.ts`.
 */

import { asCacheKey, type SystemPromptCacheKey } from "@/llm/system-prompt-cache"
import type { TypedHistoryEvent } from "@/memory/typed-event"
import type { CacheLine, PersistedCacheEntry, PersistedSessionResources } from "./types"

/** Closed list of `TypedHistoryEventKind` literals. Kept here as a
 *  string-array (rather than typed import) so we can mark unknown
 *  `kind` lines as invalid without importing the union (which would
 *  re-introduce a runtime cost). The 8 entries match ADR-0320 +
 *  ADR-0324 + ADR-0335 verbatim — drift detected by the typed-event
 *  hellgate suite, not this set. */
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

/** Type-guard: payload looks like a `TypedHistoryEvent` (closed-kind +
 *  `at` is a finite number). The full structural check is deliberately
 *  light — the producer is `append`-only and we trust its prior
 *  validation. A round-trip failure on hostile content lands in the
 *  NO-THROW degrade path. */
const looksLikeEvent = (raw: unknown): raw is TypedHistoryEvent => {
  if (raw === null || typeof raw !== "object") return false
  const obj = raw as Record<string, unknown>
  const kind = obj.kind
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) return false
  const at = obj.at
  return typeof at === "number" && Number.isFinite(at)
}

/** Type-guard: payload looks like a serialized `CacheLine` (key + text
 *  + contentHash + builtAt). */
const looksLikeCacheLine = (raw: unknown): raw is CacheLine => {
  if (raw === null || typeof raw !== "object") return false
  const obj = raw as Record<string, unknown>
  return (
    typeof obj.key === "string" &&
    typeof obj.text === "string" &&
    typeof obj.contentHash === "string" &&
    typeof obj.builtAt === "number" &&
    Number.isFinite(obj.builtAt as number)
  )
}

/** Serialize one `TypedHistoryEvent` to one JSONL line.
 *  Returns `""` on failure (NO-THROW). The empty-string return is
 *  deliberate: callers append `"\n"`, and the reader-side
 *  `deserializeEventLine` returns `null` for empty input, so a dropped
 *  event leaves no observable artifact. */
export const serializeEventLine = (event: TypedHistoryEvent): string => {
  try {
    return JSON.stringify(event)
  } catch {
    return ""
  }
}

/** Parse one JSONL line into a `TypedHistoryEvent`. Returns `null` on
 *  empty / malformed / unknown-kind input. NO-THROW. */
export const deserializeEventLine = (line: string): TypedHistoryEvent | null => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return looksLikeEvent(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Serialize one `PersistedCacheEntry` to one JSONL line.
 *  Returns `""` on failure (NO-THROW). The on-disk shape drops the
 *  branded key (JSON has no brand notion); the deserializer re-applies
 *  `asCacheKey`. */
export const serializeCacheLine = (entry: PersistedCacheEntry): string => {
  try {
    const wire: CacheLine = {
      key: entry.key,
      text: entry.text,
      contentHash: entry.contentHash,
      builtAt: entry.builtAt,
    }
    return JSON.stringify(wire)
  } catch {
    return ""
  }
}

/** Parse one JSONL line into a `PersistedCacheEntry`. Returns `null` on
 *  empty / malformed input. NO-THROW. */
export const deserializeCacheLine = (line: string): PersistedCacheEntry | null => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!looksLikeCacheLine(parsed)) return null
    const branded: SystemPromptCacheKey = asCacheKey(parsed.key)
    return {
      key: branded,
      text: parsed.text,
      contentHash: parsed.contentHash,
      builtAt: parsed.builtAt,
    }
  } catch {
    return null
  }
}

/** Aggregate a session's per-file persisted lines into a
 *  {@link PersistedSessionResources} snapshot. NO-THROW: the callers
 *  pass the raw line arrays (already filtered through
 *  `deserialize*Line`); this helper just packages. */
export const buildPersistedSnapshot = (
  sessionId: string,
  events: readonly TypedHistoryEvent[],
  cacheEntries: readonly PersistedCacheEntry[],
  lastTouched: number,
): PersistedSessionResources => ({
  sessionId,
  events,
  cacheEntries,
  lastTouched,
})

/** Parse a full `events.jsonl` body into an event array. Lines that
 *  fail to deserialize are skipped silently (NO-THROW degraded path).
 *  The result preserves on-disk order — the producer is append-only so
 *  this matches insertion-time semantics. */
export const parseEventsBody = (body: string): readonly TypedHistoryEvent[] => {
  if (body.length === 0) return []
  const out: TypedHistoryEvent[] = []
  for (const line of body.split("\n")) {
    const ev = deserializeEventLine(line)
    if (ev !== null) out.push(ev)
  }
  return out
}

/** Parse a full `prompt-cache.jsonl` body into a cache-entry array.
 *  Lines that fail to deserialize are skipped silently. Duplicates by
 *  `key` keep the LAST entry (the file is append-only; later writes
 *  override earlier ones for the same key). */
export const parseCacheBody = (body: string): readonly PersistedCacheEntry[] => {
  if (body.length === 0) return []
  const byKey = new Map<string, PersistedCacheEntry>()
  for (const line of body.split("\n")) {
    const entry = deserializeCacheLine(line)
    if (entry !== null) byKey.set(entry.key, entry)
  }
  return Array.from(byKey.values())
}
