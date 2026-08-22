/**
 * ADR-0370 — Operator visibility for `SessionResourceRegistry`.
 * ADR-0377 — Cross-platform path normalization for the inspector
 *            (`storageDir` / `databasePath` rendered POSIX-style for
 *            Codex parity; closed-port read-only `path?` field added
 *            without widening the port itself).
 *
 * The closed `SessionResourceRegistry` port (ADR-0345) only exposes
 * `getOrCreate` / `peek` / `evict` / `size` / `clear` — none of which
 * surface the durable mirror dimensions an operator needs to reason
 * about retention (total bytes, WAL size, per-backend health). Codex
 * exposes the same data through admin shell access to
 * `~/.codex/logs_2.sqlite` (memory `codex-logs-retention-pattern`).
 * This slice gives quanta operators the same surface without breaking
 * the closed port:
 *
 *   - The port itself stays untouched. The 5-method shape (ADR-0345)
 *     is byte-identical pre / post this ADR.
 *   - Sibling read-only inspect functions reach BACKEND-SPECIFIC
 *     state (disk fs walk / sqlite SELECT / in-process Map) without
 *     widening the port. Closed-port discipline preserved.
 *   - A `/session-registry stats` slash command (`src/apps/cli/
 *     session-registry-cmd.ts`) renders the result in operator-
 *     friendly form.
 *
 * # Backend detection
 *
 * `inspectGlobalRegistry()` reads the SAME env vars `global.ts` uses
 * to pick a backend:
 *
 *   1. `QUANTA_SESSION_REGISTRY_SQLITE_PATH` — sqlite adapter
 *      (followup env-var swap planned by ADR-0361 §Default-OFF; this
 *      ADR predates the swap so the var is inspect-only — it does
 *      NOT cause `getGlobalSessionResourceRegistry` to mount the
 *      sqlite backend).
 *   2. `QUANTA_SESSION_REGISTRY_DISK_DIR` — disk adapter (ADR-0351).
 *   3. otherwise — the in-memory singleton.
 *
 * Whichever wins, the inspector returns a `RegistryStats` snapshot
 * shaped to that backend. Fields the backend does not own are
 * `undefined` (e.g. in-memory has no `totalBytes` / `walSize`).
 *
 * # NO-THROW
 *
 * Every inspect function NO-THROWS. SQL errors / fs errors degrade
 * to `unavailable: true` + zeroed numeric fields so the slash
 * formatter can render "unavailable" without taking the process
 * down. The caller (slash command) is operator-facing so a typo'd
 * path must NOT crash the REPL.
 *
 * # Slice fence
 *
 * Imports `bun:sqlite` + `node:fs` + sibling barrel reads
 * (`./global`, `./disk-adapter/types`). No mutation of the port
 * types or the existing adapters. No new cross-slice imports
 * beyond what the existing adapters already establish.
 */

import { Database } from "bun:sqlite"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_MAX_SESSION_BYTES,
  DEFAULT_TTL_MS as DISK_DEFAULT_TTL_MS,
} from "./disk-adapter/types"
import { getGlobalSessionResourceRegistry } from "./global"
import {
  DEFAULT_MAX_TOTAL_BYTES as SQLITE_DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_TTL_MS as SQLITE_DEFAULT_TTL_MS,
} from "./sqlite-adapter/types"
import type { SessionResourceRegistry } from "./types"

/** Backend tag the formatter renders in the title bar. */
export type RegistryBackend = "in-memory" | "disk" | "sqlite"

/**
 * Read-only snapshot of one registry backend. Backend-agnostic on the
 * outside (`backend` discriminator) so the slash formatter can render
 * a single template; backend-specific fields are optional and only
 * populated when the underlying store exposes them.
 *
 * `unavailable` is the explicit NO-THROW signal: an in-memory registry
 * NEVER returns `unavailable: true`; a disk / sqlite backend returns
 * it when the path is unreadable / locked / corrupt. Numeric fields
 * are zeroed in that case so the formatter does not have to special-
 * case `undefined` vs `0`.
 */
export interface RegistryStats {
  readonly backend: RegistryBackend
  /** Number of session-scoped entries currently tracked by the
   *  backend. For disk → per-session directory count under
   *  `storageDir`. For sqlite → COUNT(sessions). For in-memory →
   *  `registry.size()`. */
  readonly sessions: number
  /** Total typed-history events across all sessions. Only the SQLite
   *  backend tracks this durably; disk + in-memory return `undefined`
   *  because counting JSONL lines / Map entries is unbounded work the
   *  inspector should not pay synchronously. */
  readonly totalEvents?: number
  /** Total system-prompt cache rows across all sessions. SQLite only;
   *  same reasoning as `totalEvents`. */
  readonly totalCacheEntries?: number
  /** Bytes on disk:
   *    - disk backend: SUM(stat.size) across `events.jsonl` +
   *      `prompt-cache.jsonl` + `meta.json` per session.
   *    - sqlite backend: SUM(total_estimated_bytes) from the
   *      `sessions` table (same column Codex uses for the
   *      `logs_2.sqlite` sliding window).
   *    - in-memory: `undefined` (process memory not measured here). */
  readonly totalBytes?: number
  /** WAL size in bytes — sqlite only. `stat("$path-wal").size` —
   *  surfaces the "WAL has not checkpointed lately" failure mode. */
  readonly walSize?: number
  /** TTL configured for the backend. `undefined` ⇒ no TTL (in-memory
   *  default). */
  readonly ttlMs?: number
  /** Byte cap configured for the backend. Disk → per-session;
   *  sqlite → total. `undefined` ⇒ unbounded. */
  readonly maxBytes?: number
  /** `true` iff the backend is reachable but reports a usable
   *  snapshot. `false` ⇒ unreachable / errored — caller should render
   *  "unavailable". The numeric fields are still safe to read
   *  (zeroed) in either case. */
  readonly available: boolean
  /**
   * ADR-0377 — backend storage location, normalized to POSIX (forward-
   * slash) form so Windows operators and Codex parity readers see the
   * same shape. `undefined` for the in-memory backend (no on-disk
   * location). Echoed even on the `available:false` branch so a
   * mistyped path is visible to the operator. No `~` expansion / no
   * absolute→relative rewrite — the value is the path the inspector
   * was handed, transformed only by `\` → `/`.
   *
   * This is a read-only addition to the snapshot shape; callers that
   * spread the previous shape continue to work byte-identically
   * because the field is optional and consumers either read it or
   * ignore it.
   */
  readonly path?: string
}

const ZERO_DISK_STATS: RegistryStats = {
  backend: "disk",
  sessions: 0,
  totalBytes: 0,
  ttlMs: DISK_DEFAULT_TTL_MS,
  maxBytes: DEFAULT_MAX_SESSION_BYTES,
  available: false,
}

const ZERO_SQLITE_STATS: RegistryStats = {
  backend: "sqlite",
  sessions: 0,
  totalEvents: 0,
  totalCacheEntries: 0,
  totalBytes: 0,
  walSize: 0,
  ttlMs: SQLITE_DEFAULT_TTL_MS,
  maxBytes: SQLITE_DEFAULT_MAX_TOTAL_BYTES,
  available: false,
}

/**
 * ADR-0377 — flip Windows backslashes to POSIX forward slashes so the
 * inspector surface is identical across platforms (Codex parity = POSIX).
 * Defensive against non-string input even though the type contract
 * forbids it — the inspector is operator-facing and NO-THROW is a
 * cross-cutting invariant for this module.
 *
 * Scope (deliberately narrow):
 *   - Replace every literal `\` with `/`.
 *   - Do NOT expand `~` (the operator may be reading a path from
 *     another machine's config — surfacing the literal is honest).
 *   - Do NOT canonicalize via `path.resolve` (the operator needs to
 *     see exactly the path the backend was handed).
 *   - Do NOT collapse `//` runs (preserve the input shape).
 */
const normalizePath = (p: string): string => {
  if (typeof p !== "string") return ""
  return p.replace(/\\/g, "/")
}

/**
 * Inspect a process-local in-memory registry instance. The port's
 * own `size()` is the only durable signal — `peek` is read-only and
 * the closed port deliberately does NOT expose event / cache counts
 * (those live INSIDE the per-session resources).
 *
 * NO-THROW: hostile registry impls fall back to `sessions = 0`.
 */
export const inspectInMemoryRegistry = (registry: SessionResourceRegistry): RegistryStats => {
  let sessions = 0
  try {
    sessions = registry.size()
  } catch {
    // NO-THROW.
  }
  return {
    backend: "in-memory",
    sessions,
    available: true,
  }
}

interface DiskFileSizes {
  readonly events: number
  readonly cache: number
  readonly meta: number
}

const safeStatSize = async (path: string): Promise<number> => {
  try {
    const st = await stat(path)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

const readSessionDirSizes = async (sessionDir: string): Promise<DiskFileSizes> => {
  const [events, cache, meta] = await Promise.all([
    safeStatSize(join(sessionDir, "events.jsonl")),
    safeStatSize(join(sessionDir, "prompt-cache.jsonl")),
    safeStatSize(join(sessionDir, "meta.json")),
  ])
  return { events, cache, meta }
}

/**
 * Inspect a disk-backed registry by walking the storage directory.
 * Reads file sizes only — no JSONL parsing — so a corrupt body
 * cannot poison the byte total. NO-THROW.
 *
 * ADR-0377: the returned `path` field is the input `storageDir`
 * with backslashes flipped to forward slashes. Echoed on BOTH
 * branches (success + unavailable) so a typo'd path is still
 * visible to the operator in the slash output.
 */
export const inspectDiskRegistryByPath = async (storageDir: string): Promise<RegistryStats> => {
  const path = normalizePath(storageDir)
  let entries: string[]
  try {
    entries = await readdir(storageDir)
  } catch {
    return { ...ZERO_DISK_STATS, path }
  }
  let sessions = 0
  let totalBytes = 0
  for (const entry of entries) {
    const sessionDir = join(storageDir, entry)
    let isDir = false
    try {
      const st = await stat(sessionDir)
      isDir = st.isDirectory()
    } catch {
      // NO-THROW.
    }
    if (!isDir) continue
    sessions += 1
    const sizes = await readSessionDirSizes(sessionDir)
    totalBytes += sizes.events + sizes.cache + sizes.meta
  }
  return {
    backend: "disk",
    sessions,
    totalBytes,
    ttlMs: DISK_DEFAULT_TTL_MS,
    maxBytes: DEFAULT_MAX_SESSION_BYTES,
    path,
    available: true,
  }
}

interface SqliteCountRow {
  readonly c: number
}

interface SqliteSumRow {
  readonly s: number | null
}

const safeCount = (db: Database, sql: string): number => {
  try {
    const row = db.query(sql).get() as SqliteCountRow | null
    return row !== null ? row.c : 0
  } catch {
    return 0
  }
}

const safeSum = (db: Database, sql: string): number => {
  try {
    const row = db.query(sql).get() as SqliteSumRow | null
    if (row === null) return 0
    return row.s !== null ? row.s : 0
  } catch {
    return 0
  }
}

/**
 * Inspect a SQLite-backed registry by opening the DB read-only and
 * running COUNT / SUM queries against the public schema. Includes
 * `stat("$path-wal").size` so operators can see when the WAL has
 * not checkpointed (the same signal Codex exposes through
 * `du -sh ~/.codex/logs_2.sqlite-wal`).
 *
 * NO-THROW: a missing file / corrupt DB / locked table degrades to
 * `available: false` + zero fields. The DB handle is always closed
 * in a `finally` so a transient error cannot leak a connection.
 */
export const inspectSqliteRegistryByPath = async (databasePath: string): Promise<RegistryStats> => {
  const path = normalizePath(databasePath)
  let db: Database
  try {
    // Open read-only so a concurrent writer cannot stall the
    // operator's inspect call. `Database` second-arg is the open mode.
    db = new Database(databasePath, { readonly: true })
  } catch {
    // ADR-0377: still echo the normalized path so the operator can
    // see WHICH path failed to open.
    return { ...ZERO_SQLITE_STATS, path }
  }
  let sessions = 0
  let totalEvents = 0
  let totalCacheEntries = 0
  let totalBytes = 0
  let walSize = 0
  try {
    sessions = safeCount(db, "SELECT COUNT(*) AS c FROM sessions")
    totalEvents = safeCount(db, "SELECT COUNT(*) AS c FROM events")
    totalCacheEntries = safeCount(db, "SELECT COUNT(*) AS c FROM cache_entries")
    totalBytes = safeSum(db, "SELECT COALESCE(SUM(total_estimated_bytes), 0) AS s FROM sessions")
  } finally {
    try {
      db.close()
    } catch {
      // NO-THROW.
    }
  }
  // WAL file lives at `${databasePath}-wal`. Stat-only — no read.
  walSize = await safeStatSize(`${databasePath}-wal`)
  return {
    backend: "sqlite",
    sessions,
    totalEvents,
    totalCacheEntries,
    totalBytes,
    walSize,
    ttlMs: SQLITE_DEFAULT_TTL_MS,
    maxBytes: SQLITE_DEFAULT_MAX_TOTAL_BYTES,
    path,
    available: true,
  }
}

const readEnv = (key: string): string | undefined => {
  const v = process.env[key]
  return v !== undefined && v.length > 0 ? v : undefined
}

/**
 * Resolve the active backend from env vars + inspect it. Same
 * precedence as `global.ts`:
 *   1. sqlite path (env: `QUANTA_SESSION_REGISTRY_SQLITE_PATH`)
 *   2. disk dir (env: `QUANTA_SESSION_REGISTRY_DISK_DIR`)
 *   3. in-memory singleton fallback
 *
 * The sqlite env var is NEW with this ADR — it is consulted only
 * by the inspector (NOT by `getGlobalSessionResourceRegistry`) so
 * the closed-port + default-OFF discipline ADR-0361 declared still
 * holds. A follow-up ADR can promote the var to a full mount on
 * the ADR-0351 pattern.
 *
 * NO-THROW.
 */
export const inspectGlobalRegistry = async (): Promise<RegistryStats> => {
  const sqlitePath = readEnv("QUANTA_SESSION_REGISTRY_SQLITE_PATH")
  if (sqlitePath !== undefined) {
    return inspectSqliteRegistryByPath(sqlitePath)
  }
  const diskDir = readEnv("QUANTA_SESSION_REGISTRY_DISK_DIR")
  if (diskDir !== undefined) {
    return inspectDiskRegistryByPath(diskDir)
  }
  return inspectInMemoryRegistry(getGlobalSessionResourceRegistry())
}

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  // 1 decimal place for KB+, no fractional for B
  const unit = units[u] ?? "KB"
  return `${v.toFixed(1)} ${unit}`
}

const formatDays = (ms: number): string => {
  const days = ms / (24 * 60 * 60 * 1000)
  if (days >= 1) {
    const d = Math.round(days)
    return `${d} day${d === 1 ? "" : "s"}`
  }
  const hours = Math.round(ms / (60 * 60 * 1000))
  return `${hours} hour${hours === 1 ? "" : "s"}`
}

/**
 * Render a `RegistryStats` snapshot into a human-readable block.
 * Pure (no IO) so callers (slash, web admin, log line) all share
 * the same format. Format mirrors Codex `logs_2.sqlite` admin
 * output (memory `codex-logs-retention-pattern`):
 *
 *   ## Session Registry — sqlite (Codex parity)
 *
 *   Path:           /home/op/.quanta/sessions.sqlite
 *   Sessions:           42
 *   Events:           1283
 *   Cache entries:      67
 *   Total bytes:    3.4 MB
 *   WAL size:       512 KB
 *   TTL cap:        14 days
 *   Size cap:       14 GB
 *
 * Numeric padding is best-effort — the formatter intentionally does
 * NOT do column-precise alignment (terminal width is unknown) but
 * keeps a stable 2-column layout so operators can grep.
 *
 * ADR-0377: the `Path:` line is emitted whenever `s.path` is defined
 * — it appears for the disk + sqlite backends (always-on) and is
 * absent for in-memory (which does not have an on-disk location).
 * The value is rendered as-is — `normalizePath` was already applied
 * at the inspect site, so the formatter never sees a backslash here.
 * The `Path:` line is also emitted on the `available:false` branch
 * so an operator can see WHICH path failed.
 */
export const formatRegistryStats = (s: RegistryStats): string => {
  const lines: string[] = []
  const title = `## Session Registry — ${s.backend}`
  const paritySuffix = s.backend === "sqlite" ? " (Codex logs_2.sqlite parity)" : ""
  lines.push(`${title}${paritySuffix}`)
  lines.push("")
  if (s.path !== undefined) lines.push(`Path:            ${s.path}`)
  if (!s.available) {
    lines.push("(unavailable — backend reachable but reports an error)")
    return `${lines.join("\n")}\n`
  }
  lines.push(`Sessions:        ${s.sessions}`)
  if (s.totalEvents !== undefined) lines.push(`Events:          ${s.totalEvents}`)
  if (s.totalCacheEntries !== undefined) {
    lines.push(`Cache entries:   ${s.totalCacheEntries}`)
  }
  if (s.totalBytes !== undefined) lines.push(`Total bytes:     ${formatBytes(s.totalBytes)}`)
  if (s.walSize !== undefined) lines.push(`WAL size:        ${formatBytes(s.walSize)}`)
  if (s.ttlMs !== undefined) lines.push(`TTL cap:         ${formatDays(s.ttlMs)}`)
  if (s.maxBytes !== undefined) lines.push(`Size cap:        ${formatBytes(s.maxBytes)}`)
  return `${lines.join("\n")}\n`
}
