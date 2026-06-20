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
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"

const HOME = homedir()
const REPO = join(import.meta.dir, "..", "..")
const PORT = Number(argOf("--port") ?? 7878)

// Where to look for our run reports + the competitor matrix + live logs.
// Extra roots can be added on the CLI: `--reports /some/dir --reports /other`.
const REPORT_ROOTS = [
  ...argsOf("--reports"),
  join(HOME, "reprovote-ab"),
  join(HOME, "easy-more"),
  // The big trove: full-remote per-instance sidecars + work/runs reports.
  join(HOME, "Library", "quanta-codeagent-v3", "bench"),
  join(HOME, "Library", "quanta-codeagent-v3", "bench-slices"),
]
const MATRIX_MD =
  argOf("--matrix") ??
  join(REPO, "_scaffold-summary", "scaffold-solving-summary.md")
// SWE-bench Verified dataset (500) → problem statement + official difficulty.
const DATASET_JSONL =
  argOf("--dataset") ??
  join(REPO, "docs", "analysis", "swe-bench-verified-analysis", "_data", "verified-full.jsonl")
const LIVE_ROOTS = [...argsOf("--live"), join(HOME, "easy-more")]
// Competitor (frontier-winning) full trajectories — the only ones still on
// disk. The broad per-submission turn data lived in a swe-bench/experiments
// clone that's gone; only the parsed ✅/· matrix md survived.
const FRONTIER_TRAJ_DIR =
  argOf("--frontier-trajs") ?? join(HOME, "Library", "quanta-codeagent-v3", "frontier-winning", "trajs")

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function argsOf(flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < process.argv.length; i++)
    if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1])
  return out
}

const shortId = (full: string) => (full && full.includes("__") ? full.split("__")[1] : full || "")

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

function parseMatrix(): MatrixData {
  const empty: MatrixData = { scaffolds: [], rows: {}, topScaffolds: [], source: MATRIX_MD }
  if (!existsSync(MATRIX_MD)) return empty
  const lines = readFileSync(MATRIX_MD, "utf8").split("\n")
  let header: string[] | null = null
  const rows: Record<string, MatrixRow> = {}
  let scaffolds: string[] = []
  const topScaffolds: MatrixData["topScaffolds"] = []
  let inTop = false

  for (const line of lines) {
    // Section 2 holds the headline scaffold leaderboard.
    if (line.startsWith("## 2.")) inTop = true
    if (line.startsWith("## 3.")) inTop = false
    if (inTop) {
      // | Sonar (`sonar-o45`) | Opus-4.5 | 396 | 79.2 | 🔒closed | repo |
      const m = line.match(/^\|\s*([^|(]+?)\s*\(`([^`]+)`\)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([\d.]+)/)
      if (m) topScaffolds.push({ key: m[2].trim(), model: m[3].trim(), resolved: Number(m[4]), pct: Number(m[5]) })
    }

    if (!line.startsWith("|")) continue
    const cols = line.split("|").map((s) => s.trim())
    // drop leading/trailing empties from the split
    const cells = cols.slice(1, cols.length - 1)
    if (cells[0] === "instance") {
      header = cells // [instance, sonar-o45, ..., #, T]
      scaffolds = header.slice(1, header.length - 2)
      continue
    }
    if (!header) continue
    if (/^-+$|^:-/.test(cells[0])) continue // separator row
    // Recovered-target rows are prefixed with ★ — strip it (and backticks).
    const id = cells[0].replace(/`/g, "").replace(/^[★*\s]+/, "").trim()
    if (!/^[a-z][a-z0-9-]*-\d+$/.test(id)) continue
    const cellMap: Record<string, Cell> = {}
    scaffolds.forEach((s, i) => {
      cellMap[s] = cells[1 + i] === "✅"
    })
    const hash = Number(cells[cells.length - 2]) || 0
    const tier = cells[cells.length - 1] || "?"
    const repo = id.replace(/-\d+$/, "")
    rows[id] = { id, repo, cells: cellMap, hash, tier }
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
function classifyFail(pi: any): FailInfo | null {
  if (pi.passed) return null
  const gb = pi.gradeBreakdown ?? {}
  const term = pi.failure?.termination ?? pi.budget?.attemptOutcomes?.slice(-1)?.[0]?.subkind ?? "unknown"
  const f2p = Number(gb.failToPassFailed) || 0
  const p2p = Number(gb.passToPassFailed) || 0
  let klass: string
  if (p2p > 0)
    klass = "기존테스트깸" // patch broke PASS_TO_PASS (regression)
  else if (f2p > 0)
    klass = "패치햇는데틀림" // patch graded but FAIL_TO_PASS still red — wrong fix
  else if (/timeout/i.test(term))
    klass = "타임아웃"
  else if (/admission|blocked|gate/i.test(term))
    klass = "게이트차단" // admission gate blocked the patch before grading
  else if (/error|harness|exec/i.test(term))
    klass = "채점/실행에러" // infra error, not a model miss
  else if (/no_patch|empty|no_repro|no_diff/i.test(term))
    klass = "패치생성실패" // model produced no usable patch
  else
    klass = "미제출(불명)" // completed without a graded patch, no clear signal
  return { termination: term, klass, repro: pi.reproTest?.reason ?? "", f2p, p2p }
}

// Dirs that are source checkouts / caches — never hold our reports but contain
// thousands of files. Pruning them keeps the scan from exploding.
const PRUNE_DIR = /^(repo|repo-.*|swebench-.*|node_modules|__pycache__|\.git|venv|\.venv|site-packages)$/

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
    let st
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
function presetLabel(file: string, knobs: any): string {
  const name = basename(file).toLowerCase()
  const dir = basename(file.replace(/\/[^/]+$/, "")).toLowerCase()
  // 1) the FILENAME literally encodes the arm. Match name only — the parent
  //    dir (e.g. `reprovote-ab`) would otherwise poison every file under it.
  if (/v3.?thin.*strict|strict/.test(name)) return "agentless-v3-thin-strict*"
  if (/v3.?thin|v3thin/.test(name)) return "agentless-v3-thin*"
  if (/norepair/.test(name)) return "agentless-v2 · norepair*"
  if (/reprovote/.test(name)) return "agentless-v2 · reprovote*"
  if (/v2.?repair|[-_]repair/.test(name)) return "agentless-v2 · repair*"
  if (/v2/.test(name)) return "agentless-v2*"
  if (/v1/.test(name)) return "agentless-v1*"
  // 2) SOTA shard campaign (reprovote-ab/sota) = the agentless-v2 baseline
  if (dir === "sota" || /shard/.test(name)) return "agentless-v2 (SOTA)*"
  // 3) full-remote per-instance sidecars carry no preset in the data
  if (/^report-i-/.test(name)) return "full-remote · preset 미기록"
  if (/^local-/.test(name)) return "local"
  // 4) last resort: knob fingerprint
  try {
    const r = knobs?.resolved ?? {}
    const bits = [r["issue-hint"]?.value, r["repro-vote"]?.display ?? r["repro-vote"]?.value].filter(Boolean)
    return bits.length ? bits.join("/") + "*" : "preset 미기록"
  } catch {
    return "preset 미기록"
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
    let r: any
    try {
      r = JSON.parse(readFileSync(f, "utf8"))
    } catch {
      continue
    }
    if (!Array.isArray(r.perInstance)) continue
    const perInstance = r.perInstance.map((pi: any) => ({
      id: pi.id,
      passed: !!pi.passed,
      turns: Number(pi.turns) || 0,
      fail: classifyFail(pi),
    }))
    const resolved = perInstance.filter((p) => p.passed).length
    let mtime = 0
    try {
      mtime = statSync(f).mtimeMs
    } catch {}
    runs.push({
      label: basename(f).replace(/\.report\.json$/, ""),
      file: f,
      model: r.model ?? "?",
      preset: presetLabel(f, r.knobs),
      mtime,
      resolved,
      total: perInstance.length,
      perInstance,
    })
  }
  runs.sort((a, b) => b.mtime - a.mtime)
  return runs
}

function parseLive() {
  const boxes: { dir: string; log: string; lines: number; lastInstance: string; mtime: number; tail: string }[] = []
  for (const root of LIVE_ROOTS) {
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const e of entries) {
      const dir = join(root, e)
      let st
      try {
        st = statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      let logs: string[]
      try {
        logs = readdirSync(dir).filter((x) => x.endsWith(".log"))
      } catch {
        continue
      }
      for (const lg of logs) {
        const p = join(dir, lg)
        let txt = ""
        let mt = 0
        try {
          txt = readFileSync(p, "utf8")
          mt = statSync(p).mtimeMs
        } catch {
          continue
        }
        // only surface logs touched in the last 6h to avoid stale noise
        if (Date.now() - mt > 6 * 3600_000) continue
        const lineArr = txt.split("\n").filter(Boolean)
        const instMatches = txt.match(/bench-[a-zA-Z0-9_]+__[a-zA-Z0-9_.-]+/g) || []
        const lastInstance = instMatches.length ? instMatches[instMatches.length - 1] : ""
        boxes.push({
          dir: e,
          log: lg,
          lines: lineArr.length,
          lastInstance,
          mtime: mt,
          tail: lineArr.slice(-3).join("\n"),
        })
      }
    }
  }
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
function loadDataset(): Record<string, DatasetRow> {
  if (DATASET_CACHE) return DATASET_CACHE
  const map: Record<string, DatasetRow> = {}
  if (existsSync(DATASET_JSONL)) {
    for (const line of readFileSync(DATASET_JSONL, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        map[shortId(o.instance_id)] = {
          difficulty: o.difficulty ?? "?",
          statement: o.problem_statement ?? "",
          patch: o.patch ?? "",
          testPatch: o.test_patch ?? "",
          repo: o.repo ?? "",
          baseCommit: o.base_commit ?? "",
          instanceId: o.instance_id ?? "",
        }
      } catch {}
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
        map[shortId(f.replace(/\.txt$/, ""))] = { turns, file: p }
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

// Roll many report files into logical campaigns:
//   - shards (`clean-shard3`)         → one run (SOTA-clean = 16/36)
//   - full-remote `report-i-*` sidecars → one campaign per (dir, model)
//   - `local-*` single targets         → one bucket
// resolved/total dedupe by instance (union) so overlapping sidecars don't
// double-count.
function groupRuns(runs: Run[]): Campaign[] {
  const groups = new Map<string, Campaign & { seen: Map<string, boolean> }>()
  for (const r of runs) {
    const dir = basename(r.file.replace(/\/[^/]+$/, ""))
    const m = r.label.match(/^(.*?)[-_]?shard(\d+)$/i)
    let key: string
    if (/^report-i-/.test(r.label)) key = `${dir} · full-remote (${r.model})`
    else if (m) key = `${dir}/${m[1] || "shard"}`
    else if (/^local-/.test(r.label)) key = `${dir}/local-singles`
    else key = r.label
    let g = groups.get(key)
    if (!g) {
      g = { key, members: [], model: r.model, preset: r.preset, mtime: 0, resolved: 0, total: 0, seen: new Map() }
      groups.set(key, g)
    }
    g.members.push(r.label)
    g.mtime = Math.max(g.mtime, r.mtime)
    for (const pi of r.perInstance) {
      const sid = shortId(pi.id)
      if (!sid) continue
      g.seen.set(sid, (g.seen.get(sid) ?? false) || pi.passed)
    }
  }
  const out: Campaign[] = []
  for (const g of groups.values()) {
    g.total = g.seen.size
    g.resolved = [...g.seen.values()].filter(Boolean).length
    out.push({ key: g.key, members: g.members, model: g.model, preset: g.preset, mtime: g.mtime, resolved: g.resolved, total: g.total })
  }
  return out.sort((a, b) => b.total - a.total || b.resolved / Math.max(1, b.total) - a.resolved / Math.max(1, a.total))
}

function buildData() {
  const matrix = parseMatrix()
  const fullDataset = loadDataset()
  // Lite view for the bulk payload — gold patches are fetched on demand.
  const dataset: Record<string, { difficulty: string; statement: string }> = {}
  for (const [id, d] of Object.entries(fullDataset))
    dataset[id] = { difficulty: d.difficulty, statement: d.statement.slice(0, 400) }
  const runs = parseRuns()
  const campaigns = groupRuns(runs)
  // Merge our results across every run into one per-instance verdict.
  const quanta: Record<
    string,
    {
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
  > = {}
  for (const run of runs) {
    for (const pi of run.perInstance) {
      const sid = shortId(pi.id)
      // Skip synthetic placeholder ids (e.g. `py.repo.swebench_sphinx_doc.012`
      // from smoke reports) — keep only real `repo-NNNN` SWE-bench instances.
      if (!sid || !/^[a-z][a-z0-9-]*-\d+$/.test(sid)) continue
      const q = (quanta[sid] ??= {
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
      q.attempts++
      if (!q.models.includes(run.model)) q.models.push(run.model)
      if (run.preset && !q.presets.includes(run.preset)) q.presets.push(run.preset)
      if (pi.passed) {
        q.passed = true
        q.passes++
        q.passedBy.push(run.label)
        if (pi.turns > 0 && (q.bestTurns === null || pi.turns < q.bestTurns)) {
          q.bestTurns = pi.turns
          // Record the profile/model of the cheapest passing run.
          q.passPreset = run.preset
          q.passModel = run.model
        }
        if (!q.passPreset) {
          q.passPreset = run.preset
          q.passModel = run.model
        }
      } else {
        if (pi.turns > 0 && (q.failTurns === null || pi.turns > q.failTurns)) {
          // Most turns burned on a failing attempt — effort before giving up.
          q.failTurns = pi.turns
        }
        // Keep the failure reason from the most recent failing attempt.
        if (pi.fail && run.mtime >= q.failMtime) {
          q.fail = pi.fail
          q.failMtime = run.mtime
        }
      }
    }
  }
  // Surface every instance we have a record for, even if it's not in the
  // competitor matrix (so nothing we ran silently disappears).
  const coverage = {
    datasetTotal: Object.keys(dataset).length,
    matrixRows: Object.keys(matrix.rows).length,
    quantaRan: Object.keys(quanta).length,
    quantaSolved: Object.values(quanta).filter((q) => q.passed).length,
    reportFiles: runs.length,
  }
  const frontier = loadFrontierTrajs()
  const frontierTurns: Record<string, number> = {}
  for (const [id, t] of Object.entries(frontier)) frontierTurns[id] = t.turns
  return {
    generatedAt: new Date().toISOString(),
    matrixSource: matrix.source,
    scaffolds: matrix.scaffolds,
    topScaffolds: matrix.topScaffolds,
    rows: matrix.rows,
    dataset,
    frontierTurns,
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

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/oracle") {
      const id = url.searchParams.get("id") || ""
      const d = loadDataset()[id]
      if (!d) return new Response(JSON.stringify({ error: "no dataset row for " + id }), { status: 404, headers: { "content-type": "application/json" } })
      const github = d.repo && d.baseCommit ? `https://github.com/${d.repo}/commit/${d.baseCommit}` : ""
      const ft = loadFrontierTrajs()[id]
      let frontierTraj: { turns: number; text: string } | null = null
      if (ft) {
        let text = ""
        try {
          text = readFileSync(ft.file, "utf8").slice(0, 20000)
        } catch {}
        frontierTraj = { turns: ft.turns, text }
      }
      return new Response(
        JSON.stringify({
          id,
          instanceId: d.instanceId,
          repo: d.repo,
          difficulty: d.difficulty,
          statement: d.statement,
          patch: d.patch, // the GOLD/oracle patch
          testPatch: d.testPatch,
          github,
          frontierTraj, // competitor winning trajectory (only 4 on disk)
        }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } },
      )
    }
    if (url.pathname === "/api/data") {
      try {
        return new Response(JSON.stringify(buildData()), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        })
      } catch (e: any) {
        return new Response(JSON.stringify({ error: String(e?.stack || e) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      }
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
  },
})
console.log(`leaderboard-dashboard → http://localhost:${server.port}`)
console.log(`  reports roots: ${REPORT_ROOTS.join(", ")}`)
console.log(`  matrix: ${MATRIX_MD}`)

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
  else v.innerHTML = renderLive();
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
    const m = rows[id] || { id, repo: id.replace(/-\d+$/, ""), cells: {}, hash: -1, tier: "?" };
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
