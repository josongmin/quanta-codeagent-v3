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
  maxTurns: number
  timeoutMs: number
  pythonGrade: boolean
}

export const parseArgs = (argv: readonly string[]): MatrixArgs => {
  const dataset = argValue(argv, "--dataset")
  if (dataset === undefined || dataset === "") {
    throw new Error("missing required --dataset <file>")
  }
  const corpus = argValue(argv, "--corpus")
  if (corpus === undefined || corpus === "") {
    throw new Error("missing required --corpus <dir>")
  }
  const out = argValue(argv, "--out")
  if (out === undefined || out === "") {
    throw new Error("missing required --out <dir>")
  }
  const model = argValue(argv, "--model") ?? "gpt-5"
  const conditions = parseConditions(argValue(argv, "--conditions"))
  const maxTurns = argPositiveInt(argv, "--max-turns", 30)
  const timeoutMs = argPositiveInt(argv, "--timeout-ms", 600_000)
  const pythonGrade = argFlag(argv, "--python-grade")
  return {
    dataset: resolve(dataset),
    corpus: resolve(corpus),
    model,
    out: resolve(out),
    conditions,
    maxTurns,
    timeoutMs,
    pythonGrade,
  }
}

const conditionLabel = (c: Condition): string => c.replace(/\+/g, "_")

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

const parseArgsOrExit = (): MatrixArgs => {
  try {
    return parseArgs(process.argv.slice(2))
  } catch (e) {
    log(`error: ${(e as Error).message}`)
    log(
      "usage: bun run tools/swebench-matrix.ts --dataset <file> --corpus <dir> --out <dir> [--model gpt-5] [--conditions baseline,lsp,...] [--max-turns 30] [--timeout-ms 600000] [--python-grade]",
    )
    process.exit(1)
  }
}

const main = async (): Promise<void> => {
  const args = parseArgsOrExit()
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

// Only run main() when executed as a script — keep imports side-effect-free
// for tests. `import.meta.main` is set by Bun for the entrypoint module.
if (import.meta.main) {
  main().catch((e) => {
    // biome-ignore lint/suspicious/noConsole: fatal-path operator output.
    console.error(`[matrix] fatal: ${(e as Error).message}`)
    process.exit(1)
  })
}
