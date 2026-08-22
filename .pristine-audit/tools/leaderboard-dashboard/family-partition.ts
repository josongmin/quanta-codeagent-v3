import { basename } from "node:path"

/** Minimal run shape {@link campaignKeyOf} needs (extracted from server.ts so the
 *  partition logic is unit-testable — server.ts calls `Bun.serve` at import and can't
 *  be imported by a test). */
export interface RunKeyFields {
  file: string
  label: string
  model: string
  /**
   * BFND-03: the run's SUITE-SCOPED identity segment, produced by its projector
   * (`ProjectedRun.campaignIdentity`) — a SWE family for SWE runs, a benchmark
   * version + pinned dataset ref for Terminal ones. The campaign key starts with
   * suite identity, so reports of incompatible identities never coalesce.
   */
  campaignIdentity: string
}

/**
 * Group key for a run's campaign. Shards / full-remote sidecars / local singles roll
 * up; the fallback is the run label.
 *
 * RFC jun-29 R4 PARTITION: a pro/live run NEVER merges into a verified campaign — else
 * a Pro resolved-rate is unioned with (and averaged into) the Verified leaderboard
 * number, the exact dataset-conflation R4 fences. Verified projects to an EMPTY
 * identity segment and so gets NO prefix, which is what keeps the existing 100% of
 * runs on byte-identical campaign keys.
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
  return run.campaignIdentity ? `[${run.campaignIdentity}] ${base}` : base
}
