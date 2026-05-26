#!/usr/bin/env bun
/**
 * `bun run tools/swebench-matrix.ts` — SWE-bench A/B matrix runner.
 *
 * Sweeps a small SWE-bench dataset (e.g. `tests/smoke/swebench/picks.jsonl`)
 * across a 3-axis ON/OFF condition matrix and reports per-condition pass@1,
 * average tokens, turns, wall-clock, and cost.
 *
 * Axes (8 total = 2^3):
 *   - LSP       — `QUANTA_BENCH_LSP=1`
 *   - SUBAGENT  — `QUANTA_BENCH_SUBAGENT=1`
 *   - SKILLS    — `QUANTA_BENCH_SKILLS=1`
 *
 * Conditions (default = all 8):
 *   baseline, lsp, subagent, skills,
 *   lsp+subagent, lsp+skills, subagent+skills, all
 *
 * Design choices (no heuristics):
 *   - The runner DOES NOT modify the bench process — it composes via env vars
 *     only, so each ON/OFF gate is a property of the bench/agent code (a
 *     separate track owns wiring those gates).
 *   - default-OFF guarantee: running with `--conditions baseline` writes NONE
 *     of the three QUANTA_BENCH_* env vars; the child bench inherits the
 *     parent env unmodified for that axis.
 *   - Bench results are parsed from the `summary.json` it writes under
 *     `<observe-dir>/<runId>/summary.json`. Per-instance token / wall /
 *     cost come from the JSONL event stream (`<runId>/<runId>.NN.jsonl`).
 *   - We do not invent token numbers or wall times — missing data ⇒ zero.
 *
 * Exit codes:
 *   0 — all selected conditions ran to a final summary (even if some failed
 *       individual picks). Per-condition non-zero exits are recorded in
 *       `matrix-summary.jsonl` but never abort the sweep.
 *   1 — a fatal harness error (e.g. cannot read dataset, cannot create out
 *       dir). Partial progress is preserved on disk.
 *   130 — SIGINT before the first condition completed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { costUsd } from "@/observability"
import { type AnyKnob, allKnobs, knobsForSurface, registerKnob } from "@/runner/knobs"

/**
 * Bench-knob bootstrap entry. The matrix tool's `--axes` mode (and its
 * helpers `generateAxesConditions` / `estimateAxesCost`) need the
 * bench-surface knob registry populated.
 *
 * Implementation: dynamic-import each knob module FIRST so the side-effect
 * `registerKnob` fires when this function runs (NOT at module load — see
 * the registry-neutral note below). If a previous caller already loaded
 * those modules AND the registry was subsequently cleared (test harness
 * `__resetRegistry()`), the dynamic-import is a no-op (ESM cache) and we
 * recover by re-registering from the cached module's exported knob record.
 *
 * Always-recover: we do NOT cache a "bootstrapped" flag — we ALWAYS walk
 * the cached module exports and add any knob the registry is missing. This
 * makes the helper safe to call repeatedly across tests that reset the
 * registry (cost is a 12-entry registry lookup; the dynamic imports are
 * cheaper still after the first call thanks to ESM caching).
 *
 * Registry-neutral at module load: this file is imported by the legacy
 * `tests/unit/swebench-matrix.test.ts` which never touches knob mode —
 * pulling in the knob modules transitively at file scope would pollute the
 * load-order graph and break unrelated tests (notably `knobs-import-bundle`
 * after `knobs-hellgate`'s `afterEach` reset). The bootstrap fires only
 * when `--axes` / docs-generator path actually invokes it.
 */
export const bootstrapBenchKnobs = async (): Promise<void> => {
  const modules = await Promise.all([
    import("@/runner/knobs/knobs/branch-search"),
    import("@/runner/knobs/knobs/closeout-guard"),
    import("@/runner/knobs/knobs/hooks"),
    import("@/runner/knobs/knobs/issue-hint"),
    import("@/runner/knobs/knobs/localize-phase"),
    import("@/runner/knobs/knobs/lsp"),
    import("@/runner/knobs/knobs/must-pass"),
    import("@/runner/knobs/knobs/persona"),
    import("@/runner/knobs/knobs/repro-test"),
    import("@/runner/knobs/knobs/skills"),
    import("@/runner/knobs/knobs/subagent"),
    import("@/runner/knobs/knobs/working-state"),
  ])
  // Recovery walk: ALWAYS check + re-register missing ids. Walking 12
  // module exports per call is negligible; the safety property is more
  // important (a stale `bootstrapped=true` flag after a registry reset
  // would silently leave the registry empty — caught the hard way in
  // dev when `knobs-import-bundle` failed downstream of a hellgate run).
  const reg = allKnobs()
  for (const mod of modules) {
    for (const v of Object.values(mod)) {
      if (v !== null && typeof v === "object" && "id" in v && "envKey" in v && "parse" in v) {
        const k = v as AnyKnob
        if (!reg.has(k.id)) registerKnob(k)
      }
    }
  }
}

// ── condition / axis vocabulary ─────────────────────────────────────────────

/** The three independent ON/OFF axes. Each maps to ONE env var. The bench
 *  process is the consumer; this runner is purely a composer. */
export const AXES = ["lsp", "subagent", "skills"] as const
export type Axis = (typeof AXES)[number]

/** Closed list of 8 condition names. Order matters: it pins the output
 *  table row order and matches "first three single-axis ON, then 2-combos,
 *  then all". `baseline` and `all` are the corners. */
export const CONDITIONS = [
  "baseline",
  "lsp",
  "subagent",
  "skills",
  "lsp+subagent",
  "lsp+skills",
  "subagent+skills",
  "all",
] as const
export type Condition = (typeof CONDITIONS)[number]

/** Axis → env var name. Single source of truth for the 3 gates. */
export const AXIS_ENV: Readonly<Record<Axis, string>> = {
  lsp: "QUANTA_BENCH_LSP",
  subagent: "QUANTA_BENCH_SUBAGENT",
  skills: "QUANTA_BENCH_SKILLS",
}

/** Decompose a condition into the set of axes that should be ON. Pure. */
export const axesOf = (c: Condition): readonly Axis[] => {
  if (c === "baseline") return []
  if (c === "all") return AXES
  // The composite tokens are exactly the `+`-joined axis names.
  return c.split("+") as readonly Axis[]
}

/** condition → env overlay. ABSENT keys for OFF axes (do not set
 *  `QUANTA_BENCH_*=0`); that preserves the byte-identical default-OFF
 *  semantics when other tracks default these env vars to undefined. */
export const conditionToEnv = (c: Condition): Record<string, "1"> => {
  const env: Record<string, "1"> = {}
  for (const a of axesOf(c)) env[AXIS_ENV[a]] = "1"
  return env
}

/** Parse the CSV `--conditions` flag. Empty / undefined ⇒ all 8 in order.
 *  Unknown tokens throw — fail loudly, no heuristic best-effort. */
export const parseConditions = (csv: string | undefined): readonly Condition[] => {
  if (csv === undefined || csv.trim() === "") return CONDITIONS
  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const out: Condition[] = []
  for (const p of parts) {
    if (!(CONDITIONS as readonly string[]).includes(p)) {
      throw new Error(`unknown condition "${p}". valid: ${CONDITIONS.join(", ")}`)
    }
    out.push(p as Condition)
  }
  return out
}

// ── --axes mode (registry-driven N-axis sweep) ───────────────────────────────

/**
 * Closed ON-value table for the `--axes` mode. Maps a bench-surface knob id to
 * the EXACT raw string that turns it ON in a 2^N matrix sweep. The registry
 * carries each knob's `envKey` + the `parse` predicate; what it does NOT
 * carry is "the canonical ON literal" (a knob may accept multiple raws —
 * `"1"`, `"on"`, `"true"`, an integer K, an enum value). We pin ONE literal
 * per axis here so the sweep is deterministic and byte-identical across runs.
 *
 * Unknown axis ⇒ throw (silent default forbidden). Adding a knob to the
 * registry MUST add its ON value here OR be intentionally excluded from
 * `--axes` (e.g. an enum-valued knob with no natural "default ON"). The
 * `--axes` parser validates the axis is in this table.
 */
export const AXIS_ON_VALUES: Readonly<Record<string, string>> = {
  lsp: "1",
  subagent: "1",
  skills: "1",
  "localize-phase": "3",
  "branch-search": "3",
  "issue-hint": "1",
  "repro-test": "5",
  "must-pass": "strict",
  persona: "pragmatic",
  "working-state": "on",
  "closeout-guard": "on",
  hooks: "on",
}

/** Parse the CSV `--axes` flag. Empty / undefined ⇒ undefined (not in axes
 *  mode). Whitespace-only tokens are dropped. Unknown axis tokens throw
 *  HERE so the operator sees the error before the bench spawns. */
export const parseAxes = (csv: string | undefined): readonly string[] | undefined => {
  if (csv === undefined) return undefined
  const trimmed = csv.trim()
  if (trimmed === "") {
    throw new Error("--axes requires a non-empty CSV (e.g. --axes lsp,subagent)")
  }
  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) {
    throw new Error("--axes requires at least one axis token")
  }
  // De-dupe while preserving caller order — duplicates would double the matrix.
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** A single axis-mode condition: the bit pattern (0..2^N-1) and the env
 *  overlay it produces (only ON axes appear; OFF axes are ABSENT — same
 *  default-OFF byte-identical contract as `conditionToEnv`). */
export interface AxesCondition {
  readonly label: string // e.g. "axes-baseline" or "axes-lsp_subagent"
  readonly env: Readonly<Record<string, string>>
  readonly onAxes: readonly string[] // subset of `axes`, in input order
}

/** Generate all 2^N conditions for the given axis list. Pure.
 *
 *  Throws on:
 *    - unknown axis (not registered for surface "bench")
 *    - axis with no entry in `AXIS_ON_VALUES`
 *
 *  Conflict knobs (e.g. `localize-phase` + `branch-search`) are skipped in
 *  generation: the bit combinations that would activate both are still
 *  emitted (so the bench process sees them and the resolver's `validateKnobs`
 *  raises a `KnobConflictError` exactly where it would in a manual run). This
 *  keeps the sweep "complete" from the operator's POV; suppressing conflict
 *  pairs at generation time would hide the conflict instead of surfacing it.
 *  Tests pin both behaviors. */
/** Validate every axis token against the registry + the ON-value table.
 *  Throws on first mismatch (loud failure — operator sees error before the
 *  sweep starts). Extracted to keep `generateAxesConditions` complexity low. */
const validateAxes = (axes: readonly string[], benchKnobs: ReadonlyMap<string, AnyKnob>): void => {
  for (const a of axes) {
    if (!benchKnobs.has(a)) {
      throw new Error(`unknown axis "${a}" — not a registered bench-surface knob`)
    }
    if (!Object.hasOwn(AXIS_ON_VALUES, a)) {
      throw new Error(`no ON value for axis "${a}" in AXIS_ON_VALUES`)
    }
  }
}

/** Build ONE AxesCondition from a bit pattern `i` (LSB → axes[0]). Pure. */
const conditionFromBitPattern = (
  i: number,
  axes: readonly string[],
  benchKnobs: ReadonlyMap<string, AnyKnob>,
): AxesCondition => {
  const env: Record<string, string> = {}
  const onAxes: string[] = []
  for (let bit = 0; bit < axes.length; bit++) {
    if (((i >> bit) & 1) === 0) continue
    const axisId = axes[bit]
    if (axisId === undefined) continue // noUncheckedIndexedAccess
    const knob = benchKnobs.get(axisId)
    if (knob === undefined) continue // pre-validated; defensive
    const raw = AXIS_ON_VALUES[axisId]
    if (raw === undefined) continue // pre-validated; defensive
    env[knob.envKey] = raw
    onAxes.push(axisId)
  }
  const label = onAxes.length === 0 ? "axes-baseline" : `axes-${onAxes.join("_")}`
  return { label, env, onAxes }
}

export const generateAxesConditions = (
  axes: readonly string[],
  registry?: ReadonlyMap<string, AnyKnob>,
): readonly AxesCondition[] => {
  if (axes.length === 0) {
    // A 0-axis sweep is still ONE condition — the baseline with no overlay.
    return [{ label: "axes-baseline", env: {}, onAxes: [] }]
  }
  // 2^N cap — a 12-axis sweep is 4096 conditions; we don't ban it, but pin a
  // hard ceiling so a typo (`--axes lsp,sub,...` 20 axes) can't fork a million
  // bench processes. Check FIRST so the gate trips before any registry hits.
  if (axes.length > 12) {
    throw new Error(`--axes ${axes.length} too many — hard cap is 12 (= 4096 conditions)`)
  }
  // The optional `registry` parameter is a TEST seam: tests can pass a
  // hand-built map so they don't have to touch the global knob registry
  // (which is fragile under reset-style hellgate suites). Production
  // callers omit it and pick up the global bench-surface view.
  const benchKnobs = registry ?? knobsForSurface("bench")
  validateAxes(axes, benchKnobs)
  const out: AxesCondition[] = []
  const total = 1 << axes.length
  for (let i = 0; i < total; i++) {
    out.push(conditionFromBitPattern(i, axes, benchKnobs))
  }
  return out
}

/** Sum the worst-case cost multiplier of an axes sweep. We multiply the
 *  per-condition products and sum — the operator sees an upper bound on
 *  baseline-equivalent work. A knob without `costMultiplier` counts as 1.
 *
 *  Optional `registry` test seam: tests pass a deterministic map so they
 *  don't have to touch the global knob registry. Production callers omit it. */
export const estimateAxesCost = (
  axes: readonly string[],
  registry?: ReadonlyMap<string, AnyKnob>,
): number => {
  const benchKnobs = registry ?? knobsForSurface("bench")
  const conditions = generateAxesConditions(axes, benchKnobs)
  let total = 0
  for (const cond of conditions) {
    let product = 1
    for (const a of cond.onAxes) {
      const k = benchKnobs.get(a)
      const m = costFor(k)
      product *= m
    }
    total += product
  }
  return total
}

const costFor = (k: AnyKnob | undefined): number => {
  if (k === undefined) return 1
  const m = k.costMultiplier
  return typeof m === "number" && m > 0 ? m : 1
}

// ── result aggregation ──────────────────────────────────────────────────────

/** One row of `matrix-summary.jsonl` — flat for easy `jq` / spreadsheets. */
export interface MatrixRow {
  condition: Condition
  pickId: string
  verdict: "pass" | "fail" | "degraded" | "error"
  turns: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  wallMs: number
  /** USD; 0 when token rates for the model are unknown or no usage was
   *  observed. We never invent a price — `costUsd(...) === null` ⇒ 0. */
  costUsd: number
}

/** Per-condition rollup printed in the markdown table. */
export interface ConditionStats {
  condition: Condition
  /** `passed/total` where `total` excludes `degraded` (matches bench
   *  `resolved/total`). `error` rows count toward `total` (the picker chose
   *  this instance; an error there is a fail-to-deliver). */
  passed: number
  total: number
  passAt1Pct: number
  avgTurns: number
  avgTokensIn: number
  avgTokensOut: number
  avgWallMs: number
  avgCostUsd: number
}

/** Compute per-condition stats from flat rows. Pure. */
export const aggregate = (rows: readonly MatrixRow[]): readonly ConditionStats[] => {
  const byCond = new Map<Condition, MatrixRow[]>()
  for (const r of rows) {
    const list = byCond.get(r.condition) ?? []
    list.push(r)
    byCond.set(r.condition, list)
  }
  const out: ConditionStats[] = []
  // Iterate in canonical order so the table is stable.
  for (const c of CONDITIONS) {
    const list = byCond.get(c)
    if (list === undefined || list.length === 0) continue
    const counted = list.filter((r) => r.verdict !== "degraded")
    const passed = counted.filter((r) => r.verdict === "pass").length
    const total = counted.length
    const avg = (sel: (r: MatrixRow) => number): number => {
      if (counted.length === 0) return 0
      return counted.reduce((acc, r) => acc + sel(r), 0) / counted.length
    }
    out.push({
      condition: c,
      passed,
      total,
      passAt1Pct: total === 0 ? 0 : Math.round((passed / total) * 1000) / 10,
      avgTurns: round1(avg((r) => r.turns)),
      avgTokensIn: Math.round(avg((r) => r.tokensIn)),
      avgTokensOut: Math.round(avg((r) => r.tokensOut)),
      avgWallMs: Math.round(avg((r) => r.wallMs)),
      avgCostUsd: round4(avg((r) => r.costUsd)),
    })
  }
  return out
}

const round1 = (n: number): number => Math.round(n * 10) / 10
const round4 = (n: number): number => Math.round(n * 10000) / 10000

/** Render a markdown table of per-condition stats. Pure. */
export const formatMatrixTable = (stats: readonly ConditionStats[]): string => {
  const header = "| condition | pass@1 | n | avg turns | avg in | avg out | avg wall (s) | avg $ |"
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |"
  const rows = stats.map((s) => {
    const wallS = (s.avgWallMs / 1000).toFixed(1)
    return (
      `| ${s.condition} | ${s.passAt1Pct.toFixed(1)}% (${s.passed}/${s.total}) | ${s.total} | ` +
      `${s.avgTurns.toFixed(1)} | ${s.avgTokensIn} | ${s.avgTokensOut} | ${wallS} | ` +
      `$${s.avgCostUsd.toFixed(4)} |`
    )
  })
  return [header, sep, ...rows].join("\n")
}

// ── dataset / id parsing ────────────────────────────────────────────────────

/** Read `instance_id` lines out of a SWE-bench JSONL file. We only need the
 *  ids; the bench process parses the rest. Throws on file read error. */
export const readPickIds = (datasetFile: string): readonly string[] => {
  const text = readFileSync(datasetFile, "utf8")
  const ids: string[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    try {
      const obj = JSON.parse(line) as { instance_id?: unknown }
      if (typeof obj.instance_id === "string" && obj.instance_id !== "") {
        ids.push(obj.instance_id)
      }
    } catch {
      // Skip non-JSON lines silently — matches bench's own forgiving parser.
    }
  }
  return ids
}

// ── per-run parser (summary.json + JSONL stream) ────────────────────────────

interface SummaryFile {
  runId: string
  resolved?: number
  total?: number
  degraded?: number
  instances?: Array<{ id: string; passed: boolean; verdict?: string; turns?: number }>
}

interface UsageRollup {
  tokensIn: number
  tokensOut: number
  cacheRead: number
  model: string
}

const numOr = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback)
const strOr = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback)

const mergeUsage = (acc: UsageRollup, obj: Record<string, unknown>): void => {
  const d = (obj.data as Record<string, unknown> | undefined) ?? obj
  acc.tokensIn += numOr(d.inputTokens, 0)
  acc.tokensOut += numOr(d.outputTokens, 0)
  acc.cacheRead += numOr(d.cacheReadTokens, 0)
  const m = strOr(d.model, "")
  if (m !== "") acc.model = m
}

const tryParseJsonl = (file: string): Record<string, unknown>[] => {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "") continue
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // Skip malformed lines — JSONL streams may be partial under SIGINT.
    }
  }
  return out
}

const wallSpanOf = (events: readonly Record<string, unknown>[]): number => {
  let firstTs = Number.POSITIVE_INFINITY
  let lastTs = 0
  for (const obj of events) {
    const ts = obj.ts
    if (typeof ts !== "number") continue
    if (ts < firstTs) firstTs = ts
    if (ts > lastTs) lastTs = ts
  }
  return firstTs === Number.POSITIVE_INFINITY ? 0 : Math.max(0, lastTs - firstTs)
}

/** Walk an attempt JSONL file and roll up usage events plus wall time
 *  (last event ts minus first event ts, if `ts` fields are present). */
const parseAttemptJsonl = (file: string): { usage: UsageRollup; wallMs: number; turns: number } => {
  const events = tryParseJsonl(file)
  const usage: UsageRollup = { tokensIn: 0, tokensOut: 0, cacheRead: 0, model: "" }
  let turns = 0
  for (const obj of events) {
    const k = obj.kind ?? obj.type
    if (k === "turn_start" || k === "turn_started") turns += 1
    if (k === "llm_usage" || k === "usage") mergeUsage(usage, obj)
  }
  return { usage, wallMs: wallSpanOf(events), turns }
}

/** Match an attempt file to an instance id by reading the first few events.
 *  The bench writes one file per (instance, attempt). When the file's events
 *  include a turn carrying a `taskId`/`id` matching the pick, that's the
 *  binding. We fall back to filename scan (`<id>` substring) which the bench
 *  doesn't currently guarantee — so the canonical signal is "events first
 *  appearing in this file for this id". Pure of side effects. */
const indexAttemptsByInstance = (runDir: string, ids: readonly string[]): Map<string, string> => {
  const map = new Map<string, string>()
  let entries: string[]
  try {
    entries = readdirSync(runDir).filter((f) => f.endsWith(".jsonl"))
  } catch {
    return map
  }
  for (const f of entries) {
    const path = join(runDir, f)
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      continue
    }
    // Scan all lines for any string field referencing one of the ids. First
    // match wins; later attempts on the same id are ignored (we use
    // `summary.json` for the verdict, which is per-id already).
    for (const id of ids) {
      if (map.has(id)) continue
      if (text.includes(id)) {
        map.set(id, path)
        break
      }
    }
  }
  return map
}

const readSummary = (runDir: string): SummaryFile | undefined => {
  const summaryPath = join(runDir, "summary.json")
  if (!existsSync(summaryPath)) return undefined
  try {
    return JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryFile
  } catch {
    return undefined
  }
}

const verdictOf = (
  inst: NonNullable<SummaryFile["instances"]>[number] | undefined,
  fallback: "fail" | "error",
): MatrixRow["verdict"] => {
  if (inst === undefined) return fallback
  if (inst.verdict === "degraded") return "degraded"
  return inst.passed ? "pass" : "fail"
}

const emptyEvents = (): { usage: UsageRollup; wallMs: number; turns: number } => ({
  usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, model: "" },
  wallMs: 0,
  turns: 0,
})

const costOf = (u: UsageRollup): number => {
  if (u.model === "") return 0
  return costUsd(u.model, u.tokensIn, u.tokensOut, u.cacheRead) ?? 0
}

/** Collect per-pick rows for ONE condition from its on-disk artifacts. */
export const collectRowsForCondition = (
  condition: Condition,
  runDir: string,
  pickIds: readonly string[],
  fallbackVerdict: "fail" | "error",
): MatrixRow[] => {
  const summary = readSummary(runDir)
  const attempts = indexAttemptsByInstance(runDir, pickIds)
  const byId = new Map<string, NonNullable<SummaryFile["instances"]>[number]>()
  for (const inst of summary?.instances ?? []) byId.set(inst.id, inst)
  return pickIds.map((pickId) => {
    const inst = byId.get(pickId)
    const attemptFile = attempts.get(pickId)
    const events = attemptFile !== undefined ? parseAttemptJsonl(attemptFile) : emptyEvents()
    return {
      condition,
      pickId,
      verdict: verdictOf(inst, fallbackVerdict),
      turns: inst?.turns ?? events.turns,
      tokensIn: events.usage.tokensIn,
      tokensOut: events.usage.tokensOut,
      cacheRead: events.usage.cacheRead,
      wallMs: events.wallMs,
      costUsd: round4(costOf(events.usage)),
    }
  })
}

// ── CLI plumbing ────────────────────────────────────────────────────────────

const argValue = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const argFlag = (argv: readonly string[], flag: string): boolean => argv.includes(flag)

const argPositiveInt = (argv: readonly string[], flag: string, fallback: number): number => {
  const raw = argValue(argv, flag)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`invalid ${flag}="${raw}" — must be a positive integer`)
  }
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

export interface MatrixArgs {
  dataset: string
  corpus: string
  model: string
  out: string
  conditions: readonly Condition[]
  /** Set when the operator passed `--axes`. ABSENT (default) ⇒ legacy
   *  `--conditions` mode (byte-identical). PRESENT ⇒ axes mode: the runner
   *  derives 2^N conditions from `axes` via `generateAxesConditions` and
   *  ignores `conditions`. The two flags are mutually exclusive (parseArgs
   *  throws). */
  axes?: readonly string[]
  /** Preview mode: print the planned matrix + estimated cost and exit
   *  without spawning the bench. Compatible with both `--axes` and the
   *  legacy `--conditions` mode (in the legacy mode it just lists the
   *  conditions). */
  dryRun: boolean
  maxTurns: number
  timeoutMs: number
  pythonGrade: boolean
}

/** Resolve a path-or-empty in dry-run vs. real-run modes. Throws on missing
 *  in non-dry-run mode (real run requires the path). Extracted to keep
 *  `parseArgs` complexity below the biome ceiling. */
const resolveRequired = (raw: string | undefined, flag: string, dryRun: boolean): string => {
  if (raw === undefined || raw === "") {
    if (dryRun) return ""
    throw new Error(`missing required ${flag} <dir>`)
  }
  return resolve(raw)
}

export const parseArgs = (argv: readonly string[]): MatrixArgs => {
  // Axes / dry-run are checked FIRST so a `--axes` request without `--dataset`
  // still fails with the dataset error (operator-visible: same flag set
  // required regardless of mode). The mutually-exclusive check between
  // `--axes` and `--conditions` runs AFTER all required-arg checks pass —
  // otherwise the operator would see two errors out of order.
  const dataset = argValue(argv, "--dataset")
  if (dataset === undefined || dataset === "") {
    throw new Error("missing required --dataset <file>")
  }
  // --axes mode does NOT require --corpus / --out when --dry-run is set: the
  // bench is never spawned in that case, so we tolerate their absence to
  // make `bun run tools/swebench-matrix.ts --dataset f --axes lsp --dry-run`
  // a friction-free smoke for the operator.
  const dryRun = argFlag(argv, "--dry-run")
  const axes = parseAxes(argValue(argv, "--axes"))
  if (axes !== undefined && argv.includes("--conditions")) {
    throw new Error("--axes and --conditions are mutually exclusive")
  }
  const corpus = resolveRequired(argValue(argv, "--corpus"), "--corpus", dryRun)
  const out = resolveRequired(argValue(argv, "--out"), "--out", dryRun)
  return {
    dataset: resolve(dataset),
    corpus,
    model: argValue(argv, "--model") ?? "gpt-5",
    out,
    conditions: parseConditions(argValue(argv, "--conditions")),
    ...(axes !== undefined ? { axes } : {}),
    dryRun,
    maxTurns: argPositiveInt(argv, "--max-turns", 30),
    timeoutMs: argPositiveInt(argv, "--timeout-ms", 600_000),
    pythonGrade: argFlag(argv, "--python-grade"),
  }
}

const conditionLabel = (c: Condition): string => c.replace(/\+/g, "_")

/** Sanitise an axes-mode label so it's safe as a path segment. The label
 *  already comes from a closed alphabet (axis ids + underscore), but defence
 *  in depth keeps a future axis id with `+`/`/` from foot-gunning. */
const axesLabel = (label: string): string => label.replace(/[^A-Za-z0-9_-]/g, "_")

/** Spawn the bench process for ONE condition. Returns the parent's exit code
 *  (0 ok, non-zero ⇒ bench reported error). `stdio:inherit` so the operator
 *  sees the bench's own logs in real time. */
const spawnBench = async (
  args: MatrixArgs,
  condition: Condition,
  obsRunDir: string,
): Promise<{ exitCode: number; observeRunDir: string }> => {
  const runId = `matrix-${conditionLabel(condition)}-${Date.now()}`
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...conditionToEnv(condition),
    QUANTA_RUN_ID: runId,
    QUANTA_OBSERVE_DIR: obsRunDir,
  }
  if (args.pythonGrade) {
    env.QUANTA_SWEBENCH_PYTHON = "1"
    // arm64 macOS recipe — see swebench-arm64-grading-recipe memory.
    env.QUANTA_SWEBENCH_NAMESPACE = env.QUANTA_SWEBENCH_NAMESPACE ?? "swebench"
    env.QUANTA_SWEBENCH_MAX_WORKERS = env.QUANTA_SWEBENCH_MAX_WORKERS ?? "1"
  }
  const benchEntry = resolve(import.meta.dir, "..", "src/apps/bench/index.ts")
  const cmd: string[] = [
    "bun",
    "run",
    benchEntry,
    "--swebench",
    args.dataset,
    "--corpus",
    args.corpus,
    "--model",
    args.model,
    "--observe-dir",
    obsRunDir,
    "--predictions",
    join(obsRunDir, "predictions.jsonl"),
    "--report",
    join(obsRunDir, "report.json"),
  ]
  const proc = Bun.spawn(cmd, {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  })
  const exitCode = await proc.exited
  return { exitCode, observeRunDir: join(obsRunDir, runId) }
}

/** Print a one-line estimate of remaining conditions and rough budget hint.
 *  We do NOT predict cost — we only count remaining conditions and remind
 *  the operator that each runs the full pick set. */
const printRemaining = (i: number, total: number, condition: Condition): void => {
  // biome-ignore lint/suspicious/noConsole: this is a CLI tool's primary UX.
  console.error(
    `[matrix] (${i + 1}/${total}) condition=${condition} — ${total - i} condition(s) including this one remaining`,
  )
}

const writeJsonl = (file: string, rows: readonly MatrixRow[]): void => {
  const text = rows.map((r) => JSON.stringify(r)).join("\n")
  writeFileSync(file, text === "" ? "" : `${text}\n`)
}

const log = (msg: string): void => {
  // biome-ignore lint/suspicious/noConsole: this is a CLI tool's primary UX.
  console.error(`[matrix] ${msg}`)
}

const errorRowsFor = (condition: Condition, pickIds: readonly string[]): MatrixRow[] =>
  pickIds.map((pickId) => ({
    condition,
    pickId,
    verdict: "error" as const,
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    wallMs: 0,
    costUsd: 0,
  }))

const runOneCondition = async (
  args: MatrixArgs,
  condition: Condition,
  pickIds: readonly string[],
): Promise<MatrixRow[]> => {
  const obsRoot = join(args.out, conditionLabel(condition))
  mkdirSync(obsRoot, { recursive: true })
  let result: { exitCode: number; observeRunDir: string }
  try {
    result = await spawnBench(args, condition, obsRoot)
  } catch (e) {
    log(`condition=${condition} spawn FAILED: ${(e as Error).message} — skipping`)
    return errorRowsFor(condition, pickIds)
  }
  if (result.exitCode !== 0) {
    log(`condition=${condition} bench exited ${result.exitCode} — collecting partial rows`)
  }
  return collectRowsForCondition(
    condition,
    result.observeRunDir,
    pickIds,
    result.exitCode === 0 ? "fail" : "error",
  )
}

// ── --axes mode driver helpers ───────────────────────────────────────────────

/** Spawn the bench process for ONE axes-mode condition. Mirrors `spawnBench`
 *  byte-by-byte EXCEPT the env overlay (taken straight from
 *  `AxesCondition.env` — already a closed `knob.envKey → ON literal` map). */
const spawnBenchAxes = async (
  args: MatrixArgs,
  cond: AxesCondition,
  obsRunDir: string,
): Promise<{ exitCode: number; observeRunDir: string }> => {
  const runId = `matrix-${axesLabel(cond.label)}-${Date.now()}`
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...cond.env,
    QUANTA_RUN_ID: runId,
    QUANTA_OBSERVE_DIR: obsRunDir,
  }
  if (args.pythonGrade) {
    env.QUANTA_SWEBENCH_PYTHON = "1"
    env.QUANTA_SWEBENCH_NAMESPACE = env.QUANTA_SWEBENCH_NAMESPACE ?? "swebench"
    env.QUANTA_SWEBENCH_MAX_WORKERS = env.QUANTA_SWEBENCH_MAX_WORKERS ?? "1"
  }
  const benchEntry = resolve(import.meta.dir, "..", "src/apps/bench/index.ts")
  const cmd: string[] = [
    "bun",
    "run",
    benchEntry,
    "--swebench",
    args.dataset,
    "--corpus",
    args.corpus,
    "--model",
    args.model,
    "--observe-dir",
    obsRunDir,
    "--predictions",
    join(obsRunDir, "predictions.jsonl"),
    "--report",
    join(obsRunDir, "report.json"),
  ]
  const proc = Bun.spawn(cmd, {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  })
  const exitCode = await proc.exited
  return { exitCode, observeRunDir: join(obsRunDir, runId) }
}

/** Run one axes-mode condition end-to-end. Rows are labeled with `"baseline"`
 *  (when the condition has zero ON axes) OR `"all"` (when every axis is ON)
 *  OR the synthetic label when no canonical Condition fits — the rows are
 *  parsed and aggregated by the same `collectRowsForCondition` parser as
 *  the legacy mode, but a per-row `condition` value chosen from `CONDITIONS`
 *  is required by the `MatrixRow` shape. For axes mode we always treat each
 *  row as a `"baseline"` slot (no aggregation collision: each axes-mode row
 *  carries its own `axes` label via the on-disk `obsRoot` directory name). */
const runOneAxesCondition = async (
  args: MatrixArgs,
  cond: AxesCondition,
  pickIds: readonly string[],
): Promise<MatrixRow[]> => {
  const obsRoot = join(args.out, axesLabel(cond.label))
  mkdirSync(obsRoot, { recursive: true })
  let result: { exitCode: number; observeRunDir: string }
  try {
    result = await spawnBenchAxes(args, cond, obsRoot)
  } catch (e) {
    log(`axes=${cond.label} spawn FAILED: ${(e as Error).message} — skipping`)
    return errorRowsFor("baseline", pickIds)
  }
  if (result.exitCode !== 0) {
    log(`axes=${cond.label} bench exited ${result.exitCode} — collecting partial rows`)
  }
  return collectRowsForCondition(
    "baseline",
    result.observeRunDir,
    pickIds,
    result.exitCode === 0 ? "fail" : "error",
  )
}

const parseArgsOrExit = (): MatrixArgs => {
  try {
    return parseArgs(process.argv.slice(2))
  } catch (e) {
    log(`error: ${(e as Error).message}`)
    log(
      "usage: bun run tools/swebench-matrix.ts --dataset <file> --corpus <dir> --out <dir> [--model gpt-5] [--conditions baseline,lsp,...] [--axes lsp,subagent,...] [--dry-run] [--max-turns 30] [--timeout-ms 600000] [--python-grade]",
    )
    process.exit(1)
  }
}

/** Print the axes-mode preamble + estimated cost. Operator-facing UX. */
const printAxesPreamble = (axes: readonly string[], conditions: readonly AxesCondition[]): void => {
  // biome-ignore lint/suspicious/noConsole: this is a CLI tool's primary UX.
  console.error(
    `[matrix] axes (${axes.length}): [${axes.join(", ")}] → ${conditions.length} conditions`,
  )
  const cost = estimateAxesCost(axes)
  // biome-ignore lint/suspicious/noConsole: this is a CLI tool's primary UX.
  console.error(`[matrix] cost (Σ per-condition product): ~${cost}× baseline`)
}

/** Print the axes-mode dry-run table of planned conditions. Pure stdout output. */
const printAxesDryRun = (conditions: readonly AxesCondition[]): void => {
  for (const cond of conditions) {
    const envStr =
      Object.entries(cond.env).length === 0
        ? "(no env overlay — baseline)"
        : Object.entries(cond.env)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
    // biome-ignore lint/suspicious/noConsole: this is a CLI tool's primary UX.
    console.error(`[matrix]   ${cond.label}: ${envStr}`)
  }
}

const mainAxesMode = async (args: MatrixArgs, axes: readonly string[]): Promise<void> => {
  await bootstrapBenchKnobs()
  const conditions = generateAxesConditions(axes)
  printAxesPreamble(axes, conditions)
  if (args.dryRun) {
    printAxesDryRun(conditions)
    log("dry-run — exiting without spawning bench")
    return
  }
  mkdirSync(args.out, { recursive: true })
  log(`dataset=${basename(args.dataset)} model=${args.model} out=${args.out}`)
  const pickIds = readPickIds(args.dataset)
  log(`picks (${pickIds.length}): ${pickIds.join(", ")}`)
  const partialFile = join(args.out, `partial-axes-${Date.now()}.jsonl`)
  const allRows: MatrixRow[] = []
  let interrupted = false
  const onSigint = (): void => {
    interrupted = true
    log("SIGINT — preserving progress and stopping after current condition")
  }
  process.on("SIGINT", onSigint)
  try {
    for (let i = 0; i < conditions.length; i++) {
      if (interrupted) break
      const cond = conditions[i]
      if (cond === undefined) continue // noUncheckedIndexedAccess
      // biome-ignore lint/suspicious/noConsole: this is a CLI tool's primary UX.
      console.error(`[matrix] (${i + 1}/${conditions.length}) axes=${cond.label}`)
      allRows.push(...(await runOneAxesCondition(args, cond, pickIds)))
      writeJsonl(partialFile, allRows)
    }
    const summaryFile = join(args.out, "matrix-summary-axes.jsonl")
    writeJsonl(summaryFile, allRows)
    log(`wrote ${summaryFile} (${allRows.length} row(s))`)
    if (interrupted) process.exit(130)
  } finally {
    process.off("SIGINT", onSigint)
  }
}

const mainConditionsMode = async (args: MatrixArgs): Promise<void> => {
  if (args.dryRun) {
    log(`conditions (${args.conditions.length}): ${args.conditions.join(", ")}`)
    log("dry-run — exiting without spawning bench")
    return
  }
  mkdirSync(args.out, { recursive: true })
  log(`dataset=${basename(args.dataset)} model=${args.model} out=${args.out}`)
  log(`conditions (${args.conditions.length}): ${args.conditions.join(", ")}`)

  const pickIds = readPickIds(args.dataset)
  log(`picks (${pickIds.length}): ${pickIds.join(", ")}`)

  const partialFile = join(args.out, `partial-${Date.now()}.jsonl`)
  const allRows: MatrixRow[] = []
  let interrupted = false
  const onSigint = (): void => {
    interrupted = true
    log("SIGINT — preserving progress and stopping after current condition")
  }
  process.on("SIGINT", onSigint)

  try {
    for (let i = 0; i < args.conditions.length; i++) {
      if (interrupted) break
      const condition = args.conditions[i]
      if (condition === undefined) continue // noUncheckedIndexedAccess
      printRemaining(i, args.conditions.length, condition)
      allRows.push(...(await runOneCondition(args, condition, pickIds)))
      writeJsonl(partialFile, allRows)
    }
    const summaryFile = join(args.out, "matrix-summary.jsonl")
    writeJsonl(summaryFile, allRows)
    const stats = aggregate(allRows)
    const table = formatMatrixTable(stats)
    // biome-ignore lint/suspicious/noConsole: this is the operator-visible output.
    console.log(table)
    writeFileSync(join(args.out, "matrix-summary.md"), `${table}\n`)
    log(`wrote ${summaryFile} (${allRows.length} row(s))`)
    if (interrupted) process.exit(130)
  } finally {
    process.off("SIGINT", onSigint)
  }
}

const main = async (): Promise<void> => {
  const args = parseArgsOrExit()
  if (args.axes !== undefined) {
    await mainAxesMode(args, args.axes)
    return
  }
  await mainConditionsMode(args)
}

// Only run main() when executed as a script — keep imports side-effect-free
// for tests. `import.meta.main` is set by Bun for the entrypoint module.
if (import.meta.main) {
  main().catch((e) => {
    // biome-ignore lint/suspicious/noConsole: fatal-path operator output.
    console.error(`[matrix] fatal: ${(e as Error).message}`)
    process.exit(1)
  })
}
