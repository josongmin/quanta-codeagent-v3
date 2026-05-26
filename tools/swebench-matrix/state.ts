/**
 * Sweep-state checkpointing for `tools/swebench-matrix.ts`.
 *
 * Why: a long sweep (10 picks × 3 trials × 4 conditions ≈ 3h on a paid model)
 * can be aborted at any time (OAuth lapse, SIGINT, machine sleep, network).
 * Restarting from condition 1 wastes every minute already spent. The bench
 * already writes per-instance JSONL streams; what is MISSING is a compact
 * top-level "which conditions are DONE" pointer that survives a crash.
 *
 * Shape: a single JSON file at `<outDir>/.matrix-state.json`. The file is
 * written atomically (`tmp → rename`) — partial writes can never leave a
 * corrupt half-state on disk. A `version` field pins forward-compat: future
 * shape changes that drop fields MUST bump the version + reject loading an
 * older file (the runner then starts fresh, preserving the safety property
 * "never resume into an incompatible state").
 *
 * Granularity: condition-level (NOT instance-level). Reasons:
 *   1. The bench process already writes per-instance JSONL — instance-level
 *      replay can be reconstructed from disk. The state file just answers
 *      "which condition do I run NEXT", not "which instance".
 *   2. The bench is the unit of LLM cost: aborting mid-condition wastes the
 *      already-spent budget BUT does not corrupt anything, because the bench
 *      itself is restart-safe (writes happen at instance boundaries). The
 *      state file records condition completion AFTER the bench returns.
 *   3. Condition-level granularity keeps the state file tiny (≤ a few KB
 *      even with thousands of pick rows) and the read/write cost negligible.
 *
 * Slice / dependency posture: this file lives under `tools/` and imports
 * nothing from `src/` (no slice fence concerns). It re-uses `MatrixRow` from
 * the matrix tool, which is the only structural link.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Condition, MatrixRow } from "../swebench-matrix"

/** Path of the sweep state file relative to `outDir`. Hidden so it never
 *  appears in normal `ls`. The leading `.` keeps it out of grep/jq tooling
 *  pointed at the JSONL summaries. */
export const STATE_FILE = ".matrix-state.json"

/** Schema version. Bump on incompatible shape changes (drop / rename a
 *  field). The loader rejects files whose version does not match the
 *  current writer; tests pin this contract. */
export const STATE_VERSION = 1 as const

/**
 * On-disk sweep checkpoint.
 *
 *   - `completed`  — condition LABELS (legacy: `Condition`; axes mode: the
 *                    sanitised label like `"axes-lsp_subagent"`). The runner
 *                    skips any label that is already in this set.
 *   - `partialResults` — every row produced so far, keyed by the SAME label.
 *                    When resuming, the runner concatenates these rows into
 *                    its in-memory `allRows` before continuing.
 *   - `mode`       — distinguishes legacy `--conditions` from `--axes`. A
 *                    resume that crosses modes is rejected (a state file
 *                    written under `--conditions` cannot resume into
 *                    `--axes`, and vice versa).
 *   - `axes` / `conditions` — captured INPUT so resume can detect a
 *                    mismatch (operator changed --axes between runs).
 *   - `spentUsd`   — running cost total (sum of `costUsd` over completed
 *                    rows; preserved across resume).
 *   - `totalEstCostUsd` — sweep-level upper-bound estimate (optional;
 *                    written at startup if known, never recomputed mid-run).
 */
export interface SweepState {
  readonly version: typeof STATE_VERSION
  readonly startedAt: number
  readonly dataset: string
  readonly outDir: string
  readonly model: string
  readonly mode: "conditions" | "axes"
  readonly axes?: readonly string[]
  readonly conditions: readonly string[]
  readonly completed: readonly string[]
  readonly partialResults: Readonly<Record<string, readonly MatrixRow[]>>
  readonly totalEstCostUsd?: number
  readonly spentUsd?: number
}

/** Mismatch reason returned by `detectMismatch` — undefined ⇒ compatible. */
export type StateMismatch =
  | { readonly kind: "mode"; readonly stored: string; readonly requested: string }
  | {
      readonly kind: "axes"
      readonly stored: readonly string[]
      readonly requested: readonly string[]
    }
  | {
      readonly kind: "conditions"
      readonly stored: readonly string[]
      readonly requested: readonly string[]
    }
  | { readonly kind: "dataset"; readonly stored: string; readonly requested: string }
  | { readonly kind: "model"; readonly stored: string; readonly requested: string }

/** Atomic write: serialise → write to `${path}.tmp` → rename over `path`.
 *  `renameSync` is atomic on POSIX (same-filesystem rename), so a reader
 *  never sees a partial file. On a crash mid-write only the tmp file may
 *  linger; the canonical file is either the old or the new full content. */
const atomicWriteJson = (path: string, value: unknown): void => {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

/** Locate the state file under `outDir`. Pure. */
export const stateFilePath = (outDir: string): string => join(outDir, STATE_FILE)

/** Load the state file. Returns `undefined` when:
 *    - the file does not exist (first run),
 *    - the file is unreadable / not JSON (corrupt — start fresh),
 *    - the version does not match `STATE_VERSION` (forward-compat reject).
 *
 *  No exceptions thrown to caller — the runner treats every "undefined"
 *  return as "start fresh", which is always safe (the bench's own JSONL
 *  writes are unaffected; only the resume short-circuit is skipped).
 */
export const loadSweepState = (outDir: string): SweepState | undefined => {
  const path = stateFilePath(outDir)
  if (!existsSync(path)) return undefined
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isShapedAsSweepState(parsed)) return undefined
  if (parsed.version !== STATE_VERSION) return undefined
  return parsed
}

/** Atomically persist the state. Caller decides when to checkpoint (after
 *  each condition completes is the canonical call site). */
export const saveSweepState = (outDir: string, state: SweepState): void => {
  atomicWriteJson(stateFilePath(outDir), state)
}

/** Remove the state file. Safe to call when no file exists. Called by the
 *  runner after the FINAL condition completes (so a successful sweep does
 *  not leave a stale checkpoint that a later `--resume` would short-circuit
 *  through). */
export const cleanSweepState = (outDir: string): void => {
  const path = stateFilePath(outDir)
  if (!existsSync(path)) return
  try {
    rmSync(path)
  } catch {
    // Best-effort: a leftover state file is recoverable (operator can `rm`).
    // We do not raise — the sweep has succeeded; cleanup is bookkeeping.
  }
  // Also sweep an orphaned `.tmp` if a previous write crashed mid-rename.
  const tmp = `${path}.tmp`
  if (existsSync(tmp)) {
    try {
      rmSync(tmp)
    } catch {
      // ignore
    }
  }
}

/** Detect an incompatible resume request. Returns the first mismatch found
 *  (in priority order: mode → dataset → model → axes → conditions) or
 *  undefined when the state matches. The runner uses this to fail loudly
 *  on `--resume` when the operator changed the sweep shape between runs.
 *
 *  We compare CSV-equivalent lists by canonical JSON of the array — order
 *  matters for `--conditions` (the runner respects caller order) but axes
 *  are stored AFTER de-duping in caller order too, so identical-array
 *  comparison is correct for both. */
export const detectMismatch = (
  stored: SweepState,
  req: {
    readonly mode: "conditions" | "axes"
    readonly dataset: string
    readonly model: string
    readonly axes?: readonly string[]
    readonly conditions: readonly string[]
  },
): StateMismatch | undefined => {
  if (stored.mode !== req.mode) {
    return { kind: "mode", stored: stored.mode, requested: req.mode }
  }
  if (stored.dataset !== req.dataset) {
    return { kind: "dataset", stored: stored.dataset, requested: req.dataset }
  }
  if (stored.model !== req.model) {
    return { kind: "model", stored: stored.model, requested: req.model }
  }
  if (req.mode === "axes") {
    const a = stored.axes ?? []
    const b = req.axes ?? []
    if (!arraysEqual(a, b)) {
      return { kind: "axes", stored: a, requested: b }
    }
  }
  if (!arraysEqual(stored.conditions, req.conditions)) {
    return { kind: "conditions", stored: stored.conditions, requested: req.conditions }
  }
  return undefined
}

/** Append rows for a just-completed condition into the partial-results map
 *  and bump the in-memory state. PURE: caller passes the previous state +
 *  the delta, gets a new state back. Caller is responsible for persisting
 *  via `saveSweepState`. */
export const recordConditionComplete = (
  prev: SweepState,
  label: string,
  rows: readonly MatrixRow[],
): SweepState => {
  const completed = prev.completed.includes(label) ? prev.completed : [...prev.completed, label]
  const partialResults: Record<string, readonly MatrixRow[]> = { ...prev.partialResults }
  partialResults[label] = rows
  const addedCost = rows.reduce((acc, r) => acc + (r.costUsd ?? 0), 0)
  const prevSpent = prev.spentUsd ?? 0
  return {
    ...prev,
    completed,
    partialResults,
    spentUsd: round4(prevSpent + addedCost),
  }
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

/** Flatten all rows from `partialResults`, preserving caller-supplied
 *  condition order from `conditions` (or `completed` for axes mode). Used
 *  on resume to seed the runner's in-memory `allRows`. */
export const flattenPartialRows = (state: SweepState): readonly MatrixRow[] => {
  const order = state.conditions.length > 0 ? state.conditions : state.completed
  const out: MatrixRow[] = []
  for (const label of order) {
    const rows = state.partialResults[label]
    if (rows !== undefined) out.push(...rows)
  }
  // Also include any partial-results bucket NOT in the order list (defensive
  // — e.g. axes-mode where `conditions` is the static label list and the
  // bucket key is the canonical label). De-duplicated by reference.
  const seen = new Set(order)
  for (const label of Object.keys(state.partialResults)) {
    if (seen.has(label)) continue
    const rows = state.partialResults[label]
    if (rows !== undefined) out.push(...rows)
  }
  return out
}

/** Construct a fresh SweepState for a brand-new sweep. Pure. */
export const newSweepState = (init: {
  readonly dataset: string
  readonly outDir: string
  readonly model: string
  readonly mode: "conditions" | "axes"
  readonly axes?: readonly string[]
  readonly conditions: readonly string[]
  readonly totalEstCostUsd?: number
  readonly now?: () => number
}): SweepState => {
  const now = init.now?.() ?? Date.now()
  const base: SweepState = {
    version: STATE_VERSION,
    startedAt: now,
    dataset: init.dataset,
    outDir: init.outDir,
    model: init.model,
    mode: init.mode,
    conditions: [...init.conditions],
    completed: [],
    partialResults: {},
    spentUsd: 0,
  }
  // Add optional fields only when defined — `exactOptionalPropertyTypes: true`
  // forbids assigning `undefined` to an optional property.
  return {
    ...base,
    ...(init.axes !== undefined ? { axes: [...init.axes] } : {}),
    ...(init.totalEstCostUsd !== undefined ? { totalEstCostUsd: init.totalEstCostUsd } : {}),
  }
}

/** Render a one-line human summary of a mismatch for the error message. */
export const formatMismatch = (m: StateMismatch): string => {
  if (m.kind === "mode") return `mode mismatch: stored=${m.stored}, requested=${m.requested}`
  if (m.kind === "dataset") return `dataset mismatch: stored=${m.stored}, requested=${m.requested}`
  if (m.kind === "model") return `model mismatch: stored=${m.stored}, requested=${m.requested}`
  if (m.kind === "axes") {
    return `axes mismatch: stored=[${m.stored.join(",")}], requested=[${m.requested.join(",")}]`
  }
  return `conditions mismatch: stored=[${m.stored.join(",")}], requested=[${m.requested.join(",")}]`
}

// ── internal: structural guard for the parsed JSON ─────────────────────────

const arraysEqual = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string")

const isMatrixRow = (v: unknown): v is MatrixRow => {
  if (v === null || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  return (
    typeof r.condition === "string" && typeof r.pickId === "string" && typeof r.verdict === "string"
  )
}

const isPartialResults = (v: unknown): v is Record<string, readonly MatrixRow[]> => {
  if (v === null || typeof v !== "object") return false
  for (const val of Object.values(v)) {
    if (!Array.isArray(val)) return false
    if (!val.every(isMatrixRow)) return false
  }
  return true
}

/** Check that every required scalar field has the right primitive type.
 *  Split out of `isShapedAsSweepState` to keep cognitive complexity low. */
const hasValidScalars = (s: Record<string, unknown>): boolean =>
  typeof s.version === "number" &&
  typeof s.startedAt === "number" &&
  typeof s.dataset === "string" &&
  typeof s.outDir === "string" &&
  typeof s.model === "string" &&
  (s.mode === "conditions" || s.mode === "axes")

/** Check that every required array / record field has the right SHAPE.
 *  Reuses the closed-element guards already defined above. */
const hasValidContainers = (s: Record<string, unknown>): boolean =>
  isStringArray(s.conditions) && isStringArray(s.completed) && isPartialResults(s.partialResults)

/** Check that the optional fields, when present, have the right type.
 *  Absent values are valid by construction (the loader returns them as
 *  undefined which TypeScript narrows away). */
const hasValidOptionals = (s: Record<string, unknown>): boolean => {
  if (s.axes !== undefined && !isStringArray(s.axes)) return false
  if (s.totalEstCostUsd !== undefined && typeof s.totalEstCostUsd !== "number") return false
  if (s.spentUsd !== undefined && typeof s.spentUsd !== "number") return false
  return true
}

/** Structural guard. We do NOT fully validate `MatrixRow` shape down to the
 *  numeric fields — the bench parser is the source of truth there. The
 *  guard rejects only obviously-malformed top-level shapes. */
const isShapedAsSweepState = (v: unknown): v is SweepState => {
  if (v === null || typeof v !== "object") return false
  const s = v as Record<string, unknown>
  return hasValidScalars(s) && hasValidContainers(s) && hasValidOptionals(s)
}

/** Filter the supplied condition list to the ones NOT YET completed. The
 *  runner uses this to know which legacy conditions remain after a resume.
 *
 *  Generic over the condition string type so legacy `Condition` callers
 *  preserve their narrow type, and axes-mode callers (string labels) work
 *  the same way without an extra overload. */
export const remainingConditions = <T extends string>(
  all: readonly T[],
  completed: readonly string[],
): readonly T[] => {
  const done = new Set(completed)
  return all.filter((c) => !done.has(c))
}

/** Narrow string-only utility for legacy callers. The `Condition` import
 *  ensures this file is kept in step with the matrix tool's vocabulary. */
export type StateCondition = Condition | string
