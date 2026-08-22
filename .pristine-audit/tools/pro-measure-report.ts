/**
 * SOTA++ Pro measurement CLI (RFC jun-29). Two modes over the full-remote report dir + the
 * Python-Pro-266 dataset — both built on the TESTED pure core (src/apps/bench/pro-measure.ts):
 *
 *   --remaining <dataset.jsonl>   → print instance_ids NOT yet graded (campaign resume feed)
 *   (default)   <dataset.jsonl>   → print the solvability-gated measurement + Wilson CI + vs-SOTA
 *
 * The supervisor (tools/pro-measure.sh) calls --remaining each round to feed the next chunk and
 * the default mode at the end for the headline number. Read-only over reports; no spawning.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  filterPythonProIds,
  type InstanceOutcome,
  tallyMeasurement,
  vsExternalLine,
} from "../src/apps/bench/pro-measure"

const REPORT_DIR = join(homedir(), "Library/quanta-codeagent-v3/bench/full-remote")
const EXTERNAL = join(import.meta.dir, "leaderboard-dashboard/external-baselines.json")

const datasetArg = process.argv.find((a) => a.endsWith(".jsonl"))
if (datasetArg === undefined) {
  console.error("usage: bun run tools/pro-measure-report.ts [--remaining] <dataset.jsonl>")
  process.exit(2)
}

/** All Python-Pro instance_ids in the target dataset (the measurement universe). */
const universe = filterPythonProIds(
  readFileSync(datasetArg, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>),
)
const universeSet = new Set(universe)

/** Latest per-instance outcome across ALL family=pro reports (last write wins on dup id). */
const collectProOutcomes = (): Map<string, InstanceOutcome> => {
  const byId = new Map<string, InstanceOutcome>()
  if (!existsSync(REPORT_DIR)) return byId
  // Sort by mtime ASCENDING so newest-write wins the dedup — readdir order is filesystem
  // (name/inode) order, NOT time, so a re-graded instance's latest verdict must be applied last.
  const files = readdirSync(REPORT_DIR)
    .filter((n) => /^report-i-.*\.json$/.test(n))
    .map((n) => ({ n, mtime: statSync(join(REPORT_DIR, n)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map((x) => x.n)
  for (const f of files) {
    let r: Record<string, unknown>
    try {
      r = JSON.parse(readFileSync(join(REPORT_DIR, f), "utf8")) as Record<string, unknown>
    } catch {
      continue
    }
    if (r.datasetFamily !== "pro") continue
    for (const pi of (r.perInstance as Array<Record<string, unknown>>) ?? []) {
      const id = typeof pi.id === "string" ? pi.id : undefined
      if (id === undefined || !universeSet.has(id)) continue
      const verdict = typeof pi.verdict === "string" ? (pi.verdict as InstanceOutcome["verdict"]) : undefined
      byId.set(
        id,
        verdict === undefined
          ? { id, passed: pi.passed === true }
          : { id, passed: pi.passed === true, verdict },
      )
    }
  }
  return byId
}

const outcomes = collectProOutcomes()

if (process.argv.includes("--remaining")) {
  // Resume feed: ids in the universe with NO outcome yet.
  for (const id of universe) if (!outcomes.has(id)) console.log(id)
  process.exit(0)
}

// Measurement mode.
const m = tallyMeasurement([...outcomes.values()])
let extPct: number | undefined
let extModel: string | undefined
if (existsSync(EXTERNAL)) {
  try {
    const b = JSON.parse(readFileSync(EXTERNAL, "utf8")) as {
      models?: Array<{ name: string; dataset: string; set: string; rate: number }>
    }
    const top = (b.models ?? [])
      .filter((x) => x.dataset === "pro")
      .sort((a, c) => c.rate - a.rate)[0]
    if (top) {
      extPct = top.rate * 100
      extModel = top.name
    }
  } catch {
    // external baseline optional
  }
}

console.log("=== SOTA++ Pro measurement (Python-266 subset) ===")
console.log(`graded:      ${outcomes.size} / ${universe.length} universe`)
console.log(`measurable:  ${m.measurable}  (holes excluded: ${m.holes})`)
console.log(`resolved:    ${m.resolved}`)
console.log(`rate:        ${m.ratePct}%  (Wilson 95% CI ${m.ci95[0]}–${m.ci95[1]}%)`)
console.log(vsExternalLine(m.ratePct, extPct, extModel))
