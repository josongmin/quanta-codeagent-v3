#!/usr/bin/env bun
/**
 * tb-report-emit — normalize a Terminal-Bench (harbor) result tree into ONE
 * report.json in the SAME SSOT IR the leaderboard dashboard already consumes for
 * SWE-bench verified/live/pro (RFC 06, jul-2). No suite abstraction, no dashboard
 * render changes: TB becomes a 4th `datasetFamily` that flows through the existing
 * report-scan → campaign-group → render pipeline.
 *
 * WHY (jul-3): harbor writes per-task `verifier/reward.txt` (0|1) + `result.json`
 * (started/finished, token/cost stats) under `<jobTs>/<task>__<hash>/`. That is a
 * DIFFERENT on-disk shape from our `*.report.json`, and it lives on the bench box.
 * This tool reads a (synced) harbor tree and emits `report.json` with
 * `datasetFamily:"terminal-bench"` + `perInstance:[{id:<task>, passed:reward===1}]`
 * so the dashboard shows the run identically to a verified campaign.
 *
 * The verdicts are the REAL harbor-graded rewards (the task's own hidden test
 * suite), read verbatim — not synthesized. The report carries
 * `source:"terminal-bench-harbor"` so provenance is explicit.
 *
 *   bun tb-report-emit.ts --tree ~/.quanta/bench/tb-raw/failset-levers \
 *       --preset "TB +levers" --model gpt-5.5 --tag levers [--out <dir>] [--dry-run]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

// ── pure core (unit-tested) ─────────────────────────────────────────────────

export interface TbInstance {
  /** task name (harbor dir `<task>__<hash>` → `<task>`). */
  id: string
  /** reward.txt === "1" (the task's own verifier passed). */
  passed: boolean
  /** finished_at − started_at from the task result.json, ms. 0 if unknown. */
  durationMs: number
  /** D1 (RFC jul-3): an INFRA fault, NOT a capability miss — a harbor task-level
   *  timeout/crash or an agent that died before producing a report. Folding these into
   *  `passed:false` deflates the score (a real-miss denominator should exclude them,
   *  mirroring jun-20 real_attempt). Absent ⇒ a genuine graded outcome. */
  error?: { readonly kind: "agent-timeout" | "agent-crash" }
}

/** Split a harbor task dir name `<task>__<hash>` → `<task>`. The hash suffix is a
 *  per-trial id; the task name is everything before the LAST `__`. */
export const taskNameFromDir = (dir: string): string => {
  const base = basename(dir)
  const i = base.lastIndexOf("__")
  return i > 0 ? base.slice(0, i) : base
}

/** D1 (RFC jul-3): classify an INFRA fault from a harbor task `result.json`, or undefined for a
 *  genuine graded outcome. Keyed on the AUTHORITATIVE `exception_info.exception_type` harbor records:
 *  `AgentTimeoutError` ⇒ task-level timeout; any other exception (CancelledError/crash) ⇒ agent-crash.
 *  (Empirically `metadata-absent ⊂ exception`, so `exception_info` alone is sufficient — a
 *  metadata-absence heuristic would false-flag a minimal-but-genuine result.json.) These are excluded
 *  from the capability-miss denominator (not a real miss). PURE. */
export const errorFromResult = (result: unknown): TbInstance["error"] | undefined => {
  if (typeof result !== "object" || result === null) return undefined
  const exc = (result as Record<string, unknown>).exception_info
  const excType =
    typeof exc === "object" && exc !== null
      ? (exc as Record<string, unknown>).exception_type
      : undefined
  if (typeof excType !== "string" || excType.length === 0) return undefined
  return { kind: excType === "AgentTimeoutError" ? "agent-timeout" : "agent-crash" }
}

/** Parse `finished_at`/`started_at` ISO strings → elapsed ms (0 if either absent). */
export const durationMsFromResult = (result: unknown): number => {
  if (typeof result !== "object" || result === null) return 0
  const r = result as Record<string, unknown>
  const s = typeof r.started_at === "string" ? Date.parse(r.started_at) : NaN
  const f = typeof r.finished_at === "string" ? Date.parse(r.finished_at) : NaN
  return Number.isFinite(s) && Number.isFinite(f) && f >= s ? f - s : 0
}

export interface TbReport {
  timestamp: string
  model: string | undefined
  datasetFamily: "terminal-bench"
  source: string
  /** P1-C (RFC jul-3): the A/B arm this run belongs to, stamped EXPLICITLY at emit
   *  (`--arm`) so the dashboard never has to guess it from a preset substring (which
   *  silently sorted an oc1/owned-only run into `baseline` and inverted the control). */
  arm?: "baseline" | "levers"
  knobs: { preset: string; resolved: Record<string, never>; inactive: never[] }
  perInstance: Array<{
    id: string
    passed: boolean
    turns: number
    durationMs: number
    error?: { readonly kind: "agent-timeout" | "agent-crash" }
  }>
}

/** Build a report.json shaped EXACTLY like a real bench report (perInstance +
 *  knobs.preset + model + datasetFamily) so the dashboard parses it identically.
 *  Dedups to ONE verdict per task (any-pass wins, mirroring the dashboard's
 *  any-pass=solved semantic and campaign-log-to-report's dedup). */
export const buildTbReport = (
  instances: readonly TbInstance[],
  opts: { preset: string; model: string | undefined; timestamp: string; arm?: "baseline" | "levers" },
): TbReport => {
  const best = new Map<string, TbInstance>()
  for (const inst of instances) {
    const cur = best.get(inst.id)
    if (cur === undefined || preferInstance(inst, cur)) best.set(inst.id, inst)
  }
  const rows = [...best.values()].sort((a, b) => a.id.localeCompare(b.id))
  return {
    timestamp: opts.timestamp,
    model: opts.model,
    datasetFamily: "terminal-bench",
    source: "terminal-bench-harbor",
    ...(opts.arm !== undefined ? { arm: opts.arm } : {}),
    knobs: { preset: opts.preset, resolved: {}, inactive: [] },
    perInstance: rows.map((r) => ({
      id: r.id,
      passed: r.passed,
      turns: 0, // harbor reward tree carries no turn count; trajectory-only.
      durationMs: r.durationMs,
      ...(r.error !== undefined ? { error: r.error } : {}),
    })),
  }
}

/** Dedup preference (P1-F, RFC jul-3): a PASS always beats a non-pass. Among two of the
 *  SAME pass-state, prefer the SHORTER run ONLY when both PASSED (a faster clean solve is
 *  the better representative). Among two FAILs, prefer the LONGER run — a fast fail is
 *  usually an infra crash (25s auth-death), and a 20-min genuine attempt is the more
 *  informative representative to RCA. `error`-free is preferred over `error` at equal state. */
const preferInstance = (inst: TbInstance, cur: TbInstance): boolean => {
  if (inst.passed !== cur.passed) return inst.passed
  if (cur.error !== undefined && inst.error === undefined) return true
  if (inst.error !== undefined && cur.error === undefined) return false
  if (inst.durationMs <= 0 || cur.durationMs <= 0) return false
  return inst.passed
    ? inst.durationMs < cur.durationMs // both passed: shorter wins
    : inst.durationMs > cur.durationMs // both failed: the longer (real) attempt wins
}

/** Read a harbor result tree (`<jobTs>/<task>__<hash>/verifier/reward.txt` +
 *  sibling `result.json`) into flat {@link TbInstance}[]. PURE over the fs it is
 *  handed via the injected `read` seam so it can be unit-tested on a fixture. */
export const scanHarborTree = (
  root: string,
  fs: {
    readdir: (p: string) => string[]
    isDir: (p: string) => boolean
    readFile: (p: string) => string | null
    exists: (p: string) => boolean
  },
): TbInstance[] => {
  const out: TbInstance[] = []
  if (!fs.exists(root)) return out
  // Layout: root/<jobTs>/<task>__<hash>/verifier/reward.txt
  for (const jobTs of fs.readdir(root)) {
    const jobDir = join(root, jobTs)
    if (!fs.isDir(jobDir)) continue
    for (const taskDir of fs.readdir(jobDir)) {
      const td = join(jobDir, taskDir)
      if (!fs.isDir(td)) continue
      const rewardPath = join(td, "verifier", "reward.txt")
      const reward = fs.readFile(rewardPath)
      if (reward === null) continue // not (yet) graded — skip
      let durationMs = 0
      let error: TbInstance["error"] | undefined
      const resultRaw = fs.readFile(join(td, "result.json"))
      if (resultRaw !== null) {
        try {
          const parsed = JSON.parse(resultRaw)
          durationMs = durationMsFromResult(parsed)
          error = errorFromResult(parsed)
        } catch {}
      }
      out.push({
        id: taskNameFromDir(taskDir),
        passed: reward.trim() === "1",
        durationMs,
        ...(error !== undefined ? { error } : {}),
      })
    }
  }
  return out
}

// ── IO shell ────────────────────────────────────────────────────────────────

const realFs = {
  readdir: (p: string): string[] => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  },
  isDir: (p: string): boolean => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  readFile: (p: string): string | null => {
    try {
      return readFileSync(p, "utf8")
    } catch {
      return null
    }
  },
  exists: (p: string): boolean => existsSync(p),
}

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const main = (): void => {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`)
  }
  const tree = argOf("--tree")
  const preset = argOf("--preset") ?? "terminal-bench"
  if (tree === undefined) {
    out(
      "usage: tb-report-emit.ts --tree <harbor-tree> [--preset name] [--model m] [--tag t] [--out dir] [--dry-run]",
    )
    process.exit(2)
  }
  // P3-A: do NOT fabricate a model — an absent --model stays undefined (the report must not
  // LIE about which model produced the rewards; record-winning-config). Downstream renders it
  // as "unknown model", never a made-up id.
  const model = argOf("--model")
  // P1-C: explicit A/B arm; unset ⇒ undefined (the dashboard falls back to preset substring only
  // for OLD reports that predate this flag).
  const armRaw = argOf("--arm")
  const arm = armRaw === "baseline" || armRaw === "levers" ? armRaw : undefined
  if (armRaw !== undefined && arm === undefined) {
    out(`invalid --arm "${armRaw}" (expected baseline|levers)`)
    process.exit(2)
  }
  const tag = argOf("--tag") ?? "tb"
  const outDir =
    argOf("--out") ??
    (process.env.QUANTA_BENCH_RESULTS_DIR && process.env.QUANTA_BENCH_RESULTS_DIR !== "off"
      ? process.env.QUANTA_BENCH_RESULTS_DIR
      : join(homedir(), ".quanta", "bench", "results"))

  const instances = scanHarborTree(tree, realFs)
  if (instances.length === 0) {
    out(`no graded tasks found under ${tree}`)
    process.exit(1)
  }
  const report = buildTbReport(instances, {
    preset,
    model,
    timestamp: new Date().toISOString(),
    ...(arm !== undefined ? { arm } : {}),
  })
  const passed = report.perInstance.filter((p) => p.passed)
  const dest = join(outDir, `report-terminal-bench-${tag}.report.json`)
  if (process.argv.includes("--dry-run")) {
    out(`[dry-run] would write ${dest}`)
  } else {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(dest, JSON.stringify(report, null, 2))
    out(`wrote ${basename(dest)} → ${outDir}`)
  }
  out(
    `  ${report.perInstance.length} tasks (${passed.length} PASS) family=terminal-bench preset="${preset}"`,
  )
}

if (import.meta.main) main()
