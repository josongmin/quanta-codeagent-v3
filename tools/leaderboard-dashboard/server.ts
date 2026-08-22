#!/usr/bin/env bun
/**
 * Leaderboard Dashboard — a tiny live web view of SWE-bench progress.
 *
 *   bun run tools/leaderboard-dashboard/server.ts [--port 7878]
 *
 * It re-parses the *evidence on every request* (no DB, no cache) so the page
 * reflects new report.json files the instant they land:
 *   - Our runs:        every `*.report.json` under the configured roots
 *                      (perInstance pass/fail, grouped by file label).
 *   - Competitors:     the frontier matrix in
 *                      `rawdata/scaffold-solving-summary.md`
 *                      (134 public SWE-bench Verified submissions, per-instance;
 *                      upstream results.json vendored under rawdata/experiments-verified/).
 *   - Live boxes:      any `*.log` under the configured live dirs (best-effort
 *                      progress: which instance, how many lines).
 *
 * The browser polls `/api/data` every few seconds and re-renders.
 *
 * BFND-03: this file is the page SHELL. It knows about benchmark suites only
 * through `./projectors` — the registry decides which view a report belongs to,
 * which campaign it may coalesce with, and what client code renders it. There is
 * deliberately no suite name in here.
 */
import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { ActionError } from "./bench-actions"
import { BenchControl } from "./bench-control"
import { iidFromBody, launchSpecFromBody, presetsFromCatalog } from "./bench-request"
import type { ExternalBaselines } from "./external-baselines"
import { campaignKeyOf } from "./family-partition"
import { renderDashboardPage } from "./page"
import {
  benchmarkViewsOf,
  projectReport,
  quarantinedArtifacts,
  recordQuarantine,
  suiteData,
} from "./projectors/registry"
import { swePresetLabel } from "./projectors/swe-bench/preset-label"
import type { ProjectedInstanceRow } from "./projectors/types"
import type { FailInfo, InstanceRowBase, Run, RunBase, SweInstanceRow } from "./run-types"

const HOME = homedir()
const REPO = join(import.meta.dir, "..", "..")
const PORT = Number(argOf("--port") ?? 7878)
// SECURITY (RFC jun-29): the console has endpoints that spawn EC2 boxes ($), terminate them,
// and serve run logs that carry the grade's creds-bearing stdout. Bind LOOPBACK by default so
// the network can't reach the console; an operator who wants remote VIEWING of the legacy
// report tabs opts in with QUANTA_DASH_HOST=0.0.0.0 — and even then the ENTIRE bench console
// (mutating AND its log/box-id reads) is gated to loopback clients (see routeBench).
// ⚠️ The loopback gate trusts the SOCKET PEER. Do NOT put this behind a reverse proxy (nginx/
// caddy) on 0.0.0.0 — every proxied request's peer becomes 127.0.0.1 and the gate opens to all.
const DASH_HOST = process.env.QUANTA_DASH_HOST ?? "127.0.0.1"
// The live OTEL trace waterfall (otel-trace-sink) is shown as a tab here via an
// iframe. By default the dashboard auto-spawns the sink as a child so ONE command
// brings up BOTH surfaces; `--no-trace` opts out, `--trace-port N` overrides.
const TRACE_PORT = Number(argOf("--trace-port") ?? 4318)
const NO_TRACE = process.argv.includes("--no-trace")

// Where to look for our run reports + the competitor matrix + live logs.
// Extra roots can be added on the CLI: `--reports /some/dir --reports /other`.
const REPORT_ROOTS = [
  ...argsOf("--reports"),
  // Canonical SSOT sink — every bench report (local batch + full-remote per-box
  // sidecars) mirrors here via mirrorReportToSsot, so a graded instance shows up
  // live the moment its box fetches the report. Keep first so it always wins.
  process.env.QUANTA_BENCH_RESULTS_DIR && process.env.QUANTA_BENCH_RESULTS_DIR !== "off"
    ? process.env.QUANTA_BENCH_RESULTS_DIR
    : join(HOME, ".quanta", "bench", "results"),
  join(HOME, "reprovote-ab"),
  join(HOME, "easy-more"),
  // The big trove: full-remote per-instance sidecars + work/runs reports.
  join(HOME, "Library", "quanta-codeagent-v3", "bench"),
  join(HOME, "Library", "quanta-codeagent-v3", "bench-slices"),
]
// Raw source data lives under the bench tool: tools/leaderboard-dashboard/rawdata/.
const RAWDATA = join(import.meta.dir, "rawdata")
const MATRIX_MD = argOf("--matrix") ?? join(RAWDATA, "scaffold-solving-summary.md")
// SWE-bench Verified dataset (500) → problem statement + official difficulty.
const DATASET_JSONL = argOf("--dataset") ?? join(RAWDATA, "verified-full.jsonl")
const LIVE_ROOTS = [...argsOf("--live"), join(HOME, "easy-more")]
// Competitor (frontier-winning) full trajectories — the only ones still on
// disk. The broad per-submission turn data lived in a swe-bench/experiments
// clone that's gone; only the parsed ✅/· matrix md survived.
const FRONTIER_TRAJ_DIR =
  argOf("--frontier-trajs") ??
  join(HOME, "Library", "quanta-codeagent-v3", "frontier-winning", "trajs")

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function argsOf(flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < process.argv.length; i++)
    if (process.argv[i] === flag) {
      const value = process.argv[i + 1]
      if (value) out.push(value)
    }
  return out
}

const shortId = (full: string): string => {
  if (!full) return ""
  if (!full.includes("__")) return full
  return full.split("__")[1] ?? ""
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null ? (value as JsonRecord) : null

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null)

// ---------------------------------------------------------------------------
// Evidence parsers (run fresh on every /api/data request)
// ---------------------------------------------------------------------------

type Cell = boolean
interface MatrixRow {
  id: string
  repo: string
  cells: Record<string, Cell>
  hash: number // how many of the 134 public submissions solved it
  tier: string // E / M / H / × (easy / medium / hard / ceiling)
}
interface MatrixData {
  scaffolds: string[]
  rows: Record<string, MatrixRow>
  topScaffolds: { key: string; model: string; resolved: number; pct: number }[]
  source: string
}

const emptyMatrixData = (): MatrixData => ({
  scaffolds: [],
  rows: {},
  topScaffolds: [],
  source: MATRIX_MD,
})

const updateTopSection = (line: string, inTop: boolean): boolean => {
  if (line.startsWith("## 2.")) return true
  if (line.startsWith("## 3.")) return false
  return inTop
}

const topScaffoldOf = (line: string): MatrixData["topScaffolds"][number] | undefined => {
  const match = line.match(
    /^\|\s*([^|(]+?)\s*\(`([^`]+)`\)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([\d.]+)/,
  )
  if (match === null) return undefined
  const [, , key, model, resolved, pct] = match
  if (key === undefined || model === undefined || resolved === undefined || pct === undefined)
    return undefined
  return {
    key: key.trim(),
    model: model.trim(),
    resolved: Number(resolved),
    pct: Number(pct),
  }
}

const tableCellsOf = (line: string): string[] | undefined => {
  if (!line.startsWith("|")) return undefined
  const cols = line.split("|").map((segment) => segment.trim())
  return cols.slice(1, cols.length - 1)
}

const matrixHeaderOf = (cells: readonly string[]): string[] | undefined =>
  cells[0] === "instance" ? [...cells] : undefined

const matrixRowOf = (
  cells: readonly string[],
  scaffolds: readonly string[],
): MatrixRow | undefined => {
  const firstCell = cells[0]
  if (firstCell === undefined || /^-+$|^:-/.test(firstCell)) return undefined
  const id = firstCell
    .replace(/`/g, "")
    .replace(/^[★*\s]+/, "")
    .trim()
  if (!/^[a-z][a-z0-9-]*-\d+$/.test(id)) return undefined
  const cellMap: Record<string, Cell> = {}
  scaffolds.forEach((scaffold, index) => {
    cellMap[scaffold] = cells[1 + index] === "✅"
  })
  return {
    id,
    repo: id.replace(/-\d+$/, ""),
    cells: cellMap,
    hash: Number(cells[cells.length - 2]) || 0,
    tier: cells[cells.length - 1] || "?",
  }
}

function parseMatrix(): MatrixData {
  const empty = emptyMatrixData()
  if (!existsSync(MATRIX_MD)) return empty
  const lines = readFileSync(MATRIX_MD, "utf8").split("\n")
  let header: string[] | null = null
  const rows: Record<string, MatrixRow> = {}
  let scaffolds: string[] = []
  const topScaffolds: MatrixData["topScaffolds"] = []
  let inTop = false

  for (const line of lines) {
    inTop = updateTopSection(line, inTop)
    if (inTop) {
      const topScaffold = topScaffoldOf(line)
      if (topScaffold !== undefined) topScaffolds.push(topScaffold)
    }
    const cells = tableCellsOf(line)
    if (cells === undefined) continue
    const parsedHeader = matrixHeaderOf(cells)
    if (parsedHeader !== undefined) {
      header = parsedHeader
      scaffolds = parsedHeader.slice(1, parsedHeader.length - 2)
      continue
    }
    if (header === null) continue
    const row = matrixRowOf(cells, scaffolds)
    if (row !== undefined) rows[row.id] = row
  }
  return { scaffolds, rows, topScaffolds, source: MATRIX_MD }
}

// A failing instance is unmeasured (re-runnable) iff its classified failure says
// so. Passing instances are always measured. Used for both run-level and
// campaign-level denominators so the two stay consistent.
//
// TB21-05 removed the agent-CRASH clause that used to sit beside it. It encoded
// D1 (RFC jul-3) — "an agent crash is a re-runnable hole, not a miss" — but
// TB21-04 REVERSED that for Terminal: an errored trial earns no reward, so it
// scores zero and stays in the official denominator. Keeping the exclusion here
// made the dashboard's rollup silently disagree with the scorer that produced the
// artifact. A suite whose rows are its own (see `ProjectedRun.rows`) therefore
// supplies rows with no re-runnable channel at all, and this predicate is once
// again exactly the SWE rule it is named after.
const instanceIsUnmeasured = (pi: { passed: boolean; fail?: FailInfo | null }): boolean =>
  !pi.passed && pi.fail?.reRunnable === true

// Canonical re-runnable terminations — byte-identical to verdicts.ts's
// RE_RUNNABLE_TERMINATIONS. throttle(429/usage-limit), harness/runner infra,
// grader output failures. timeout / hung_stream / generation_error /
// admission_blocked / empty_patch are deliberately NOT here: they are GENUINE
// misses that stay in the denominator.
const RE_RUNNABLE_TERMINATIONS = new Set(["throttled", "harness_error", "grader_invalid"])

// Decide whether a failing instance is an unmeasured re-runnable hole.
// Source-of-truth is the RAW termination string + env/infra-blocked flags on
// the per-instance row (same signals verdicts.ts uses), NOT the fuzzy `klass`
// label — `admission_blocked` and `infra_blocked` BOTH render as 게이트차단 via
// classifyFail's /blocked/ regex, but only `infra_blocked` is re-runnable, so
// we must not key off klass. A graded miss (f2p/p2p > 0) is never re-runnable:
// the grader ran and the patch was wrong / regressed.
function isReRunnableHole(row: JsonRecord | null, term: string, f2p: number, p2p: number): boolean {
  if (f2p > 0 || p2p > 0) return false
  if (RE_RUNNABLE_TERMINATIONS.has(term)) return true
  if (row?.envPrepFailed === true) return true
  if (row?.proofState === "infra_blocked") return true
  return false
}

// Turn the raw grade/termination signals into a one-line failure reason.
function classifyFail(pi: unknown): FailInfo | null {
  const row = asRecord(pi)
  if (row?.passed === true) return null
  const gb = asRecord(row?.gradeBreakdown) ?? {}
  const failure = asRecord(row?.failure)
  const budget = asRecord(row?.budget)
  const attemptOutcomes = Array.isArray(budget?.attemptOutcomes) ? budget.attemptOutcomes : []
  const lastOutcome = asRecord(attemptOutcomes.at(-1))
  const term = asString(failure?.termination) ?? asString(lastOutcome?.subkind) ?? "unknown"
  const f2p = Number(gb.failToPassFailed) || 0
  const p2p = Number(gb.passToPassFailed) || 0
  let klass: string
  if (p2p > 0)
    klass = "기존테스트깸" // patch broke PASS_TO_PASS (regression)
  else if (f2p > 0)
    klass = "패치햇는데틀림" // patch graded but FAIL_TO_PASS still red — wrong fix
  else if (/timeout/i.test(term)) klass = "타임아웃"
  else if (/admission|blocked|gate/i.test(term))
    klass = "게이트차단" // admission gate blocked the patch before grading
  else if (/error|harness|exec/i.test(term))
    klass = "채점/실행에러" // infra error, not a model miss
  else if (/no_patch|empty|no_repro|no_diff/i.test(term))
    klass = "패치생성실패" // model produced no usable patch
  else klass = "미제출(불명)" // completed without a graded patch, no clear signal
  const reproTest = asRecord(row?.reproTest)
  return {
    termination: term,
    klass,
    repro: asString(reproTest?.reason) ?? "",
    f2p,
    p2p,
    reRunnable: isReRunnableHole(row, term, f2p, p2p),
  }
}

// Dirs that are source checkouts / caches — never hold our reports but contain
// thousands of files. Pruning them keeps the scan from exploding.
const PRUNE_DIR =
  /^(repo|repo-.*|swebench-.*|node_modules|__pycache__|\.git|venv|\.venv|site-packages)$/

function walkReports(root: string, acc: string[], depth = 0) {
  if (depth > 3 || !existsSync(root)) return
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.startsWith(".") || PRUNE_DIR.test(e)) continue
    const p = join(root, e)
    let st: Stats
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walkReports(p, acc, depth + 1)
    // `*.report.json` (campaign reports), `report-i-*.json`/`report.json`
    // (full-remote per-instance sidecars). Exclude `closure-*`/`summary.json`
    // (different schema — filtered again at parse time by perInstance check).
    else if (e.endsWith(".report.json") || /^report.*\.json$/.test(e)) acc.push(p)
  }
}

// Per-file parse memo keyed on (path, mtimeMs). The directory walk + statSync
// still run on every call (so added / removed / EDITED files are always seen —
// a content edit bumps mtimeMs, which is the cache key, forcing a re-parse), but
// the expensive readFileSync + JSON.parse + Run construction is skipped for
// reports whose mtime hasn't moved since the last poll. Same shape as the
// dataset / frontier caches above, but invalidating instead of permanent.
const RUN_PARSE_CACHE = new Map<string, { mtime: number; run: Run | null }>()

function parseReportFile(f: string, mtime: number): Run | null {
  // mtime === 0 means statSync failed; never trust an unknowable key — parse
  // fresh and don't poison the cache (matches the prior always-reparse behavior).
  if (mtime === 0) return buildRunFromFile(f, 0)
  const hit = RUN_PARSE_CACHE.get(f)
  if (hit && hit.mtime === mtime) return hit.run
  const run = buildRunFromFile(f, mtime)
  RUN_PARSE_CACHE.set(f, { mtime, run })
  return run
}

const rowBaseOf = (row: JsonRecord | null): InstanceRowBase => ({
  id: asString(row?.id) ?? "",
  passed: row?.passed === true,
  turns: Number(row?.turns) || 0,
  durationMs: Number(row?.durationMs) || 0,
})

/** MED-D — SWE rows keep the grading dispositions and NOTHING from the Terminal
 *  vocabulary (the SWE branch persists `error` as free text, never as `{kind}`). */
const sweRowsOf = (rows: readonly unknown[]): SweInstanceRow[] =>
  rows.map((pi) => {
    const row = asRecord(pi)
    return {
      ...rowBaseOf(row),
      fail: classifyFail(pi),
      // Only the explicit boolean is meaningful — absent stays absent (not checked).
      ...(typeof row?.goldResolved === "boolean" ? { goldResolved: row.goldResolved } : {}),
    }
  })

/**
 * Run-level tally, shared by both suites.
 *
 * FLAG-B: drop re-runnable measurement-holes (throttle/infra/env) from the
 * denominator so a throttled run isn't reported with a deflated solve-rate.
 * BFND-03: when the artifact PERSISTS official-shaped metrics (Terminal), the
 * dashboard formats them; otherwise it keeps counting rows exactly as before.
 */
const tallyOf = (
  rows: readonly (SweInstanceRow | ProjectedInstanceRow)[],
  headline: { resolved: number; total: number } | undefined,
): Pick<RunBase, "resolved" | "total" | "unmeasured"> => {
  const unmeasured = rows.filter(instanceIsUnmeasured).length
  return {
    resolved: headline?.resolved ?? rows.filter((r) => r.passed).length,
    total: headline?.total ?? rows.length - unmeasured,
    unmeasured,
  }
}

function buildRunFromFile(f: string, mtime: number): Run | null {
  let report: JsonRecord | null
  try {
    report = asRecord(JSON.parse(readFileSync(f, "utf8")))
  } catch {
    return null
  }
  if (report === null) return null
  // BFND-03: THE dispatch. An artifact whose identity cannot be established is
  // dropped rather than guessed at — a mixed report root never poisons a view.
  // TB21-05: the refusal is RECORDED, so a suite view can show that the file
  // exists and was refused instead of silently rendering a shorter list.
  let projected: ReturnType<typeof projectReport>
  try {
    projected = projectReport(report)
  } catch (error) {
    if (Array.isArray(report.perInstance) || Object.hasOwn(report, "trials")) {
      recordQuarantine(f, report, error)
    }
    return null
  }
  const base: Omit<RunBase, "resolved" | "total" | "unmeasured"> = {
    label: basename(f).replace(/\.report\.json$/, ""),
    file: f,
    model: asString(report.model) ?? "?",
    // A suite may label its own presets; otherwise the SWE fingerprint chain runs.
    preset: projected.presetLabel ?? swePresetLabel(f, asRecord(report.knobs)),
    viewId: projected.viewId,
    campaignIdentity: projected.campaignIdentity,
    benchmarkSuite: projected.benchmarkSuite,
    // P1-C (RFC jul-3): explicit A/B arm; typeof-narrowed like goldResolved so exactOptional is happy.
    ...(typeof report.arm === "string" ? { arm: report.arm } : {}),
    mtime,
  }
  // TB21-05: a suite whose artifact carries its OWN per-instance channel ships
  // the rows already shaped (Terminal's lossless `trials` is not `perInstance`,
  // so the shell could not read it even if it wanted to). The shell only carries
  // them plus the suite's own per-run payload.
  if (projected.rows !== undefined) {
    return {
      ...base,
      ...tallyOf(projected.rows, projected.headline),
      instanceRowKind: "trial-receipt",
      perInstance: projected.rows,
      ...(projected.runPayload !== undefined ? { suiteView: projected.runPayload } : {}),
    }
  }
  if (!Array.isArray(report.perInstance)) return null
  const perInstance = sweRowsOf(report.perInstance)
  return {
    ...base,
    ...tallyOf(perInstance, projected.headline),
    instanceRowKind: "swe-grade",
    ...(projected.datasetFamily !== undefined ? { datasetFamily: projected.datasetFamily } : {}),
    // PMX-05: the artifact's persisted official-grade result, carried verbatim.
    ...(projected.officialGrade !== undefined ? { officialGrade: projected.officialGrade } : {}),
    perInstance,
  }
}

function parseRuns(): Run[] {
  const files: string[] = []
  for (const root of REPORT_ROOTS) walkReports(root, files)
  const seen = new Set<string>()
  const runs: Run[] = []
  for (const f of files) {
    if (seen.has(f)) continue
    seen.add(f)
    let mtime = 0
    try {
      mtime = statSync(f).mtimeMs
    } catch {}
    const run = parseReportFile(f, mtime)
    if (run !== null) runs.push(run)
  }
  runs.sort((a, b) => b.mtime - a.mtime)
  return runs
}

interface LiveBox {
  dir: string
  log: string
  lines: number
  lastInstance: string
  mtime: number
  tail: string
}

const readLiveLog = (dir: string, log: string, file: string): LiveBox | undefined => {
  let text = ""
  let mtime = 0
  try {
    text = readFileSync(file, "utf8")
    mtime = statSync(file).mtimeMs
  } catch {
    return undefined
  }
  if (Date.now() - mtime > 6 * 3600_000) return undefined
  const lines = text.split("\n").filter(Boolean)
  const instances = text.match(/bench-[a-zA-Z0-9_]+__[a-zA-Z0-9_.-]+/g) || []
  return {
    dir,
    log,
    lines: lines.length,
    lastInstance: instances.at(-1) ?? "",
    mtime,
    tail: lines.slice(-3).join("\n"),
  }
}

const liveBoxesFromDir = (root: string, entry: string): LiveBox[] => {
  const dir = join(root, entry)
  let stats: Stats
  try {
    stats = statSync(dir)
  } catch {
    return []
  }
  if (!stats.isDirectory()) return []
  let logs: string[]
  try {
    logs = readdirSync(dir).filter((value) => value.endsWith(".log"))
  } catch {
    return []
  }
  const boxes: LiveBox[] = []
  for (const log of logs) {
    const box = readLiveLog(entry, log, join(dir, log))
    if (box !== undefined) boxes.push(box)
  }
  return boxes
}

const liveBoxesFromRoot = (root: string): LiveBox[] => {
  if (!existsSync(root)) return []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries.flatMap((entry) => liveBoxesFromDir(root, entry))
}

function parseLive() {
  const boxes = LIVE_ROOTS.flatMap((root) => liveBoxesFromRoot(root))
  boxes.sort((a, b) => b.mtime - a.mtime)
  return boxes
}

// SWE-bench Verified dataset → short-id → full record (difficulty, problem
// text, GOLD patch = the oracle, test patch, repo/commit for a GitHub link).
interface DatasetRow {
  difficulty: string
  statement: string
  patch: string
  testPatch: string
  repo: string
  baseCommit: string
  instanceId: string
}
let DATASET_CACHE: Record<string, DatasetRow> | null = null

const datasetEntryOf = (line: string): { key: string; row: DatasetRow } | undefined => {
  if (!line.trim()) return undefined
  try {
    const parsed = asRecord(JSON.parse(line))
    if (parsed === null) return undefined
    const instanceId = asString(parsed.instance_id) ?? ""
    const key = shortId(instanceId)
    if (key === "") return undefined
    return {
      key,
      row: {
        difficulty: asString(parsed.difficulty) ?? "?",
        statement: asString(parsed.problem_statement) ?? "",
        patch: asString(parsed.patch) ?? "",
        testPatch: asString(parsed.test_patch) ?? "",
        repo: asString(parsed.repo) ?? "",
        baseCommit: asString(parsed.base_commit) ?? "",
        instanceId,
      },
    }
  } catch {
    return undefined
  }
}

function loadDataset(): Record<string, DatasetRow> {
  if (DATASET_CACHE) return DATASET_CACHE
  const map: Record<string, DatasetRow> = {}
  if (existsSync(DATASET_JSONL)) {
    for (const line of readFileSync(DATASET_JSONL, "utf8").split("\n")) {
      const entry = datasetEntryOf(line)
      if (entry !== undefined) map[entry.key] = entry.row
    }
  }
  DATASET_CACHE = map
  return map
}

// Competitor frontier trajectories → short-id → turn count (tool-call rounds,
// counted from `<function_results>` blocks) + path. Only the 4 recovered
// targets exist on disk.
let FRONTIER_CACHE: Record<string, { turns: number; file: string }> | null = null
function loadFrontierTrajs() {
  if (FRONTIER_CACHE) return FRONTIER_CACHE
  const map: Record<string, { turns: number; file: string }> = {}
  if (existsSync(FRONTIER_TRAJ_DIR)) {
    for (const f of readdirSync(FRONTIER_TRAJ_DIR)) {
      if (!f.endsWith(".txt")) continue
      const p = join(FRONTIER_TRAJ_DIR, f)
      try {
        const txt = readFileSync(p, "utf8")
        const turns = (txt.match(/<function_results>/g) || []).length
        const key = shortId(f.replace(/\.txt$/, ""))
        if (key !== "") map[key] = { turns, file: p }
      } catch {}
    }
  }
  FRONTIER_CACHE = map
  return map
}

interface Campaign {
  key: string
  members: string[] // file labels that rolled up into this campaign
  model: string
  preset: string
  /** Dataset family (RFC jun-29 R4) — the SWE axis only. Lets the UI chip/filter
   *  by dataset so a pro resolved-rate is never shown beside (or averaged into)
   *  the verified leaderboard number. Absent on family-less suites. */
  datasetFamily?: string
  /** Top-level view tab this campaign belongs to (see Run.viewId). */
  viewId: string
  mtime: number
  resolved: number
  // Denominator EXCLUDING re-runnable holes (FLAG-B). An instance counts as
  // unmeasured only if EVERY run failed to measure it (a measured/passing run
  // anywhere wins), mirroring verdicts.ts dedup semantics.
  total: number
  unmeasured: number
}

// Per-instance rollup state inside one campaign. passed wins over everything;
// among non-passing, a measured failure (real miss) wins over an unmeasured
// hole — so an instance only counts as unmeasured when no run ever measured it.
interface SeenInstance {
  passed: boolean
  measured: boolean // at least one run produced a graded/real outcome (not a hole)
}

// campaignKeyOf moved to ./family-partition (testable — server.ts calls Bun.serve at
// import, so a unit test cannot import it). RFC jun-29 R4 partition lives there.

const addRunToCampaign = (
  groups: Map<string, Campaign & { seen: Map<string, SeenInstance> }>,
  run: Run,
): void => {
  const key = campaignKeyOf(run)
  let group = groups.get(key)
  if (!group) {
    group = {
      key,
      members: [],
      model: run.model,
      preset: run.preset,
      ...(run.datasetFamily !== undefined ? { datasetFamily: run.datasetFamily } : {}),
      viewId: run.viewId,
      mtime: 0,
      resolved: 0,
      total: 0,
      unmeasured: 0,
      seen: new Map(),
    }
    groups.set(key, group)
  }
  group.members.push(run.label)
  group.mtime = Math.max(group.mtime, run.mtime)
  for (const perInstance of run.perInstance) {
    const sid = shortId(perInstance.id)
    if (!sid) continue
    const prev = group.seen.get(sid)
    const measured = perInstance.passed || !instanceIsUnmeasured(perInstance)
    group.seen.set(sid, {
      passed: (prev?.passed ?? false) || perInstance.passed,
      measured: (prev?.measured ?? false) || measured,
    })
  }
}

// Roll many report files into logical campaigns:
//   - shards (`clean-shard3`)         → one run (SOTA-clean = 16/36)
//   - full-remote `report-i-*` sidecars → one campaign per (dir, model)
//   - `local-*` single targets         → one bucket
// resolved/total dedupe by instance (union) so overlapping sidecars don't
// double-count.
function groupRuns(runs: Run[]): Campaign[] {
  const groups = new Map<string, Campaign & { seen: Map<string, SeenInstance> }>()
  for (const run of runs) addRunToCampaign(groups, run)
  const out: Campaign[] = []
  for (const group of groups.values()) {
    const seen = [...group.seen.values()]
    // FLAG-B: unmeasured = instances NO run ever measured (all-throttle/infra).
    // They leave the denominator; surfaced separately as `unmeasured`.
    const unmeasured = seen.filter((s) => !s.passed && !s.measured).length
    group.total = group.seen.size - unmeasured
    group.unmeasured = unmeasured
    group.resolved = seen.filter((s) => s.passed).length
    out.push({
      key: group.key,
      members: group.members,
      model: group.model,
      preset: group.preset,
      mtime: group.mtime,
      resolved: group.resolved,
      total: group.total,
      unmeasured: group.unmeasured,
      ...(group.datasetFamily !== undefined ? { datasetFamily: group.datasetFamily } : {}),
      viewId: group.viewId,
    })
  }
  // Rank on the REAL solve-rate (resolved / measured-total), so throttle noise
  // can no longer reorder the leaderboard. Ties broken by larger measured set.
  return out.sort(
    (a, b) =>
      b.resolved / Math.max(1, b.total) - a.resolved / Math.max(1, a.total) || b.total - a.total,
  )
}

interface QuantaSummary {
  passed: boolean
  attempts: number
  passes: number
  bestTurns: number | null
  // Wall-clock (ms) of the winning run — the same run that set bestTurns, so the
  // profile column can show "how long it took" beside "which profile solved it".
  passDurationMs: number | null
  // Report mtime (epoch ms) of the winning run = WHEN it was solved.
  passMtime: number | null
  failTurns: number | null
  models: string[]
  presets: string[]
  passPreset: string | null
  passModel: string | null
  passedBy: string[]
  fail: FailInfo | null
  failMtime: number
  // SOLVABILITY rollup (RFC jun-29). goldResolved === false on ANY run ⇒ the
  // instance's verifier was broken / gold failed: a miss here is NOT a model miss,
  // so the matrix flags it "⚠ verifier-broken (excluded)". A true anywhere clears
  // the flag (a sound verifier somewhere wins). undefined throughout ⇒ not checked.
  goldBroken: boolean
}

const datasetPreviewOf = (
  dataset: Record<string, DatasetRow>,
): Record<string, { difficulty: string; statement: string }> => {
  const preview: Record<string, { difficulty: string; statement: string }> = {}
  for (const [id, row] of Object.entries(dataset)) {
    preview[id] = { difficulty: row.difficulty, statement: row.statement.slice(0, 400) }
  }
  return preview
}

const isRealSwebenchInstanceId = (id: string): boolean => /^[a-z][a-z0-9-]*-\d+$/.test(id)

const createQuantaSummary = (): QuantaSummary => ({
  passed: false,
  attempts: 0,
  passes: 0,
  bestTurns: null,
  passDurationMs: null,
  passMtime: null,
  failTurns: null,
  models: [],
  presets: [],
  passPreset: null,
  passModel: null,
  passedBy: [],
  fail: null,
  failMtime: 0,
  goldBroken: false,
})

const ensureQuantaSummary = (quanta: Record<string, QuantaSummary>, id: string): QuantaSummary => {
  quanta[id] ??= createQuantaSummary()
  return quanta[id]
}

const addRunMetadata = (summary: QuantaSummary, run: Run): void => {
  summary.attempts++
  if (!summary.models.includes(run.model)) summary.models.push(run.model)
  if (run.preset && !summary.presets.includes(run.preset)) summary.presets.push(run.preset)
}

const recordPassingAttempt = (
  summary: QuantaSummary,
  run: Run,
  turns: number,
  durationMs: number,
): void => {
  summary.passed = true
  summary.passes++
  summary.passedBy.push(run.label)
  if (turns > 0 && (summary.bestTurns === null || turns < summary.bestTurns)) {
    summary.bestTurns = turns
    summary.passDurationMs = durationMs > 0 ? durationMs : null
    summary.passMtime = run.mtime > 0 ? run.mtime : null
    summary.passPreset = run.preset
    summary.passModel = run.model
  }
  if (!summary.passPreset) {
    summary.passPreset = run.preset
    summary.passModel = run.model
    if (summary.passDurationMs === null && durationMs > 0) summary.passDurationMs = durationMs
    if (summary.passMtime === null && run.mtime > 0) summary.passMtime = run.mtime
  }
}

const recordFailingAttempt = (
  summary: QuantaSummary,
  run: Run,
  turns: number,
  fail: FailInfo | null,
): void => {
  if (turns > 0 && (summary.failTurns === null || turns > summary.failTurns)) {
    summary.failTurns = turns
  }
  if (fail !== null && run.mtime >= summary.failMtime) {
    summary.fail = fail
    summary.failMtime = run.mtime
  }
}

const quantaSummaryOf = (runs: readonly Run[]): Record<string, QuantaSummary> => {
  const quanta: Record<string, QuantaSummary> = {}
  for (const run of runs) {
    // Another SUITE is a separate benchmark with its own task space and its own
    // render path. Foreign task names can accidentally match the SWE-bench
    // instance-id shape (e.g. `caffe-cifar-10` → `…-10`), so they MUST be excluded
    // from the SWE-bench quanta/matrix or they leak into the Verified leaderboard.
    if (run.instanceRowKind !== "swe-grade") continue
    for (const perInstance of run.perInstance) {
      const sid = shortId(perInstance.id)
      if (!sid || !isRealSwebenchInstanceId(sid)) continue
      const summary = ensureQuantaSummary(quanta, sid)
      addRunMetadata(summary, run)
      // gold === false anywhere ⇒ verifier broken (sticky); a later sound run can't
      // un-break it, but a passing instance is obviously solvable so we never set it.
      if (perInstance.goldResolved === false && !perInstance.passed) summary.goldBroken = true
      if (perInstance.passed)
        recordPassingAttempt(summary, run, perInstance.turns, perInstance.durationMs)
      else recordFailingAttempt(summary, run, perInstance.turns, perInstance.fail)
    }
  }
  return quanta
}

const coverageOf = (
  dataset: Record<string, { difficulty: string; statement: string }>,
  matrix: MatrixData,
  quanta: Record<string, QuantaSummary>,
  runs: readonly Run[],
) => ({
  datasetTotal: Object.keys(dataset).length,
  matrixRows: Object.keys(matrix.rows).length,
  quantaRan: Object.keys(quanta).length,
  quantaSolved: Object.values(quanta).filter((summary) => summary.passed).length,
  reportFiles: runs.length,
})

const frontierTurnsOf = (
  frontier: Record<string, { turns: number; file: string }>,
): Record<string, number> => {
  const turns: Record<string, number> = {}
  for (const [id, entry] of Object.entries(frontier)) turns[id] = entry.turns
  return turns
}

// External SOTA baselines (RFC jun-29). Generated by external-baselines.ts into
// external-baselines.json next to this file. Read fresh each request (re-running the
// generator reflects live, no restart). DEFENSIVE: the file may be absent / malformed —
// return null so the comparison feature degrades to "—" instead of crashing the page.
function loadExternalBaselines(): ExternalBaselines | null {
  const p = join(import.meta.dir, "external-baselines.json")
  if (!existsSync(p)) return null
  try {
    const parsed = asRecord(JSON.parse(readFileSync(p, "utf8")))
    if (parsed === null || !Array.isArray(parsed.models)) return null
    return {
      generatedFrom: asString(parsed.generatedFrom) ?? "",
      models: parsed.models as ExternalBaselines["models"],
      liveResolvedBy: asRecord(parsed.liveResolvedBy) ?? {},
    } as ExternalBaselines
  } catch {
    return null
  }
}

function buildData() {
  const matrix = parseMatrix()
  const fullDataset = loadDataset()
  const dataset = datasetPreviewOf(fullDataset)
  const runs = parseRuns()
  const campaigns = groupRuns(runs)
  const quanta = quantaSummaryOf(runs)
  const coverage = coverageOf(dataset, matrix, quanta, runs)
  const frontier = loadFrontierTrajs()
  return {
    generatedAt: new Date().toISOString(),
    matrixSource: matrix.source,
    scaffolds: matrix.scaffolds,
    topScaffolds: matrix.topScaffolds,
    rows: matrix.rows,
    dataset,
    frontierTurns: frontierTurnsOf(frontier),
    runs,
    campaigns,
    quanta,
    coverage,
    live: parseLive(),
    reportRoots: REPORT_ROOTS,
    // null when the file is absent/malformed → client renders no external column (—).
    externalBaselines: loadExternalBaselines(),
    // BFND-03 — the selectable benchmark tabs, owned by the projector registry.
    // Each carries its `suite`, which is what the client dispatches its render on.
    benchmarks: benchmarkViewsOf(runs.map((r) => r.viewId)),
    // TB21-05 — artifacts REFUSED at the identity boundary. They contribute no
    // run, no campaign and no score; a suite view renders the ones it claims as
    // a visible "refused, and here is why" diagnostic.
    quarantine: quarantinedArtifacts(),
    // Suite-owned payloads (e.g. a suite's public competitor matrix). Each
    // projector contributes its own keys; the shell never names them.
    ...suiteData({ rawdataDir: RAWDATA, argOf }),
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Knob/preset catalog — generated from source by gen-knob-catalog.ts. Read
// fresh each request so re-running the generator reflects live (no restart).
interface KnobCatalogPayload {
  readonly presets: Record<string, unknown>
  readonly knobs: Record<string, unknown>
  readonly presetOrder: readonly string[]
  readonly missing?: boolean
}

const EMPTY_KNOB_CATALOG: KnobCatalogPayload = {
  presets: {},
  knobs: {},
  presetOrder: [],
  missing: true,
}

function loadKnobCatalog(): KnobCatalogPayload {
  const p = join(import.meta.dir, "knob-catalog.json")
  if (!existsSync(p)) return EMPTY_KNOB_CATALOG
  try {
    const parsed = asRecord(JSON.parse(readFileSync(p, "utf8")))
    if (parsed === null) return EMPTY_KNOB_CATALOG
    return {
      presets: asRecord(parsed.presets) ?? {},
      knobs: asRecord(parsed.knobs) ?? {},
      presetOrder: Array.isArray(parsed.presetOrder)
        ? parsed.presetOrder.filter((value): value is string => typeof value === "string")
        : [],
      ...(parsed.missing === true ? { missing: true } : {}),
    }
  } catch {
    return EMPTY_KNOB_CATALOG
  }
}

const headerEntriesOf = (headers: ResponseInit["headers"]): [string, string][] => {
  if (headers === undefined) return []
  if (Array.isArray(headers)) {
    const entries: [string, string][] = []
    for (const entry of headers) {
      if (!Array.isArray(entry)) continue
      const [key, value] = entry
      if (typeof key !== "string" || typeof value !== "string") continue
      entries.push([key, value])
    }
    return entries
  }
  if (headers instanceof Headers) return [...headers.entries()]
  return Object.entries(headers).map(([key, value]): [string, string] => [key, value])
}

const jsonResponse = (body: unknown, init?: ResponseInit): Response => {
  const headers = Object.fromEntries(headerEntriesOf(init?.headers))
  if (!("content-type" in headers)) headers["content-type"] = "application/json"
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  })
}

const knobCatalogResponse = (): Response =>
  jsonResponse(loadKnobCatalog(), { headers: { "cache-control": "no-store" } })

// ---------------------------------------------------------------------------
// Benchmark MANAGEMENT console (RFC jun-29). The control plane (spawn registry,
// box queries, log tailing, argv validation) lives in BenchControl + bench-actions;
// the routes below are a THIN adapter — parse the request → call a control method →
// JSON. No spawning / validation / business logic here. Constructed ONCE (lazy).
let _benchControl: BenchControl | undefined
const benchControl = (): BenchControl => {
  if (_benchControl === undefined) {
    _benchControl = new BenchControl({
      repoDir: process.cwd(),
      runDir: join(tmpdir(), "bench-launches"),
      // Live preset allowlist = knob-catalog keys (read fresh so a regenerated
      // catalog reflects without restart); falls back to a built-in safe set.
      validPresets: () => presetsFromCatalog(loadKnobCatalog().presets),
    })
  }
  return _benchControl
}

/** Map an ActionError (bad input) → 400, anything else → 500. Thin adapter only. */
const benchError = (e: unknown): Response =>
  jsonResponse(
    { error: e instanceof Error ? e.message : String(e) },
    { status: e instanceof ActionError ? 400 : 500 },
  )

const launchResponse = async (req: Request): Promise<Response> => {
  try {
    const body = await req.json().catch(() => ({}))
    return jsonResponse(benchControl().launch(launchSpecFromBody(body)))
  } catch (e) {
    return benchError(e)
  }
}

const runningResponse = async (): Promise<Response> => {
  try {
    const launches = benchControl().listLaunches()
    // boxStatus hits AWS and may be slow/unavailable — never let it sink the view.
    const boxStatus = await benchControl()
      .boxStatus()
      .catch(() => ({}))
    return jsonResponse({ launches, boxStatus }, { headers: { "cache-control": "no-store" } })
  } catch (e) {
    return benchError(e) // mirror sibling handlers — never an unwrapped 500
  }
}

const launchLogResponse = (url: URL): Response => {
  const id = url.searchParams.get("id") || ""
  try {
    return new Response(benchControl().readLaunchLog(id), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    })
  } catch (e) {
    return benchError(e)
  }
}

const boxStopResponse = async (req: Request): Promise<Response> => {
  try {
    const body = await req.json().catch(() => ({}))
    return jsonResponse(await benchControl().stopBox(iidFromBody(body)))
  } catch (e) {
    return benchError(e)
  }
}

const boxesResponse = async (): Promise<Response> => {
  try {
    return jsonResponse(await benchControl().listBoxes(), {
      headers: { "cache-control": "no-store" },
    })
  } catch (e) {
    return benchError(e)
  }
}

const oracleResponse = (url: URL): Response => {
  const id = url.searchParams.get("id") || ""
  const row = loadDataset()[id]
  if (!row) return jsonResponse({ error: `no dataset row for ${id}` }, { status: 404 })
  const github =
    row.repo && row.baseCommit ? `https://github.com/${row.repo}/commit/${row.baseCommit}` : ""
  const frontier = loadFrontierTrajs()[id]
  let frontierTraj: { turns: number; text: string } | null = null
  if (frontier) {
    let text = ""
    try {
      text = readFileSync(frontier.file, "utf8").slice(0, 20000)
    } catch {}
    frontierTraj = { turns: frontier.turns, text }
  }
  return jsonResponse(
    {
      id,
      instanceId: row.instanceId,
      repo: row.repo,
      difficulty: row.difficulty,
      statement: row.statement,
      patch: row.patch,
      testPatch: row.testPatch,
      github,
      frontierTraj,
    },
    { headers: { "cache-control": "no-store" } },
  )
}

const dataResponse = (): Response => {
  try {
    return jsonResponse(buildData(), { headers: { "cache-control": "no-store" } })
  } catch (error: unknown) {
    return jsonResponse(
      { error: error instanceof Error ? (error.stack ?? error.message) : String(error) },
      { status: 500 },
    )
  }
}

const routeRequest = (url: URL): Response => {
  if (url.pathname === "/api/knobs") return knobCatalogResponse()
  if (url.pathname === "/api/oracle") return oracleResponse(url)
  if (url.pathname === "/api/data") return dataResponse()
  return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
}

// Benchmark-console routes (async: POST bodies + AWS-backed box queries). Each is a
// 3-liner thin adapter (parse → control method → JSON); returns undefined if the
// path isn't a bench route so the sync router handles the rest.
// ALL bench-console routes are operator-only and loopback-gated — NOT just the mutating ones.
// Round-3 audit: the READ routes leak privileged output too — launch logs carry the detached
// grade's stdout (the run inherits process.env incl. cloud creds + runs --allow-remote-secrets),
// and running/boxes enumerate live EC2 instance ids. So a non-loopback client must reach NONE of
// them. (The legacy report-view routes /api/data·/api/knobs·/api/oracle stay open — no secrets.)
const BENCH_ROUTES: ReadonlySet<string> = new Set([
  "/api/launch",
  "/api/running",
  "/api/launch-log",
  "/api/box/stop",
  "/api/boxes",
])

const routeBench = (
  req: Request,
  url: URL,
  fromLoopback: boolean,
): Promise<Response> | undefined => {
  if (!BENCH_ROUTES.has(url.pathname)) return undefined
  // Defense-in-depth: even if QUANTA_DASH_HOST exposes the dashboard to the network, the whole
  // bench console (spawn/terminate AND its secret-bearing logs/box-ids) is loopback-only.
  if (!fromLoopback) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "bench console is loopback-only" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    )
  }
  if (url.pathname === "/api/launch" && req.method === "POST") return launchResponse(req)
  if (url.pathname === "/api/running") return runningResponse()
  if (url.pathname === "/api/launch-log") return Promise.resolve(launchLogResponse(url))
  if (url.pathname === "/api/box/stop" && req.method === "POST") return boxStopResponse(req)
  if (url.pathname === "/api/boxes") return boxesResponse()
  return undefined
}

const isLoopbackAddr = (addr: string | undefined): boolean =>
  addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"

// When the dashboard is BOUND to loopback (the default), every connection is local by
// construction — so don't depend on requestIP (which can be undefined): treat all as loopback.
// Only when an operator opts into a non-loopback bind do we gate mutations on the client IP.
const BIND_IS_LOOPBACK = isLoopbackAddr(DASH_HOST) || DASH_HOST === "localhost"

const server = Bun.serve({
  port: PORT,
  hostname: DASH_HOST,
  fetch(req, srv) {
    const url = new URL(req.url)
    const fromLoopback = BIND_IS_LOOPBACK || isLoopbackAddr(srv.requestIP(req)?.address)
    return routeBench(req, url, fromLoopback) ?? routeRequest(url)
  },
})
// Auto-spawn the live-trace receiver (otel-trace-sink) so the "🔭 트레이스" tab's
// iframe has something to load — one command brings up BOTH surfaces. Best-effort:
// if the port is already serving (a sink the operator launched themselves), skip;
// if the spawn fails, the tab simply shows a "sink not running" note. Never blocks
// or crashes the dashboard.
const maybeSpawnTraceSink = async (): Promise<void> => {
  if (NO_TRACE) return
  const alreadyUp = await fetch(`http://127.0.0.1:${TRACE_PORT}/spans.json`, {
    signal: AbortSignal.timeout(400),
  })
    .then((r) => r.ok)
    .catch(() => false)
  if (alreadyUp) return
  try {
    Bun.spawn(["bun", join(REPO, "src", "apps", "bench", "otel-trace-sink.ts")], {
      env: { ...process.env, PORT: String(TRACE_PORT) },
      stdout: "ignore",
      stderr: "ignore",
    })
  } catch {
    // no bun on PATH / spawn denied — the tab falls back to its "not running" note.
  }
}
void maybeSpawnTraceSink()

process.stdout.write(
  `${[
    `leaderboard-dashboard → http://localhost:${server.port}`,
    `  live trace tab → :${TRACE_PORT}${NO_TRACE ? " (--no-trace: not auto-spawned)" : " (auto-spawned)"}`,
    `  reports roots: ${REPORT_ROOTS.join(", ")}`,
    `  matrix: ${MATRIX_MD}`,
  ].join("\n")}\n`,
)

const HTML = renderDashboardPage({ tracePort: TRACE_PORT })
