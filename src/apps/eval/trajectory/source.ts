/**
 * Read-only JSONL trajectory loader. Symmetric reader for the format
 * `src/stream/adapters/jsonl-recorder.ts` produces — but does NOT import the
 * producer (refactor-symmetry).
 *
 * Authoritative metadata (the seed user prompt, cwd, scenario/usecase tags) is
 * read from the `<jsonl>.meta.json` sidecar (`./meta.ts`). The reader REFUSES
 * to invent a prompt from the trajectory body — a session without a meta
 * sidecar has `meta: null` and downstream tiers treat it as unclassifiable
 * (no heuristic fallback).
 *
 * Robustness:
 *   - Malformed JSONL lines are LOGGED (file + line preview) AND counted —
 *     a corrupt fixture has both observability AND a numeric signal.
 *   - File system races (`stat` on a file that vanishes between `readdir` and
 *     `stat`) are handled per-file; one missing file does NOT abort the scan.
 *   - Path manipulation uses `node:path` (not raw `/` splits) — Windows-safe.
 *   - The sidecar reader distinguishes "missing" (`{kind:"missing"}`) from
 *     "malformed" (`{kind:"malformed", error}`) so callers can tell apart
 *     "operator hasn't recorded meta yet" from "operator wrote broken meta".
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { errMessage, isTrajectoryEvent, logger, type TrajectoryEvent } from "@/shared"
import { type EvalMeta, type MetaReadResult, readMetaResult } from "./meta"

/** A loaded session view, built from a single JSONL file + its sibling meta. */
export interface SessionView {
  /** Source file path. */
  source: string
  /** Session id — `ctx.runId` of the first event, falling back to the
   *  filename's basename (without the `.jsonl` extension). Uses
   *  `node:path.basename` so Windows paths work. */
  sessionId: string
  /** All events in seq order. */
  events: readonly TrajectoryEvent[]
  /** Number of `turn_start` events observed. */
  turns: number
  /** Authoritative metadata when the sidecar is present AND valid.
   *  Discriminated union surfaces malformed-vs-missing so callers can choose
   *  to log/refuse instead of silently treating both as "no meta". */
  metaResult: MetaReadResult
  /** Convenience: `metaResult.kind === "ok" ? metaResult.meta : null`. */
  meta: EvalMeta | null
  /** Number of malformed JSONL lines skipped (operational signal). */
  skippedLines: number
}

/** Read one JSONL file + its meta sidecar into a SessionView. */
export const loadSession = (path: string): SessionView => {
  const text = readFileSync(path, "utf8")
  const events: TrajectoryEvent[] = []
  let skipped = 0
  for (const line of text.split("\n")) {
    if (line === "") continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch (e) {
      skipped += 1
      logger.warn("eval.trajectory: skip malformed JSONL line", {
        file: path,
        linePreview: line.slice(0, 120),
        error: errMessage(e),
      })
      continue
    }
    if (!isTrajectoryEvent(obj)) {
      skipped += 1
      logger.warn("eval.trajectory: skip non-trajectory line", {
        file: path,
        // `data` exists on TrajectoryEvent; preview the kind for triage.
        kindGuess: (obj as { kind?: unknown })?.kind,
      })
      continue
    }
    events.push(obj)
  }
  events.sort((a, b) => a.seq - b.seq)
  const sessionId = events[0]?.ctx.runId ?? basename(path, ".jsonl")
  const turns = events.filter((e) => e.kind === "turn_start").length
  const metaResult = readMetaResult(path)
  return {
    source: path,
    sessionId,
    events,
    turns,
    metaResult,
    meta: metaResult.kind === "ok" ? metaResult.meta : null,
    skippedLines: skipped,
  }
}

/** Scan a directory for `*.jsonl` files, oldest-first by mtime. Files that
 *  disappear between `readdir` and `stat` are skipped silently — the scan is
 *  best-effort over a directory that can churn between iterations (e.g. CI
 *  pruning old runs). */
export const listSessions = (dir: string): readonly string[] => {
  const entries: { f: string; mtime: number }[] = []
  for (const name of readdirSync(dir)) {
    if (extname(name) !== ".jsonl") continue
    const full = join(dir, name)
    try {
      entries.push({ f: full, mtime: statSync(full).mtimeMs })
    } catch (e) {
      // ENOENT race ⇒ file deleted between readdir and stat. Log + skip so
      // the rest of the listing still proceeds.
      logger.warn("eval.trajectory: stat failed during listing", {
        file: full,
        error: errMessage(e),
      })
    }
  }
  return entries.sort((a, b) => a.mtime - b.mtime).map(({ f }) => f)
}

/** Pull the producer name(s) seen in this session — useful for filtering. */
export const producersOf = (s: SessionView): readonly string[] => {
  const set = new Set<string>()
  for (const e of s.events) set.add(e.producer.name)
  return [...set].sort()
}
