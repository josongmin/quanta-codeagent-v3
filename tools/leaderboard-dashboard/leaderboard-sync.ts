#!/usr/bin/env bun
/**
 * leaderboard-sync — make the bench REPORT files the single source of truth and
 * keep docs/swebench-leaderboard.yaml from silently diverging from them.
 *
 * WHY (jun-28): we had TWO SSOTs — the dashboard reads REPORT files (the
 * canonical `mirrorReportToSsot` sink, live), while the curated leaderboard.yaml
 * was hand-folded. A result folded into the yaml never reached the dashboard, and
 * a graded report never reached the yaml unless someone remembered to fold it.
 *
 * This tool reads the ONE canonical sink (`~/.quanta/bench/results`, the same
 * "keep first so it always wins" root the dashboard server uses) and reconciles
 * the solved set against the leaderboard:
 *   --check (default): print MISSING (solved in reports, absent from the yaml) and
 *     OVERCLAIM (in the yaml, no passing report). Exits non-zero on divergence so
 *     it can gate CI / a pre-commit hook.
 *   --emit: print a ready-to-append leaderboard run-block (auto-derived from the
 *     reports) for the MISSING instances — folding becomes one paste, not manual.
 *
 * The reports stay THE SSOT; the yaml becomes a verified derivative + human
 * curation (audit_flags / notes), never a parallel hand-maintained truth.
 */
import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ── pure core (unit-tested; no IO) ──────────────────────────────────────────

export interface ReportRow {
  id: string
  passed: boolean
  preset: string | undefined
  model: string | undefined
  turns: number | undefined
  /** epoch ms — used to break ties toward the most recent passing receipt. */
  ts: number
}

export interface SolvedReceipt {
  id: string
  preset: string | undefined
  model: string | undefined
  turns: number | undefined
}

const SWE_ID = /^[a-z0-9_-]+__[a-z0-9_.-]+-\d+$/i

/** An instance is SOLVED if ANY report graded it passed. The receipt is the
 *  passing run with the FEWEST turns (the cleanest solve), ties broken toward the
 *  most recent. Non-SWE ids (fixtures like "a"/"x") are ignored. */
export function solvedFromReports(rows: readonly ReportRow[]): Map<string, SolvedReceipt> {
  const best = new Map<string, ReportRow>()
  for (const r of rows) {
    if (!r.passed || !SWE_ID.test(r.id)) continue
    const cur = best.get(r.id)
    if (cur === undefined) {
      best.set(r.id, r)
      continue
    }
    const rt = r.turns ?? Number.POSITIVE_INFINITY
    const ct = cur.turns ?? Number.POSITIVE_INFINITY
    if (rt < ct || (rt === ct && r.ts > cur.ts)) best.set(r.id, r)
  }
  const out = new Map<string, SolvedReceipt>()
  for (const [id, r] of best) {
    out.set(id, { id, preset: r.preset, model: r.model, turns: r.turns })
  }
  return out
}

export interface Reconciliation {
  /** Solved in the reports but NOT listed resolved in the leaderboard — fold these. */
  missing: SolvedReceipt[]
  /** Listed resolved in the leaderboard but NO passing report backs it — stale / over-claim. */
  overclaim: string[]
}

export function reconcile(
  solved: ReadonlyMap<string, SolvedReceipt>,
  resolvedInYaml: ReadonlySet<string>,
): Reconciliation {
  const missing: SolvedReceipt[] = []
  for (const [id, receipt] of solved) {
    if (!resolvedInYaml.has(id)) missing.push(receipt)
  }
  const overclaim: string[] = []
  for (const id of resolvedInYaml) {
    if (!solved.has(id)) overclaim.push(id)
  }
  missing.sort((a, b) => a.id.localeCompare(b.id))
  overclaim.sort()
  return { missing, overclaim }
}

const repoOf = (id: string): string => {
  const owner = id.split("__")[0] ?? id
  return (
    { "pytest-dev": "pytest", "pylint-dev": "pylint", "sphinx-doc": "sphinx", pydata: "xarray" }[
      owner
    ] ?? owner
  )
}

/** Render a ready-to-append leaderboard run-block YAML for the missing solves. */
export function emitRunblock(missing: readonly SolvedReceipt[], date: string): string {
  if (missing.length === 0)
    return "# (nothing to fold — leaderboard is in sync with the report SSOT)\n"
  const lines = [
    `- run_id: sync-derived-${date}`,
    `  date: '${date}'`,
    "  preset: '(derived from report SSOT — see per-instance receipts)'",
    "  model: '(see reports)'",
    "  grading: official swebench python harness",
    "  scope: 'AUTO-DERIVED by leaderboard-sync: instances with a passing report not yet folded. Verify provenance before trusting as clean.'",
    `  resolved_count: ${missing.length}`,
    "  resolved:",
  ]
  for (const r of missing) {
    lines.push(`  - instance_id: ${r.id}  # preset=${r.preset ?? "?"} model=${r.model ?? "?"}`)
    lines.push(`    repo: ${repoOf(r.id)}`)
    if (r.turns !== undefined) lines.push(`    turns: ${r.turns}`)
  }
  return `${lines.join("\n")}\n`
}

// ── IO shell ────────────────────────────────────────────────────────────────

const HOME = homedir()
const LEADERBOARD = join(import.meta.dir, "..", "..", "docs", "swebench-leaderboard.yaml")

// Read the SAME report trove the dashboard server reads, so this tool can never
// disagree with the dashboard's view. KEEP IN SYNC with server.ts REPORT_ROOTS /
// PRUNE_DIR / the report-file match (TODO: extract a shared report-source module
// to make that mechanical). The canonical mirror sink is first.
const REPORT_ROOTS: string[] = [
  process.env.QUANTA_BENCH_RESULTS_DIR && process.env.QUANTA_BENCH_RESULTS_DIR !== "off"
    ? process.env.QUANTA_BENCH_RESULTS_DIR
    : join(HOME, ".quanta", "bench", "results"),
  join(HOME, "reprovote-ab"),
  join(HOME, "easy-more"),
  join(HOME, "Library", "quanta-codeagent-v3", "bench"),
  join(HOME, "Library", "quanta-codeagent-v3", "bench-slices"),
]
const PRUNE_DIR =
  /^(repo|repo-.*|swebench-.*|node_modules|__pycache__|\.git|venv|\.venv|site-packages)$/
const isReportFile = (name: string): boolean =>
  !name.startsWith("tmp__") && (name.endsWith(".report.json") || /^report.*\.json$/.test(name))

const walkReportFiles = (root: string, acc: string[], depth = 0): void => {
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
    if (st.isDirectory()) walkReportFiles(p, acc, depth + 1)
    else if (isReportFile(e)) acc.push(p)
  }
}

const readReportRows = (roots: readonly string[]): ReportRow[] => {
  const files: string[] = []
  for (const root of roots) walkReportFiles(root, files)
  const rows: ReportRow[] = []
  for (const p of files) {
    let st: Stats
    let d: Record<string, unknown>
    try {
      st = statSync(p)
      d = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
    } catch {
      continue
    }
    const preset = (d.knobs as { preset?: string })?.preset
    const model = d.model as string | undefined
    const pi = (d.perInstance ?? d.results) as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(pi)) continue
    for (const r of pi) {
      const id = (r.id ?? r.instance_id) as string | undefined
      if (id === undefined) continue
      rows.push({
        id,
        passed: r.passed === true,
        preset,
        model,
        turns: typeof r.turns === "number" ? r.turns : undefined,
        ts: st.mtimeMs,
      })
    }
  }
  return rows
}

const resolvedIdsFromLeaderboard = (path: string): Set<string> => {
  const ids = new Set<string>()
  if (!existsSync(path)) return ids
  // Light parse: every `instance_id: <id>` under the runs' resolved lists.
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*-?\s*instance_id:\s*([a-z0-9_.-]+__[a-z0-9_.-]+-\d+)/i)
    if (m?.[1] !== undefined && SWE_ID.test(m[1])) ids.add(m[1])
  }
  return ids
}

const main = (): void => {
  const mode = process.argv.includes("--emit") ? "emit" : "check"
  const rows = readReportRows(REPORT_ROOTS)
  const solved = solvedFromReports(rows)
  const resolved = resolvedIdsFromLeaderboard(LEADERBOARD)
  const { missing, overclaim } = reconcile(solved, resolved)

  if (mode === "emit") {
    const date = new Date().toISOString().slice(0, 10)
    process.stdout.write(emitRunblock(missing, date))
    return
  }
  console.log(`leaderboard-sync — SSOT: report trove (${REPORT_ROOTS.length} roots)`)
  console.log(`  reports: ${rows.length} rows | solved instances: ${solved.size}`)
  console.log(`  leaderboard resolved: ${resolved.size}`)
  console.log(`  MISSING (solved in reports, not folded): ${missing.length}`)
  for (const r of missing)
    console.log(`    + ${r.id} (preset=${r.preset ?? "?"} turns=${r.turns ?? "?"})`)
  console.log(`  OVERCLAIM (in leaderboard, no passing report): ${overclaim.length}`)
  for (const id of overclaim) console.log(`    - ${id}`)
  if (missing.length > 0 || overclaim.length > 0) {
    console.log("\n  → run with --emit to print a run-block for the MISSING set.")
    process.exit(1)
  }
  console.log("  ✓ in sync")
}

if (import.meta.main) main()
