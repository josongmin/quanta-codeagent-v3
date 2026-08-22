/**
 * Cognitive-complexity ceiling ratchet (one-directional).
 *
 * WHY THIS EXISTS. `biome.json` declares
 * `complexity/noExcessiveCognitiveComplexity` with `maxAllowedComplexity: 15`
 * at level **warn**. `biome check` only exits non-zero on ERROR diagnostics and
 * CI does not pass `--error-on-warnings`, so that rule gates NOTHING — while
 * AGENTS.md described it as "gated". Flipping the rule to `error` is not an
 * option: hundreds of pre-existing sites would turn every unrelated PR red.
 *
 * So the rule stays advisory per-site, and THIS is the gate: the repo-wide
 * COUNT of over-threshold functions and the WORST single score are pinned to a
 * one-directional ceiling, the same shape as the other house ratchets
 * (`silent-failure-growth`, `god-code`):
 *
 *   count/worst >  ceiling  → REGRESSION, exit 1 (split the function; never
 *                             raise the ceiling to get unblocked)
 *   count/worst <= ceiling  → PASS. A drop prints a "you can tighten to N"
 *                             advisory instead of forcing a reflexive bump
 *                             (silent-failure-growth D14 / META-LESSON #6).
 *
 * KNOWN LIMITATION (same class as the silent-failure ratchet's): these are
 * AGGREGATE counts with no per-site identity, so a commit that splits one god
 * function and adds another nets zero and slips past. Per-site identity would
 * churn on every line-number shift. Bounding net growth + the worst score is
 * the job here; substitution is caught by review and by the god-FUNCTION
 * length ratchet (`tools/god-code/detect.ts`), which IS per-site.
 *
 * The scan reflects the RUNTIME linter over the SAME file set `bun run lint`
 * uses (`collectBiomeTargets`) — not a source-text regex — so it cannot drift
 * from what developers see locally.
 *
 * Usage:
 *   bun run tools/dev/complexity-ceiling.ts            # check (CI)
 *   bun run tools/dev/complexity-ceiling.ts --tighten  # lock in an improvement
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { collectBiomeTargets } from "./biome-targets"

const RULE = "lint/complexity/noExcessiveCognitiveComplexity"
const SCORE_RE = /Excessive complexity of (\d+) detected/

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const biomeBin = join(repoRoot, "node_modules/.bin/biome")
const ceilingPath = join(repoRoot, "tools/dev/complexity-ceiling.json")

type Ceiling = { readonly count: number; readonly worst: number; readonly note?: string }

type BiomeDiagnostic = {
  readonly category?: string
  readonly message?: unknown
  readonly location?: { readonly path?: unknown }
}

/** Biome's JSON `message` is either a string or an array of `{content}` spans. */
const messageText = (message: unknown): string => {
  if (typeof message === "string") return message
  if (Array.isArray(message)) {
    return message
      .map((part) =>
        part && typeof part === "object" && "content" in part
          ? String((part as { content: unknown }).content)
          : "",
      )
      .join("")
  }
  return ""
}

const pathOf = (d: BiomeDiagnostic): string => {
  const p = d.location?.path
  if (typeof p === "string") return p
  if (p && typeof p === "object" && "file" in p) return String((p as { file: unknown }).file)
  return "<unknown>"
}

const runBiome = (targets: readonly string[]): readonly BiomeDiagnostic[] => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-complexity-"))
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
      // binary, crash) — a silent "0 violations" here would be vacuous.
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
  console.error("complexity-ceiling: collectBiomeTargets returned 0 files — scan would be vacuous")
  process.exit(1)
}

const diagnostics = runBiome(targets)
const hits = diagnostics.filter((d) => d.category === RULE)

const perFile = new Map<string, number>()
let worst = 0
let worstSite = "<none>"
for (const d of hits) {
  const rel = pathOf(d)
  perFile.set(rel, (perFile.get(rel) ?? 0) + 1)
  const m = SCORE_RE.exec(messageText(d.message))
  const score = m ? Number(m[1]) : 0
  if (score > worst) {
    worst = score
    worstSite = rel
  }
}

if (hits.length > 0 && worst === 0) {
  console.error(
    "complexity-ceiling: matched diagnostics but parsed no score — `Excessive complexity of N` message shape drifted",
  )
  process.exit(1)
}

const ceiling = JSON.parse(readFileSync(ceilingPath, "utf8")) as Ceiling
const observed = { count: hits.length, worst }

const topFiles = (): string =>
  [...perFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([f, n]) => `  ${n}× ${f}`)
    .join("\n")

if (process.argv.includes("--tighten")) {
  if (observed.count > ceiling.count || observed.worst > ceiling.worst) {
    console.error("complexity-ceiling: refusing to --tighten a REGRESSION (ceilings only go down)")
    process.exit(1)
  }
  writeFileSync(
    ceilingPath,
    `${JSON.stringify({ ...ceiling, count: observed.count, worst: observed.worst }, null, 2)}\n`,
  )
  console.log(
    `complexity-ceiling: tightened count ${ceiling.count} → ${observed.count}, worst ${ceiling.worst} → ${observed.worst}`,
  )
  process.exit(0)
}

let failed = false
if (observed.count > ceiling.count) {
  console.error(
    `REGRESSION: over-threshold functions rose to ${observed.count} (ceiling ${ceiling.count}). ` +
      `Split the new function instead of raising the ceiling. Top files:\n${topFiles()}`,
  )
  failed = true
}
if (observed.worst > ceiling.worst) {
  console.error(
    `REGRESSION: worst cognitive complexity rose to ${observed.worst} (ceiling ${ceiling.worst}) at ${worstSite}.`,
  )
  failed = true
}
if (failed) process.exit(1)

console.log(
  `complexity-ceiling: count ${observed.count}/${ceiling.count}, worst ${observed.worst}/${ceiling.worst} (${worstSite})`,
)
if (observed.count < ceiling.count || observed.worst < ceiling.worst) {
  console.log(
    `[advisory] below ceiling — run \`bun run lint:complexity --tighten\` to lock in count=${observed.count} worst=${observed.worst}`,
  )
}
