import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Measured per-file wall-time store for the chunk planner's LPT placement.
 *
 * Source of truth is the runner's own green chunks: Bun's JUnit receipt gives
 * per-file suite time (test bodies only), and the chunk's wall clock minus the
 * suite sum is the load/import overhead, attributed evenly across the chunk's
 * files. That keeps the estimate an actual measurement of THIS host — never a
 * size heuristic — while a cold store simply degrades the planner to
 * file-count balancing.
 */

export const TEST_TIMING_SCHEMA = "quanta.test-timings.v1" as const
/** Entries older than this are dropped on write: dead files must not steer LPT. */
export const TEST_TIMING_MAX_AGE_MS = 14 * 24 * 60 * 60_000

interface TimingEntry {
  readonly ms: number
  readonly sampledAtMs: number
}

interface TimingStoreFile {
  readonly schema: typeof TEST_TIMING_SCHEMA
  readonly entries: Record<string, TimingEntry>
}

const isTimingEntry = (value: unknown): value is TimingEntry => {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.ms === "number" &&
    Number.isFinite(row.ms) &&
    row.ms > 0 &&
    Number.isSafeInteger(row.sampledAtMs)
  )
}

/** Corrupt or foreign content is an empty store, never a crash. */
export const loadTestTimings = (path: string, nowMs = Date.now()): ReadonlyMap<string, number> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return new Map()
  }
  if (typeof parsed !== "object" || parsed === null) return new Map()
  const store = parsed as Partial<TimingStoreFile>
  if (store.schema !== TEST_TIMING_SCHEMA || typeof store.entries !== "object") return new Map()
  const timings = new Map<string, number>()
  for (const [file, entry] of Object.entries(store.entries ?? {})) {
    if (isTimingEntry(entry) && nowMs - entry.sampledAtMs <= TEST_TIMING_MAX_AGE_MS) {
      timings.set(file, entry.ms)
    }
  }
  return timings
}

export const mergeTestTimings = (
  path: string,
  updates: ReadonlyMap<string, number>,
  nowMs = Date.now(),
): void => {
  const merged = new Map<string, TimingEntry>()
  let existing: unknown
  try {
    existing = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    existing = undefined
  }
  const store = existing as Partial<TimingStoreFile> | undefined
  if (store?.schema === TEST_TIMING_SCHEMA && typeof store.entries === "object") {
    for (const [file, entry] of Object.entries(store.entries ?? {})) {
      if (isTimingEntry(entry) && nowMs - entry.sampledAtMs <= TEST_TIMING_MAX_AGE_MS) {
        merged.set(file, entry)
      }
    }
  }
  for (const [file, ms] of updates) {
    if (Number.isFinite(ms) && ms > 0) merged.set(file, { ms: Math.round(ms), sampledAtMs: nowMs })
  }
  const payload: TimingStoreFile = {
    schema: TEST_TIMING_SCHEMA,
    entries: Object.fromEntries(
      [...merged.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag)
  return match?.[1]
}

const decodeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

/** Exact test-file set independently emitted by Bun's JUnit reporter. */
export const junitExecutedFiles = (junitXml: string): readonly string[] => {
  const files = new Set<string>()
  for (const match of junitXml.matchAll(/<testsuite\b[^>]*>/g)) {
    const file = attribute(match[0] ?? "", "file")
    if (file !== undefined && file !== "") files.add(decodeXmlAttribute(file))
  }
  return [...files].sort((left, right) => left.localeCompare(right))
}

/**
 * Per-file wall estimate for one green chunk: the file's JUnit suite time plus
 * an even share of the chunk's unattributed wall (module load, setup, runner
 * overhead). `files` are the chunk's file names EXACTLY as they appear in the
 * JUnit `file` attribute (the runner passes absolute paths to `bun test`).
 */
export const harvestChunkTimings = (
  junitXml: string,
  files: readonly string[],
  chunkElapsedMs: number,
): ReadonlyMap<string, number> => {
  if (files.length === 0) return new Map()
  const suiteMs = new Map<string, number>()
  for (const match of junitXml.matchAll(/<testsuite\b[^>]*>/g)) {
    const tag = match[0] ?? ""
    const file = attribute(tag, "file")
    const seconds = Number.parseFloat(attribute(tag, "time") ?? "")
    if (file !== undefined && Number.isFinite(seconds) && seconds >= 0) {
      suiteMs.set(file, (suiteMs.get(file) ?? 0) + seconds * 1_000)
    }
  }
  const attributed = files.reduce((sum, file) => sum + (suiteMs.get(file) ?? 0), 0)
  const overheadShare = Math.max(0, chunkElapsedMs - attributed) / files.length
  const estimates = new Map<string, number>()
  for (const file of files) {
    estimates.set(file, Math.max(1, Math.round((suiteMs.get(file) ?? 0) + overheadShare)))
  }
  return estimates
}
