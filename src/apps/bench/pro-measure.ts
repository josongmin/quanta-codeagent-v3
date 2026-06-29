/**
 * SOTA++ Pro MEASUREMENT aggregator (RFC jun-29 — in-house Pro benchmark).
 *
 * The n=5 pilot proved the Pro pipeline grades; this turns it into a real MEASUREMENT:
 *   - the addressable subset (Python-Pro 266 — our pytest/repro stack reaches it; go/js/ts
 *     are weaker lanes per the analysis),
 *   - a resume plan (skip already-graded instances so a multi-box, multi-session campaign is
 *     checkpoint-restartable without re-spending),
 *   - a solvability-GATED tally with a Wilson 95% CI — measurement-holes (gold-broken /
 *     env-failed / degraded) leave the denominator (never counted as model misses; the #1
 *     rule), and the CI makes "n is still small" honest instead of a bare point estimate,
 *   - a vs-external-SOTA line.
 *
 * Pure + framework-free — the supervisor (tools/pro-measure.sh) feeds it parsed inputs. Slice:
 * takes plain rows/outcomes, no corpus/runner imports, so it's app-slice-clean + unit-testable.
 */

/** Pro repos whose `repo_language` is Python — the subset our stack addresses directly. */
export const PYTHON_PRO_REPOS: ReadonlySet<string> = new Set([
  "ansible/ansible",
  "internetarchive/openlibrary",
  "qutebrowser/qutebrowser",
])

/** instance_ids of the Python-Pro subset (case-insensitive `repo_language` startsWith "py"). */
export const filterPythonProIds = (
  rows: ReadonlyArray<{ instance_id?: unknown; repo_language?: unknown }>,
): string[] =>
  rows
    .filter(
      (r) =>
        typeof r.instance_id === "string" &&
        typeof r.repo_language === "string" &&
        r.repo_language.toLowerCase().startsWith("py"),
    )
    .map((r) => r.instance_id as string)

/** Remaining-work chunks: drop `done` ids, keep source order, split into `chunkSize` groups.
 *  Empty result ⇒ campaign complete. */
export const planResumeChunks = (
  allIds: readonly string[],
  done: ReadonlySet<string>,
  chunkSize: number,
): string[][] => {
  const remaining = allIds.filter((id) => !done.has(id))
  const size = Math.max(1, chunkSize)
  const chunks: string[][] = []
  for (let i = 0; i < remaining.length; i += size) chunks.push(remaining.slice(i, i + size))
  return chunks
}

/** A measurement-hole verdict = excluded from the denominator (NOT a model miss). */
const HOLE_VERDICTS: ReadonlySet<string> = new Set([
  "grader_invalid",
  "env_prep_failed",
  "degraded",
])

export interface InstanceOutcome {
  id: string
  passed: boolean
  verdict?: "ok" | "degraded" | "env_prep_failed" | "grader_invalid"
}

export interface Measurement {
  resolved: number
  measurable: number // denominator: graded, non-hole instances
  holes: number // excluded measurement-holes
  ratePct: number // round(100 * resolved / measurable), 0 when measurable=0
  ci95: [number, number] // Wilson 95% interval on the rate, percent points
}

/** Wilson score 95% interval (z=1.96) for `resolved` of `n`, returned in PERCENT. n=0 ⇒ [0,0]. */
const wilson95 = (resolved: number, n: number): [number, number] => {
  if (n <= 0) return [0, 0]
  const z = 1.96
  const p = resolved / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  const lo = Math.max(0, center - half)
  const hi = Math.min(1, center + half)
  return [Math.round(lo * 100), Math.round(hi * 100)]
}

/** Solvability-gated tally: measurement-holes leave the denominator; resolved-rate + Wilson CI. */
export const tallyMeasurement = (outcomes: readonly InstanceOutcome[]): Measurement => {
  const measurableOutcomes = outcomes.filter((o) => !HOLE_VERDICTS.has(o.verdict ?? "ok"))
  const measurable = measurableOutcomes.length
  const resolved = measurableOutcomes.filter((o) => o.passed).length
  const holes = outcomes.length - measurable
  const ratePct = measurable > 0 ? Math.round((100 * resolved) / measurable) : 0
  return { resolved, measurable, holes, ratePct, ci95: wilson95(resolved, measurable) }
}

/** One-line "ours vs external SOTA" — POPULATION-HONEST. Our number is the Python-266 subset;
 *  the published Pro SOTA is the FULL 731 (incl. go/js/ts, our weak lanes). Those are different
 *  populations, so the line states both + a not-comparable caveat — "67% vs 59%" must NEVER read
 *  as "we beat SOTA" (a subset-vs-full comparison is a classic benchmark lie). */
export const vsExternalLine = (
  oursPct: number,
  externalSotaPct: number | undefined,
  externalModel: string | undefined,
): string =>
  externalSotaPct === undefined
    ? `ours ${oursPct}% (Python-266 subset; no external baseline)`
    : `ours ${oursPct}% (Python-266 subset) · external SOTA ${Math.round(externalSotaPct)}% (${externalModel ?? "?"}, full-731) — ⚠ different populations, NOT directly comparable (ours excludes go/js/ts)`
