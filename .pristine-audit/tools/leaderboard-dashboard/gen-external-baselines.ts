/**
 * Generate `external-baselines.json` (consumed by the dashboard) from the downloaded Live
 * leaderboard JSONL + the curated Pro aggregate. Run:
 *   bun run tools/leaderboard-dashboard/gen-external-baselines.ts
 * Re-run when a newer Live `reports-<MMDD>.jsonl` is downloaded into rawdata/external/.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildExternalBaselines } from "./external-baselines"

const dir = join(import.meta.dir, "rawdata", "external")
const out = join(import.meta.dir, "external-baselines.json")

// Pick the newest live-leaderboard-*.jsonl (date-stamped).
const liveFile = readdirSync(dir)
  .filter((f) => f.startsWith("live-leaderboard-") && f.endsWith(".jsonl"))
  .sort()
  .pop()
if (liveFile === undefined) {
  console.error(`no live-leaderboard-*.jsonl in ${dir} — download reports-<MMDD>.jsonl first`)
  process.exit(1)
}

const baselines = buildExternalBaselines(readFileSync(join(dir, liveFile), "utf8"), liveFile)
writeFileSync(out, `${JSON.stringify(baselines, null, 2)}\n`)
const live = baselines.models.filter((m) => m.dataset === "live").length
const pro = baselines.models.filter((m) => m.dataset === "pro").length
console.log(
  `wrote ${out}: ${live} live model-results + ${pro} pro baselines, ` +
    `${Object.keys(baselines.liveResolvedBy).length} per-instance resolved-by entries (from ${liveFile})`,
)
