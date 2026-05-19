/**
 * Probe — load + validate trajectory / run-dir (RFC-0002 §7, Wave E).
 *
 * The trajectory JSONL is the single source of truth (RFC §3 원칙1); probe is
 * a READ-ONLY, NON-authoritative inspector (RFC §1.2 / §3 원칙8). This module
 * is pure and deterministic: it never mutates inputs, never writes, and never
 * throws on a malformed file — unparseable lines are *counted and surfaced*
 * (forward-compat: an unknown future schema must degrade, not crash, RFC §3.7).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import type { TrajectoryEvent } from "@/shared"
import { isTrajectoryEvent } from "@/shared"

/** Result of parsing one trajectory file. `skipped` = garbage/foreign lines. */
export interface ParsedTrajectory {
  events: TrajectoryEvent[]
  /** Lines that were non-JSON or not a `quanta.trajectory.v1` event. */
  skipped: number
  /** Human-readable, non-fatal notes (missing file, malformed file, …). */
  warnings: string[]
}

/** One attempt's parsed trajectory plus its identity. */
export interface AttemptTraj {
  instanceId: string
  attempt: number
  file: string
  parsed: ParsedTrajectory
}

/** A discovered run directory (or a single trajectory file). */
export interface ParsedRun {
  runId?: string
  /** instanceId → attempts (sorted by attempt). */
  instances: Map<string, AttemptTraj[]>
  /** `summary.json` (W-D shape), if present and parseable. */
  summary?: RunSummaryLike
  /** `metrics.json` (W-D shape), if present and parseable. */
  metrics?: RunMetricsLike
  warnings: string[]
}

/** Minimal structural view of W-D `summary.json` (see apps/bench/observe.ts). */
export interface RunSummaryLike {
  runId?: string
  resolved?: number
  total?: number
  degraded?: number
  instances?: Array<{
    id: string
    passed?: boolean
    verdict?: string
    turns?: number
    patchPath?: string
  }>
}

/** Minimal structural view of W-D `metrics.json`. */
export interface RunMetricsLike {
  runId?: string
  pricingVersion?: string
  snapshot?: unknown
}

/** Stable, deterministic sort by `seq` (preserves input order on ties). */
const bySeqStable = (events: TrajectoryEvent[]): TrajectoryEvent[] =>
  events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.seq - b.e.seq || a.i - b.i)
    .map(({ e }) => e)

/** Parse one line; returns the event or null (caller counts nulls as skipped). */
const parseLine = (raw: string): TrajectoryEvent | null => {
  const text = raw.trim()
  if (text === "") return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return isTrajectoryEvent(value) ? value : null
}

/**
 * Read one JSONL trajectory. Keeps only valid `quanta.trajectory.v1` events,
 * counts everything else (blank lines excluded), sorts by `seq` (stable), and
 * never throws — a missing/unreadable file yields empty events + a warning.
 */
export const loadTrajectory = (file: string): ParsedTrajectory => {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (e) {
    return { events: [], skipped: 0, warnings: [`unreadable: ${file} (${(e as Error).message})`] }
  }
  const events: TrajectoryEvent[] = []
  let skipped = 0
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue
    const ev = parseLine(raw)
    if (ev === null) skipped += 1
    else events.push(ev)
  }
  const warnings = skipped > 0 ? [`${file}: skipped ${skipped} unparseable/foreign line(s)`] : []
  return { events: bySeqStable(events), skipped, warnings }
}

/** `<instanceId>.<attempt>.jsonl` → identity, or null for `session.jsonl` etc. */
const parseAttemptName = (name: string): { instanceId: string; attempt: number } | null => {
  const m = /^(.+)\.(\d+)\.jsonl$/.exec(name)
  if (m?.[1] !== undefined && m[2] !== undefined) {
    return { instanceId: m[1], attempt: Number(m[2]) }
  }
  return null
}

/** Identity for any discovered `*.jsonl` (falls back to the base name). */
const identityOf = (name: string): { instanceId: string; attempt: number } => {
  const parsed = parseAttemptName(name)
  if (parsed !== null) return parsed
  return { instanceId: name.replace(/\.jsonl$/, ""), attempt: 0 }
}

/** Read + JSON-parse an optional sidecar; never throws (warns on bad JSON). */
const readJsonSidecar = <T>(dir: string, name: string, warnings: string[]): T | undefined => {
  const path = join(dir, name)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch (e) {
    warnings.push(`${name}: malformed JSON (${(e as Error).message})`)
    return undefined
  }
}

const addAttempt = (instances: Map<string, AttemptTraj[]>, dir: string, name: string): string[] => {
  const file = join(dir, name)
  const { instanceId, attempt } = identityOf(name)
  const parsed = loadTrajectory(file)
  const list = instances.get(instanceId) ?? []
  list.push({ instanceId, attempt, file, parsed })
  instances.set(instanceId, list)
  return parsed.warnings
}

/** Build a single-file run (the `<path>/trajectory.jsonl` invocation form). */
const loadSingleFile = (file: string): ParsedRun => {
  const instances = new Map<string, AttemptTraj[]>()
  const { instanceId, attempt } = identityOf(basename(file))
  const parsed = loadTrajectory(file)
  instances.set(instanceId, [{ instanceId, attempt, file, parsed }])
  return { instances, warnings: [...parsed.warnings] }
}

/**
 * Discover every `*.jsonl` in a run dir (named `<id>.<attempt>.jsonl` or
 * `session.jsonl`), parse each, and optionally read `summary.json` /
 * `metrics.json` (W-D shapes, tolerated when absent). Never throws.
 *
 * Accepts a single trajectory file path too (probe CLI contract, RFC §7).
 */
export const loadRun = (path: string): ParsedRun => {
  if (existsSync(path) && statSync(path).isFile()) return loadSingleFile(path)
  if (!existsSync(path)) {
    return { instances: new Map(), warnings: [`no such run dir or file: ${path}`] }
  }
  const warnings: string[] = []
  const instances = new Map<string, AttemptTraj[]>()
  for (const name of readdirSync(path).sort()) {
    if (!name.endsWith(".jsonl")) continue
    warnings.push(...addAttempt(instances, path, name))
  }
  for (const list of instances.values()) list.sort((a, b) => a.attempt - b.attempt)

  const summary = readJsonSidecar<RunSummaryLike>(path, "summary.json", warnings)
  const metrics = readJsonSidecar<RunMetricsLike>(path, "metrics.json", warnings)
  const runId = summary?.runId ?? metrics?.runId
  return {
    ...(runId !== undefined ? { runId } : {}),
    instances,
    ...(summary !== undefined ? { summary } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    warnings,
  }
}
