/**
 * Idle monitor + snooze persistence (Cursor 3.2 inspired).
 *
 * Two surface-only mechanisms layered into the CLI REPL:
 *
 *   1. **Idle suppress** — track the timestamp of the last user activity
 *      (keypress / turn boundary). After `idleThresholdMs` (default 60_000ms,
 *      Cursor §4.2 verbatim) with no activity, `isIdle()` returns true. The
 *      REPL paints a transient status-bar hint and refuses to enter a new
 *      turn until activity resumes. Running turns are NOT torn down — idle
 *      is a UI gate on NEW turns only (background subagents keep going).
 *
 *   2. **Snooze** — explicit user gesture (`/snooze 5m`) that suspends new
 *      turns until `snoozedUntil` elapses. Default 300_000ms (Cursor §5
 *      verbatim). State persisted to `~/.quanta/snooze` (JSON) so a
 *      re-launched CLI within the snooze window still refuses turns.
 *
 * Disk persistence is best-effort: a write failure (read-only home, ENOSPC)
 * falls back to in-memory snooze silently — the user can still re-issue
 * `/snooze` after `/resume` and it will work for the current process.
 *
 * Slice discipline: this module is `apps/cli` only — no agent / LLM imports.
 * Clock is injected (`opts.now`) so tests advance time without `sleep`. Both
 * default thresholds are hot-overridable per call to `createIdleMonitor` (the
 * REPL reads the QUANTA_IDLE_MS / QUANTA_SNOOZE_DEFAULT_MS env knobs at
 * construction time).
 *
 * `QUANTA_IDLE_SUPPRESS=0` ⇒ the REPL skips construction entirely (no-op
 * default-OFF path) — there is no internal kill-switch here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_IDLE_MS = 60_000
const DEFAULT_SNOOZE_MS = 300_000

export interface IdleMonitor {
  /** Mark the latest user-driven activity (keypress, turn start). Resets
   *  the idle clock; does NOT cancel an active snooze (which is explicit). */
  markActive(): void
  /** True iff `(now - lastActive) >= idleThresholdMs`. False during a fresh
   *  process (markActive is called at construction so the user never sees
   *  an immediate idle banner on startup). */
  isIdle(): boolean
  /** Enter snooze for `durationMs` (default = `opts.defaultSnoozeMs`).
   *  Persists `{ snoozedUntil }` to `opts.snoozeFile` (best-effort). */
  snooze(durationMs?: number): void
  /** Cancel an active snooze AND clear the disk record. Idempotent. */
  unsnooze(): void
  /** True iff `now < snoozedUntil`. The disk record (if any) is read once
   *  at construction time (when `loadSnoozeFromDisk !== false`) so a
   *  re-launched CLI within the window is still snoozed. */
  isSnoozed(): boolean
  /** Test-only: clear in-memory state (does NOT delete the disk record). */
  reset(): void
}

export interface IdleMonitorOptions {
  /** Threshold for `isIdle()`. Default 60_000ms (Cursor §4.2). */
  idleThresholdMs?: number
  /** Default duration applied when `snooze()` is called with no argument.
   *  Default 300_000ms (Cursor §5). */
  defaultSnoozeMs?: number
  /** Override the disk persistence path. Default `~/.quanta/snooze`. */
  snoozeFile?: string
  /** Inject a deterministic clock (tests). Default `Date.now`. */
  now?: () => number
  /** When false, the constructor does NOT read the disk file (ephemeral
   *  mode — useful for tests and one-shot prompts). Default true. */
  loadSnoozeFromDisk?: boolean
}

interface SnoozeRecord {
  snoozedUntil: number
}

const defaultSnoozeFile = (): string => join(homedir(), ".quanta", "snooze")

const readSnoozeFile = (path: string): number | null => {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object") return null
    const until = (parsed as Partial<SnoozeRecord>).snoozedUntil
    if (typeof until !== "number" || !Number.isFinite(until)) return null
    return until
  } catch {
    // Corrupt JSON / unreadable file ⇒ silent in-memory fallback.
    return null
  }
}

const writeSnoozeFile = (path: string, until: number): void => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const rec: SnoozeRecord = { snoozedUntil: until }
    writeFileSync(path, `${JSON.stringify(rec)}\n`, "utf8")
  } catch {
    // Persistence is best-effort; in-memory state remains correct.
  }
}

const deleteSnoozeFile = (path: string): void => {
  if (!existsSync(path)) return
  try {
    // Overwrite with `{}` instead of unlink — keeps the file path stable
    // and avoids a TOCTOU window where a concurrent writer would re-create
    // it with stale contents. A subsequent read parses `{}` → null.
    writeFileSync(path, "{}\n", "utf8")
  } catch {
    // Best-effort.
  }
}

export const createIdleMonitor = (opts?: IdleMonitorOptions): IdleMonitor => {
  const idleMs = opts?.idleThresholdMs ?? DEFAULT_IDLE_MS
  const snoozeMs = opts?.defaultSnoozeMs ?? DEFAULT_SNOOZE_MS
  const snoozeFile = opts?.snoozeFile ?? defaultSnoozeFile()
  const now = opts?.now ?? ((): number => Date.now())
  const loadFromDisk = opts?.loadSnoozeFromDisk !== false

  let lastActive = now()
  let snoozedUntil: number | null = null

  if (loadFromDisk) {
    const persisted = readSnoozeFile(snoozeFile)
    if (persisted !== null && persisted > now()) snoozedUntil = persisted
  }

  return {
    markActive: (): void => {
      lastActive = now()
    },
    isIdle: (): boolean => {
      // `Infinity` threshold ⇒ never idle (env-driven disable).
      if (!Number.isFinite(idleMs)) return false
      if (idleMs <= 0) return false
      return now() - lastActive >= idleMs
    },
    snooze: (durationMs?: number): void => {
      const dur = durationMs ?? snoozeMs
      if (!Number.isFinite(dur) || dur <= 0) return
      const until = now() + dur
      snoozedUntil = until
      writeSnoozeFile(snoozeFile, until)
    },
    unsnooze: (): void => {
      snoozedUntil = null
      deleteSnoozeFile(snoozeFile)
    },
    isSnoozed: (): boolean => {
      if (snoozedUntil === null) return false
      if (now() < snoozedUntil) return true
      // Window elapsed ⇒ auto-clear so a stale disk record never lingers.
      snoozedUntil = null
      return false
    },
    reset: (): void => {
      lastActive = now()
      snoozedUntil = null
    },
  }
}

/** Parse a `/snooze` duration token like `5m`, `10m`, `1h`, `30s`, `1500`
 *  (milliseconds when bare numeric). Returns ms or `null` on a bad token.
 *  Exported so the slash-command and the REPL test harness use a single
 *  parser (the spec lists `5m|10m|1h` verbatim; we accept any positive
 *  integer with an s/m/h suffix and bare-ms for power users). */
export const parseSnoozeDuration = (token: string): number | null => {
  const t = token.trim().toLowerCase()
  if (t === "") return null
  const match = /^(\d+)(ms|s|m|h)?$/.exec(t)
  if (match === null) return null
  const n = Number(match[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = match[2] ?? "ms"
  switch (unit) {
    case "ms":
      return n
    case "s":
      return n * 1_000
    case "m":
      return n * 60_000
    case "h":
      return n * 3_600_000
    default:
      return null
  }
}
