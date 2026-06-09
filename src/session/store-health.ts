/**
 * §13.1 (jun-08 long-tail) — store-level AGGREGATE corruption detection +
 * operator recovery guidance.
 *
 * The per-file read path (`readSavedSession` in `store.ts`) already degrades
 * gracefully: a single corrupt / malformed / wrong-shape session file collapses
 * to `undefined` + a `logger.warn`, so one bad file never sinks the others. What
 * was MISSING is the AGGREGATE signal: when the WHOLE store is unreadable (disk
 * fault, a botched migration, an encryption-key loss, a sync conflict that
 * rewrote every file), the user just sees an empty session list with no
 * explanation — indistinguishable from "no sessions yet".
 *
 * This module adds the missing store-level health check. It scans every
 * `<root>/*.json` (active) + `<root>/archived/*.json`, classifies each as
 * `ok | corrupt | unreadable`, and — when corruption crosses a meaningful
 * threshold — emits an explicit, operator-facing recovery diagnostic
 * (`StoreHealthReport.guidance`) instead of silently swallowing it.
 *
 * Codex parity: Codex's `state db` layer surfaces aggregate persistence
 * failures with explicit recovery messaging (`state db ... failed`,
 * compaction/repair hints) rather than degrading to an empty result. quanta is
 * file-per-session (no sqlite), so the aggregate signal is "what fraction of
 * the files refused to load".
 *
 * GATE: this is a DIAGNOSTIC, not a behavior change — it does not run on the
 * hot path. The CLI invokes {@link checkSessionStoreHealth} from a `/doctor`-
 * style command (or on a "session list came back empty AND the dir is
 * non-empty" trigger). Because it never runs automatically, there is no
 * default-OFF byte-identity concern for the live loop: nothing calls it unless
 * an operator asks. NEVER throws — every fs error is captured into the report.
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { errMessage, logger } from "@/shared"
import { readFile } from "@/storage"
import { archivedFilePath, sessionFilePath, sessionsRoot } from "./paths"

/** Per-file classification of a scanned session file. */
export type SessionFileStatus = "ok" | "corrupt" | "unreadable"

export interface SessionFileHealth {
  readonly id: string
  readonly path: string
  readonly archived: boolean
  readonly status: SessionFileStatus
  /** Short reason when NOT ok (parse error / shape mismatch / fs error). */
  readonly detail?: string
}

/** Overall store verdict. `healthy` = nothing corrupt. `degraded` = SOME files
 *  corrupt but readable ones remain. `corrupt` = the store is AGGREGATELY
 *  unreadable (every / nearly-every file failed) — the operator-action case. */
export type StoreHealthVerdict = "empty" | "healthy" | "degraded" | "corrupt"

export interface StoreHealthReport {
  readonly root: string
  readonly verdict: StoreHealthVerdict
  readonly total: number
  readonly ok: number
  readonly corrupt: number
  readonly unreadable: number
  readonly files: readonly SessionFileHealth[]
  /** Operator-facing recovery guidance — present ONLY when `verdict` is
   *  `degraded` or `corrupt`. Absent on `empty` / `healthy`. */
  readonly guidance?: string
}

/** A minimal, dependency-free shape check: a loadable session file MUST parse
 *  as JSON and carry a `meta.id` string + a `messages` array. This deliberately
 *  does NOT re-run the full `savedSessionSchema` (that lives in store.ts and is
 *  intentionally strict) — for an aggregate HEALTH signal we only need to know
 *  "is this plausibly a session file or is it garbage". A file that parses but
 *  fails the strict schema is still classified `corrupt` here (it won't load via
 *  the real path either). */
const classifyOne = async (
  id: string,
  path: string,
  archived: boolean,
): Promise<SessionFileHealth> => {
  let raw: string
  try {
    raw = await readFile(path)
  } catch (e) {
    return {
      id,
      path,
      archived,
      status: "unreadable",
      detail: errMessage(e),
    }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    return {
      id,
      path,
      archived,
      status: "corrupt",
      detail: `malformed JSON: ${errMessage(e)}`,
    }
  }
  const ok =
    typeof json === "object" &&
    json !== null &&
    typeof (json as { meta?: { id?: unknown } }).meta?.id === "string" &&
    Array.isArray((json as { messages?: unknown }).messages)
  if (!ok) return { id, path, archived, status: "corrupt", detail: "missing meta.id/messages" }
  return { id, path, archived, status: "ok" }
}

/** Strip a `.json` suffix to recover the session id (best-effort; ids are
 *  already sanitized at write time). */
const idFromFile = (file: string): string =>
  file.endsWith(".json") ? file.slice(0, -".json".length) : file

/** List `*.json` files in `dir`, or `[]` when the dir is missing/unreadable.
 *  We `readdir` directly (NOT gated on `fileExists`, which is file-oriented —
 *  `Bun.file(dir).exists()` is unreliable for directories) and treat any fs
 *  error (ENOENT for a never-created root, EACCES, ENOTDIR) as "no files". */
const listJson = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir)
    return entries.filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
}

/** Build the operator recovery guidance for a non-healthy store. PURE. The
 *  message names the root, the corruption ratio, and concrete next steps (the
 *  store is file-per-session, so recovery is per-file, not all-or-nothing). */
export const buildRecoveryGuidance = (report: {
  root: string
  verdict: StoreHealthVerdict
  total: number
  ok: number
  corrupt: number
  unreadable: number
}): string => {
  const bad = report.corrupt + report.unreadable
  const lines: string[] = []
  if (report.verdict === "corrupt") {
    lines.push(
      `Session store appears AGGREGATELY corrupt: ${bad}/${report.total} files failed to load in ${report.root}.`,
    )
    lines.push("This usually means a disk fault, a failed sync/merge, or a botched migration.")
  } else {
    lines.push(
      `Session store is DEGRADED: ${bad}/${report.total} files failed to load in ${report.root} (${report.ok} still load).`,
    )
  }
  lines.push("Recovery (file-per-session — safe to act per file):")
  lines.push(
    `  1. Inspect: each corrupt file is at ${report.root}/<id>.json (or archived/<id>.json).`,
  )
  lines.push("  2. Back up the whole directory before any deletion.")
  lines.push("  3. Move the unreadable files aside; the readable sessions keep working.")
  lines.push(
    `  4. The index (${report.root}/index.jsonl) is a derived cache — delete it to force a rebuild on next load.`,
  )
  return lines.join("\n")
}

/**
 * Scan the whole session store and return an aggregate health report.
 *
 * Verdict policy (no magic thresholds — explicit ratios):
 *   - `empty`    : zero session files.
 *   - `healthy`  : zero corrupt/unreadable.
 *   - `corrupt`  : EVERY file failed (ok === 0 with total > 0) — the aggregate-
 *                  unreadable case the operator must act on.
 *   - `degraded` : some failed but some still load.
 *
 * NEVER throws: directory + per-file errors are captured into the report.
 * Read-only. When the verdict is non-healthy a `logger.warn` is also emitted so
 * the failure is visible in logs (not just in a returned struct a caller might
 * ignore).
 */
export const checkSessionStoreHealth = async (): Promise<StoreHealthReport> => {
  const root = sessionsRoot()
  const archivedDir = join(root, "archived")
  const activeFiles = await listJson(root)
  const archivedFiles = await listJson(archivedDir)

  // Build the path + classify under a guard: an on-disk filename whose derived
  // id fails session-id validation (leading "-", control byte, …) makes
  // `sessionFilePath`/`archivedFilePath` THROW SessionIdError. This function's
  // contract is NEVER throws — so surface such a file as `corrupt` (an entry the
  // operator must act on) instead of letting the path-builder crash the scan.
  const classifyFile = async (
    id: string,
    buildPath: (id: string) => string,
    archived: boolean,
  ): Promise<SessionFileHealth> => {
    let path: string
    try {
      path = buildPath(id)
    } catch (e) {
      return { id, path: id, archived, status: "corrupt", detail: `invalid session id: ${errMessage(e)}` }
    }
    return classifyOne(id, path, archived)
  }

  const files: SessionFileHealth[] = []
  for (const f of activeFiles) {
    files.push(await classifyFile(idFromFile(f), sessionFilePath, false))
  }
  for (const f of archivedFiles) {
    files.push(await classifyFile(idFromFile(f), archivedFilePath, true))
  }

  const ok = files.filter((f) => f.status === "ok").length
  const corrupt = files.filter((f) => f.status === "corrupt").length
  const unreadable = files.filter((f) => f.status === "unreadable").length
  const total = files.length

  let verdict: StoreHealthVerdict
  if (total === 0) verdict = "empty"
  else if (corrupt + unreadable === 0) verdict = "healthy"
  else if (ok === 0) verdict = "corrupt"
  else verdict = "degraded"

  const base = { root, verdict, total, ok, corrupt, unreadable }
  const guidance =
    verdict === "corrupt" || verdict === "degraded" ? buildRecoveryGuidance(base) : undefined

  if (guidance !== undefined) {
    logger.warn("session store health: non-healthy", { root, verdict, total, ok, corrupt, unreadable })
  }

  return { ...base, files, ...(guidance !== undefined ? { guidance } : {}) }
}
