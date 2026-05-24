/**
 * Disk-backed snapshot helpers for {@link BackgroundSubagentScheduler}
 * (ADR-0153).
 *
 * Pure helpers — the scheduler's `serialize()` / `hydrate()` primitive does
 * the in-memory JSON conversion; these helpers are the caller-wired bridge
 * between that primitive and a flat file on disk. The caller decides when
 * to snapshot (periodic timer? on shutdown? at every turn boundary?) and
 * when to restore (at startup? on `/resume`? after a process restart?).
 *
 * Plane-clean: imports ONLY `./subagent-background` (the scheduler type)
 * and `node:fs/promises`. NO `@/storage`, `@/observability`, `@/permission`,
 * `@/tool` — this is a leaf adapter; the surface that wires it owns the
 * choice of path + cadence + write-vs-restore policy.
 *
 * Voice-match ADR-0124's persistence helpers: the caller controls when
 * snapshots happen so the scheduler stays decoupled from disk policy.
 *
 * Contract (3):
 *   1. NO-THROW on `restoreFromFile` — missing file ⇒ `null` return; the
 *      caller branches on `null` to decide whether to start from empty.
 *      (Other errors — permission denied, parse failure — surface as
 *      `restored: 0` via the scheduler's own NO-THROW hydrate contract.)
 *   2. snapshotToFile WRITES whatever `scheduler.serialize()` returns —
 *      empty scheduler still produces a valid JSON `{v:1, handles:[]}` so
 *      the file is always parseable on the next start.
 *   3. The function signatures use `string | null` for the in-memory JSON
 *      contract so callers can compose: read the file once (or get null),
 *      pass the result to `restoreFromFile` which threads through to
 *      `scheduler.hydrate`.
 */

import { readFile, writeFile } from "node:fs/promises"
import type { BackgroundSubagentScheduler } from "./subagent-background"

/** Snapshot the scheduler to a flat file. Caller invokes periodically OR on
 *  shutdown. Overwrites the file atomically via the host's fs semantics
 *  (Node's `writeFile` is atomic on POSIX for whole-file writes). The
 *  caller chooses `path`; typical conventions:
 *  `~/.quanta/subagents.json` or session-scoped `<sessionDir>/subagents.json`. */
export const snapshotToFile = async (
  scheduler: BackgroundSubagentScheduler,
  path: string,
): Promise<void> => {
  const json = scheduler.serialize()
  await writeFile(path, json, "utf8")
}

/** Restore from a snapshot file by reading it first into memory then handing
 *  to the scheduler. Returns count restored, OR `null` when the file is
 *  missing (so the caller can branch on "fresh start"). Parse-error /
 *  shape-mismatch paths surface as `0` because the scheduler's `hydrate`
 *  is NO-THROW by contract. */
export const restoreFromFile = async (
  json: string | null,
  scheduler: BackgroundSubagentScheduler,
): Promise<number | null> => {
  if (json === null) return null
  return scheduler.hydrate(json)
}

/** Read a snapshot file's contents, OR return `null` when missing. Pure
 *  filesystem read — the caller is expected to pass the result to
 *  `restoreFromFile`. Errors OTHER than ENOENT propagate so the surface
 *  can decide whether to log + continue or abort. */
export const readSnapshotFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8")
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code
    if (code === "ENOENT") return null
    throw e
  }
}
