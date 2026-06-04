/**
 * Session transcript retention sweep — host/CLI-layer wiring.
 *
 * The mechanism (`applyRetention`, a cumulative-bytes sliding window) already
 * lives in `@/stream` (`src/stream/adapters/jsonl-retention.ts`). The per-session
 * `.jsonl` event envelopes already grow under `sessionsRoot()` (written by
 * `@/session` `store.ts` `appendEnvelope`). This module is the SEAM that connects
 * the two — it lists the `<id>.jsonl` envelopes and applies the window to each.
 *
 * # Why the host/CLI layer (fence handling)
 *
 * `@/session` may import `@/llm`, `@/storage`, `@/shared` — NOT `@/stream`
 * (biome `noRestrictedImports`, RFC §3.1). And `@/stream` may import `@/shared`
 * only — NOT `@/session`. So neither slice can call the other's primitive.
 * The CLI/app layer (`src/apps/cli/**`) is the composition root that may reach
 * BOTH slices, so the sweep lives here. `@/session` is imported ONLY for
 * `sessionsRoot()` (a path string); `@/stream` ONLY for `applyRetention`.
 *
 * # Policy is knob-driven (no magic constant)
 *
 * The byte cap comes from `QUANTA_SESSION_TRANSCRIPT_MAX_BYTES`
 * (`runtimeConfig().sessionTranscriptMaxBytes`). Absent ⇒ OFF: the sweep is a
 * `{ skipped: "no-policy" }` no-op (today's unbounded behavior). Even when ON,
 * `applyRetention` NEVER deletes a whole session — it keeps the NEWEST rows of
 * each transcript and trims only the OLDEST once a single transcript alone
 * crosses the cap. Recent/active sessions are inherently preserved.
 *
 * # NO-THROW
 *
 * Per-envelope: a malformed file, a busy sibling `.tmp`
 * (`JsonlRecorderRetentionBusyError`), or any fs error is captured into
 * `errors[]` and the sweep CONTINUES over the remaining envelopes. A missing
 * root directory ⇒ an empty result (not an error — the dir may not exist yet).
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { sessionsRoot } from "@/session"
import { errMessage, runtimeConfig } from "@/shared"
import { applyRetention } from "@/stream"

export interface TranscriptSweepError {
  /** Absolute path of the envelope that failed. */
  readonly path: string
  /** Human-readable failure reason (never throws — captured here instead). */
  readonly error: string
}

export interface TranscriptSweepResult {
  /** Number of `<id>.jsonl` transcript envelopes considered. */
  readonly filesScanned: number
  /** Number of envelopes whose oldest rows were trimmed (or WOULD be, dry-run). */
  readonly filesRewritten: number
  /** Total rows dropped across all envelopes. */
  readonly droppedRows: number
  /** Total utf-8 bytes freed across all envelopes (excludes framing newlines —
   *  the same "bytes you lost" metric `applyRetention` reports). */
  readonly bytesFreed: number
  /** Per-envelope failures (NO-THROW). Empty on a fully clean sweep. */
  readonly errors: readonly TranscriptSweepError[]
}

/** Returned when retention is OFF (knob unset) — nothing was touched. */
export interface TranscriptSweepSkipped {
  readonly skipped: "no-policy"
}

export interface SweepSessionTranscriptsOpts {
  /** Override the root dir to sweep. Default `sessionsRoot()`. (Test seam +
   *  multi-tenant surfaces that resolve their own root.) */
  readonly root?: string
  /** Override the cumulative-bytes cap. Default
   *  `runtimeConfig().sessionTranscriptMaxBytes`. When neither is set the sweep
   *  is a no-policy skip. */
  readonly maxCumulativeBytes?: number
  /** Compute the drop counts WITHOUT mutating any file on disk. */
  readonly dryRun?: boolean
}

/**
 * Sweep every `<id>.jsonl` transcript envelope under `root` (default
 * `sessionsRoot()`) with the cumulative-bytes retention window.
 *
 * Returns `{ skipped: "no-policy" }` when no cap is configured (OFF default) —
 * deletes nothing. Otherwise returns a {@link TranscriptSweepResult} with an
 * exact count + bytes-freed report. NEVER throws: per-file failures are
 * captured in `errors[]`; a missing root is an empty result.
 */
export async function sweepSessionTranscripts(
  opts: SweepSessionTranscriptsOpts = {},
): Promise<TranscriptSweepResult | TranscriptSweepSkipped> {
  const cap = opts.maxCumulativeBytes ?? runtimeConfig().sessionTranscriptMaxBytes
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) {
    return { skipped: "no-policy" }
  }

  const root = opts.root ?? sessionsRoot()
  const envelopes = await listTranscriptEnvelopes(root)

  let filesScanned = 0
  let filesRewritten = 0
  let droppedRows = 0
  let bytesFreed = 0
  const errors: TranscriptSweepError[] = []

  for (const path of envelopes) {
    filesScanned += 1
    try {
      const res = await applyRetention(path, {
        maxCumulativeBytes: cap,
        dryRun: opts.dryRun === true,
      })
      if (res.droppedRows > 0) {
        filesRewritten += 1
        droppedRows += res.droppedRows
        bytesFreed += res.droppedBytes
      }
    } catch (e) {
      // NO-THROW: a busy `.tmp`, a malformed file, or any fs error on ONE
      // envelope must not abort the sweep over its siblings.
      errors.push({ path, error: errMessage(e) })
    }
  }

  return { filesScanned, filesRewritten, droppedRows, bytesFreed, errors }
}

/**
 * List absolute paths of the per-session transcript envelopes under `root`.
 *
 * ONLY top-level `<id>.jsonl` files are returned. Deliberately EXCLUDED:
 *   - `index.jsonl` — the derived session directory (NOT a transcript; trimming
 *     it would corrupt the listing index, a different rail entirely).
 *   - `*.json` snapshot files — the source-of-truth session bodies.
 *   - `archived/` — a subdirectory; `readdir` (non-recursive) skips it.
 *
 * A missing root ⇒ empty list (NOT an error — the sessions dir may not exist
 * before the first session is written).
 */
async function listTranscriptEnvelopes(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
  const out: string[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (e.name === "index.jsonl") continue
    if (!e.name.endsWith(".jsonl")) continue
    out.push(join(root, e.name))
  }
  out.sort()
  return out
}
