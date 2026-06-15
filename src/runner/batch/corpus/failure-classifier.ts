/**
 * Decisive failure classification for `InstanceResult` — surfaced both in
 * `bench-report.json` and in the operator console next to each `[FAIL]` line.
 *
 * Two-axis schema (covering + non-exclusive):
 *   - `termination`: exactly one — HOW the run ended.
 *   - `signals[]`:    zero-or-more — WHAT went wrong along the way.
 *
 * Sources of truth:
 *   - `InstanceResult` (turns, patch, passed, error, patchPath)
 *   - The per-attempt trajectory JSONL at `<patchPath>.replace(.patch,.jsonl)`,
 *     when observe was on. Trajectory is opportunistic — absence ⇒ termination
 *     degrades to `"unknown"` and only patch-based signals fire.
 *
 * Pure-by-signature: no argv reads, no logger calls, no env. The contract is
 * exercised by `tests/unit/bench-failure-classifier.test.ts` against synthetic
 * fixtures so a future detector cannot silently drift.
 */
import { existsSync, readFileSync } from "node:fs"
import type { InstanceResult } from "../types"
import { getCachePathRe } from "./cache-pathspecs"

/** How the run terminated. Covering partition — every failed result lands in
 *  exactly one bucket. */
export type TerminationType =
  | "passed"
  | "generation_error"
  | "grader_invalid"
  | "harness_error"
  | "hung_stream"
  | "max_turns_exhausted"
  | "completed_unresolved"
  | "unknown"

/** Non-exclusive failure signals. Multiple may co-occur on one result. */
export type FailureSignal =
  | "empty_patch"
  | "dirty_cache_leak"
  | "verify_loop_stuck"
  | "search_thrashing"
  | "multi_file_drift"

export interface FailureClassification {
  termination: TerminationType
  signals: FailureSignal[]
}

const VERIFY_LOOP_THRESHOLD = 5
const SEARCH_THRASH_THRESHOLD = 5
const DRIFT_THRESHOLD = 3

/** Loose shape for a trajectory event. The recorder envelope guarantees
 *  `kind` + `data`; everything else is opportunistic. */
interface TrajectoryEvent {
  kind?: string
  data?: Record<string, unknown>
}

/** Derive trajectory file path from `r.patchPath`. Returns null when patchPath
 *  is absent (observe was off), or the .jsonl sibling is missing. */
const trajectoryPathFor = (patchPath: string | undefined): string | null => {
  if (!patchPath?.endsWith(".patch")) return null
  return `${patchPath.slice(0, -".patch".length)}.jsonl`
}

/** Best-effort trajectory loader. A malformed line is skipped (not throw) so a
 *  single bad event can never derail the whole classification. */
const readTrajectory = (patchPath: string | undefined): TrajectoryEvent[] | null => {
  const path = trajectoryPathFor(patchPath)
  if (path === null || !existsSync(path)) return null
  const out: TrajectoryEvent[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue
    try {
      out.push(JSON.parse(line) as TrajectoryEvent)
    } catch {
      // Skip malformed lines.
    }
  }
  return out
}

const lastSessionEnd = (events: TrajectoryEvent[]): TrajectoryEvent | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.kind === "session_end") return e
  }
  return undefined
}

const computeTermination = (
  r: InstanceResult,
  events: TrajectoryEvent[] | null,
): TerminationType => {
  if (r.passed) return "passed"
  if (r.verdict === "grader_invalid") return "grader_invalid"
  if (isGenerationError(r.error)) return "generation_error"
  if (r.error !== undefined) return "harness_error"
  if (events === null) return "unknown"
  const end = lastSessionEnd(events)
  if (!end?.data) return "unknown"
  const reason = (end.data as { reason?: string }).reason
  const turns = ((end.data as { turns?: number }).turns ?? r.turns) | 0
  if (reason === "aborted" && turns === 0) return "hung_stream"
  if (reason === "max_turns") return "max_turns_exhausted"
  return "completed_unresolved"
}

const isGenerationError = (error: string | undefined): boolean =>
  error !== undefined &&
  /agent stopped with (?:error|refusal)|LLM stream failed|usage_limit_reached|usage limit|rate[_ -]?limit|429 Too Many Requests/i.test(
    error,
  )

/** Collect `b/<path>` from every `diff --git` header in a unified diff. */
const diffHeaderPaths = (patch: string): string[] => {
  const out: string[] = []
  for (const line of patch.split("\n")) {
    const m = line.match(/^diff --git a\/\S+ b\/(\S+)/)
    if (m?.[1]) out.push(m[1])
  }
  return out
}

/**
 * Dirty-cache leak: the patch ONLY modifies build/cache-shaped paths. A
 * single source-shaped path disqualifies the signal.
 *
 * INVARIANT ALARM (post-T2): the bench runner now prunes cache paths at the
 * git layer via `CACHE_PATHSPECS` (see `cache-pathspecs.ts`), so under
 * normal operation this detector should fire 0 times. A positive match
 * means the prune-at-source contract was violated upstream — either a new
 * cache-shaped path entered the worktree and is missing from the SSOT, or
 * the pathspec exclude was bypassed. Treat any new occurrence as a bug
 * report on the runner, not as a normal classification.
 */
const isDirtyCacheLeak = (patch: string): boolean => {
  if (patch.trim() === "") return false
  const paths = diffHeaderPaths(patch)
  if (paths.length === 0) return false
  const re = getCachePathRe()
  return paths.every((p) => re.test(p))
}

const distinctEditedFiles = (patch: string): number => new Set(diffHeaderPaths(patch)).size

/** Verify-loop signal: trailing run of ≥N consecutive `bash`/`test_runner`
 *  calls with no edit/write/scripted_replace in between. Captures the
 *  "agent burned remaining turns trying to install env" pattern. */
const hasVerifyLoopStuck = (events: TrajectoryEvent[]): boolean => {
  const calls: string[] = []
  for (const e of events) {
    if (e.kind !== "tool_call") continue
    const name = (e.data?.name as string) ?? ""
    calls.push(name)
  }
  let trailing = 0
  for (let i = calls.length - 1; i >= 0; i--) {
    const name = calls[i]
    if (name === "bash" || name === "test_runner") trailing++
    else break
  }
  return trailing >= VERIFY_LOOP_THRESHOLD
}

const SEARCH_TOOLS = new Set(["search_codebase", "glob", "grep", "localize"])
const FOUND_NAV_TOOLS = new Set(["read", "edit", "write", "scripted_replace"])

/** Find the tool_result immediately following a tool_call at index `i`. The
 *  recorder writes one result per call back-to-back; another tool_call before
 *  any result means the result is missing for this call. */
const resultAfter = (events: TrajectoryEvent[], i: number): TrajectoryEvent | undefined => {
  for (let j = i + 1; j < events.length; j++) {
    const e = events[j]
    if (e?.kind === "tool_result") return e
    if (e?.kind === "tool_call") return undefined
  }
  return undefined
}

const isEmptyResult = (result: TrajectoryEvent): boolean => {
  const r = String(result.data?.result ?? "").trim()
  return r === "" || r === "[]" || r === "{}"
}

/** Search-thrash: ≥N consecutive empty-result search calls
 *  (`search_codebase`/`glob`/`grep`/`localize`) BEFORE the first
 *  read/edit/write breaks the streak. Tracks max consecutive run, not just
 *  the trailing one — so a thrash that ended with a successful `localize`
 *  still surfaces. */
const hasSearchThrashing = (events: TrajectoryEvent[]): boolean => {
  let consec = 0
  let max = 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e?.kind !== "tool_call") continue
    const name = (e.data?.name as string) ?? ""
    if (FOUND_NAV_TOOLS.has(name)) break
    if (!SEARCH_TOOLS.has(name)) continue
    const result = resultAfter(events, i)
    if (!result) continue
    if (isEmptyResult(result)) consec++
    else consec = 0
    if (consec > max) max = consec
  }
  return max >= SEARCH_THRASH_THRESHOLD
}

export const classify = (r: InstanceResult): FailureClassification => {
  if (r.passed) return { termination: "passed", signals: [] }
  const events = readTrajectory(r.patchPath)
  const termination = computeTermination(r, events)
  const signals: FailureSignal[] = []
  if (r.patch.trim() === "" && termination !== "generation_error") signals.push("empty_patch")
  else if (isDirtyCacheLeak(r.patch)) signals.push("dirty_cache_leak")
  if (distinctEditedFiles(r.patch) >= DRIFT_THRESHOLD) signals.push("multi_file_drift")
  if (events !== null) {
    if (hasVerifyLoopStuck(events)) signals.push("verify_loop_stuck")
    if (hasSearchThrashing(events)) signals.push("search_thrashing")
  }
  return { termination, signals }
}

/** Aggregate counts across all results — emitted in `bench-report.json`
 *  under `failureBreakdown`. SPARSE: a key is present only when its count is
 *  ≥1, so an empty input yields `{ byTermination:{}, bySignal:{} }` (no
 *  zero-init noise). `Partial<...>` reflects that — `byTermination.unknown`
 *  may legitimately be `undefined`. */
export interface FailureBreakdown {
  byTermination: Partial<Record<TerminationType, number>>
  bySignal: Partial<Record<FailureSignal, number>>
}

export const aggregate = (classifications: FailureClassification[]): FailureBreakdown => {
  const byTermination: Partial<Record<TerminationType, number>> = {}
  const bySignal: Partial<Record<FailureSignal, number>> = {}
  for (const c of classifications) {
    byTermination[c.termination] = (byTermination[c.termination] ?? 0) + 1
    for (const s of c.signals) bySignal[s] = (bySignal[s] ?? 0) + 1
  }
  return { byTermination, bySignal }
}
