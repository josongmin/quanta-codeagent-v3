/**
 * External SOTA baseline ingestion (RFC jun-29 — SOTA++ in-house benchmark platform).
 *
 * An in-house Pro/Live benchmark is only credible if our resolve-rate sits NEXT TO the
 * external SOTA. This module normalizes the public leaderboards into ONE artifact the
 * dashboard consumes (`external-baselines.json`):
 *   - SWE-bench **Live** (microsoft): per-model resolve rates by subset + a per-instance
 *     "resolved-by which external models" map (the strongest external solvability signal —
 *     an instance resolved by ≥1 external model is provably solvable).
 *   - SWE-bench **Pro** (ScaleAI): per-model aggregate resolve rates (no public per-instance
 *     matrix exists — only aggregate % + failure CSVs + S3 trajectories), curated with
 *     explicit provenance.
 *
 * Live source = the leaderboard SSOT JSONL committed at
 *   github.com/swe-bench-live/swe-bench-live.github.io/main/reports-<MMDD>.jsonl
 * (date-stamped; re-pull periodically). `resolved` is per-line EITHER an int count OR an
 * array of instance_ids — we normalize both; only the array form yields per-instance data.
 */

/** One external model's aggregate result on a (dataset, subset). */
export interface ExternalModelResult {
  name: string
  dataset: "pro" | "live"
  set: string // lite | verified | full | public | tsjs | java | …
  total: number
  resolved: number
  rate: number // resolved / total, 0..1
  date?: string
}

export interface ExternalBaselines {
  generatedFrom: string // provenance (source file / url + as-of)
  models: ExternalModelResult[]
  /** instance_id → external models that RESOLVED it (Live only; the solvability oracle's
   *  external corroboration). Empty array = appeared but no external resolve observed. */
  liveResolvedBy: Record<string, string[]>
}

/** Parse the Live leaderboard JSONL text into normalized model results + per-instance
 *  resolved-by map. Tolerant of the int|array `resolved` field. Pure + tested. */
export const parseLiveLeaderboard = (
  jsonlText: string,
  _sourceLabel: string,
): { models: ExternalModelResult[]; liveResolvedBy: Record<string, string[]> } => {
  const models: ExternalModelResult[] = []
  const liveResolvedBy: Record<string, string[]> = {}
  for (const line of jsonlText.split("\n")) {
    const parsed = parseLeaderboardLine(line)
    if (parsed === null) continue // empty / malformed / no verdict — skipped
    models.push(parsed.model)
    // Per-instance: only the array form carried instance_ids (else resolvedIds is empty).
    for (const id of parsed.resolvedIds) {
      liveResolvedBy[id] ??= []
      liveResolvedBy[id].push(parsed.model.name)
    }
  }
  for (const id of Object.keys(liveResolvedBy)) {
    liveResolvedBy[id] = [...new Set(liveResolvedBy[id])].sort() // stable de-dup
  }
  return { models, liveResolvedBy }
}

/** Parse ONE leaderboard JSONL line → a model result + its resolved instance-ids (empty when
 *  the line carries only a count). Returns null for empty/malformed/no-verdict lines. Extracted
 *  so {@link parseLiveLeaderboard}'s loop stays a simple accumulator (complexity ratchet). */
const parseLeaderboardLine = (
  line: string,
): { model: ExternalModelResult; resolvedIds: string[] } | null => {
  const t = line.trim()
  if (t === "") return null
  let row: Record<string, unknown>
  try {
    row = JSON.parse(t) as Record<string, unknown>
  } catch {
    return null // malformed line, never throw
  }
  const name = typeof row.name === "string" ? row.name : undefined
  const total = typeof row.total === "number" ? row.total : undefined
  if (name === undefined || total === undefined || total <= 0) return null
  const rv = row.resolved
  const resolvedIds = Array.isArray(rv) ? rv.filter((x): x is string => typeof x === "string") : []
  const resolvedCount = Array.isArray(rv) ? rv.length : typeof rv === "number" ? rv : undefined
  if (resolvedCount === undefined) return null
  const model: ExternalModelResult = {
    name,
    dataset: "live",
    set: typeof row.set === "string" ? row.set : "full",
    total,
    resolved: resolvedCount,
    rate: resolvedCount / total,
    ...(typeof row.date === "string" ? { date: row.date } : {}),
  }
  return { model, resolvedIds }
}

/** Curated SWE-bench **Pro** aggregate SOTA — the open 731-instance public subset. No public
 *  per-instance matrix or JSON API exists (labs.scale.com is HTML; per-instance lives only in
 *  S3 trajectories), so these are transcribed from the published standardized-SEAL leaderboard
 *  with explicit provenance. Update the `asOf` + numbers when the leaderboard refreshes. */
export const PRO_BASELINE_ASOF =
  "2026-06 (labs.scale.com/leaderboard/swe_bench_pro_public, standardized SEAL)"
export const proBaselines = (): ExternalModelResult[] => {
  const pub = (name: string, rate: number): ExternalModelResult => ({
    name,
    dataset: "pro",
    set: "public-731",
    total: 731,
    resolved: Math.round(rate * 731),
    rate,
    date: "2026-06",
  })
  return [
    pub("gpt-5.4 (xHigh)", 0.591),
    pub("Muse Spark", 0.55),
    pub("claude-opus-4-6 (thinking)", 0.519),
    pub("gemini-3.1-pro (thinking)", 0.461),
    pub("claude-opus-4-5", 0.4589),
    pub("claude-4-5-sonnet", 0.436),
    pub("gpt-5 (High)", 0.4178),
    pub("gpt-5.2-codex", 0.4104),
  ]
}

/** Build the merged baselines artifact from a Live leaderboard JSONL. */
export const buildExternalBaselines = (
  liveJsonl: string,
  liveSourceLabel: string,
): ExternalBaselines => {
  const live = parseLiveLeaderboard(liveJsonl, liveSourceLabel)
  return {
    generatedFrom: `live=${liveSourceLabel}; pro=${PRO_BASELINE_ASOF}`,
    models: [...live.models, ...proBaselines()],
    liveResolvedBy: live.liveResolvedBy,
  }
}

/** Top external resolve-rate for a (dataset, set) — the SOTA number our run is measured against. */
export const sotaFor = (
  b: ExternalBaselines,
  dataset: "pro" | "live",
  set: string,
): ExternalModelResult | undefined =>
  b.models.filter((m) => m.dataset === dataset && m.set === set).sort((a, c) => c.rate - a.rate)[0]
