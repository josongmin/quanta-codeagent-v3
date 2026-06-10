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
 *      jun-10 silent-failure audit #3 — the truncation rewrite is gated
 *      on the ADR-0356 per-session file-lock (try-once acquire: a held
 *      lock means a LIVE owner elsewhere, so the truncation is deferred
 *      to a later sweep instead of racing the owner's O_APPENDs) and is
 *      ATOMIC (tmp + rename in the same directory) with a lost-update
 *      tail merge: rows appended after the locked snapshot read are
 *      re-read and carried forward so the rename never drops a
 *      concurrently-appended (newest) row. The tail re-read FAILS CLOSED:
 *      a transient fs error (stat/open/read throwing while the file DID
 *      grow) aborts the truncate so the next sweep retries instead of
 *      clobbering unread rows. Mirrors the LOST-UPDATE GUARD in
 *      `src/stream/adapters/jsonl-retention.ts`. Residual window: an
 *      append landing between the tail re-read and the rename can still
 *      be lost — same documented residual as the retention slice.
 *      ("ATOMIC" here means tear-free, not durable: an fsync is not
 *      forced, so a power loss between rename and the OS flushing the
 *      directory entry can still lose the rewrite — non-durable by design,
 *      acceptable for a best-effort GC.)
 *
 * NO-THROW: every filesystem call is wrapped; permission errors / race
 * conditions degrade to "no-op for this entry" so a hostile filesystem
 * does not break the registry's contract. Counts are returned for
 * observability — callers may log them, but failures themselves are
 * swallowed.
 *
 * # Slice fence
 *
 * Imports `node:crypto`, `node:fs/promises`, `node:path`, and siblings
 * `./file-lock` + `./types`. No cross-slice imports beyond what
 * `./types` carries (typed-event / system-prompt-cache port types).
 */

import { randomBytes } from "node:crypto"
import { open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type AcquireSessionLockOpts, acquireSessionLock } from "./file-lock"
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

/**
 * TEST-ONLY interleaving seams for the locked truncation path (mirrors
 * `ApplyRetentionOpts._afterReadForTest` in
 * `src/stream/adapters/jsonl-retention.ts`). Never set in production —
 * `disk-store.ts` calls `sweepDiskRegistry(cfg)` without hooks.
 */
export interface SweepTestHooks {
  /** Invoked exactly once per truncated session, right AFTER the
   *  under-lock snapshot read and BEFORE the rewrite, so a test can
   *  drive a concurrent append into the read→rename window and prove
   *  the lost-update guard. NO-OP when absent. */
  readonly afterReadForTest?: () => Promise<void>
  /** Invoked between the tmp write and the rename. Throwing here
   *  simulates a crash mid-rewrite — the original file must stay
   *  intact. NO-OP when absent. */
  readonly beforeRenameForTest?: () => Promise<void>
  /** Invoked INSIDE {@link readAppendedTail} AFTER `stat` has confirmed
   *  the file grew past the snapshot (so genuine appended rows DO exist)
   *  but BEFORE the open/read that would recover them. Throwing here
   *  simulates a transient fs failure on the tail re-read — the
   *  fail-CLOSED guard must then ABORT the truncate (leave the original
   *  file byte-identical) rather than clobber the unread rows. NO-OP when
   *  absent. */
  readonly failTailReadForTest?: () => Promise<void>
}

/** GC acquires the per-session lock in "try once + fail immediately"
 *  mode (see `AcquireSessionLockOpts.timeoutMs` — `0` is documented for
 *  best-effort background sweeps). A contended lock means a LIVE owner
 *  in another process; the sweep defers truncation rather than blocking
 *  the lazy `getOrCreate` hook behind a multi-second wait. Same-process
 *  sweeps (the disk-store's own lazy hook while it holds the session
 *  lock) succeed instantly via the holder-map re-entrancy. */
const GC_TRUNCATE_LOCK_TIMEOUT_MS = 0

/** The registry only mints session dirs through `safeId` (`[A-Za-z0-9_-]`
 *  allowlist — see disk-store/file-lock). An entry outside that alphabet
 *  is a foreign directory whose lock path would diverge (safeId maps it
 *  elsewhere), so it can never be truncated under a correct lock. */
const isLockableEntry = (entry: string): boolean => /^[A-Za-z0-9_-]+$/.test(entry)

/** `stat` a file's on-disk byte size. Missing/unreadable ⇒ 0. NO-THROW. */
const fileSizeSafe = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Read a file body + its exact on-disk byte size at snapshot time (the
 *  offset from which a concurrent O_APPEND writes — must be the BYTE
 *  length, not the utf8 string length, so multibyte rows do not shift
 *  the appended-tail offset). Missing/unreadable ⇒ empty. NO-THROW. */
const readBodyWithSize = async (path: string): Promise<{ body: string; bytes: number }> => {
  try {
    const raw = await readFile(path)
    return { body: raw.toString("utf8"), bytes: raw.byteLength }
  } catch {
    return { body: "", bytes: 0 }
  }
}

/** Typed result of a tail re-read. `ok:true` carries the recovered tail
 *  (`""` ONLY when the file legitimately did not grow past `fromByte`);
 *  `ok:false` signals a TRANSIENT fs failure (stat/open/read threw) while
 *  growth was POSSIBLE — the caller must FAIL CLOSED (abort the truncate)
 *  rather than treat an unreadable tail as "no rows appended". */
type TailReadResult = { readonly ok: true; readonly tail: string } | { readonly ok: false }

/** Read the raw bytes appended to `path` AFTER byte offset `fromByte`
 *  (the size at snapshot time). POSIX O_APPEND is atomic per write, so
 *  the grown tail is always a sequence of WHOLE rows.
 *
 *  FAIL-CLOSED: returns `{ ok:false }` on any stat/open/read failure so a
 *  transient fs error cannot masquerade as "no growth" and let the rename
 *  silently drop concurrently-appended rows (jun-10 silent-failure audit
 *  D2). `{ ok:true, tail:"" }` is returned ONLY for a genuine no-growth
 *  (`size <= fromByte`) read. */
const readAppendedTail = async (
  path: string,
  fromByte: number,
  failTailReadForTest?: () => Promise<void>,
): Promise<TailReadResult> => {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return { ok: false }
  }
  if (size <= fromByte) return { ok: true, tail: "" }
  // Growth confirmed past the snapshot: from here on, any failure means
  // we KNOW rows exist that we could not read — fail closed.
  let handle: Awaited<ReturnType<typeof open>>
  try {
    if (failTailReadForTest !== undefined) await failTailReadForTest()
    handle = await open(path, "r")
  } catch {
    return { ok: false }
  }
  try {
    const len = size - fromByte
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, fromByte)
    return { ok: true, tail: buf.toString("utf8") }
  } catch {
    return { ok: false }
  } finally {
    try {
      await handle.close()
    } catch {
      // fd reclaimed by the kernel at the latest on process exit.
    }
  }
}

/** Join the retained suffix with a concurrently-appended tail without
 *  splicing rows: the tail starts at a row boundary (it was appended
 *  after a complete prior write), so the only seam to repair is a
 *  retained suffix that lacks its trailing newline. */
const joinRetainedWithTail = (kept: string, tail: string): string => {
  if (tail.length === 0) return kept
  if (kept.length === 0) return tail
  return kept.endsWith("\n") ? `${kept}${tail}` : `${kept}\n${tail}`
}

/** Atomic single-file rewrite via temp+rename IN THE SAME DIRECTORY
 *  (mirrors `writeAtomicSafe` in `./disk-store.ts` — kept local because
 *  disk-store imports this module, so importing back would cycle).
 *  NO-THROW: returns `false` on any failure, leaving the original file
 *  intact (a crash between tmp write and rename never tears it). */
const writeAtomicTruncateSafe = async (
  path: string,
  body: string,
  beforeRenameForTest?: () => Promise<void>,
): Promise<boolean> => {
  const suffix = randomBytes(8).toString("hex")
  const tmpPath = `${path}.tmp-${suffix}`
  try {
    await writeFile(tmpPath, body, "utf8")
  } catch {
    return false
  }
  try {
    if (beforeRenameForTest !== undefined) await beforeRenameForTest()
    await rename(tmpPath, path)
    return true
  } catch {
    // Cleanup the leftover temp on rename failure; swallow further errors.
    try {
      await rm(tmpPath, { force: true })
    } catch {
      // unreachable in practice; defense in depth.
    }
    return false
  }
}

/** Rewrite one jsonl file down to `budget` bytes, atomically, carrying
 *  forward any rows a live writer appended after the snapshot read
 *  (lost-update guard). Returns `true` iff the rewrite landed. */
const truncateFileAtomic = async (
  path: string,
  snapshot: { body: string; bytes: number },
  budget: number,
  hooks?: SweepTestHooks,
): Promise<boolean> => {
  const kept = truncateFromFront(snapshot.body, budget)
  // LOST-UPDATE GUARD: a live same-process writer may have O_APPEND-ed
  // fresh rows AFTER our under-lock snapshot read (the disk-store's
  // append mirror is fire-and-forget and does not re-take the lock per
  // append). Those bytes live past `snapshot.bytes` — re-read the grown
  // tail and carry it forward so the rename never drops a newest row.
  // The merged body may transiently exceed `budget`; the next sweep
  // re-truncates.
  const tailRes = await readAppendedTail(path, snapshot.bytes, hooks?.failTailReadForTest)
  // FAIL-CLOSED: a transient fs failure on the tail re-read (growth was
  // possible but unreadable) ⇒ ABORT the truncate. Leaving the original
  // file intact lets the next sweep retry — clobbering it via the rename
  // would SILENTLY DROP the concurrently-appended rows we just failed to
  // read (jun-10 silent-failure audit D2).
  if (!tailRes.ok) return false
  const next = joinRetainedWithTail(kept, tailRes.tail)
  return writeAtomicTruncateSafe(path, next, hooks?.beforeRenameForTest)
}

/** Truncate one session's jsonl files to fit `maxSessionBytes`, under
 *  the per-session lock, with atomic rewrites. Returns `true` iff at
 *  least one file was truncated. NO-THROW. */
const truncateSession = async (
  storageDir: string,
  entry: string,
  maxBytes: number,
  lockOpts?: AcquireSessionLockOpts,
  hooks?: SweepTestHooks,
): Promise<boolean> => {
  const sessionDir = join(storageDir, entry)
  const eventsPath = join(sessionDir, EVENTS_FILENAME)
  const cachePath = join(sessionDir, CACHE_FILENAME)
  // Cheap UNLOCKED pre-check via stat so the common under-cap session
  // never pays a lock acquire. The authoritative read happens UNDER the
  // lock below (the pre-check alone would be a TOCTOU).
  const preTotal = (await fileSizeSafe(eventsPath)) + (await fileSizeSafe(cachePath))
  if (preTotal <= maxBytes) return false
  // Foreign dir (never minted by the registry): the lock path would
  // diverge from the data path, so an unlocked rewrite is exactly the
  // defect class this guard exists for. Skip.
  if (!isLockableEntry(entry)) return false

  const lock = await acquireSessionLock(storageDir, entry, {
    ...(lockOpts ?? {}),
    timeoutMs: GC_TRUNCATE_LOCK_TIMEOUT_MS,
  })
  // Contended ⇒ a LIVE owner elsewhere is appending; defer to a later
  // sweep rather than racing it.
  if (lock === null) return false
  let touched = false
  try {
    // Fresh read UNDER the lock — rows appended between the pre-check
    // and the acquire are captured here.
    const events = await readBodyWithSize(eventsPath)
    const cache = await readBodyWithSize(cachePath)
    if (hooks?.afterReadForTest !== undefined) await hooks.afterReadForTest()
    const total = events.bytes + cache.bytes
    if (total <= maxBytes) return false

    // Distribute the budget evenly between events + cache. If only one
    // file is over its share, the other keeps its full body.
    const halfBudget = Math.floor(maxBytes / 2)
    const eventsBudget = events.bytes > halfBudget ? halfBudget : events.bytes
    const cacheBudget = cache.bytes > maxBytes - eventsBudget ? maxBytes - eventsBudget : cache.bytes

    if (events.bytes > eventsBudget) {
      if (await truncateFileAtomic(eventsPath, events, eventsBudget, hooks)) touched = true
    }
    if (cache.bytes > cacheBudget) {
      if (await truncateFileAtomic(cachePath, cache, cacheBudget, hooks)) touched = true
    }
    return touched
  } catch {
    // NO-THROW: a throwing test hook / hostile fs degrades to "whatever
    // landed so far" — the atomic rewrite guarantees no torn file either way.
    return touched
  } finally {
    await lock.release()
  }
}

/** Per-entry classification used by {@link sweepDiskRegistry}. */
type EntryFate = "skip" | "evicted" | "truncated" | "untouched"

/** Per-sweep invariants threaded into {@link processEntry} (bundled so
 *  the helper stays within the parameter budget). */
interface SweepEntryCtx {
  readonly storageDir: string
  readonly ttlMs: number
  readonly maxBytes: number
  readonly currentNow: number
  readonly lockOpts?: AcquireSessionLockOpts
  readonly hooks?: SweepTestHooks
}

/** Decide the fate of one filesystem entry inside storageDir. Pulled out
 *  of {@link sweepDiskRegistry} so the main fn stays under the cognitive-
 *  complexity budget (biome `noExcessiveCognitiveComplexity`). NO-THROW. */
const processEntry = async (entry: string, ctx: SweepEntryCtx): Promise<EntryFate> => {
  const sessionDir = join(ctx.storageDir, entry)
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
  if (meta !== null && ctx.currentNow - meta.lastTouched >= ctx.ttlMs) {
    return (await removeSession(sessionDir)) ? "evicted" : "skip"
  }
  // Even without meta we can apply size-cap truncation defensively
  // (lock-gated + atomic — see truncateSession).
  return (await truncateSession(ctx.storageDir, entry, ctx.maxBytes, ctx.lockOpts, ctx.hooks))
    ? "truncated"
    : "untouched"
}

/**
 * ADR-0387 — Result of a dry-run candidate count. Same axes as
 * {@link SweepResult} but stated as "WOULD evict" + a paired
 * `inspectedSessions` so an operator can sanity-check the denominator.
 */
export interface DiskCleanupCandidates {
  /** Sessions whose `meta.lastTouched` is older than the TTL cutoff. */
  readonly wouldEvictByTtl: number
  /**
   * Sessions whose combined `events.jsonl + prompt-cache.jsonl` body
   * exceeds the per-session byte cap (and would therefore be truncated
   * by `sweepDiskRegistry`). Counted SESSION-wise, not byte-wise, so
   * the value pairs cleanly with `SweepResult.truncated`.
   */
  readonly wouldEvictBySize: number
  /** Total number of top-level entries inspected under `storageDir`. */
  readonly inspectedSessions: number
  /** Echo of `cfg.storageDir` so the operator output identifies the path. */
  readonly storageDir: string
}

const EMPTY_CANDIDATES = (storageDir: string): DiskCleanupCandidates => ({
  wouldEvictByTtl: 0,
  wouldEvictBySize: 0,
  inspectedSessions: 0,
  storageDir,
})

/** Per-entry classification for the dry-run count. Distinguishes
 *  TTL-expired from oversize so they roll up into separate counters. */
type CandidateFate = "skip" | "ttl-candidate" | "size-candidate" | "untouched"

/** Read total byte length of `events.jsonl + prompt-cache.jsonl` for one
 *  session dir. Missing files contribute 0. NO-THROW. */
const sessionByteLen = async (sessionDir: string): Promise<number> => {
  const events = await readFileSafe(join(sessionDir, EVENTS_FILENAME))
  const cache = await readFileSafe(join(sessionDir, CACHE_FILENAME))
  return byteLen(events) + byteLen(cache)
}

/** Decide whether one filesystem entry would be evicted by TTL or by
 *  size. Mirrors {@link processEntry} but performs NO mutation —
 *  uses only `stat`/`readFile`. NO-THROW. */
const classifyEntry = async (
  sessionDir: string,
  ttlMs: number,
  maxBytes: number,
  currentNow: number,
): Promise<CandidateFate> => {
  let st: { isDirectory: () => boolean }
  try {
    st = await stat(sessionDir)
  } catch {
    return "skip"
  }
  if (!st.isDirectory()) return "skip"

  const meta = await readMeta(sessionDir)
  // TTL takes precedence over size (mirrors sweep's processEntry).
  if (meta !== null && currentNow - meta.lastTouched >= ttlMs) {
    return "ttl-candidate"
  }
  const total = await sessionByteLen(sessionDir)
  return total > maxBytes ? "size-candidate" : "untouched"
}

/**
 * ADR-0387 — Count candidates a `sweepDiskRegistry` call WOULD evict
 * without mutating the filesystem. Used by `/session-registry cleanup
 * --dry-run` for operator preview.
 *
 * Algorithm: identical scan + classification to `sweepDiskRegistry`,
 * but `rm` / `writeFile` calls are replaced with counter increments.
 * `readMeta` + `stat` + `readFile` are read-only.
 *
 * NO-THROW: missing `storageDir` ⇒ all-zero counts; per-entry stat /
 * read errors are classified as `"skip"` (consistent with sweep).
 *
 * Idempotent — two consecutive calls return identical results on a
 * stable filesystem (the function performs zero writes).
 */
export const countDiskRegistryCleanupCandidates = async (
  cfg: DiskRegistryConfig,
): Promise<DiskCleanupCandidates> => {
  const ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS
  const maxBytes = cfg.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES
  const now = cfg.now ?? Date.now

  let entries: string[]
  try {
    entries = await readdir(cfg.storageDir)
  } catch {
    return EMPTY_CANDIDATES(cfg.storageDir)
  }

  let wouldEvictByTtl = 0
  let wouldEvictBySize = 0
  let inspectedSessions = 0
  const currentNow = now()

  for (const entry of entries) {
    const sessionDir = join(cfg.storageDir, entry)
    const fate = await classifyEntry(sessionDir, ttlMs, maxBytes, currentNow)
    if (fate === "skip") continue
    inspectedSessions += 1
    if (fate === "ttl-candidate") wouldEvictByTtl += 1
    else if (fate === "size-candidate") wouldEvictBySize += 1
  }
  return { wouldEvictByTtl, wouldEvictBySize, inspectedSessions, storageDir: cfg.storageDir }
}

/**
 * Sweep `storageDir` for TTL-expired sessions + oversize jsonl files.
 *
 * Returns counts for observability. NO-THROW: a missing `storageDir`
 * resolves to `{ evicted: 0, truncated: 0 }`; per-entry failures are
 * swallowed (best-effort GC). Safe to call from the disk-store's
 * lazy hook on every `getOrCreate`.
 *
 * `hooks` is TEST-ONLY (see {@link SweepTestHooks}) — production callers
 * pass only `cfg`.
 */
export const sweepDiskRegistry = async (
  cfg: DiskRegistryConfig,
  hooks?: SweepTestHooks,
): Promise<SweepResult> => {
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
  // `exactOptionalPropertyTypes` — omit absent optional keys entirely.
  const ctx: SweepEntryCtx = {
    storageDir: cfg.storageDir,
    ttlMs,
    maxBytes,
    currentNow,
    ...(cfg.lock !== undefined ? { lockOpts: cfg.lock } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  }

  for (const entry of entries) {
    const fate = await processEntry(entry, ctx)
    if (fate === "evicted") evicted += 1
    else if (fate === "truncated") truncated += 1
  }
  return { evicted, truncated }
}
