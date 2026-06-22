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
 *                      `_scaffold-summary/scaffold-solving-summary.md`
 *                      (134 public SWE-bench Verified submissions, per-instance).
 *   - Live boxes:      any `*.log` under the configured live dirs (best-effort
 *                      progress: which instance, how many lines).
 *
 * The browser polls `/api/data` every few seconds and re-renders. Nothing here
 * imports from the app — it runs standalone on plain Bun.
 */
import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

const HOME = homedir()
const REPO = join(import.meta.dir, "..", "..")
const PORT = Number(argOf("--port") ?? 7878)

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
const MATRIX_MD =
  argOf("--matrix") ?? join(REPO, "_scaffold-summary", "scaffold-solving-summary.md")
// SWE-bench Verified dataset (500) → problem statement + official difficulty.
const DATASET_JSONL =
  argOf("--dataset") ??
  join(REPO, "docs", "analysis", "swe-bench-verified-analysis", "_data", "verified-full.jsonl")
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
  mtime: number
  resolved: number
  total: number
  perInstance: { id: string; passed: boolean; turns: number; fail: FailInfo | null }[]
}

interface FailInfo {
  termination: string // completed_unresolved / error / timeout / …
  klass: string // 못고침 / regression(기존깨짐) / timeout / error / 미해결
  repro: string // reproTest.reason (no_reproduced_candidate / execution_failed / …)
  f2p: number // FAIL_TO_PASS still failing
  p2p: number // PASS_TO_PASS broken (regression signal)
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
  const encoded = presetFromEncodedFileName(name)
  if (encoded !== undefined) return encoded
  if (dir === "sota" || /shard/.test(name)) return "agentless-v2 (SOTA)*"
  const sidecar = presetFromSidecar(name, knobs)
  if (sidecar !== undefined) return sidecar
  return presetFromFingerprint(knobs)
}

function parseRuns(): Run[] {
  const files: string[] = []
  for (const root of REPORT_ROOTS) walkReports(root, files)
  const seen = new Set<string>()
  const runs: Run[] = []
  for (const f of files) {
    if (seen.has(f)) continue
    seen.add(f)
    let report: JsonRecord | null
    try {
      report = asRecord(JSON.parse(readFileSync(f, "utf8")))
    } catch {
      continue
    }
    if (report === null || !Array.isArray(report.perInstance)) continue
    const perInstance: Run["perInstance"] = report.perInstance.map((pi) => {
      const row = asRecord(pi)
      return {
        id: asString(row?.id) ?? "",
        passed: row?.passed === true,
        turns: Number(row?.turns) || 0,
        fail: classifyFail(pi),
      }
    })
    const resolved = perInstance.filter((p: (typeof perInstance)[number]) => p.passed).length
    let mtime = 0
    try {
      mtime = statSync(f).mtimeMs
    } catch {}
    runs.push({
      label: basename(f).replace(/\.report\.json$/, ""),
      file: f,
      model: asString(report.model) ?? "?",
      preset: presetLabel(f, asRecord(report.knobs)),
      mtime,
      resolved,
      total: perInstance.length,
      perInstance,
    })
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
  mtime: number
  resolved: number
  total: number
}

const campaignKeyOf = (run: Run): string => {
  const dir = basename(run.file.replace(/\/[^/]+$/, ""))
  const shardMatch = run.label.match(/^(.*?)[-_]?shard(\d+)$/i)
  if (/^report-i-/.test(run.label)) return `${dir} · full-remote (${run.model})`
  if (shardMatch) return `${dir}/${shardMatch[1] || "shard"}`
  if (/^local-/.test(run.label)) return `${dir}/local-singles`
  return run.label
}

const addRunToCampaign = (
  groups: Map<string, Campaign & { seen: Map<string, boolean> }>,
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
      mtime: 0,
      resolved: 0,
      total: 0,
      seen: new Map(),
    }
    groups.set(key, group)
  }
  group.members.push(run.label)
  group.mtime = Math.max(group.mtime, run.mtime)
  for (const perInstance of run.perInstance) {
    const sid = shortId(perInstance.id)
    if (!sid) continue
    group.seen.set(sid, (group.seen.get(sid) ?? false) || perInstance.passed)
  }
}

// Roll many report files into logical campaigns:
//   - shards (`clean-shard3`)         → one run (SOTA-clean = 16/36)
//   - full-remote `report-i-*` sidecars → one campaign per (dir, model)
//   - `local-*` single targets         → one bucket
// resolved/total dedupe by instance (union) so overlapping sidecars don't
// double-count.
function groupRuns(runs: Run[]): Campaign[] {
  const groups = new Map<string, Campaign & { seen: Map<string, boolean> }>()
  for (const run of runs) addRunToCampaign(groups, run)
  const out: Campaign[] = []
  for (const group of groups.values()) {
    group.total = group.seen.size
    group.resolved = [...group.seen.values()].filter(Boolean).length
    out.push({
      key: group.key,
      members: group.members,
      model: group.model,
      preset: group.preset,
      mtime: group.mtime,
      resolved: group.resolved,
      total: group.total,
    })
  }
  return out.sort(
    (a, b) =>
      b.total - a.total || b.resolved / Math.max(1, b.total) - a.resolved / Math.max(1, a.total),
  )
}

interface QuantaSummary {
  passed: boolean
  attempts: number
  passes: number
  bestTurns: number | null
  failTurns: number | null
  models: string[]
  presets: string[]
  passPreset: string | null
  passModel: string | null
  passedBy: string[]
  fail: FailInfo | null
  failMtime: number
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
  failTurns: null,
  models: [],
  presets: [],
  passPreset: null,
  passModel: null,
  passedBy: [],
  fail: null,
  failMtime: 0,
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

const recordPassingAttempt = (summary: QuantaSummary, run: Run, turns: number): void => {
  summary.passed = true
  summary.passes++
  summary.passedBy.push(run.label)
  if (turns > 0 && (summary.bestTurns === null || turns < summary.bestTurns)) {
    summary.bestTurns = turns
    summary.passPreset = run.preset
    summary.passModel = run.model
  }
  if (!summary.passPreset) {
    summary.passPreset = run.preset
    summary.passModel = run.model
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
    for (const perInstance of run.perInstance) {
      const sid = shortId(perInstance.id)
      if (!sid || !isRealSwebenchInstanceId(sid)) continue
      const summary = ensureQuantaSummary(quanta, sid)
      addRunMetadata(summary, run)
      if (perInstance.passed) recordPassingAttempt(summary, run, perInstance.turns)
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

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    return routeRequest(new URL(req.url))
  },
})
process.stdout.write(
  `${[
    `leaderboard-dashboard → http://localhost:${server.port}`,
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
</style>
</head>
<body>
<header>
  <h1>SWE-bench Verified — Leaderboard</h1>
  <span class="muted" id="stamp"></span>
  <span class="muted">auto-refresh <span id="cd">5</span>s</span>
</header>
<div class="cards" id="cards"></div>
<nav>
  <button data-tab="matrix" class="active">전체 문제 매트릭스</button>
  <button data-tab="runs">우리 런</button>
  <button data-tab="scaffolds">경쟁 스캐폴드</button>
  <button data-tab="knobs">Knob / 프로필</button>
  <button data-tab="live">라이브</button>
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
const SCAF_SHOW = ["sonar-o45","trae-dbo","OH-o45","live-gem3","prom-gpt5"];
const SCAF_LABEL = { "sonar-o45":"Sonar", "trae-dbo":"Trae", "OH-o45":"OpenHands", "live-gem3":"Live-SWE", "prom-gpt5":"Prometheus" };
function esc(s){ return (s||"").replace(/</g,"&lt;").replace(/"/g,"&quot;"); }

async function poll() {
  try {
    const r = await fetch("/api/data");
    DATA = await r.json();
    render();
  } catch (e) { document.getElementById("stamp").textContent = "fetch error: " + e; }
}

function tierClass(t){ return "tier-" + (t === "×" ? "x" : t); }

function render() {
  if (!DATA) return;
  document.getElementById("stamp").textContent = "as of " + new Date(DATA.generatedAt).toLocaleTimeString();
  renderCards();
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === TAB));
  const v = document.getElementById("view");
  if (TAB === "runs") v.innerHTML = renderRuns();
  else if (TAB === "matrix") {
    // On a background refresh, only redraw the table body so the search box
    // keeps focus and scroll position; full rebuild only on first open.
    if (document.getElementById("mtable")) drawMatrix();
    else renderMatrix(v);
  }
  else if (TAB === "scaffolds") v.innerHTML = renderScaffolds();
  else if (TAB === "knobs") renderKnobs(v);
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

const kesc = s => (s==null?'':String(s)).replace(/</g,'&lt;');

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

function renderCards() {
  const q = DATA.quanta;
  const ids = Object.keys(q);
  const solved = ids.filter(i => q[i].passed).length;
  const ran = ids.length;
  // ceiling-adjusted: drop instances no public submission solved (#<=1)
  let realMiss = 0, ceilMiss = 0;
  for (const id of ids) {
    if (q[id].passed) continue;
    const row = DATA.rows[id];
    if (row && row.hash <= 1) ceilMiss++; else realMiss++;
  }
  const best = (DATA.campaigns||[]).slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)))[0];
  const cards = [
    ["해결 / 실행", solved + " / " + ran, DATA.coverage ? "데이터셋 "+DATA.coverage.datasetTotal : ""],
    ["천장보정 점수", solved + " / " + (solved + realMiss), "ceiling("+ceilMiss+") 제외"],
    ["진짜 격차", realMiss, "프론티어는 푸는데 미스"],
    ["best 캠페인", best ? (best.resolved+"/"+best.total) : "—", best ? best.key : ""],
    ["리포트 파일", DATA.runs.length, (DATA.campaigns||[]).length+" 캠페인"],
    ["라이브 박스", DATA.live.length],
  ];
  document.getElementById("cards").innerHTML = cards.map(c =>
    '<div class="card"><div class="n">'+c[1]+'</div><div class="l">'+c[0]+'</div>'+
    (c[2]? '<div class="muted" style="font-size:10px">'+c[2]+'</div>':'')+'</div>').join("");
}

function renderRuns() {
  // Campaigns roll shards up into one logical run (clean-shard×6 → SOTA-clean).
  const camps = (DATA.campaigns||[]).slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)));
  let h = '<p class="muted">샤드는 한 캠페인으로 묶음. 행 펼치면 멤버 리포트.</p>';
  h += '<table><thead><tr><th class="inst" style="text-align:left">캠페인</th><th>모델</th><th>preset</th><th>멤버</th><th>해결</th><th>%</th><th>갱신</th></tr></thead><tbody>';
  for (const r of camps) {
    const pct = r.total ? Math.round(100*r.resolved/r.total) : 0;
    h += '<tr><td class="inst" title="'+r.members.join(", ")+'">'+r.key+'</td><td class="muted">'+r.model+'</td><td class="muted">'+r.preset+'</td>'+
      '<td class="muted">'+r.members.length+'</td>'+
      '<td>'+r.resolved+'/'+r.total+'</td>'+
      '<td><span class="bar"><i style="width:'+pct+'%"></i></span> '+pct+'%</td>'+
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
      (me.bestTurns?', 최소 '+me.bestTurns+'턴':'')+(me.passPreset?' · '+esc(me.passPreset):'')+(me.passModel?' · '+esc(me.passModel):'')+'</div>';
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
  h += '<th data-k="hash" title="공개 SWE-bench Verified 제출물 134개 중 이 문제를 푼 개수 — 낮을수록 어려움">해결/전체스캐폴드</th><th>tier</th></tr></thead><tbody>';
  for (const r of rows) {
    const me = r.me;
    let qcell = '<td class="muted">·</td>';
    if (me && me.passed) qcell = '<td class="q-yes" title="'+me.passedBy.slice(0,8).join(", ")+'">✅<span class="muted" style="font-size:10px"> '+me.passes+'/'+me.attempts+'</span></td>';
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
      presetCell = '<span title="'+esc(presetsArr.join(' / ')+' · '+(mdl||'—'))+'">'+body+
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
    h += '<tr class="mrow" data-id="'+r.id+'"><td class="inst">'+r.id+(r.statement?' <span class="muted">ⓘ</span>':'')+ftBadge+'</td>'+qcell+
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
  document.querySelectorAll("#mtable tr.mrow").forEach(tr => tr.onclick = () => openModal(tr.dataset.id));
}

function renderScaffolds() {
  let h = '<table><thead><tr><th class="inst" style="text-align:left">스캐폴드</th><th>모델</th><th>resolved/500</th><th>%</th></tr></thead><tbody>';
  for (const s of DATA.topScaffolds) {
    h += '<tr><td class="inst">'+s.key+'</td><td class="muted">'+s.model+'</td><td>'+s.resolved+'</td>'+
      '<td><span class="bar"><i style="width:'+s.pct+'%"></i></span> '+s.pct+'%</td></tr>';
  }
  return h + '</tbody></table>';
}

function renderLive() {
  if (!DATA.live.length) return '<p class="muted">최근 6시간 내 라이브 로그 없음.</p>';
  return DATA.live.map(b =>
    '<div class="live"><b>'+b.dir+'</b> / '+b.log+
    ' <span class="pill">'+b.lines+' lines</span>'+
    (b.lastInstance? ' <span class="pill">'+b.lastInstance+'</span>':'')+
    ' <span class="muted">'+new Date(b.mtime).toLocaleTimeString()+'</span>'+
    '<pre>'+ (b.tail||'').replace(/</g,'&lt;') +'</pre></div>'
  ).join("");
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
