/**
 * ADR-0348 — TTL + size-cap GC for the disk-backed session registry.
 *
 * Lazy sweep called by the disk-store on `getOrCreate` (and exposed
 * publicly so callers can run a one-shot maintenance pass). Two
 * eviction axes:
 *
 *   1. TTL — a session whose `meta.json.lastTouched` lies more than
 *      `ttlMs` in the past is EVICTED (the whole `<storageDir>/<id>/`
 *      directory tree is removed). Default 14 days.
 *
 *   2. Size — when a session's combined `events.jsonl + prompt-cache.jsonl`
 *      bytes exceed `maxSessionBytes`, the OLDEST lines are dropped
 *      until under cap. The truncation is line-aware (we walk
 *      newline-boundaries from the end backwards) so we never leave a
 *      partial JSON line on disk. Default 50 MB.
 *
 * NO-THROW: every filesystem call is wrapped; permission errors / race
 * conditions degrade to "no-op for this entry" so a hostile filesystem
 * does not break the registry's contract. Counts are returned for
 * observability — callers may log them, but failures themselves are
 * swallowed.
 *
 * # Slice fence
 *
 * Imports `node:fs/promises`, `node:path`, and sibling `./types`. No
 * cross-slice imports beyond what `./types` carries (typed-event /
 * system-prompt-cache port types).
 */

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_MAX_SESSION_BYTES, DEFAULT_TTL_MS, type DiskRegistryConfig } from "./types"

/** Result of a sweep pass. `evicted` = sessions removed by TTL.
 *  `truncated` = sessions whose jsonl files were reduced to fit
 *  `maxSessionBytes`. */
export interface SweepResult {
  readonly evicted: number
  readonly truncated: number
}

/** Per-session file names — kept here as a constant so the disk-store
 *  and the gc agree on layout without a hidden coupling. */
export const EVENTS_FILENAME = "events.jsonl"
export const CACHE_FILENAME = "prompt-cache.jsonl"
export const META_FILENAME = "meta.json"

interface MetaShape {
  readonly sessionId: string
  readonly lastTouched: number
}

/** Read `meta.json` for a session directory. Returns `null` on any
 *  failure (missing file, malformed JSON, bad shape). NO-THROW. */
const readMeta = async (sessionDir: string): Promise<MetaShape | null> => {
  try {
    const raw = await readFile(join(sessionDir, META_FILENAME), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object") return null
    const obj = parsed as Record<string, unknown>
    const sessionId = obj.sessionId
    const lastTouched = obj.lastTouched
    if (typeof sessionId !== "string" || sessionId.length === 0) return null
    if (typeof lastTouched !== "number" || !Number.isFinite(lastTouched)) return null
    return { sessionId, lastTouched }
  } catch {
    return null
  }
}

/** Best-effort remove of a session directory. Idempotent + NO-THROW. */
const removeSession = async (sessionDir: string): Promise<boolean> => {
  try {
    await rm(sessionDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Read a file's body as utf8. Returns `""` on any failure (missing,
 *  permission denied, etc). NO-THROW. */
const readFileSafe = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}

/** Compute the byte length of a string. Buffer.byteLength counts UTF-8
 *  bytes correctly (matters for non-ASCII payloads). */
const byteLen = (s: string): number => Buffer.byteLength(s, "utf8")

/** Truncate a jsonl body to at most `maxBytes` by dropping lines from
 *  the FRONT (oldest entries) until the suffix fits. Returns the
 *  retained suffix. NO-THROW (pure). */
const truncateFromFront = (body: string, maxBytes: number): string => {
  if (body.length === 0) return ""
  if (byteLen(body) <= maxBytes) return body
  const lines = body.split("\n")
  // Walk from the back, accumulating bytes until we'd exceed maxBytes.
  // Then keep only the suffix.
  let acc = 0
  let keepFrom = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ""
    const lineBytes = byteLen(line) + 1 // +1 for newline
    if (acc + lineBytes > maxBytes) break
    acc += lineBytes
    keepFrom = i
  }
  // Always preserve at least one line if possible (so empty truncation
  // doesn't wipe everything when one line alone exceeds the cap).
  if (keepFrom === lines.length && lines.length > 0) {
    keepFrom = lines.length - 1
  }
  return lines.slice(keepFrom).join("\n")
}

/** Best-effort overwrite. NO-THROW. */
const writeBodySafe = async (path: string, body: string): Promise<boolean> => {
  try {
    await writeFile(path, body, "utf8")
    return true
  } catch {
    return false
  }
}

/** Truncate one session's jsonl files to fit `maxSessionBytes`. Returns
 *  `true` iff at least one file was truncated. NO-THROW. */
const truncateSession = async (sessionDir: string, maxBytes: number): Promise<boolean> => {
  const eventsPath = join(sessionDir, EVENTS_FILENAME)
  const cachePath = join(sessionDir, CACHE_FILENAME)
  const eventsBody = await readFileSafe(eventsPath)
  const cacheBody = await readFileSafe(cachePath)
  const total = byteLen(eventsBody) + byteLen(cacheBody)
  if (total <= maxBytes) return false

  // Distribute the budget evenly between events + cache. If only one
  // file is over its share, the other keeps its full body.
  const halfBudget = Math.floor(maxBytes / 2)
  const eventsBudget = byteLen(eventsBody) > halfBudget ? halfBudget : byteLen(eventsBody)
  const cacheBudget =
    byteLen(cacheBody) > maxBytes - eventsBudget ? maxBytes - eventsBudget : byteLen(cacheBody)

  let touched = false
  if (byteLen(eventsBody) > eventsBudget) {
    const next = truncateFromFront(eventsBody, eventsBudget)
    if (await writeBodySafe(eventsPath, next)) touched = true
  }
  if (byteLen(cacheBody) > cacheBudget) {
    const next = truncateFromFront(cacheBody, cacheBudget)
    if (await writeBodySafe(cachePath, next)) touched = true
  }
  return touched
}

/** Per-entry classification used by {@link sweepDiskRegistry}. */
type EntryFate = "skip" | "evicted" | "truncated" | "untouched"

/** Decide the fate of one filesystem entry inside storageDir. Pulled out
 *  of {@link sweepDiskRegistry} so the main fn stays under the cognitive-
 *  complexity budget (biome `noExcessiveCognitiveComplexity`). NO-THROW. */
const processEntry = async (
  sessionDir: string,
  ttlMs: number,
  maxBytes: number,
  currentNow: number,
): Promise<EntryFate> => {
  let st: { isDirectory: () => boolean }
  try {
    st = await stat(sessionDir)
  } catch {
    return "skip"
  }
  if (!st.isDirectory()) return "skip"

  const meta = await readMeta(sessionDir)
  // TTL check first — an expired entry is removed wholesale, no
  // truncation needed.
  if (meta !== null && currentNow - meta.lastTouched >= ttlMs) {
    return (await removeSession(sessionDir)) ? "evicted" : "skip"
  }
  // Even without meta we can apply size-cap truncation defensively.
  return (await truncateSession(sessionDir, maxBytes)) ? "truncated" : "untouched"
}

/**
 * Sweep `storageDir` for TTL-expired sessions + oversize jsonl files.
 *
 * Returns counts for observability. NO-THROW: a missing `storageDir`
 * resolves to `{ evicted: 0, truncated: 0 }`; per-entry failures are
 * swallowed (best-effort GC). Safe to call from the disk-store's
 * lazy hook on every `getOrCreate`.
 */
export const sweepDiskRegistry = async (cfg: DiskRegistryConfig): Promise<SweepResult> => {
  const ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS
  const maxBytes = cfg.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES
  const now = cfg.now ?? Date.now

  let entries: string[]
  try {
    entries = await readdir(cfg.storageDir)
  } catch {
    return { evicted: 0, truncated: 0 }
  }

  let evicted = 0
  let truncated = 0
  const currentNow = now()

  for (const entry of entries) {
    const sessionDir = join(cfg.storageDir, entry)
    const fate = await processEntry(sessionDir, ttlMs, maxBytes, currentNow)
    if (fate === "evicted") evicted += 1
    else if (fate === "truncated") truncated += 1
  }
  return { evicted, truncated }
}
