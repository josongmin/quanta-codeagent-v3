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
 * The browser polls `/api/data` every few seconds and re-renders. Nothing here
 * imports from the app — it runs standalone on plain Bun.
 */
import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { ActionError } from "./bench-actions"
import { BenchControl } from "./bench-control"
import { iidFromBody, launchSpecFromBody, presetsFromCatalog } from "./bench-request"
import type { ExternalBaselines } from "./external-baselines"
import { campaignKeyOf } from "./family-partition"
import { parseTbPertask, type TbPertask } from "./tb-pertask"

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
// Terminal-Bench per-task competitor matrix (RFC 06) — the TB analogue of the SWE
// scaffold matrix. Absent ⇒ TB view still shows our runs, just no competitor column.
const TB_PERTASK_MD = argOf("--tb-matrix") ?? join(RAWDATA, "tb-pertask.md")
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

interface Run {
  label: string
  file: string
  model: string
  preset: string
  /** Dataset family (RFC jun-29 R4) from report.datasetFamily. Absent in the
   *  report ⇒ "verified" (the legacy default), so verified runs are unchanged and
   *  pro/live runs partition into their own campaigns instead of being averaged
   *  into one bogus resolved-rate. */
  datasetFamily: string
  /** P1-C — explicit TB A/B arm (`baseline`/`levers`) from report.arm; absent on old reports. */
  arm?: string
  mtime: number
  resolved: number
  // Denominator EXCLUDING re-runnable measurement-holes (FLAG-B). A campaign
  // throttled on N instances no longer shows a deflated resolved/total %.
  total: number
  // Count of attempts dropped from `total` because they were unmeasured
  // (throttle / infra / env-degraded) — surfaced beside the ratio.
  unmeasured: number
  perInstance: {
    id: string
    passed: boolean
    turns: number
    durationMs: number
    fail: FailInfo | null
    // SOLVABILITY (RFC jun-29): did the GOLD patch pass the instance's verifier?
    //   true  = instance solvable + verifier sound (a fail here is a genuine model miss)
    //   false = gold FAILED / verifier broken → NOT a model miss, exclude from blame
    //   undefined = not checked
    goldResolved?: boolean
    // P1-C/D1 (RFC jul-3): a harbor INFRA fault (agent-timeout/crash), NOT a capability miss —
    // excluded from the TB miss denominator by tbOurResults.
    error?: { kind: string }
  }[]
}

// A failing instance is unmeasured (re-runnable) iff its classified failure says
// so. Passing instances are always measured. Used for both run-level and
// campaign-level denominators so the two stay consistent.
const instanceIsUnmeasured = (pi: { passed: boolean; fail: FailInfo | null }): boolean =>
  !pi.passed && pi.fail?.reRunnable === true

interface FailInfo {
  termination: string // completed_unresolved / error / timeout / …
  klass: string // 못고침 / regression(기존깨짐) / timeout / error / 미해결
  repro: string // reproTest.reason (no_reproduced_candidate / execution_failed / …)
  f2p: number // FAIL_TO_PASS still failing
  p2p: number // PASS_TO_PASS broken (regression signal)
  // Re-runnable measurement-hole (throttle / harness / grader-infra /
  // env-degraded) — EXCLUDED from the solve-rate denominator and from the
  // "real gap" card, mirroring src/apps/bench/analyze/verdicts.ts. NOT a
  // capability miss: re-running the instance can still resolve it.
  reRunnable: boolean
}

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

// The versioned preset (agentless-v2, v3-thin-strict, …) is a `--preset` CLI
// arg that is NOT persisted in report.json. We recover it from the file path
// (the ground truth of how the campaign was launched). A trailing `*` marks a
// label inferred from path/knobs rather than read from the data.
const presetFromEncodedFileName = (name: string): string | undefined => {
  if (/v3.?thin.*strict|strict/.test(name)) return "agentless-v3-thin-strict*"
  if (/v3.?thin|v3thin/.test(name)) return "agentless-v3-thin*"
  if (/norepair/.test(name)) return "agentless-v2 · norepair*"
  if (/reprovote/.test(name)) return "agentless-v2 · reprovote*"
  if (/v2.?repair|[-_]repair/.test(name)) return "agentless-v2 · repair*"
  if (/v2/.test(name)) return "agentless-v2*"
  if (/v1/.test(name)) return "agentless-v1*"
  if (/^local-/.test(name)) return "local"
  return undefined
}

const presetFromSidecar = (name: string, knobs: JsonRecord | null): string | undefined => {
  if (!/^report-i-/.test(name)) return undefined
  const preset = asString(knobs?.preset)
  return typeof preset === "string" && preset.trim()
    ? `${preset} · full-remote`
    : "full-remote · preset 미기록"
}

const presetFromFingerprint = (knobs: JsonRecord | null): string => {
  try {
    const resolved = asRecord(knobs?.resolved) ?? {}
    const issueHint = asRecord(resolved["issue-hint"])
    const reproVote = asRecord(resolved["repro-vote"])
    const bits = [
      asString(issueHint?.value),
      asString(reproVote?.display) ?? asString(reproVote?.value),
    ].filter((bit): bit is string => !!bit)
    return bits.length > 0 ? `${bits.join("/")}*` : "preset 미기록"
  } catch {
    return "preset 미기록"
  }
}

function presetLabel(file: string, knobs: JsonRecord | null): string {
  const name = basename(file).toLowerCase()
  const dir = basename(file.replace(/\/[^/]+$/, "")).toLowerCase()
  // Terminal-Bench (RFC 06): harbor-emitted reports carry the lever set verbatim in
  // knobs.preset — surface it directly instead of the SWE-oriented fingerprint fallback.
  if (/terminal-bench/.test(name)) {
    const p = asString(knobs?.preset)
    return p && p.trim() ? p : "terminal-bench"
  }
  const encoded = presetFromEncodedFileName(name)
  if (encoded !== undefined) return encoded
  if (dir === "sota" || /shard/.test(name)) return "agentless-v2 (SOTA)*"
  const sidecar = presetFromSidecar(name, knobs)
  if (sidecar !== undefined) return sidecar
  return presetFromFingerprint(knobs)
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

function buildRunFromFile(f: string, mtime: number): Run | null {
  let report: JsonRecord | null
  try {
    report = asRecord(JSON.parse(readFileSync(f, "utf8")))
  } catch {
    return null
  }
  if (report === null || !Array.isArray(report.perInstance)) return null
  const perInstance: Run["perInstance"] = report.perInstance.map((pi) => {
    const row = asRecord(pi)
    // D1: carry the infra-fault classification through so tbOurResults can exclude it.
    const errRec = asRecord(row?.error)
    const errKind = errRec !== null && typeof errRec.kind === "string" ? errRec.kind : undefined
    return {
      id: asString(row?.id) ?? "",
      passed: row?.passed === true,
      turns: Number(row?.turns) || 0,
      durationMs: Number(row?.durationMs) || 0,
      fail: classifyFail(pi),
      // Only the explicit boolean is meaningful — absent stays absent (not checked).
      ...(typeof row?.goldResolved === "boolean" ? { goldResolved: row.goldResolved } : {}),
      ...(errKind !== undefined ? { error: { kind: errKind } } : {}),
    }
  })
  const resolved = perInstance.filter((p: (typeof perInstance)[number]) => p.passed).length
  // FLAG-B: drop re-runnable measurement-holes (throttle/infra/env) from the
  // denominator so a throttled run isn't reported with a deflated solve-rate.
  const unmeasured = perInstance.filter(instanceIsUnmeasured).length
  return {
    label: basename(f).replace(/\.report\.json$/, ""),
    file: f,
    model: asString(report.model) ?? "?",
    preset: presetLabel(f, asRecord(report.knobs)),
    datasetFamily: asString(report.datasetFamily) ?? "verified",
    // P1-C (RFC jul-3): explicit A/B arm; typeof-narrowed like goldResolved so exactOptional is happy.
    ...(typeof report.arm === "string" ? { arm: report.arm } : {}),
    mtime,
    resolved,
    total: perInstance.length - unmeasured,
    unmeasured,
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
  /** Dataset family (RFC jun-29 R4) — "verified" | "pro" | "live". Lets the UI
   *  filter/group by dataset so a pro resolved-rate is never shown beside (or
   *  averaged into) the verified leaderboard number. */
  datasetFamily: string
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
      datasetFamily: run.datasetFamily,
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
      datasetFamily: group.datasetFamily,
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
    // Terminal-Bench (RFC 06) is a SEPARATE benchmark with its own task space + its
    // own render path (DATA.tb). Its task names can accidentally match the SWE-bench
    // instance-id shape (e.g. `caffe-cifar-10` → `…-10`), so they MUST be excluded
    // from the SWE-bench quanta/matrix or they leak into the Verified leaderboard.
    if ((run.datasetFamily || "verified") === "terminal-bench") continue
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

// TB competitor matrix — parsed fresh each request (small file); null-safe if absent.
function loadTbPertask(): TbPertask {
  try {
    if (!existsSync(TB_PERTASK_MD)) return { scaffolds: [], tasks: [] }
    return parseTbPertask(readFileSync(TB_PERTASK_MD, "utf8"))
  } catch {
    return { scaffolds: [], tasks: [] }
  }
}

// Benchmarks present in the dashboard: verified is always shown; any other family
// found in the runs (pro/live/terminal-bench) adds a selectable benchmark. This
// drives the client's top-level benchmark selector (RFC 06).
function benchmarksOf(runs: readonly Run[]): { id: string; label: string }[] {
  const LABELS: Record<string, string> = {
    verified: "SWE-bench Verified",
    pro: "SWE-bench Pro",
    live: "SWE-bench Live",
    "terminal-bench": "Terminal-Bench",
  }
  const fams = new Set<string>(["verified"])
  for (const r of runs) fams.add(r.datasetFamily || "verified")
  const order = ["verified", "pro", "live", "terminal-bench"]
  return [...fams]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((id) => ({ id, label: LABELS[id] ?? id }))
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
    // RFC 06 — TB benchmark: selectable benchmarks + TB per-task competitor matrix.
    benchmarks: benchmarksOf(runs),
    tb: loadTbPertask(),
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

const HTML = /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SWE-bench Leaderboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #c9d1d9; }
  header { padding: 14px 18px; border-bottom: 1px solid #21262d; display: flex;
           align-items: baseline; gap: 14px; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; color: #e6edf3; }
  .muted { color: #768390; }
  /* RFC jun-29 R4 dataset-family chips — pro/live are visually fenced off from verified. */
  .fam { display: inline-block; padding: 0 5px; border-radius: 4px; font-size: 10px;
         font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
         vertical-align: 1px; border: 1px solid transparent; }
  .fam-pro { background: #3a2d12; color: #e3b341; border-color: #5c4516; }
  .fam-live { background: #122a3a; color: #58a6ff; border-color: #1f4a6b; }
  .fam-terminal-bench { background: #13233a; color: #79c0ff; border-color: #1f6feb; }
  /* RFC 06 — top-level benchmark selector */
  .benchsel { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .benchsel button { background: #161b22; color: #adbac7; border: 1px solid #30363d;
    border-radius: 999px; padding: 6px 16px; cursor: pointer; font: inherit; font-size: 13px; }
  .benchsel button:hover { border-color: #388bfd; color: #e6edf3; }
  .benchsel button.active { background: #1f6feb; color: #fff; border-color: #2f81f7; font-weight: 600; }
  .benchsel button .bn { font-size: 10px; color: inherit; opacity: .75; margin-left: 6px; }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; padding: 12px 18px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px;
          padding: 10px 14px; min-width: 120px; }
  .card .n { font-size: 22px; color: #e6edf3; }
  .card .l { color: #768390; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  nav { display: flex; gap: 6px; padding: 0 18px; border-bottom: 1px solid #21262d; }
  nav button { background: none; border: none; color: #768390; padding: 8px 12px;
               cursor: pointer; border-bottom: 2px solid transparent; font: inherit; }
  nav button.active { color: #e6edf3; border-bottom-color: #2f81f7; }
  .wrap { padding: 14px 18px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 3px 7px; text-align: center; border-bottom: 1px solid #1b212a; white-space: nowrap; }
  th { position: sticky; top: 0; background: #0d1117; color: #768390; font-weight: 600;
       cursor: pointer; user-select: none; }
  td.inst { text-align: left; color: #adbac7; }
  td.q-yes { color: #3fb950; font-weight: 700; }
  td.q-no { color: #f85149; font-weight: 700; }
  td.profile { white-space: normal; max-width: 180px; text-align: left; font-size: 11px; line-height: 1.5; }
  .yes { color: #2ea043; }
  .no { color: #30363d; }
  tr:hover td { background: #11161d; }
  .tier-E { color: #3fb950; } .tier-M { color: #d29922; }
  .tier-H { color: #f85149; } .tier-x { color: #8b949e; }
  .controls { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  input, select { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
                  border-radius: 6px; padding: 5px 8px; font: inherit; }
  .pill { padding: 1px 6px; border-radius: 10px; font-size: 11px; background: #21262d; color: #adbac7; }
  .bar { height: 7px; background: #21262d; border-radius: 4px; overflow: hidden; display: inline-block; width: 90px; vertical-align: middle; }
  .bar > i { display: block; height: 100%; background: #2f81f7; }
  .live { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; }
  .live pre { white-space: pre-wrap; color: #768390; margin: 4px 0 0; font-size: 11px; }
  pre.ora { white-space: pre-wrap; max-height: 360px; overflow: auto; background: #0d1117;
            border: 1px solid #21262d; border-radius: 6px; padding: 8px; margin: 4px 0; font-size: 11px; }
  details summary { cursor: pointer; padding: 3px 0; }
  tr.mrow { cursor: pointer; }
  .kbtn { background: #161b22; color: #adbac7; border: 1px solid #30363d; border-radius: 6px;
          padding: 5px 10px; cursor: pointer; font: inherit; }
  .kbtn.active { background: #1f6feb33; color: #e6edf3; border-color: #2f81f7; }
  a { color: #2f81f7; text-decoration: none; }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(1,4,9,.7);
                   z-index: 50; align-items: flex-start; justify-content: center; padding: 40px 16px; }
  .modal-box { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
               width: min(960px, 100%); max-height: 86vh; overflow: auto; padding: 16px 20px;
               box-shadow: 0 12px 48px rgba(0,0,0,.5); }
  .modal-head { display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 10px; position: sticky; top: -16px; background: #161b22; padding: 4px 0; }
  .modal-head h3 { margin: 0; font-size: 14px; }
  .modal-close { background: #21262d; color: #adbac7; border: 1px solid #30363d; border-radius: 6px;
                 cursor: pointer; font-size: 14px; line-height: 1; padding: 4px 9px; }
  .modal-close:hover { background: #30363d; color: #e6edf3; }
  /* 🛠 관리 tab form */
  .mng-l { display: block; font-size: 11px; color: #768390; margin-bottom: 8px; }
  .mng-l input[type=text], .mng-l select { display: block; width: 100%; margin-top: 3px;
            background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px;
            padding: 5px 7px; font: inherit; }
  .mng-l.mng-cb { display: flex; align-items: center; gap: 6px; }
  .mng-l.mng-cb input { margin: 0; }
  .mng-btn { background: #1f6feb; color: #fff; border: 1px solid #2f81f7; border-radius: 6px;
             padding: 6px 14px; cursor: pointer; font: inherit; margin-top: 4px; }
  .mng-btn:hover { background: #388bfd; }
  .mng-stop { background: #4d1f1f; border-color: #6b2222; color: #ffb4ab; }
  .mng-stop:hover { background: #6b2222; }
</style>
</head>
<body>
<header>
  <h1 id="h1title">SWE-bench Verified — Leaderboard</h1>
  <span class="muted" id="stamp"></span>
  <span class="muted">auto-refresh <span id="cd">5</span>s</span>
</header>
<div class="benchsel" id="benchsel"></div>
<div class="cards" id="cards"></div>
<nav>
  <button data-tab="matrix" class="active">전체 문제 매트릭스</button>
  <button data-tab="runs">우리 런</button>
  <button data-tab="scaffolds">경쟁 스캐폴드</button>
  <button data-tab="knobs">Knob / 프로필</button>
  <button data-tab="live">라이브</button>
  <button data-tab="trace">🔭 트레이스</button>
  <button data-tab="manage">🛠 관리</button>
</nav>
<div class="wrap" id="view"></div>
<div class="modal-overlay" id="modal">
  <div class="modal-box" id="modal-box">
    <div class="modal-head"><h3 id="modal-title"></h3><button class="modal-close" id="modal-close">✕ 닫기</button></div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
let DATA = null, TAB = "matrix", SORT = { key: "hash", dir: -1 };
// RFC 06 — active benchmark (dataset family). Scopes cards/matrix/runs to one
// benchmark; default verified = byte-identical to the pre-RFC single-benchmark view.
let BENCH = "verified";
let TB_MFILTER = { q: "", f: "all" };
const TRACE_PORT = ${TRACE_PORT};
const SCAF_SHOW = ["sonar-o45","trae-dbo","OH-o45","live-gem3","prom-gpt5","mini-o45"];
const SCAF_LABEL = { "sonar-o45":"Sonar", "trae-dbo":"Trae", "OH-o45":"OpenHands", "live-gem3":"Live-SWE", "prom-gpt5":"Prometheus", "mini-o45":"mini+Opus4.5" };
// HTML-escape covering & < > " ' — & MUST be replaced first so we never
// double-escape (turning a later &lt; into &amp;lt;). Used for BOTH text and
// attribute contexts (title="...", data-...), which is why ' and " are both here.
function esc(s){ return (s==null?"":String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

async function poll() {
  try {
    const r = await fetch("/api/data");
    DATA = await r.json();
    render();
  } catch (e) { document.getElementById("stamp").textContent = "fetch error: " + e; }
}

function tierClass(t){ return "tier-" + (t === "×" ? "x" : t); }
// Wall-clock of the winning run, compact: 47s / 6.1m / 1.3h.
function fmtDur(ms){
  if (!ms || ms <= 0) return "";
  var s = ms/1000;
  if (s < 90) return Math.round(s) + "s";
  var m = s/60;
  if (m < 90) return (m < 10 ? m.toFixed(1) : Math.round(m)) + "m";
  return (m/60).toFixed(1) + "h";
}
// WHEN it was solved — relative if recent, else M/D HH:MM (local).
function fmtWhen(ms){
  if (!ms || ms <= 0) return "";
  var d = new Date(ms), now = Date.now(), age = (now - ms)/1000;
  if (age < 3600) return Math.max(1, Math.round(age/60)) + "분 전";
  if (age < 86400) return Math.round(age/3600) + "시간 전";
  var p = function(n){ return (n<10?"0":"")+n; };
  return (d.getMonth()+1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function render() {
  if (!DATA) return;
  document.getElementById("stamp").textContent = "as of " + new Date(DATA.generatedAt).toLocaleTimeString();
  renderBenchSel();
  document.getElementById("h1title").textContent = benchLabel(BENCH) + " — Leaderboard";
  renderCards();
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === TAB));
  const v = document.getElementById("view");
  if (TAB === "runs") v.innerHTML = renderRuns();
  else if (TAB === "matrix") {
    // TB mirrors the SWE shell/body split below: on a background refresh (or a keystroke) only
    // the table body redraws, so the search box keeps focus + cursor (P3-D focus-loss fix).
    if (BENCH === "terminal-bench") {
      if (document.getElementById("tbtable")) drawTbMatrix();
      else renderTbMatrix(v);
    }
    // pro/live: a FAMILY-scoped fold — never the verified matrix under a pro/live title (P3-D
    // mislabel fix; the verified matrix is verified-only data).
    else if (BENCH !== "verified") renderFamMatrix(v);
    // On a background refresh, only redraw the table body so the search box
    // keeps focus and scroll position; full rebuild only on first open.
    else if (document.getElementById("mtable")) drawMatrix();
    else renderMatrix(v);
  }
  else if (TAB === "scaffolds") v.innerHTML = renderScaffolds();
  else if (TAB === "knobs") renderKnobs(v);
  else if (TAB === "trace") { if (!document.getElementById("trace-frame")) v.innerHTML = renderTrace(); }
  else if (TAB === "manage") { if (!document.getElementById("mng")) { v.innerHTML = renderManage(); mngInit(); } }
  else v.innerHTML = renderLive();
}

let KNOBS = null, KNOB_VIEW = "matrix";
async function renderKnobs(v) {
  if (!KNOBS) {
    v.innerHTML = '<p class="muted">knob 카탈로그 불러오는 중…</p>';
    try { KNOBS = await (await fetch("/api/knobs")).json(); }
    catch (e) { v.innerHTML = '<p class="q-no">카탈로그 로드 실패</p>'; return; }
  }
  if (KNOBS.missing) {
    v.innerHTML = '<p class="muted">knob-catalog.json 없음 — 생성: <code>bun run tools/leaderboard-dashboard/gen-knob-catalog.ts</code></p>';
    return;
  }
  drawKnobs(v);
}

const kesc = s => esc(s);

function knobGroups() {
  const K = KNOBS, groups = {};
  for (const id of Object.keys(K.knobs)) { const g = K.knobs[id].group || '기타'; (groups[g] ??= []).push(id); }
  const order = ["localize","hint","verify","select","repair","patch","structure","exec","기타"].filter(g => groups[g]);
  return { groups, order };
}

function showModal(title, html) {
  document.getElementById("modal-title").textContent = title;
  const body = document.getElementById("modal-body");
  body.innerHTML = html;
  document.getElementById("modal").style.display = "flex";
  // Cross-links inside the modal (preset ⇄ knob) via data attrs — no inline JS.
  body.querySelectorAll(".pjump").forEach(e => e.onclick = () => showPresetModal(e.dataset.p));
  body.querySelectorAll(".kjump").forEach(e => e.onclick = () => showKnobModal(e.dataset.id));
}

// Full detail for one knob — every field we have.
function showKnobModal(id) {
  const k = KNOBS.knobs[id]; if (!k) return;
  const gl = (KNOBS.groupLabels||{})[k.group] || k.group;
  let h = '<div style="margin-bottom:8px">'+kesc(k.desc)+'</div>';
  h += '<table style="margin-bottom:10px"><tbody>'+
    row("그룹", gl) + row("env 변수", k.envKey||'—') + row("단위", k.unit||'—') +
    row("상대 비용", k.cost!=null ? ('×'+k.cost+(k.cost>=10?' ⚠️ 비쌈':'')) : '—') +
    row("충돌(conflicts)", (k.conflicts&&k.conflicts.length)?k.conflicts.join(', '):'—') +
    row("출처", k.source||'—') +
    row("적용 경로", k.inRegistry?'framework 레지스트리 (knob.apply)':'bench 드라이버 (benchPostureFromState)') +
    '</tbody></table>';
  h += '<h3 style="font-size:12px;color:#768390;margin:10px 0 4px">이 knob을 쓰는 프로필 ('+k.usedBy.length+')</h3>';
  h += '<table><thead><tr><th class="inst" style="text-align:left">프로필</th><th>값</th></tr></thead><tbody>';
  for (const u of k.usedBy) h += '<tr><td class="inst pjump" data-p="'+u.preset+'" style="cursor:pointer">'+u.preset+'</td><td><span class="q-yes">'+kesc(u.value)+'</span></td></tr>';
  h += '</tbody></table>';
  showModal('🎛 ' + id, h);
}
function row(k, v) { return '<tr><td class="muted" style="text-align:left;padding-right:14px">'+k+'</td><td style="text-align:left">'+kesc(v)+'</td></tr>'; }

// Full detail for one preset — rationale + every knob it sets, with descriptions.
function showPresetModal(name) {
  const p = KNOBS.presets[name]; if (!p) return;
  let h = '';
  if (p.desc) h += '<div style="margin-bottom:10px;line-height:1.6">'+kesc(p.desc)+'</div>';
  h += '<div class="muted" style="font-size:11px;margin-bottom:6px">'+p.knobCount+' knob 설정</div>';
  const { groups, order } = knobGroups();
  h += '<table><thead><tr><th class="inst" style="text-align:left">knob</th><th>값</th><th style="text-align:left">설명</th></tr></thead><tbody>';
  for (const g of order) for (const id of groups[g]) {
    if (!(id in p.knobs)) continue;
    const k = KNOBS.knobs[id];
    h += '<tr><td class="inst kjump" data-id="'+id+'" style="cursor:pointer">'+id+'</td>'+
      '<td><span class="q-yes">'+kesc(p.knobs[id])+'</span></td>'+
      '<td style="text-align:left;font-size:11px" class="muted">'+kesc(k?k.desc:'')+'</td></tr>';
  }
  h += '</tbody></table>';
  showModal('🧩 프로필 · ' + name, h);
}

function drawKnobs(v) {
  const K = KNOBS;
  const { groups, order: groupOrder } = knobGroups();
  const presets = K.presetOrder.filter(p => K.presets[p] && K.presets[p].knobCount); // drop empty (baseline)

  let h = '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center">'+
    '<button class="kbtn" data-kv="matrix">프로필 × Knob 매트릭스</button>'+
    '<button class="kbtn" data-kv="presets">프로필 카드</button>'+
    '<button class="kbtn" data-kv="glossary">Knob 사전</button>'+
    '<span class="muted" style="font-size:11px">'+presets.length+' 프로필 · '+Object.keys(K.knobs).length+' knob · 행/헤더 클릭=상세 · 값(1=켜짐 / off / 숫자=깊이·예산·후보수)</span></div>';

  if (KNOB_VIEW === "matrix") {
    h += '<div style="overflow:auto;max-height:75vh"><table><thead><tr><th class="inst" style="text-align:left;position:sticky;left:0;top:0;z-index:3;background:#0d1117">프로필</th>';
    for (const g of groupOrder) for (const id of groups[g])
      h += '<th class="kh" data-id="'+id+'" title="'+kesc(K.knobs[id].desc)+'" style="cursor:pointer;writing-mode:vertical-rl;transform:rotate(180deg);height:150px;font-size:10px;white-space:nowrap">'+id+'</th>';
    h += '</tr></thead><tbody>';
    for (const p of presets) {
      const kv = K.presets[p].knobs;
      h += '<tr><td class="inst kp" data-p="'+p+'" style="cursor:pointer;position:sticky;left:0;background:#0d1117">'+p+'</td>';
      for (const g of groupOrder) for (const id of groups[g]) {
        const val = kv[id];
        const cell = val==null ? '<span class="no">·</span>'
          : (val==="off" ? '<span class="q-no" style="font-size:10px">off</span>'
            : '<span class="q-yes">'+kesc(val)+'</span>');
        h += '<td>'+cell+'</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table></div>';
  } else if (KNOB_VIEW === "presets") {
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px">';
    for (const p of presets) {
      const P = K.presets[p];
      const tags = Object.keys(P.knobs).slice(0,99).map(id => '<span class="pill" style="margin:1px">'+id+(P.knobs[id]!=="1"?'='+kesc(P.knobs[id]):'')+'</span>').join(' ');
      h += '<div class="card kp" data-p="'+p+'" style="cursor:pointer;display:block;min-width:0">'+
        '<div style="color:#e6edf3;font-weight:700;margin-bottom:3px">'+p+' <span class="muted" style="font-weight:400;font-size:10px">'+P.knobCount+' knob</span></div>'+
        (P.desc?'<div class="muted" style="font-size:10px;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">'+kesc(P.desc)+'</div>':'')+
        '<div style="font-size:10px;line-height:1.9">'+tags+'</div></div>';
    }
    h += '</div>';
  } else {
    for (const g of groupOrder) {
      const gl = (K.groupLabels||{})[g] || g;
      h += '<h3 style="margin:14px 0 6px;color:#e6edf3;font-size:13px">'+gl+'</h3>';
      h += '<table><thead><tr><th class="inst" style="text-align:left">knob</th><th style="text-align:left">설명</th><th>비용</th><th>env</th><th>출처</th><th>프로필</th></tr></thead><tbody>';
      for (const id of groups[g]) {
        const k = K.knobs[id];
        h += '<tr class="kg" data-id="'+id+'" style="cursor:pointer"><td class="inst">'+id+(k.unit?' <span class="muted" style="font-size:10px">'+kesc(k.unit)+'</span>':'')+
          (k.inRegistry?'':' <span class="pill" title="bench 드라이버가 적용(레지스트리 외)">drv</span>')+'</td>'+
          '<td style="text-align:left">'+kesc(k.desc)+'</td>'+
          '<td class="'+(k.cost>=10?'q-no':'muted')+'" style="font-size:10px">'+(k.cost!=null?'×'+k.cost:'—')+'</td>'+
          '<td class="muted" style="font-size:10px">'+kesc(k.envKey||'—')+'</td>'+
          '<td class="muted" style="font-size:10px">'+kesc(k.source||'—')+'</td>'+
          '<td class="muted">'+k.usedBy.length+'</td></tr>';
      }
      h += '</tbody></table>';
    }
  }
  v.innerHTML = h;
  v.querySelectorAll(".kbtn").forEach(b => {
    b.classList.toggle("active", b.dataset.kv === KNOB_VIEW);
    b.onclick = () => { KNOB_VIEW = b.dataset.kv; drawKnobs(v); };
  });
  v.querySelectorAll(".kh").forEach(e => e.onclick = () => showKnobModal(e.dataset.id));
  v.querySelectorAll(".kg").forEach(e => e.onclick = () => showKnobModal(e.dataset.id));
  v.querySelectorAll(".kp").forEach(e => e.onclick = () => showPresetModal(e.dataset.p));
}

// ── RFC 06: benchmark selector + Terminal-Bench view ────────────────────────
function benchLabel(id) {
  const bs = (DATA && DATA.benchmarks) || [];
  for (const b of bs) if (b.id === id) return b.label;
  return id === "verified" ? "SWE-bench Verified" : id;
}
function renderBenchSel() {
  const el = document.getElementById("benchsel");
  const bs = (DATA && DATA.benchmarks) || [{ id: "verified", label: "SWE-bench Verified" }];
  // one solved/total badge per benchmark so the selector doubles as a scoreboard.
  const badge = function(id) {
    const camps = (DATA.campaigns || []).filter(c => (c.datasetFamily || "verified") === id);
    if (!camps.length) return "";
    const best = camps.slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)))[0];
    return best ? '<span class="bn">'+best.resolved+'/'+best.total+'</span>' : "";
  };
  el.innerHTML = bs.map(b =>
    '<button data-bench="'+esc(b.id)+'" class="'+(BENCH===b.id?"active":"")+'">'+esc(b.label)+badge(b.id)+'</button>'
  ).join("");
  el.querySelectorAll("button").forEach(function(btn){
    btn.onclick = function(){ BENCH = btn.dataset.bench; TAB = (TAB==="knobs"||TAB==="trace"||TAB==="manage")?TAB:"matrix"; render(); };
  });
}
// Our TB result per task, folded from the terminal-bench runs (any-pass wins),
// split into baseline vs levers arms by preset text. Pure over DATA.runs (SSOT).
function tbOurResults() {
  const runs = (DATA.runs || []).filter(r => (r.datasetFamily || "verified") === "terminal-bench");
  const base = {}, lev = {};
  for (const r of runs) {
    // P1-C: route by the EXPLICIT report.arm; fall back to the preset substring only for OLD
    // reports that predate the flag (an oc1/owned-only run's preset lacks "levers" and would
    // otherwise poison the baseline control).
    const isLev = r.arm ? r.arm === "levers" : (r.preset || "").toLowerCase().indexOf("levers") >= 0;
    const sink = isLev ? lev : base;
    for (const pi of (r.perInstance || [])) {
      // D1: an agent-CRASH (auth-death / harness exception — a re-runnable infra hole, jun-20
      // real_attempt precedent) is excluded so it never counts as a capability miss. An
      // agent-TIMEOUT STAYS in the denominator as a genuine miss: the agent spent its budget and
      // failed — the HF competitor columns are trial-averaged with timeouts scored 0, and
      // RE_RUNNABLE_TERMINATIONS above deliberately keeps timeout out of the re-runnable set;
      // excluding it here would inflate our number vs the very columns we compare against.
      if (pi.error && pi.error.kind === "agent-crash") continue;
      if (sink[pi.id] === undefined || pi.passed) sink[pi.id] = pi.passed;
    }
  }
  return { base: base, lev: lev };
}

// Any-pass fold over ONE family's runs (the pro/live view scope) — same shape as tbOurResults
// but unsplit (no arm semantics outside TB). Pure over DATA.runs. Measurement-hole EXCLUSION
// mirrors the sibling folds so pro/live is consistent with them: a re-runnable throttle/infra
// hole (FLAG-B fail.reRunnable, like the verified view) or an agent-crash (D1, like the TB
// view) is NOT a capability miss — skip it (else the jun-20 throttle/miss confound re-opens here).
function famOurResults(fam) {
  const out = {};
  for (const r of (DATA.runs || []).filter(r => (r.datasetFamily || "verified") === fam)) {
    for (const pi of (r.perInstance || [])) {
      if (pi.error && pi.error.kind === "agent-crash") continue;
      if (!pi.passed && pi.fail && pi.fail.reRunnable) continue;
      if (out[pi.id] === undefined || pi.passed) out[pi.id] = pi.passed;
    }
  }
  return out;
}

// pro/live summary cards — FAMILY-scoped (P3-D: a pro/live title must never sit over verified
// numbers). any-pass across the family's runs; campaign best from the same family only.
function renderFamCards() {
  const fold = famOurResults(BENCH);
  const ids = Object.keys(fold);
  const solved = ids.filter(function(i){ return fold[i] === true; }).length;
  const camps = (DATA.campaigns || []).filter(c => (c.datasetFamily || "verified") === BENCH);
  const best = camps.slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)))[0];
  const runCount = (DATA.runs || []).filter(r => (r.datasetFamily || "verified") === BENCH).length;
  const cards = [
    ["해결 / 실행", solved + " / " + ids.length, "family=" + BENCH + " · any-pass(런 합산)"],
    ["best 캠페인", best ? (best.resolved + "/" + best.total) : "—", best ? best.key : "이 family 캠페인 없음"],
    ["리포트 파일", runCount, camps.length + " 캠페인"],
  ];
  document.getElementById("cards").innerHTML = cards.map(c =>
    '<div class="card"><div class="n">'+esc(c[1])+'</div><div class="l">'+esc(c[0])+'</div>'+
    (c[2]? '<div class="muted" style="font-size:10px">'+esc(c[2])+'</div>':'')+'</div>').join("");
}

// pro/live per-instance matrix — the family's own rows (misses first), never verified data.
function renderFamMatrix(v) {
  const fold = famOurResults(BENCH);
  const ids = Object.keys(fold).sort(function(a,b){
    if (fold[a] !== fold[b]) return fold[a] ? 1 : -1; // misses first
    return a.localeCompare(b);
  });
  const runCount = (DATA.runs || []).filter(r => (r.datasetFamily || "verified") === BENCH).length;
  let h = '<p class="muted">family='+esc(BENCH)+' · '+ids.length+' instances · ✅=any-pass across '+runCount+' run(s)</p>';
  h += '<table><thead><tr><th class="inst" style="text-align:left">instance</th><th>결과</th></tr></thead><tbody>';
  for (const id of ids) {
    h += '<tr><td class="inst">'+esc(id)+'</td><td style="text-align:center">'+
      (fold[id] ? '<span class="q-ok">✅</span>' : '<span class="q-no">❌</span>')+'</td></tr>';
  }
  v.innerHTML = h + (ids.length ? '' : '<tr><td colspan="2" class="muted">이 family 리포트 없음</td></tr>') + '</tbody></table>';
}

function renderCards() {
  if (BENCH === "terminal-bench") return renderTbCards();
  if (BENCH !== "verified") return renderFamCards();
  const q = DATA.quanta;
  const ids = Object.keys(q);
  const solved = ids.filter(i => q[i].passed).length;
  const ran = ids.length;
  // ceiling-adjusted: drop instances no public submission solved (#<=1).
  // FLAG-C: also drop re-runnable measurement-holes (throttle/infra/env) — a
  // 429 on a frontier-solved problem is NOT a capability gap, it's unmeasured.
  let realMiss = 0, ceilMiss = 0, unmeasured = 0;
  for (const id of ids) {
    if (q[id].passed) continue;
    const f = q[id].fail;
    if (f && f.reRunnable) { unmeasured++; continue; }
    const row = DATA.rows[id];
    if (row && row.hash <= 1) ceilMiss++; else realMiss++;
  }
  const best = (DATA.campaigns||[]).slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)))[0];
  const cards = [
    ["해결 / 실행", solved + " / " + ran, DATA.coverage ? "데이터셋 "+DATA.coverage.datasetTotal : ""],
    ["천장보정 점수", solved + " / " + (solved + realMiss), "ceiling("+ceilMiss+") · 미측정("+unmeasured+") 제외"],
    ["진짜 격차", realMiss, "프론티어는 푸는데 미스 · 미측정("+unmeasured+") 제외"],
    ["best 캠페인", best ? (best.resolved+"/"+best.total) : "—", best ? best.key : ""],
    ["리포트 파일", DATA.runs.length, (DATA.campaigns||[]).length+" 캠페인"],
    ["라이브 박스", DATA.live.length],
  ];
  document.getElementById("cards").innerHTML = cards.map(c =>
    '<div class="card"><div class="n">'+esc(c[1])+'</div><div class="l">'+esc(c[0])+'</div>'+
    (c[2]? '<div class="muted" style="font-size:10px">'+esc(c[2])+'</div>':'')+'</div>').join("");
}

// TB task rows = HF per-task matrix ∪ OUR run task ids (P3-D md-absent fix: with the HF md
// missing — or a harbor task name drifted from the HF name — our runs still render as rows
// instead of silently vanishing; synthesized rows carry no competitor data, avg 0 ⇒ never
// counted winnable).
function tbTaskRows() {
  const tasks = ((DATA.tb && DATA.tb.tasks) || []).slice();
  const known = new Set(tasks.map(function(t){ return t.task; }));
  const our = tbOurResults();
  const ourIds = new Set(Object.keys(our.base).concat(Object.keys(our.lev)));
  for (const id of ourIds) {
    if (!known.has(id)) {
      tasks.push({ task: id, difficulty: "?", category: "(HF 매트릭스에 없음)", avg: 0, scaffolds: {}, hardCeiling: false });
    }
  }
  return { tasks: tasks, our: our };
}

// Terminal-Bench summary cards (RFC 06): projection = baseline ∪ levers over the 89
// tasks; winnable-remaining = our miss ∩ a competitor solved (the actionable gap).
function renderTbCards() {
  const tb = tbTaskRows();
  const tasks = tb.tasks;
  const our = tb.our;
  const solved = function(t){ return our.base[t]===true || our.lev[t]===true; };
  const baseIds = Object.keys(our.base), levIds = Object.keys(our.lev);
  const baseSolved = baseIds.filter(function(t){return our.base[t]===true;}).length;
  const levSolved = levIds.filter(function(t){return our.lev[t]===true;}).length;
  const proj = tasks.filter(function(t){return solved(t.task);}).length;
  const winnable = tasks.filter(function(t){return !solved(t.task) && !t.hardCeiling && t.avg>0;}).length;
  const ceil = tasks.filter(function(t){return t.hardCeiling;}).length;
  const cards = [
    // P2-10: the aggregation is ANY-PASS (trials × runs × arms) — the HF competitor columns are
    // TRIAL-AVERAGED, so this projection is optimistic vs them BY CONSTRUCTION; labeled, not hidden.
    ["해결 (투영)", proj + " / " + tasks.length, "baseline ∪ levers · any-pass(trial×run 합)"],
    ["레버 회복", levSolved + " / " + levIds.length, "실패셋 재도전 (baseline 0)"],
    ["베이스라인", baseSolved + " / " + baseIds.length, "knob-off"],
    ["승산 타겟 남음", winnable, "우리 미해결 ∩ 남들 성공"],
    ["하드천장", ceil, "아무 스캐폴드도 못 푼 것"],
  ];
  document.getElementById("cards").innerHTML = cards.map(function(c){
    return '<div class="card"><div class="n">'+esc(c[1])+'</div><div class="l">'+esc(c[0])+'</div>'+
      (c[2]? '<div class="muted" style="font-size:10px">'+esc(c[2])+'</div>':'')+'</div>';
  }).join("");
}
// Terminal-Bench per-task matrix: our baseline vs levers result × competitor pass-
// rates, keyed on the 89 TB tasks (DATA.tb). Winnable targets (our miss ∩ someone
// solved) float to the top and are tinted; hard ceilings (nobody solved) are greyed.
function renderTbMatrix(v) {
  // SHELL (built once — P3-D focus fix): the controls + legend stay in the DOM across keystrokes
  // and background refreshes; only #tbtable's contents redraw (drawTbMatrix), mirroring the SWE
  // matrix's mtable/drawMatrix split so the search box keeps focus + cursor.
  v.innerHTML = '<div class="controls">'+
    '<input id="tbsearch" placeholder="task 검색…" value="'+esc(TB_MFILTER.q)+'" />'+
    '<select id="tbfilter">'+
      ['all|전체','winnable|승산 타겟(우리 미스 ∩ 남들 성공)','solved|우리 해결','missed|우리 미스','ceiling|하드천장']
        .map(function(o){var p=o.split("|");return '<option value="'+p[0]+'"'+(TB_MFILTER.f===p[0]?" selected":"")+'>'+esc(p[1])+'</option>';}).join("")+
    '</select> <span class="muted" id="tbcount"></span></div>'+
    // P2-10 metric label: our marks are ANY-PASS (trial×run×arm), competitor % is TRIAL-AVERAGE —
    // different aggregations; ours reads optimistic on variance tasks by construction.
    '<p class="muted">✅/❌ = 우리 결과(any-pass: trial×run 합) · 우측 = 공개 스캐폴드 pass율(HF, trial-평균 — 집계가 달라 우리 쪽이 낙관) · <b>승산 타겟</b>=우리 미스인데 최소 한 곳은 푼 것(파란 배경) · 회색 행=하드천장(아무도 못 푼 것)</p>'+
    '<div id="tbtable"></div>';
  const si = document.getElementById("tbsearch"); if (si) si.oninput = function(){ TB_MFILTER.q = si.value; drawTbMatrix(); };
  const fi = document.getElementById("tbfilter"); if (fi) fi.onchange = function(){ TB_MFILTER.f = fi.value; drawTbMatrix(); };
  drawTbMatrix();
}
// BODY (redraws on filter/search/refresh — never touches the controls above).
function drawTbMatrix() {
  const el = document.getElementById("tbtable");
  if (!el) return;
  const tb = tbTaskRows();
  const tasks = tb.tasks;
  const scaffs = (DATA.tb && DATA.tb.scaffolds) || [];
  const our = tb.our;
  const solved = function(t){ return our.base[t]===true || our.lev[t]===true; };
  const mark = function(res){
    if (res === true) return '<span class="q-ok">✅</span>';
    if (res === false) return '<span class="q-no">❌</span>';
    return '<span class="muted">—</span>';
  };
  const isWinnable = function(t){ return !solved(t.task) && !t.hardCeiling && t.avg>0; };
  // filter
  const f = TB_MFILTER.f, q = (TB_MFILTER.q||"").toLowerCase();
  let rows = tasks.filter(function(t){
    if (q && t.task.toLowerCase().indexOf(q) < 0) return false;
    if (f === "winnable") return isWinnable(t);
    if (f === "solved") return solved(t.task);
    if (f === "missed") return !solved(t.task);
    if (f === "ceiling") return t.hardCeiling;
    return true;
  });
  // winnable first, then by competitor avg desc (highest-ROI targets on top).
  rows.sort(function(a,b){
    const wa = isWinnable(a)?1:0, wb = isWinnable(b)?1:0;
    if (wa !== wb) return wb - wa;
    return b.avg - a.avg;
  });
  const cnt = document.getElementById("tbcount"); if (cnt) cnt.textContent = rows.length + "개";
  let h = '<table><thead><tr><th class="inst" style="text-align:left">task</th><th>난이도</th><th style="text-align:left">category</th>'+
    '<th title="knob-off">우리<br>base</th><th title="env-owned·maxTurns·verify-gate">우리<br>+레버</th><th>경쟁사<br>평균</th>'+
    scaffs.map(function(s){return '<th title="'+esc(s)+'">'+esc(s.slice(0,4))+'</th>';}).join("")+'</tr></thead><tbody>';
  for (const t of rows) {
    const cls = t.hardCeiling ? ' style="opacity:.45"' : (isWinnable(t) ? ' style="background:#12233a"' : '');
    h += '<tr'+cls+'><td class="inst">'+esc(t.task)+(isWinnable(t)?' <span class="fam fam-terminal-bench">타겟</span>':'')+'</td>'+
      '<td class="muted" style="text-align:center">'+esc(t.difficulty)+'</td>'+
      '<td class="muted">'+esc(t.category)+'</td>'+
      '<td style="text-align:center">'+mark(our.base[t.task])+'</td>'+
      '<td style="text-align:center">'+mark(our.lev[t.task])+'</td>'+
      '<td style="text-align:center"><b>'+t.avg+'%</b></td>'+
      scaffs.map(function(s){var p=t.scaffolds[s];return '<td class="muted" style="text-align:center">'+(p===undefined?'·':(p+'%'))+'</td>';}).join("")+
      '</tr>';
  }
  el.innerHTML = h + '</tbody></table>';
}

// RFC jun-29 R4: dataset family is a partition, not a flavor — a pro resolved-rate must
// never sit in the same row-space as a verified one without a label. verified shows no
// chip (byte-identical to the legacy look); pro/live get a colored chip.
var FAM_FILTER = "";
function famChip(fam) {
  if (!fam || fam === "verified") return "";
  return '<span class="fam fam-'+esc(fam)+'">'+esc(fam)+'</span> ';
}
// RFC jun-29: our datasetFamily → external (dataset,set) we're measured against.
// verified ⇒ null (its own surface; byte-identical, no external column). Mirrors the
// unit-tested externalCoordFor in external-comparison.ts (kept in sync there).
function extCoordFor(fam) {
  if (fam === "pro") return { dataset: "pro", sets: ["public-731"] };
  if (fam === "live") return { dataset: "live", sets: ["verified", "lite"] };
  return null;
}
// Top external model for a family from DATA.externalBaselines, or null. Defensive:
// missing/empty baselines ⇒ null (the column shows —, never crashes).
function extSotaForFamily(fam) {
  var b = DATA.externalBaselines;
  if (!b || !Array.isArray(b.models)) return null;
  var coord = extCoordFor(fam);
  if (!coord) return null;
  for (var si = 0; si < coord.sets.length; si++) {
    var set = coord.sets[si];
    var top = null;
    for (var i = 0; i < b.models.length; i++) {
      var m = b.models[i];
      if (m.dataset !== coord.dataset || m.set !== set) continue;
      if (top === null || m.rate > top.rate) top = m;
    }
    if (top) return top;
  }
  return null;
}
function renderRuns() {
  // Campaigns roll shards up into one logical run (clean-shard×6 → SOTA-clean).
  // The runs tab lists ALL families with a chip + optional per-family FAM_FILTER; the
  // top-level BENCH selector governs the matrix/cards/scaffolds tabs (benchmark-scoped
  // views), NOT this flat list — so a mixed pro+live+verified run history stays visible.
  let camps = (DATA.campaigns||[]).slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)));
  if (FAM_FILTER) camps = camps.filter(c => (c.datasetFamily||"verified") === FAM_FILTER);
  let h = '<p class="muted">샤드는 한 캠페인으로 묶음. 행 펼치면 멤버 리포트. 해결률 분모는 측정된 시도만(throttle/인프라/env=미측정 제외).</p>';
  // External SOTA column only when a non-verified (pro/live) campaign is in view AND
  // baselines loaded — keeps an all-verified dashboard byte-identical (no ext column,
  // no external-baselines references rendered).
  const showExt = !!DATA.externalBaselines &&
    camps.some(c => { const f = c.datasetFamily || "verified"; return (f === "pro" || f === "live") && !!extSotaForFamily(f); });
  const extHead = showExt ? '<th title="이 데이터셋의 공개 외부 SOTA 해결률 (pro=public-731 · live=verified/lite) — 우리 % 옆에 나란히 (R4: verified는 비교 안 함)">외부 SOTA</th>' : '';
  h += '<table><thead><tr><th class="inst" style="text-align:left">캠페인</th><th>모델</th><th>preset</th><th>멤버</th><th>해결</th><th>%</th>'+extHead+'<th title="throttle/인프라/env로 측정 못해 분모서 제외 — 재런 대상">미측정</th><th>갱신</th></tr></thead><tbody>';
  for (const r of camps) {
    const pct = r.total ? Math.round(100*r.resolved/r.total) : 0;
    const unmeasured = r.unmeasured || 0;
    let extCell = '';
    if (showExt) {
      const fam = r.datasetFamily || "verified";
      const top = (fam === "pro" || fam === "live") ? extSotaForFamily(fam) : null;
      // External names + set come from external JSON → esc() at this HTML boundary.
      extCell = top
        ? '<td class="muted" title="'+esc(top.name)+' · '+esc(top.set)+' · '+top.resolved+'/'+top.total+'">ext SOTA '+Math.round(100*top.rate)+'% <span style="font-size:10px">('+esc(top.name)+')</span></td>'
        : '<td class="muted">—</td>';
    }
    h += '<tr><td class="inst" title="'+esc(r.members.join(", "))+'">'+famChip(r.datasetFamily)+esc(r.key)+'</td><td class="muted">'+esc(r.model)+'</td><td class="muted">'+esc(r.preset)+'</td>'+
      '<td class="muted">'+r.members.length+'</td>'+
      '<td>'+r.resolved+'/'+r.total+'</td>'+
      '<td><span class="bar"><i style="width:'+pct+'%"></i></span> '+pct+'%</td>'+
      extCell+
      '<td class="muted" title="재런 가능한 측정 구멍 — 해결률 분모서 제외됨">'+(unmeasured? '⟳ '+unmeasured : '·')+'</td>'+
      '<td class="muted">'+ (r.mtime? new Date(r.mtime).toLocaleString() : '—') +'</td></tr>';
  }
  return h + '</tbody></table>';
}

function renderMatrix(v) {
  v.innerHTML = \`
    <div class="controls">
      <input id="search" placeholder="instance 검색…" value="\${MATRIX_FILTER.q}" />
      <select id="filter">
        <option value="all">전체</option>
        <option value="ran">우리가 돌린 것</option>
        <option value="solved">우리 해결</option>
        <option value="missed">우리 미스</option>
        <option value="gap">진짜 격차(미스 & #>1)</option>
        <option value="ceiling">천장(#≤1)</option>
      </select>
      <select id="repo"><option value="">모든 repo</option></select>
      <span class="muted" id="mcount"></span>
    </div>
    <div class="muted" style="font-size:11px;margin-bottom:8px;line-height:1.7">
      ❌ 실패분류 —
      <b>패치햇는데틀림</b>: 패치 채점됐으나 타겟테스트(FAIL_TO_PASS) 여전히 실패 ·
      <b>기존테스트깸</b>: 패치가 PASS_TO_PASS 깨뜨림(regression) ·
      <b>게이트차단</b>: admission 게이트가 패치 막음(채점 못감) ·
      <b>패치생성실패</b>: 모델이 쓸 패치 못만듦 ·
      <b>채점/실행에러</b>: 인프라 에러(모델탓 아님) ·
      <b>타임아웃</b> · <b>미제출(불명)</b>
      &nbsp;|&nbsp; preset <b>*</b> = 파일경로서 추정(리포트에 미기록) · 🏆 = 경쟁사 풀이 트랜스크립트 보유(4개뿐)
    </div>
    \${DATA.externalBaselines ? '<div class="muted" style="font-size:11px;margin-bottom:8px;line-height:1.7">해결가능성 — <span class="pill" style="background:#1e3a2a;color:#7ee2a8;font-size:10px">ext✓</span> 외부 모델이 푼 인스턴스(provably solvable → 우리 미스는 진짜 격차) · <span class="pill" style="background:#5a1e1e;color:#f0a0a0;font-size:10px">⚠ verifier-broken</span> gold 패치가 verifier 통과 못함 → 모델 미스 아님(제외)</div>' : ''}
    <div id="mtable"></div>\`;
  const sel = v.querySelector("#filter"); sel.value = MATRIX_FILTER.kind;
  const repoSel = v.querySelector("#repo");
  const repos = [...new Set(Object.values(DATA.rows).map(r=>r.repo))].sort();
  repoSel.innerHTML = '<option value="">모든 repo</option>' + repos.map(r=>'<option>'+r+'</option>').join("");
  repoSel.value = MATRIX_FILTER.repo;
  v.querySelector("#search").oninput = e => { MATRIX_FILTER.q = e.target.value; drawMatrix(); };
  sel.onchange = e => { MATRIX_FILTER.kind = e.target.value; drawMatrix(); };
  repoSel.onchange = e => { MATRIX_FILTER.repo = e.target.value; drawMatrix(); };
  drawMatrix();
}

const MATRIX_FILTER = { q: "", kind: "all", repo: "" };
const ORACLE_CACHE = {};

function oracleHtml(o) {
  if (o.error) return '<span class="muted">' + o.error + '</span>';
  // Our verdict + failure reason (from the merged run records).
  const me = (DATA.quanta||{})[o.id];
  let verdict = '';
  if (me && me.passed) {
    verdict = '<div style="margin-bottom:6px;color:#3fb950">✅ 우리 해결 — '+me.passes+'/'+me.attempts+'회'+
      (me.bestTurns?', 최소 '+me.bestTurns+'턴':'')+(fmtDur(me.passDurationMs)?', ⏱ '+fmtDur(me.passDurationMs):'')+(fmtWhen(me.passMtime)?', 📅 '+fmtWhen(me.passMtime):'')+(me.passPreset?' · '+esc(me.passPreset):'')+(me.passModel?' · '+esc(me.passModel):'')+'</div>';
  } else if (me) {
    const f = me.fail;
    verdict = '<div style="margin-bottom:6px;color:#f85149">❌ 우리 미해결 — 시도 '+me.attempts+'회'+(me.failTurns?', 최대 '+me.failTurns+'턴':'')+'</div>'+
      (f ? '<div style="margin-bottom:6px;font-size:11px" class="muted">실패원인: <b style="color:#e6edf3">'+esc(f.klass)+'</b>'+
        ' · 종료='+esc(f.termination)+' · FAIL_TO_PASS 실패='+f.f2p+' / PASS_TO_PASS 깨짐='+f.p2p+
        (f.repro?' · 재현테스트='+esc(f.repro):'')+'</div>' : '');
  }
  return verdict + '<div style="margin-bottom:6px">' +
      (o.github ? '<a href="'+o.github+'" target="_blank">🔗 GitHub commit ('+o.repo+')</a>  ' : '') +
      '<span class="muted">'+o.instanceId+' · '+o.difficulty+'</span></div>' +
    '<details open><summary class="muted">문제 설명</summary><pre class="ora">'+esc(o.statement)+'</pre></details>' +
    '<details><summary class="muted" style="color:#3fb950">✅ 정답(gold) 패치 — 오라클</summary><pre class="ora">'+esc(o.patch)+'</pre></details>' +
    '<details><summary class="muted">테스트 패치</summary><pre class="ora">'+esc(o.testPatch)+'</pre></details>' +
    (o.frontierTraj
      ? '<details><summary style="color:#d29922">🏆 프론티어 경쟁사 풀이 트랜스크립트 ('+o.frontierTraj.turns+'턴)</summary><pre class="ora">'+esc(o.frontierTraj.text)+'</pre></details>'
      : '');
}

async function openModal(id) {
  const overlay = document.getElementById("modal");
  const title = document.getElementById("modal-title");
  const body = document.getElementById("modal-body");
  if (!overlay || !body) return;
  title.textContent = id;
  body.innerHTML = '<span class="muted">오라클 불러오는 중…</span>';
  overlay.style.display = "flex";
  let o = ORACLE_CACHE[id];
  if (!o) {
    try { o = await (await fetch("/api/oracle?id=" + encodeURIComponent(id))).json(); ORACLE_CACHE[id] = o; }
    catch (e) { body.innerHTML = '<span class="q-no">오라클 로드 실패</span>'; return; }
  }
  // Guard against a slow fetch resolving after the user opened another row / closed.
  if (overlay.style.display === "none" || title.textContent !== id) return;
  body.innerHTML = oracleHtml(o);
}

function closeModal() {
  const overlay = document.getElementById("modal");
  if (overlay) overlay.style.display = "none";
}

// Unified row set: every instance we have ANY evidence for — competitor
// matrix ∪ SWE-bench dataset ∪ our run records. Nothing we ran disappears.
function unifiedRows() {
  const q = DATA.quanta, rows = DATA.rows, ds = DATA.dataset || {};
  const ids = new Set([...Object.keys(rows), ...Object.keys(ds), ...Object.keys(q)]);
  const out = [];
  for (const id of ids) {
    const m = rows[id] || { id, repo: id.replace(/-\\d+$/, ""), cells: {}, hash: -1, tier: "?" };
    const d = ds[id] || {};
    out.push({
      id,
      repo: m.repo,
      cells: m.cells,
      hash: m.hash,
      tier: m.tier,
      difficulty: d.difficulty || "?",
      statement: d.statement || "",
      me: q[id] || null,
    });
  }
  return out;
}

function drawMatrix() {
  let rows = unifiedRows();
  const f = MATRIX_FILTER;
  rows = rows.filter(r => {
    const me = r.me;
    if (f.repo && r.repo !== f.repo) return false;
    if (f.q && !r.id.includes(f.q)) return false;
    if (f.kind === "ran") return !!me;
    if (f.kind === "solved") return me && me.passed;
    if (f.kind === "missed") return me && !me.passed;
    if (f.kind === "gap") return me && !me.passed && r.hash > 1;
    if (f.kind === "ceiling") return r.hash >= 0 && r.hash <= 1;
    return true;
  });
  rows.sort((a,b) => {
    let av, bv;
    if (SORT.key === "hash") { av=a.hash; bv=b.hash; }
    else if (SORT.key === "inst") { av=a.id; bv=b.id; }
    else if (SORT.key === "turns") { av=(a.me&&a.me.bestTurns)||9e9; bv=(b.me&&b.me.bestTurns)||9e9; }
    else if (SORT.key === "quanta") { av=(a.me?(a.me.passed?2:1):0); bv=(b.me?(b.me.passed?2:1):0); }
    else { av=a.cells[SORT.key]?1:0; bv=b.cells[SORT.key]?1:0; }
    if (av<bv) return SORT.dir; if (av>bv) return -SORT.dir; return 0;
  });
  document.getElementById("mcount").textContent = rows.length + "개";
  let h = '<table><thead><tr>';
  h += '<th class="inst" data-k="inst" style="text-align:left">instance</th>';
  h += '<th data-k="quanta">QUANTA</th><th data-k="turns">턴</th><th title="우리가 돌린 스캐폴드 프로파일(issue-hint/repro-vote) · 모델">프로파일</th><th>난이도</th>';
  for (const s of SCAF_SHOW) h += '<th data-k="'+s+'">'+(SCAF_LABEL[s]||s)+'</th>';
  h += '<th data-k="hash" title="135개(공개 134 + mini-o45) 중 이 문제를 푼 개수 — 낮을수록 어려움. mini가 푼 행은 천장(0) 아님">해결/전체스캐폴드</th><th>tier</th></tr></thead><tbody>';
  for (const r of rows) {
    const me = r.me;
    let qcell = '<td class="muted">·</td>';
    if (me && me.passed) qcell = '<td class="q-yes" title="'+esc(me.passedBy.slice(0,8).join(", "))+'">✅<span class="muted" style="font-size:10px"> '+me.passes+'/'+me.attempts+'</span></td>';
    else if (me) {
      const fk = me.fail ? me.fail.klass : '';
      const ftitle = me.fail ? (me.fail.klass+' · '+me.fail.termination+(me.fail.repro?' · repro:'+me.fail.repro:'')+' · F2P'+me.fail.f2p+'/P2P'+me.fail.p2p) : ('시도 '+me.attempts+'회');
      qcell = '<td class="q-no" title="'+esc(ftitle)+'">❌'+(fk?' <span class="muted" style="font-size:10px">'+esc(fk)+'</span>':'')+'</td>';
    }
    // Turns: cheapest passing run, else most-effort failing run.
    const turns = me ? (me.passed ? (me.bestTurns || '?') : (me.failTurns || '')) : '';
    // Profile we ran: the winning profile on a pass, else every profile tried —
    // one per line so the column stays narrow.
    let presetCell = '<span class="muted">·</span>';
    if (me) {
      const presetsArr = me.passed && me.passPreset ? [me.passPreset] : (me.presets || []);
      const mdl = me.passed && me.passModel ? me.passModel : (me.models || []).join('/');
      const lines = presetsArr.map(esc);
      const body = lines.length ? lines.join('<br>') : '—';
      // Solve time + WHEN solved — only on a pass (the winning run).
      const dur = me.passed ? fmtDur(me.passDurationMs) : '';
      const durSpan = dur ? ' <span class="pill" title="해결 소요시간(승리 런 wall-clock)" style="background:#1e3a2a;color:#7ee2a8;font-size:10px">⏱ '+dur+'</span>' : '';
      const when = me.passed ? fmtWhen(me.passMtime) : '';
      const whenSpan = when ? ' <span class="pill" title="해결 시각(승리 런 report 기록시점)" style="background:#1e2a3a;color:#8ab4f8;font-size:10px">📅 '+when+'</span>' : '';
      presetCell = '<span title="'+esc(presetsArr.join(' / ')+' · '+(mdl||'—'))+'">'+body+durSpan+whenSpan+
        (mdl ? '<br><span class="muted" style="font-size:10px">'+esc(mdl)+'</span>' : '')+'</span>';
    }
    const hashCell = r.hash < 0
      ? '<span class="muted">—</span>'
      : (r.hash === 0
          ? '<span title="공개 134제출 전부 실패 = 천장(데이터 누락 아님)">0 <span class="pill" style="background:#5a1e1e;color:#f0a0a0">천장</span></span>'
          : r.hash);
    const tierCell = r.tier === '?' ? '<span class="muted">—</span>' : '<span class="'+tierClass(r.tier)+'">'+r.tier+'</span>';
    const ftn = (DATA.frontierTurns||{})[r.id];
    const ftBadge = ftn ? ' <span class="pill" title="프론티어 경쟁사 풀이 턴">🏆'+ftn+'t</span>' : '';
    // SOLVABILITY markers (RFC jun-29): WHY did an instance fail?
    //  ⚠ verifier-broken — gold patch failed the verifier → NOT a model miss (excluded).
    //  ext✓ — ≥1 external model resolved it (DATA.externalBaselines.liveResolvedBy) →
    //         provably solvable, so OUR miss is a genuine capability gap.
    let solvBadge = '';
    if (me && me.goldBroken) {
      solvBadge += ' <span class="pill" title="gold 패치가 이 인스턴스 verifier를 통과 못함 → 모델 미스 아님, 해결률서 제외" style="background:#5a1e1e;color:#f0a0a0;font-size:10px">⚠ verifier-broken</span>';
    }
    const resolvers = ((DATA.externalBaselines||{}).liveResolvedBy||{})[r.id];
    if (Array.isArray(resolvers) && resolvers.length) {
      // resolver names come from external JSON → esc().
      solvBadge += ' <span class="pill" title="외부 모델이 푼 인스턴스 (provably solvable): '+esc(resolvers.slice(0,8).join(", "))+'" style="background:#1e3a2a;color:#7ee2a8;font-size:10px">ext✓'+(resolvers.length>1?' '+resolvers.length:'')+'</span>';
    }
    h += '<tr class="mrow" data-id="'+esc(r.id)+'"><td class="inst">'+esc(r.id)+
      ' <span class="dbtn" data-id="'+esc(r.id)+'" title="문제·오라클·trajectory 상세" style="cursor:pointer;color:#58a6ff;font-weight:700;padding:0 4px">ⓘ</span>'+ftBadge+solvBadge+'</td>'+qcell+
      '<td class="muted">'+turns+'</td><td class="profile muted">'+presetCell+'</td><td class="muted" style="font-size:11px">'+r.difficulty+'</td>';
    for (const s of SCAF_SHOW) h += '<td class="'+(r.cells[s]?'yes':'no')+'">'+(r.cells[s]?'✅':'·')+'</td>';
    h += '<td>'+hashCell+'</td><td>'+tierCell+'</td></tr>';
  }
  h += '</tbody></table>';
  document.getElementById("mtable").innerHTML = h;
  document.querySelectorAll("#mtable th[data-k]").forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (SORT.key === k) SORT.dir *= -1; else { SORT.key = k; SORT.dir = -1; }
    drawMatrix();
  });
  document.querySelectorAll("#mtable .dbtn").forEach(b => b.onclick = e => { e.stopPropagation(); openModal(b.dataset.id); });
}

function renderScaffolds() {
  // RFC 06: Terminal-Bench has its own scaffold set — average per-task pass-rate
  // from the TB competitor matrix (DATA.tb), not the SWE scaffold-summary.
  if (BENCH === "terminal-bench") {
    const tasks = (DATA.tb && DATA.tb.tasks) || [];
    const scaffs = (DATA.tb && DATA.tb.scaffolds) || [];
    const avg = scaffs.map(function(s){
      let sum=0,n=0; for (const t of tasks){ const p=t.scaffolds[s]; if (p!==undefined){sum+=p;n++;} }
      return { key: s, pct: n? Math.round(sum/n):0, n: n };
    }).sort(function(a,b){return b.pct-a.pct;});
    let th = '<p class="muted">공개 스캐폴드별 TB 태스크 평균 pass율 (HF 리더보드 파싱, n='+tasks.length+' tasks).</p>';
    th += '<table><thead><tr><th class="inst" style="text-align:left">스캐폴드</th><th>평균 pass율</th><th>%</th></tr></thead><tbody>';
    for (const s of avg) th += '<tr><td class="inst">'+esc(s.key)+'</td><td>'+s.pct+'%</td>'+
      '<td><span class="bar"><i style="width:'+s.pct+'%"></i></span> '+s.pct+'%</td></tr>';
    return th + '</tbody></table>';
  }
  let h = '<table><thead><tr><th class="inst" style="text-align:left">스캐폴드</th><th>모델</th><th>resolved/500</th><th>%</th></tr></thead><tbody>';
  for (const s of DATA.topScaffolds) {
    h += '<tr><td class="inst">'+esc(s.key)+'</td><td class="muted">'+esc(s.model)+'</td><td>'+s.resolved+'</td>'+
      '<td><span class="bar"><i style="width:'+s.pct+'%"></i></span> '+s.pct+'%</td></tr>';
  }
  return h + '</tbody></table>';
}

function renderLive() {
  if (!DATA.live.length) return '<p class="muted">최근 6시간 내 라이브 로그 없음.</p>';
  return DATA.live.map(b =>
    '<div class="live"><b>'+esc(b.dir)+'</b> / '+esc(b.log)+
    ' <span class="pill">'+b.lines+' lines</span>'+
    (b.lastInstance? ' <span class="pill">'+esc(b.lastInstance)+'</span>':'')+
    ' <span class="muted">'+new Date(b.mtime).toLocaleTimeString()+'</span>'+
    '<pre>'+ esc(b.tail||'') +'</pre></div>'
  ).join("");
}

// Live OTEL trace waterfall (otel-trace-sink) embedded as an iframe. The frame is
// built ONCE on first switch to this tab (the render() guard skips rebuild on the
// 5s poll) so it never reloads/flickers mid-stream. Points at TRACE_PORT on the
// same host the dashboard is served from.
function renderTrace() {
  var host = location.hostname || "127.0.0.1";
  var url = "http://" + host + ":" + TRACE_PORT + "/";
  return '<div class="muted" style="padding:6px 0 10px">라이브 에이전트 트레이스 — OTLP 수신기 :' + TRACE_PORT
    + '. 벤치를 <code>QUANTA_OTEL_ENDPOINT=http://127.0.0.1:' + TRACE_PORT + '</code> 로 돌리면 워터폴이 실시간으로 찬다. '
    + '비면 싱크가 꺼진 것(대시보드가 자동 spawn하지만, 아니면 <code>quanta-bench trace</code>). '
    + '<a href="' + url + '" target="_blank" style="color:#2f81f7">↗ 새 탭</a></div>'
    + '<iframe id="trace-frame" src="' + url + '" style="width:100%;height:78vh;border:1px solid #21262d;border-radius:8px;background:#0b0e14"></iframe>';
}

// === 🛠 관리 (Manage) tab — benchmark management console =====================
// THIN client over the /api/launch · /api/running · /api/launch-log · /api/box/stop
// routes. ALL strings that reach innerHTML go through esc() (XSS): launchId, dataset,
// preset, family, box iid, log/output text. Built ONCE per tab-open (the #mng guard
// in render()); its own pollers (running 5s / log 3s) own its live state thereafter.
var MNG_DEFAULTS = {
  verified: "tools/leaderboard-dashboard/rawdata/verified-full.jsonl",
  pro: "~/.quanta/bench/datasets/pro-5.jsonl",
  live: "~/.quanta/bench/datasets/live-5.jsonl"
};
var MNG_SEL = null;          // selected launchId (console tail target)
var MNG_RUN_TIMER = null, MNG_LOG_TIMER = null;

function renderManage() {
  var presets = (KNOBS && KNOBS.presetOrder && KNOBS.presetOrder.length)
    ? KNOBS.presetOrder
    : ["agentless-v1","agentless-v3-thin-strict","baseline"];
  var presetOpts = presets.map(function(p){ return '<option value="'+esc(p)+'">'+esc(p)+'</option>'; }).join("");
  return '<div id="mng">'
    + '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">'
    // --- Run launcher ---
    + '<div class="card" style="min-width:320px;max-width:380px">'
    +   '<div class="l" style="margin-bottom:8px">런 발사</div>'
    +   '<label class="mng-l">데이터셋 패밀리'
    +     '<select id="mng-family">'
    +       '<option value="verified">verified</option>'
    +       '<option value="pro">pro</option>'
    +       '<option value="live">live</option>'
    +     '</select></label>'
    +   '<label class="mng-l">데이터셋 경로<input id="mng-dataset" type="text" value="'+esc(MNG_DEFAULTS.verified)+'"></label>'
    +   '<label class="mng-l">프리셋<select id="mng-preset">'+presetOpts+'</select></label>'
    +   '<label class="mng-l">모델<input id="mng-model" type="text" value="gpt-5.5"></label>'
    +   '<label class="mng-l">인스턴스 필터 (선택)<input id="mng-instances" type="text" placeholder="예: django__django-12345"></label>'
    +   '<label class="mng-l mng-cb"><input id="mng-ondemand" type="checkbox"> on-demand 박스 (spot 회수 없음)</label>'
    +   '<button id="mng-launch" class="mng-btn">🚀 발사</button>'
    +   '<div id="mng-launch-msg" class="muted" style="font-size:11px;margin-top:6px;min-height:14px"></div>'
    + '</div>'
    // --- Running now ---
    + '<div style="flex:1;min-width:420px">'
    +   '<div class="l" style="margin-bottom:8px">현재 실행 중</div>'
    +   '<div id="mng-box-summary" class="muted" style="font-size:11px;margin-bottom:6px"></div>'
    +   '<table style="font-size:12px"><thead><tr><th>패밀리</th><th>데이터셋</th><th>프리셋</th><th>상태</th><th>PID</th><th>경과</th></tr></thead>'
    +   '<tbody id="mng-launches"><tr><td colspan="6" class="muted">로딩…</td></tr></tbody></table>'
    +   '<div class="l" style="margin:14px 0 6px">박스</div>'
    +   '<table style="font-size:12px"><thead><tr><th>인스턴스</th><th></th></tr></thead>'
    +   '<tbody id="mng-boxes"><tr><td colspan="2" class="muted">로딩…</td></tr></tbody></table>'
    + '</div>'
    + '</div>'
    // --- Console ---
    + '<div class="l" style="margin:16px 0 6px">콘솔 <span id="mng-con-id" class="muted" style="font-size:11px"></span></div>'
    + '<pre id="mng-console" style="background:#0b0e14;border:1px solid #21262d;border-radius:8px;padding:10px;height:46vh;overflow:auto;white-space:pre-wrap;font-size:11px">런을 선택하면 로그가 여기 흐른다.</pre>'
    + '</div>';
}

function mngInit() {
  // family change → swap the dataset default (only if user hasn't typed a custom one).
  var famSel = document.getElementById("mng-family");
  var dsIn = document.getElementById("mng-dataset");
  famSel.onchange = function(){
    var def = MNG_DEFAULTS[famSel.value];
    // only auto-fill if the box still holds a known default (don't clobber edits)
    if (dsIn.value === MNG_DEFAULTS.verified || dsIn.value === MNG_DEFAULTS.pro || dsIn.value === MNG_DEFAULTS.live || dsIn.value === "")
      dsIn.value = def;
  };
  document.getElementById("mng-launch").onclick = mngLaunch;
  mngPollRunning();
  if (MNG_RUN_TIMER) clearInterval(MNG_RUN_TIMER);
  if (MNG_LOG_TIMER) clearInterval(MNG_LOG_TIMER);
  MNG_RUN_TIMER = setInterval(function(){ if (TAB === "manage") mngPollRunning(); }, 5000);
  MNG_LOG_TIMER = setInterval(function(){ if (TAB === "manage" && MNG_SEL) mngPollLog(); }, 3000);
}

async function mngLaunch() {
  var msg = document.getElementById("mng-launch-msg");
  var body = {
    family: document.getElementById("mng-family").value,
    dataset: document.getElementById("mng-dataset").value,
    preset: document.getElementById("mng-preset").value,
    model: document.getElementById("mng-model").value,
    instances: document.getElementById("mng-instances").value,
    onDemand: document.getElementById("mng-ondemand").checked
  };
  msg.style.color = "#768390"; msg.textContent = "발사 중…";
  try {
    var r = await fetch("/api/launch", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
    var j = await r.json();
    if (!r.ok) { msg.style.color = "#f85149"; msg.textContent = "실패: " + esc(j.error || ("HTTP "+r.status)); return; }
    msg.style.color = "#3fb950"; msg.innerHTML = "발사됨: " + esc(j.launchId) + " (pid " + esc(j.pid) + ")";
    MNG_SEL = j.launchId;
    mngPollRunning(); mngPollLog();
  } catch (e) { msg.style.color = "#f85149"; msg.textContent = "오류: " + esc(e); }
}

async function mngPollRunning() {
  try {
    var r = await fetch("/api/running");
    var j = await r.json();
    var rows = (j.launches || []).map(function(l){
      var age = mngAge(l.startedAt);
      var sel = (l.launchId === MNG_SEL) ? ' style="background:#161b22"' : '';
      var st = l.status === "running"
        ? '<span class="q-yes">running</span>'
        : '<span class="muted">exited'+(l.exitCode!=null?'('+esc(l.exitCode)+')':'')+'</span>';
      return '<tr class="mng-lrow" data-id="'+esc(l.launchId)+'"'+sel+' style="cursor:pointer">'
        + '<td>'+famChip(l.family)+'</td>'
        + '<td class="muted" title="'+esc(l.dataset)+'" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">'+esc(l.dataset)+'</td>'
        + '<td class="muted">'+esc(l.preset)+'</td>'
        + '<td>'+st+'</td>'
        + '<td class="muted">'+esc(l.pid)+'</td>'
        + '<td class="muted">'+esc(age)+'</td></tr>';
    }).join("");
    document.getElementById("mng-launches").innerHTML = rows || '<tr><td colspan="6" class="muted">아직 발사된 런 없음.</td></tr>';
    document.querySelectorAll(".mng-lrow").forEach(function(tr){
      tr.onclick = function(){ MNG_SEL = tr.dataset.id; mngPollRunning(); mngPollLog(); };
    });
    mngRenderBoxes(j.boxStatus);
  } catch (e) { /* transient — keep last view */ }
}

// box status is whatever 'box status --json' emits; render a compact summary + a
// terminate button per instance id we can find. Shape-tolerant (esc all text).
function mngRenderBoxes(bs) {
  bs = bs || {};
  var summary = "";
  try { summary = JSON.stringify(bs).slice(0, 400); } catch (e) { summary = ""; }
  document.getElementById("mng-box-summary").textContent = summary ? ("box status: " + summary) : "";
  // collect instance ids (i-…) anywhere in the status payload.
  var ids = mngCollectIids(bs);
  var rows = ids.map(function(id){
    return '<tr><td class="inst">'+esc(id)+'</td>'
      + '<td><button class="mng-btn mng-stop" data-iid="'+esc(id)+'" style="padding:2px 8px;font-size:11px">종료</button></td></tr>';
  }).join("");
  document.getElementById("mng-boxes").innerHTML = rows || '<tr><td colspan="2" class="muted">실행 중인 박스 없음.</td></tr>';
  document.querySelectorAll(".mng-stop").forEach(function(btn){
    btn.onclick = function(){ mngStopBox(btn.dataset.iid); };
  });
}

// Walk an arbitrary JSON value, collecting unique EC2 instance-id strings.
function mngCollectIids(v) {
  var out = {}, re = /^i-[0-9a-f]{8,}$/;
  (function walk(x){
    if (x == null) return;
    if (typeof x === "string") { if (re.test(x)) out[x] = 1; return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "object") { for (var k in x) walk(x[k]); }
  })(v);
  return Object.keys(out);
}

async function mngStopBox(iid) {
  if (!confirm("박스 종료: " + iid + " ?")) return;
  try {
    var r = await fetch("/api/box/stop", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ iid: iid }) });
    var j = await r.json();
    var msg = document.getElementById("mng-launch-msg");
    if (!r.ok) { msg.style.color = "#f85149"; msg.textContent = "종료 실패: " + esc(j.error || ("HTTP "+r.status)); }
    else { msg.style.color = j.ok ? "#3fb950" : "#d29922"; msg.innerHTML = "종료 " + (j.ok?"OK":"비정상") + ": " + esc((j.output||"").slice(-200)); }
    mngPollRunning();
  } catch (e) { /* surface nothing fatal */ }
}

async function mngPollLog() {
  if (!MNG_SEL) return;
  var con = document.getElementById("mng-console");
  if (!con) return;
  document.getElementById("mng-con-id").textContent = MNG_SEL;
  try {
    var r = await fetch("/api/launch-log?id=" + encodeURIComponent(MNG_SEL));
    var txt = await r.text();
    if (!r.ok) { con.textContent = "로그 읽기 실패: " + txt; return; }
    var lines = txt.split("\\n");
    var tail = lines.slice(-400).join("\\n");
    var atBottom = (con.scrollTop + con.clientHeight >= con.scrollHeight - 30);
    con.textContent = tail || "(로그 비어 있음)";
    if (atBottom) con.scrollTop = con.scrollHeight;
  } catch (e) { /* transient */ }
}

function mngAge(startedAt) {
  if (!startedAt) return "";
  var s = (Date.now() - startedAt) / 1000;
  if (s < 90) return Math.round(s) + "s";
  var m = s / 60;
  if (m < 90) return (m < 10 ? m.toFixed(1) : Math.round(m)) + "m";
  return (m / 60).toFixed(1) + "h";
}

document.querySelectorAll("nav button").forEach(b => b.onclick = () => { TAB = b.dataset.tab; render(); });

// Modal close: ✕ button, click on backdrop (not the box), or Escape.
document.getElementById("modal-close").onclick = closeModal;
document.getElementById("modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

let cd = 5;
setInterval(() => { cd--; if (cd <= 0) { cd = 5; poll(); } document.getElementById("cd").textContent = cd; }, 1000);
poll();
</script>
</body>
</html>`
