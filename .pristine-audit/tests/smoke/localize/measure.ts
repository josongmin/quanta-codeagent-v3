/**
 * R-Phase9 `localize` empirical calibration script.
 *
 *   Usage:  bun run tests/smoke/localize/measure.ts > baseline.json
 *
 * Loads `corpus.json`, drives `localizeTool` against the current repo for each
 * entry, parses the ranked file list out of `result.output`, and computes
 * recall@1 / recall@3 / recall@5 / MRR per query and aggregate.
 *
 * Pure helpers (`parseRanking`, `recallAtK`, `mrr`, `aggregate`) are exported
 * so `tests/unit/localize-measure.test.ts` can exercise the measurement logic
 * itself without spawning ripgrep. The main driver (`measureAll`) is gated
 * behind `import.meta.main` so test imports do NOT execute the corpus.
 *
 * NOT a regression test — see tests/smoke/localize/README.md for rationale.
 */

import { readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { localizeTool } from "../../../src/tool/localize"
import type { ToolEvent } from "../../../src/tool/types"

/**
 * The corpus + the prior baseline output BOTH live INSIDE the search tree and
 * contain every query verbatim — so a naive measurement would surface them as
 * top hits for themselves. That is measurement-instrument contamination, not a
 * real ranking signal, so we filter them from predictions BEFORE scoring. This
 * is the ONLY non-cosmetic transform applied to predictions.
 *
 * Stability invariant: this list is FIXED across runs (it does not include
 * `measure.ts` itself even though that file does contain some query tokens in
 * comments, because measure.ts is part of the codebase being searched and
 * filtering it would be moving goalposts). If you add files here, document
 * each one — every entry is a deliberate trade-off, not a heuristic knob.
 */
const MEASUREMENT_ARTIFACTS = new Set<string>([
  "tests/smoke/localize/corpus.json",
  "tests/smoke/localize/baseline.json",
  // R-Phase10: the post-R-Phase9 snapshot is preserved as a historical record
  // and lives in-tree. It contains every corpus id + many src/ path strings in
  // predicted_top5, which ripgrep would otherwise rank as a top hit for itself.
  // Same rationale as baseline.json — measurement instrument, not signal.
  "tests/smoke/localize/post-r-phase9.json",
  // R-Phase10 measurement snapshots — same instrument-contamination
  // rationale (they contain corpus ids + path strings that would self-rank).
  "tests/smoke/localize/post-r-phase10-old-corpus.json",
  "tests/smoke/localize/post-r-phase10.json",
])

// ── Types ────────────────────────────────────────────────────────────────

export interface CorpusEntry {
  id: string
  query: string
  scope: string
  expected_files: string[]
  rationale: string
}

export interface QueryReport {
  id: string
  predicted_top5: string[]
  rank_of_first_expected: number // 1-based; 0 ⇒ no expected file found
  "recall@1": number
  "recall@3": number
  "recall@5": number
}

export interface AggregateReport {
  "recall@1": number
  "recall@3": number
  "recall@5": number
  MRR: number
  n: number
}

export interface MeasureReport {
  schemaVersion: 1
  cwd: string
  git_sha: string
  queries: QueryReport[]
  aggregate: AggregateReport
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────

/**
 * Extract the ranked file list from a localize tool's `result.output`.
 *
 * Output shape (per src/tool/localize/index.ts `render`):
 *   <file>           ← group label (no leading whitespace)
 *     <file>:<line>  <snippet>   ← indented row (TWO leading spaces)
 *     ...
 *   <file>
 *     ...
 *
 * Only indented rows carry the actual ranking; the group label is just a
 * grouping artifact and may not coincide with the FIRST indented row's
 * file (it usually does, but we don't rely on that).
 *
 * Ranking semantics: the ORDER of indented rows IS the ranked-row order;
 * we collapse to a ranked-FILE order by keeping the first occurrence of
 * each path. This mirrors how a downstream consumer would read the list.
 *
 * @param output `ToolResult.output` from `localizeTool.execute`.
 * @returns      Ranked file list, deduplicated, first-occurrence-wins.
 */
export const parseRanking = (output: string): string[] => {
  const seen = new Set<string>()
  const ranked: string[] = []
  for (const raw of output.split("\n")) {
    if (!raw.startsWith("  ")) continue // group labels skipped — only indented rows rank
    const body = raw.slice(2) // strip the two-space indent
    // `body` is "<file>:<line>  <snippet>". Take everything before the FIRST `:<digits>`.
    const m = body.match(/^(.+?):\d+\b/)
    if (!m) continue
    const file = m[1]
    if (!file) continue
    if (seen.has(file)) continue
    seen.add(file)
    ranked.push(file)
  }
  return ranked
}

/**
 * Normalize a predicted-file list so it can be compared against the corpus's
 * relative-path `expected_files`:
 *   1. Relativize absolute paths under `cwd` (the localize tool currently
 *      emits absolute paths whenever `path: "."` is jailed to `cwd`).
 *   2. Drop the measurement-artifact files (see `MEASUREMENT_ARTIFACTS` above).
 *   3. Preserve order; never re-rank.
 */
export const normalizePredictions = (paths: string[], cwd: string): string[] => {
  const out: string[] = []
  for (const p of paths) {
    let rel = p
    // Absolute → relative under cwd. `relative` returns the abs path unchanged
    // when it sits outside cwd, which is fine — those rows simply won't match
    // any corpus `expected_files` (which are repo-relative).
    if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) {
      const r = relative(cwd, p)
      if (r && !r.startsWith("..")) rel = r
    }
    if (MEASUREMENT_ARTIFACTS.has(rel)) continue
    out.push(rel)
  }
  return out
}

/**
 * Per-query recall@K.
 *   recall@K = |expected ∩ predicted_top_K| / |expected|
 *
 * Returns `0` when `expected` is empty (the corpus must avoid this, but the
 * helper is defensive). Membership is exact string equality on path — no
 * normalization. Both arrays should already be in the same path style
 * (corpus stores forward slashes; localize emits forward slashes).
 */
export const recallAtK = (expected: string[], predicted: string[], k: number): number => {
  if (expected.length === 0) return 0
  const topK = new Set(predicted.slice(0, k))
  let hits = 0
  for (const e of expected) {
    if (topK.has(e)) hits++
  }
  return hits / expected.length
}

/**
 * Per-query Mean Reciprocal Rank contribution.
 *   mrr(query) = 1 / rank_of_first_expected, with `rank_of_first_expected`
 *   being the 1-based position of the FIRST expected file in `predicted`;
 *   0 (the contribution) when no expected file appears anywhere in
 *   `predicted`.
 *
 * The "aggregate MRR" reported in the JSON is the arithmetic mean of these
 * per-query contributions across the corpus.
 */
export const mrr = (expected: string[], predicted: string[]): number => {
  const expectedSet = new Set(expected)
  for (let i = 0; i < predicted.length; i++) {
    const p = predicted[i]
    if (p !== undefined && expectedSet.has(p)) return 1 / (i + 1)
  }
  return 0
}

/** First-found 1-based rank of any expected file (0 if none). */
export const rankOfFirstExpected = (expected: string[], predicted: string[]): number => {
  const expectedSet = new Set(expected)
  for (let i = 0; i < predicted.length; i++) {
    const p = predicted[i]
    if (p !== undefined && expectedSet.has(p)) return i + 1
  }
  return 0
}

/**
 * Aggregate per-query reports into the four headline numbers.
 * Aggregate = arithmetic mean across all queries (n is the corpus size).
 * `mrrValues` is supplied separately because `QueryReport` carries
 * `rank_of_first_expected` (a position) not `1/rank` directly.
 */
export const aggregate = (reports: QueryReport[], mrrValues: number[]): AggregateReport => {
  const n = reports.length
  if (n === 0) {
    return { "recall@1": 0, "recall@3": 0, "recall@5": 0, MRR: 0, n: 0 }
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    "recall@1": mean(reports.map((r) => r["recall@1"])),
    "recall@3": mean(reports.map((r) => r["recall@3"])),
    "recall@5": mean(reports.map((r) => r["recall@5"])),
    MRR: mean(mrrValues),
    n,
  }
}

// ── Driver (NOT unit-tested; only runs when invoked directly) ──────────

const drive = async (query: string, scope: string, cwd: string): Promise<string> => {
  let output = ""
  for await (const ev of localizeTool.execute(
    { query, path: scope, max_results: 20 },
    { cwd, signal: new AbortController().signal },
  ) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") output = ev.result.output
  }
  return output
}

const readGitSha = (cwd: string): string => {
  try {
    const out = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--short", "HEAD"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    return new TextDecoder().decode(out.stdout).trim() || "unknown"
  } catch {
    return "unknown"
  }
}

const measureAll = async (): Promise<MeasureReport> => {
  const here = dirname(fileURLToPath(import.meta.url))
  const corpusPath = join(here, "corpus.json")
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
    entries: CorpusEntry[]
  }

  const cwd = process.cwd()
  const queries: QueryReport[] = []
  const mrrValues: number[] = []

  for (const entry of corpus.entries) {
    const output = await drive(entry.query, entry.scope, cwd)
    const ranked = normalizePredictions(parseRanking(output), cwd)
    const rank = rankOfFirstExpected(entry.expected_files, ranked)
    const report: QueryReport = {
      id: entry.id,
      predicted_top5: ranked.slice(0, 5),
      rank_of_first_expected: rank,
      "recall@1": recallAtK(entry.expected_files, ranked, 1),
      "recall@3": recallAtK(entry.expected_files, ranked, 3),
      "recall@5": recallAtK(entry.expected_files, ranked, 5),
    }
    queries.push(report)
    mrrValues.push(mrr(entry.expected_files, ranked))
  }

  return {
    schemaVersion: 1,
    cwd,
    git_sha: readGitSha(cwd),
    queries,
    aggregate: aggregate(queries, mrrValues),
  }
}

if (import.meta.main) {
  measureAll()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    })
    .catch((err: unknown) => {
      process.stderr.write(`measure failed: ${String(err)}\n`)
      process.exit(1)
    })
}
