import { basename } from "node:path"

/** Minimal run shape {@link campaignKeyOf} needs (extracted from server.ts so the
 *  partition logic is unit-testable — server.ts calls `Bun.serve` at import and can't
 *  be imported by a test). */
export interface RunKeyFields {
  file: string
  label: string
  model: string
  datasetFamily: string
}

/**
 * Group key for a run's campaign. Shards / full-remote sidecars / local singles roll
 * up; the fallback is the run label.
 *
 * RFC jun-29 R4 PARTITION: a pro/live run NEVER merges into a verified campaign — else
 * a Pro resolved-rate is unioned with (and averaged into) the Verified leaderboard
 * number, the exact dataset-conflation R4 fences. Verified gets NO prefix, so the
 * existing 100% of runs keep byte-identical campaign keys.
 */
export const campaignKeyOf = (run: RunKeyFields): string => {
  const dir = basename(run.file.replace(/\/[^/]+$/, ""))
  const shardMatch = run.label.match(/^(.*?)[-_]?shard(\d+)$/i)
  const base = /^report-i-/.test(run.label)
    ? `${dir} · full-remote (${run.model})`
    : shardMatch
      ? `${dir}/${shardMatch[1] || "shard"}`
      : /^local-/.test(run.label)
        ? `${dir}/local-singles`
        : run.label
  return run.datasetFamily && run.datasetFamily !== "verified"
    ? `[${run.datasetFamily}] ${base}`
    : base
}
