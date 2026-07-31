#!/usr/bin/env bun
/**
 * SWE-bench Verified 10-pick measurement set selector.
 *
 * Distinct from the 6-pick smoke (`select.ts` + `picks.jsonl`) which is a
 * frozen regression baseline of trivial `<15 min fix` instances. This 10-pick
 * is a **measurement-sensitive** set, hand-stratified to maximize signal
 * detection for A/B knob measurements.
 *
 * THE CRITERIA ("기깔나는 기준"):
 *
 *   Tier A — Anchor (3 instances, `<15 min fix`, light repos):
 *     Stable-pass references. If these regress → infra broken, not knob.
 *     Reuses the 3 proven stable-pass picks from the 6-pick set.
 *
 *   Tier B — Discrimination (4 instances, `15 min - 1 hour` fix):
 *     Signal-sensitive zone. Pass rate ~30-70% — A/B knob effects detectable
 *     within practical n=3 trials. Avoid noise-zone (always-pass) and
 *     ceiling-zone (always-fail at our model). Multi-line patches, 1-3
 *     FAIL_TO_PASS tests, single-file fix.
 *
 *   Tier C — Stretch (3 instances, `1-4 hours` fix):
 *     Model capability ceiling. Hard instances where stronger model + better
 *     knob combos make detectable difference. Multi-file allowed (up to 3),
 *     more FAIL_TO_PASS allowed (up to 10). Helps separate "model can't"
 *     from "knob can't help".
 *
 * Cross-cutting axes (across the 10):
 *   - Test framework diversity: pytest, unittest, doctest
 *   - Repo size: small (requests ~50 files) to large (sympy/django >2000)
 *   - Bug category: URL/parser, web framework, lint, test infra, math, web
 *   - Issue style: terse, verbose-traceback, code-heavy
 *
 * USAGE:
 *   bun run tests/smoke/swebench/select-10.ts --audit
 *     Verify each candidate exists in Verified + matches its tier criteria.
 *
 *   bun run tests/smoke/swebench/select-10.ts --write
 *     Fetch + write `picks-10.jsonl` verbatim from upstream.
 *
 *   bun run tests/smoke/swebench/select-10.ts --suggest
 *     Print ranked Tier B/C candidates from Verified (so the operator can
 *     swap a Tier B/C pick by editing CANDIDATES below).
 *
 * The selector is intentionally OPINIONATED — we curate 10 instances by hand
 * rather than auto-sampling, because measurement designs (especially for n=3
 * trials × multiple knobs) need stable, interpretable per-instance baselines.
 */

import type { Row } from "./select"
import { violations as smokeViolations } from "./select"

const DATASET = "princeton-nlp/SWE-bench_Verified"
const ROWS_API = "https://datasets-server.huggingface.co/rows"

// ── Tier definitions ────────────────────────────────────────────────────────

/** Tier A: Anchors — known stable-pass at gpt-5-mini baseline (n=3 trials each
 *  confirmed 3/3 in `runs/variance-r1-mini/`). These must remain in Verified
 *  matching the `<15 min fix` smoke criteria (delegated to `select.ts`). */
export const ANCHOR_PICKS = [
  "psf__requests-5414",
  "pallets__flask-5014",
  "sympy__sympy-13480",
] as const

/** Tier B: Discrimination — medium difficulty, signal-sensitive at gpt-5-mini.
 *  Picks chosen for:
 *    - pylint-4970: known stable-FAIL at gpt-5-mini (0/3) — anchors model
 *      ceiling, becomes pass with stronger model. Good for knob×model A/B.
 *    - pytest-7982: pathlib edge case, single-file, light repo. Currently
 *      passes but with longer turns than Tier A.
 *    - sympy-16886: known noise instance (2/3 at gpt-5-mini) — variance
 *      detection probe.
 *    - sphinx-8595: NEW — sphinx ext autodoc edge, medium fix. Adds
 *      docstring/extension diversity not in current 6-pick. */
export const DISCRIM_PICKS = [
  "pylint-dev__pylint-4970",
  "pytest-dev__pytest-7982",
  "sympy__sympy-16886",
  "sphinx-doc__sphinx-8595",
] as const

/** Tier C: Stretch — `1-4 hours` difficulty, ≤3 files. Pinned from `--suggest`
 *  output (verified to exist in upstream Verified):
 *    - pylint-8898 (3 files, f2p=1): pylint multi-file stretch
 *    - pytest-5787 (1 file, f2p=2): pytest harder fix
 *    - sympy-12489 (1 file, f2p=1): sympy mathematics stretch
 *  Together with Tier A/B they span 4 ecosystems (requests/flask/pytest/pylint
 *  /sphinx/sympy/django-optional) and 3 difficulty tiers. */
export const STRETCH_PICKS = [
  "pylint-dev__pylint-8898",
  "pytest-dev__pytest-5787",
  "sympy__sympy-12489",
] as const

export const PICKS_10 = [...ANCHOR_PICKS, ...DISCRIM_PICKS, ...STRETCH_PICKS] as const

/** Smoke-of-smoke (3 picks): one from each tier, fastest possible sanity.
 *  Used as PR-gate / pre-measurement check (~10min, ~$0.30). If this fails,
 *  don't bother running the 10-pick. */
export const SMOKE_3 = [
  "psf__requests-5414", // Tier A: stable-pass infra sanity (cheap clone, light)
  "sympy__sympy-16886", // Tier B: known noise instance (2/3) — variance probe
  "pylint-dev__pylint-8898", // Tier C: stretch — model ceiling probe
] as const

// ── Tier-specific gates ─────────────────────────────────────────────────────

/** Light-plus-DJANGO repos. Tier C adds django (pure python, slow setup but
 *  no C-extension chain — feasible). Excluded: scikit-learn / matplotlib /
 *  astropy / xarray (heavy C/numeric deps make CI flakey). */
const TIER_REPOS = new Set([
  "psf/requests",
  "pallets/flask",
  "pylint-dev/pylint",
  "pytest-dev/pytest",
  "sympy/sympy",
  "sphinx-doc/sphinx",
  "django/django",
])

const f2pCount = (row: Row): number => {
  try {
    return (JSON.parse(row.FAIL_TO_PASS) as unknown[]).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const goldFileCount = (patch: string): number => {
  const m = patch.matchAll(/diff --git a\/(\S+) /g)
  return new Set([...m].map((x) => x[1] as string)).size
}

/** Tier B gate — medium fix, signal-sensitive. */
export const violationsB = (row: Row): string[] => {
  const v: string[] = []
  if (!["<15 min fix", "15 min - 1 hour"].includes(row.difficulty)) {
    v.push(`difficulty=${row.difficulty}`)
  }
  const files = goldFileCount(row.patch)
  if (files > 2) v.push(`goldFiles=${files}`)
  const f2p = f2pCount(row)
  if (f2p === 0 || f2p > 5) v.push(`failToPass=${f2p}`)
  if (!TIER_REPOS.has(row.repo)) v.push(`repo=${row.repo}`)
  return v
}

/** Tier C gate — harder, multi-file ok. */
export const violationsC = (row: Row): string[] => {
  const v: string[] = []
  if (!["15 min - 1 hour", "1-4 hours"].includes(row.difficulty)) {
    v.push(`difficulty=${row.difficulty}`)
  }
  const files = goldFileCount(row.patch)
  if (files > 3) v.push(`goldFiles=${files}`)
  const f2p = f2pCount(row)
  if (f2p === 0 || f2p > 10) v.push(`failToPass=${f2p}`)
  if (!TIER_REPOS.has(row.repo)) v.push(`repo=${row.repo}`)
  return v
}

const fetchAll = async (): Promise<Row[]> => {
  const rows: Row[] = []
  for (let offset = 0; offset < 500; offset += 100) {
    const url = `${ROWS_API}?dataset=${encodeURIComponent(DATASET)}&config=default&split=test&offset=${offset}&length=100`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HF rows API ${res.status} at offset ${offset}`)
    const body = (await res.json()) as { rows: { row: Row }[] }
    rows.push(...body.rows.map((r) => r.row))
  }
  return rows
}

const tierOf = (id: string): "A" | "B" | "C" | "?" => {
  if ((ANCHOR_PICKS as readonly string[]).includes(id)) return "A"
  if ((DISCRIM_PICKS as readonly string[]).includes(id)) return "B"
  if ((STRETCH_PICKS as readonly string[]).includes(id)) return "C"
  return "?"
}

const auditRow = (row: Row, tier: "A" | "B" | "C"): string[] => {
  if (tier === "A") return smokeViolations(row)
  if (tier === "B") return violationsB(row)
  return violationsC(row)
}

const printAudit = async (): Promise<void> => {
  const all = await fetchAll()
  const byId = new Map(all.map((r) => [r.instance_id, r]))

  let bad = 0
  for (const id of PICKS_10) {
    const t = tierOf(id)
    const r = byId.get(id)
    if (!r) {
      bad++
      continue
    }
    const v = auditRow(r, t === "?" ? "B" : t)
    const _f2p = f2pCount(r)
    const _files = goldFileCount(r.patch)
    const _tag = v.length === 0 ? "✓" : "✗"

    if (v.length) bad++
  }
  if (bad > 0) {
    process.exit(1)
  }
}

const printSuggest = async (): Promise<void> => {
  const all = await fetchAll()

  const b = all
    .filter((r) => violationsB(r).length === 0)
    .filter((r) => !(PICKS_10 as readonly string[]).includes(r.instance_id))
    .slice(0, 30)
  for (const _r of b) {
  }

  const c = all
    .filter((r) => violationsC(r).length === 0)
    .filter((r) => !(PICKS_10 as readonly string[]).includes(r.instance_id))
    .slice(0, 30)
  for (const _r of c) {
  }
}

const writePicksImpl = async (ids: readonly string[], outName: string): Promise<void> => {
  const all = await fetchAll()
  const byId = new Map(all.map((r) => [r.instance_id, r]))
  const lines: string[] = []
  for (const id of ids) {
    const r = byId.get(id)
    if (!r) {
      throw new Error(`pinned instance not in dataset: ${id} — run --suggest to find alternates`)
    }
    lines.push(JSON.stringify(r))
  }
  await Bun.write(`${import.meta.dir}/${outName}`, `${lines.join("\n")}\n`)
}

const writePicks = async (): Promise<void> => {
  await writePicksImpl(PICKS_10, "picks-10.jsonl")
  await writePicksImpl(SMOKE_3, "picks-3.jsonl")
}

const main = async (): Promise<void> => {
  if (process.argv.includes("--write")) {
    await writePicks()
    return
  }
  if (process.argv.includes("--suggest")) {
    await printSuggest()
    return
  }
  await printAudit()
}

if (import.meta.main) await main()
