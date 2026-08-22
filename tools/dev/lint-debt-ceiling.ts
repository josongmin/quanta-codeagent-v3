/**
 * Lint-debt ceiling ratchet — per-rule, one-directional, closed-universe.
 *
 * WHY THIS EXISTS. `bun run lint` (biome) exits non-zero only on ERROR
 * diagnostics. Everything declared at `warn` — `noNonNullAssertion` (696),
 * `noExcessiveCognitiveComplexity` (398), `noConsole` (71), … — gates NOTHING,
 * so ~1200 diagnostics had accumulated with no mechanism that could even notice
 * them growing. Flipping those rules to `error` is not an option (every
 * unrelated PR would go red on pre-existing debt), and "we'll fix them
 * eventually" is how the pile got here.
 *
 * So severity stays as-is and the COUNT is the gate, in the house
 * one-directional shape (`god-code`, `silent-failure-growth`):
 *
 *   count > ceiling  → REGRESSION, exit 1 (fix the new site; never raise the
 *                      ceiling to get unblocked)
 *   count <= ceiling → PASS, with a "you can tighten to N" advisory on a drop,
 *                      so an improvement is locked in deliberately rather than
 *                      a red test forcing a reflexive bump.
 *
 * CLOSED UNIVERSE (the part that makes this more than a counter): a rule that
 * fires but is ABSENT from the ceiling file is treated as ceiling 0 and fails.
 * A plain per-rule table only ratchets the debt you already knew about — a
 * newly-enabled rule, a biome upgrade that adds diagnostics, or a rule renamed
 * upstream would all slide in silently. Here they land as "unpinned rule".
 *
 * WORST SCORE. Counts alone cannot see one function being grown into a
 * monster (complexity 40 → 122 is still one diagnostic), so
 * `noExcessiveCognitiveComplexity` additionally pins the highest single score.
 * This subsumes the earlier `tools/dev/complexity-ceiling.ts`.
 *
 * KNOWN LIMITATION (same class as silent-failure-growth): counts are
 * AGGREGATE, so removing one site and adding another nets zero and slips past.
 * Per-site identity would churn on every line-number shift. Bounding net growth
 * + the worst score is the job; substitution is caught by review.
 *
 * The scan reflects the RUNTIME linter over the SAME file set `bun run lint`
 * uses (`collectBiomeTargets`), so it cannot drift from what developers see.
 *
 * Usage:
 *   bun run lint:debt              # check (CI)
 *   bun run lint:debt --tighten    # lock in an improvement (never raises)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { collectBiomeTargets } from "./biome-targets"

const COMPLEXITY_RULE = "lint/complexity/noExcessiveCognitiveComplexity"
const SCORE_RE = /complexity of (\d+)/

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const biomeBin = join(repoRoot, "node_modules/.bin/biome")
const ceilingPath = join(repoRoot, "tools/dev/lint-debt-ceiling.json")

type Ceiling = {
  readonly note?: string
  readonly rules: Readonly<Record<string, number>>
  readonly worstComplexity: number
}

type BiomeDiagnostic = {
  readonly category?: string
  readonly message?: unknown
  readonly location?: { readonly path?: unknown }
}

/** Biome's JSON `message` is a string or an array of `{content}` spans. */
const messageText = (message: unknown): string => {
  if (typeof message === "string") return message
  if (!Array.isArray(message)) return ""
  return message
    .map((part) =>
      part && typeof part === "object" && "content" in part
        ? String((part as { content: unknown }).content)
        : "",
    )
    .join("")
}

const pathOf = (d: BiomeDiagnostic): string => {
  const p = d.location?.path
  if (typeof p === "string") return p
  if (p && typeof p === "object" && "file" in p) return String((p as { file: unknown }).file)
  return "<unknown>"
}

const runBiome = (targets: readonly string[]): readonly BiomeDiagnostic[] => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-lint-debt-"))
  const reportPath = join(dir, "report.json")
  try {
    const proc = Bun.spawnSync(
      [
        biomeBin,
        "check",
        "--reporter=json",
        `--reporter-file=${reportPath}`,
        "--max-diagnostics=100000",
        ...targets,
      ],
      { cwd: repoRoot, stdout: "ignore", stderr: "pipe" },
    )
    let raw: string
    try {
      raw = readFileSync(reportPath, "utf8")
    } catch {
      // Fail CLOSED: no report means the linter never ran (bad flag, missing
      // binary, crash). A silent "0 diagnostics" here would be vacuous.
      throw new Error(
        `biome produced no JSON report (exit ${proc.exitCode}). stderr:\n${proc.stderr.toString()}`,
      )
    }
    const parsed = JSON.parse(raw) as { diagnostics?: readonly BiomeDiagnostic[] }
    if (!Array.isArray(parsed.diagnostics)) {
      throw new Error("biome JSON report has no `diagnostics` array — reporter shape drifted")
    }
    return parsed.diagnostics
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const targets = collectBiomeTargets(repoRoot)
if (targets.length === 0) {
  console.error("lint-debt: collectBiomeTargets returned 0 files — the scan would be vacuous")
  process.exit(1)
}

const diagnostics = runBiome(targets)
const counts = new Map<string, number>()
const worstBySite = new Map<string, number>()
let worstComplexity = 0
let worstSite = "<none>"

for (const d of diagnostics) {
  const category = d.category
  if (typeof category !== "string" || category === "") continue
  counts.set(category, (counts.get(category) ?? 0) + 1)
  if (category !== COMPLEXITY_RULE) continue
  const m = SCORE_RE.exec(messageText(d.message))
  const score = m ? Number(m[1]) : 0
  const site = pathOf(d)
  worstBySite.set(site, Math.max(worstBySite.get(site) ?? 0, score))
  if (score > worstComplexity) {
    worstComplexity = score
    worstSite = site
  }
}

const complexityCount = counts.get(COMPLEXITY_RULE) ?? 0
if (complexityCount > 0 && worstComplexity === 0) {
  console.error(
    "lint-debt: matched complexity diagnostics but parsed no score — the " +
      "`complexity of N` message shape drifted; refusing to pass on an unmeasured worst",
  )
  process.exit(1)
}

const ceiling = JSON.parse(readFileSync(ceilingPath, "utf8")) as Ceiling
const pinned = ceiling.rules

const regressions: string[] = []
const unpinned: string[] = []
const drops: string[] = []

for (const [rule, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  const cap = pinned[rule]
  if (cap === undefined) {
    unpinned.push(`  ${n}× ${rule}  (not in the ceiling file ⇒ ceiling 0)`)
    continue
  }
  if (n > cap) regressions.push(`  ${rule}: ${n} > ${cap}`)
  else if (n < cap) drops.push(`${rule} ${cap}→${n}`)
}
for (const [rule, cap] of Object.entries(pinned)) {
  if (!counts.has(rule) && cap > 0) drops.push(`${rule} ${cap}→0`)
}
if (worstComplexity > ceiling.worstComplexity) {
  regressions.push(
    `  worst cognitive complexity: ${worstComplexity} > ${ceiling.worstComplexity} (${worstSite})`,
  )
} else if (worstComplexity < ceiling.worstComplexity) {
  drops.push(`worstComplexity ${ceiling.worstComplexity}→${worstComplexity}`)
}

if (process.argv.includes("--tighten")) {
  if (regressions.length > 0 || unpinned.length > 0) {
    console.error(
      "lint-debt: refusing to --tighten while there is a REGRESSION or an unpinned rule " +
        "(ceilings only go DOWN):\n" +
        [...regressions, ...unpinned].join("\n"),
    )
    process.exit(1)
  }
  const rules: Record<string, number> = {}
  for (const rule of Object.keys(pinned)) rules[rule] = counts.get(rule) ?? 0
  writeFileSync(
    ceilingPath,
    `${JSON.stringify({ ...ceiling, rules, worstComplexity }, null, 2)}\n`,
  )
  console.log(
    drops.length > 0
      ? `lint-debt: tightened — ${drops.join(", ")}`
      : "lint-debt: already at the floor, nothing to tighten",
  )
  process.exit(0)
}

const total = [...counts.values()].reduce((a, b) => a + b, 0)
console.log(
  `lint-debt: ${total} diagnostics across ${counts.size} rules; ` +
    `worst complexity ${worstComplexity}/${ceiling.worstComplexity} (${worstSite})`,
)

if (unpinned.length > 0) {
  console.error(
    "UNPINNED RULE(S) — a rule fired that the ceiling file does not know about. " +
      "Either fix the sites, or add the rule to tools/dev/lint-debt-ceiling.json with a " +
      "deliberate starting count (which then only goes DOWN):\n" +
      unpinned.join("\n"),
  )
}
if (regressions.length > 0) {
  console.error(
    "REGRESSION — lint debt grew. Fix the new site(s); do NOT raise the ceiling:\n" +
      regressions.join("\n"),
  )
}
if (unpinned.length > 0 || regressions.length > 0) process.exit(1)

if (drops.length > 0) {
  console.log(`[advisory] below ceiling (${drops.join(", ")}) — run \`bun run lint:debt --tighten\``)
}
