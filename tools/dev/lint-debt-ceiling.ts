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
 * SCOPED RULES. A single repo-wide count cannot tell "50 assertions left the
 * production code" from "50 assertions moved INTO it", and for
 * `noNonNullAssertion` those are opposite events: `x!` in a test throws inside
 * the test that wrote it, `x!` in `src/` throws in a user's session. When the
 * 696 were measured, 593 were in tests and 103 in production — one number was
 * hiding two different problems, and the smaller, worse one could grow behind a
 * shrinking total.
 *
 * So a rule may instead be pinned per SCOPE (`prod` = non-test modules under
 * `src/`; `tests` = everything else, including `src/**\/*.test.ts` and
 * `src/**\/__tests__/`), each half a ceiling of its own. `noNonNullAssertion`
 * is pinned at prod 0 — production code may not gain one at all — while the test
 * population ratchets down separately.
 *
 * KNOWN LIMITATION (same class as silent-failure-growth): counts are
 * AGGREGATE, so removing one site and adding another nets zero and slips past.
 * Per-site identity would churn on every line-number shift. Bounding net growth
 * + the worst score is the job; substitution is caught by review. The scope
 * split narrows this for the rules it covers: substitution now has to happen
 * WITHIN a scope, and cannot launder test debt into production.
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

import { loadFreshBiomeReceipt } from "./biome-diagnostics-receipt"
import { collectBiomeTargets } from "./biome-targets"

const COMPLEXITY_RULE = "lint/complexity/noExcessiveCognitiveComplexity"
const SCORE_RE = /complexity of (\d+)/

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const biomeBin = join(repoRoot, "node_modules/.bin/biome")
const ceilingPath = join(repoRoot, "tools/dev/lint-debt-ceiling.json")

/** Where a diagnostic lives. `prod` is what ships. */
type Scope = "prod" | "tests"

export type Ceiling = {
  readonly note?: string
  readonly rules: Readonly<Record<string, number>>
  /** Rules pinned per scope instead of by one repo-wide total. A rule appears
   *  here XOR in `rules` — never both, so there is one ceiling per rule. */
  readonly scopedRules?: Readonly<Record<string, Readonly<Record<Scope, number>>>>
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

/**
 * Which half of the repo a diagnostic is in.
 *
 * `prod` is deliberately the NARROW definition — a module under `src/` that is
 * not itself a test. Colocated `src/**\/*.test.ts` and `src/**\/__tests__/`
 * files ship in the same tree but run only under the test runner, so they carry
 * the test risk profile, not production's. Everything not provably production
 * (tools, tests, an unrecognized path shape) is counted as `tests`: the prod
 * ceiling is the tight one, so an unclassifiable path must not be able to hide
 * there.
 */
export const scopeOfPath = (absOrRel: string): Scope => {
  const rel = absOrRel.startsWith(`${repoRoot}/`) ? absOrRel.slice(repoRoot.length + 1) : absOrRel
  if (!rel.startsWith("src/")) return "tests"
  if (/(?:^|\/)__tests__\//.test(rel)) return "tests"
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel)) return "tests"
  return "prod"
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

/** What one scan says about one ceiling file. */
export interface CeilingVerdict {
  /** Debt grew — the gate fails. */
  readonly regressions: readonly string[]
  /** A rule (or a scope of one) fired that the ceiling file does not cover.
   *  Also a failure: the closed universe is what stops new debt sliding in. */
  readonly unpinned: readonly string[]
  /** Debt shrank — advisory, locked in only by an explicit `--tighten`. */
  readonly drops: readonly string[]
  /** Rules pinned in both tables; the caller must refuse to report at all. */
  readonly doublePinned: readonly string[]
}

export const SCOPES: readonly Scope[] = ["prod", "tests"]

/** Key for the per-scope tally. NUL cannot appear in a rule name, so the two
 *  halves can never collide with a rule that merely contains the separator. */
export const scopeKey = (rule: string, scope: Scope): string => `${rule}\u0000${scope}`

/** `rule` → (`file` → count), so a breached ceiling can name the sites instead
 *  of only the number. */
export type SitesByRule = ReadonlyMap<string, ReadonlyMap<string, number>>

/** The scan's site index PAIRED with the scope classifier that reads it.
 *
 *  WHY A PAIR AND NOT TWO OPTIONAL ARGUMENTS. The first version took
 *  `sitesByRule?` and `scopeOfFile?` separately and its docstring said the
 *  second was "required alongside" the first. Nothing enforced that, and the
 *  failure was SILENT in the worst possible direction — measured:
 *
 *      scope given WITH scopeOfFile   : " — in src/a.ts (9)"
 *      scope given WITHOUT scopeOfFile: ""              <-- the pre-fix bug, back
 *      no scope at all                : " — in src/a.ts (9), tests/b.test.ts (2)"
 *
 *  A caller who wired the sites and forgot the classifier got a bare number on
 *  every SCOPED breach: exactly the defect this attribution was added to
 *  delete, reintroduced by half-wiring it, with no error anywhere. Making the
 *  two one value removes the half-wired state from the type system, so it needs
 *  no runtime check and no docstring promise. */
export type SiteAttribution = {
  readonly byRule: SitesByRule
  readonly scopeOfFile: (file: string) => Scope
}

/** How many files a breach lists before it stops. A regression is usually one
 *  or two sites; a rule that fires in fifty files is a config change, and the
 *  first few plus the count say that just as well as fifty lines would. */
export const SITE_LIST_CAP = 5

/** The `— in <file> (n), <file> (n)` suffix for one rule's breach line.
 *
 *  WHY THIS EXISTS. The gate used to print `lint/suspicious/noConsole: 75 > 69`
 *  and stop. Measured 2026-08-28, attributing that number to a file took six
 *  separate measurements — re-deriving the tool's own target set, re-running
 *  biome with the JSON reporter, and grouping by path by hand — and the answer
 *  turned out to be a scratch file a subagent had left in `tests/unit/`, which
 *  no amount of reading the diff would have shown. The count is the gate; the
 *  sites are what makes it actionable, and the scan already holds them.
 *
 *  `sites` is optional so the pure comparison keeps its existing signature and
 *  its existing output byte-for-byte when a caller does not supply them. */
export const siteSuffix = (
  sites: SiteAttribution | undefined,
  rule: string,
  scope?: Scope,
): string => {
  const byFile = sites?.byRule.get(rule)
  if (byFile === undefined || byFile.size === 0) return ""
  const rows = [...byFile]
    .filter(([file]) => scope === undefined || sites?.scopeOfFile(file) === scope)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (rows.length === 0) return ""
  const shown = rows.slice(0, SITE_LIST_CAP).map(([file, n]) => `${file} (${n})`)
  const rest = rows.length - shown.length
  return ` — in ${shown.join(", ")}${rest > 0 ? `, and ${rest} more file(s)` : ""}`
}

/**
 * Compare a scan against a ceiling file. Pure, and exported so the comparison
 * itself can be pinned by tests.
 *
 * That is not ceremony. Everything else here is observable when it breaks — a
 * crashed biome run, a missing report, a degenerate classification all announce
 * themselves. THIS is the part that fails silently: a scoped rule that quietly
 * stopped being compared would print the same reassuring summary line and gate
 * nothing, and the only way to notice would be for someone to add debt and see
 * it pass. So it is driven directly, on synthetic inputs, including the
 * substitution case the aggregate ceiling could not see.
 */
export const evaluateCeilings = (args: {
  readonly counts: ReadonlyMap<string, number>
  readonly scopedCounts: ReadonlyMap<string, number>
  readonly ceiling: Ceiling
  readonly worstComplexity: number
  readonly worstSite: string
  /** Optional. Present ⇒ every breach line names its files; absent ⇒ output is
   *  unchanged, which is what keeps the existing pins on this function valid.
   *  It is ONE value rather than two optional ones so the half-wired state that
   *  silently dropped scoped attribution cannot be expressed — see
   *  {@link SiteAttribution}. */
  readonly sites?: SiteAttribution
}): CeilingVerdict => {
  const { counts, scopedCounts, ceiling, worstComplexity, worstSite } = args
  const where = (rule: string, scope?: Scope): string => siteSuffix(args.sites, rule, scope)
  const pinned = ceiling.rules
  const scopedPinned = ceiling.scopedRules ?? {}

  // One ceiling per rule: a rule in BOTH tables would be checked twice under two
  // different definitions, and `--tighten` could not say which one it wrote.
  const doublePinned = Object.keys(scopedPinned).filter((r) => pinned[r] !== undefined)
  if (doublePinned.length > 0) return { regressions: [], unpinned: [], drops: [], doublePinned }

  const regressions: string[] = []
  const unpinned: string[] = []
  const drops: string[] = []

  for (const [rule, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const scoped = scopedPinned[rule]
    if (scoped !== undefined) {
      for (const scope of SCOPES) {
        const observed = scopedCounts.get(scopeKey(rule, scope)) ?? 0
        const cap = scoped[scope]
        if (cap === undefined) {
          unpinned.push(
            `  ${observed}× ${rule} [${scope}]  (scope absent from the ceiling ⇒ 0)${where(rule, scope)}`,
          )
        } else if (observed > cap) {
          regressions.push(`  ${rule} [${scope}]: ${observed} > ${cap}${where(rule, scope)}`)
        } else if (observed < cap) {
          drops.push(`${rule}[${scope}] ${cap}→${observed}`)
        }
      }
      continue
    }
    const cap = pinned[rule]
    if (cap === undefined) {
      unpinned.push(`  ${n}× ${rule}  (not in the ceiling file ⇒ ceiling 0)${where(rule)}`)
      continue
    }
    if (n > cap) regressions.push(`  ${rule}: ${n} > ${cap}${where(rule)}`)
    else if (n < cap) drops.push(`${rule} ${cap}→${n}`)
  }
  for (const [rule, cap] of Object.entries(pinned)) {
    if (!counts.has(rule) && cap > 0) drops.push(`${rule} ${cap}→0`)
  }
  // A scoped rule that stopped firing entirely still has to report its drop, or
  // the ceiling would silently stay above zero with nothing left to hold it.
  for (const [rule, scoped] of Object.entries(scopedPinned)) {
    if (counts.has(rule)) continue
    for (const scope of SCOPES) {
      const cap = scoped[scope]
      if (cap !== undefined && cap > 0) drops.push(`${rule}[${scope}] ${cap}→0`)
    }
  }
  if (worstComplexity > ceiling.worstComplexity) {
    regressions.push(
      `  worst cognitive complexity: ${worstComplexity} > ${ceiling.worstComplexity} (${worstSite})`,
    )
  } else if (worstComplexity < ceiling.worstComplexity) {
    drops.push(`worstComplexity ${ceiling.worstComplexity}→${worstComplexity}`)
  }
  return { regressions, unpinned, drops, doublePinned: [] }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Guarded so the pure halves above (`scopeOfPath`, `evaluateCeilings`) can be
// imported by their paired test without triggering a full biome scan of 7k
// files on import — which is what a bare top-level script would do, and did.
if (import.meta.main) {
  const targets = collectBiomeTargets(repoRoot)
  if (targets.length === 0) {
    console.error("lint-debt: collectBiomeTargets returned 0 files — the scan would be vacuous")
    process.exit(1)
  }

  // FAIL CLOSED on a broken split. If `scopeOfPath` ever stopped recognizing
  // production modules — a path-shape change from biome, an edited regex — every
  // diagnostic would fall into `tests`, and the `prod: 0` ceiling would report a
  // perfect score while enforcing nothing. That failure is SILENT and looks
  // exactly like success, so it is checked here rather than trusted: both
  // populations must be non-empty over the same file set the scan uses.
  const prodTargets = targets.filter((t) => scopeOfPath(t) === "prod").length
  if (prodTargets === 0 || prodTargets === targets.length) {
    console.error(
      `lint-debt: scope classification is degenerate — ${prodTargets} of ${targets.length} ` +
        "targets classified as `prod`. Every scoped ceiling would be measured against the " +
        "wrong population; refusing to report a pass.",
    )
    process.exit(1)
  }

  const receipt = loadFreshBiomeReceipt({ repoRoot, targets })
  const diagnostics = receipt === null ? runBiome(targets) : receipt.diagnostics
  if (receipt !== null) {
    console.log(`lint-debt: reused exact-input biome receipt ${receipt.receiptSha256.slice(0, 12)}`)
  }
  const counts = new Map<string, number>()
  const worstBySite = new Map<string, number>()
  let worstComplexity = 0
  let worstSite = "<none>"

  /** `${rule}\u0000${scope}` → count, for the rules pinned per scope. */
  const scopedCounts = new Map<string, number>()

  /** rule → file → count, so a breach can name its sites. Built in the SAME
   *  pass as `counts`, so the two can never describe different scans. */
  const sitesByRule = new Map<string, Map<string, number>>()

  for (const d of diagnostics) {
    const category = d.category
    if (typeof category !== "string" || category === "") continue
    counts.set(category, (counts.get(category) ?? 0) + 1)
    const byFile = sitesByRule.get(category) ?? new Map<string, number>()
    const file = pathOf(d)
    byFile.set(file, (byFile.get(file) ?? 0) + 1)
    sitesByRule.set(category, byFile)
    const k = scopeKey(category, scopeOfPath(pathOf(d)))
    scopedCounts.set(k, (scopedCounts.get(k) ?? 0) + 1)
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
  const scopedPinned = ceiling.scopedRules ?? {}

  const verdict = evaluateCeilings({
    counts,
    scopedCounts,
    ceiling,
    worstComplexity,
    worstSite,
    sites: { byRule: sitesByRule, scopeOfFile: scopeOfPath },
  })
  if (verdict.doublePinned.length > 0) {
    console.error(
      "lint-debt: these rules are pinned in BOTH `rules` and `scopedRules` — pick one:\n  " +
        verdict.doublePinned.join("\n  "),
    )
    process.exit(1)
  }
  const { regressions, unpinned, drops } = verdict

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
    const scopedRules: Record<string, Record<Scope, number>> = {}
    for (const rule of Object.keys(scopedPinned)) {
      scopedRules[rule] = {
        prod: scopedCounts.get(scopeKey(rule, "prod")) ?? 0,
        tests: scopedCounts.get(scopeKey(rule, "tests")) ?? 0,
      }
    }
    writeFileSync(
      ceilingPath,
      `${JSON.stringify(
        Object.keys(scopedRules).length > 0
          ? { ...ceiling, rules, scopedRules, worstComplexity }
          : { ...ceiling, rules, worstComplexity },
        null,
        2,
      )}\n`,
    )
    console.log(
      drops.length > 0
        ? `lint-debt: tightened — ${drops.join(", ")}`
        : "lint-debt: already at the floor, nothing to tighten",
    )
    process.exit(0)
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const scopedSummary = Object.keys(scopedPinned)
    .map((rule) => {
      const short = rule.replace(/^lint\/[a-z]+\//, "")
      const prod = scopedCounts.get(scopeKey(rule, "prod")) ?? 0
      const tests = scopedCounts.get(scopeKey(rule, "tests")) ?? 0
      return `${short} prod=${prod}/${scopedPinned[rule]?.prod ?? 0} tests=${tests}/${scopedPinned[rule]?.tests ?? 0}`
    })
    .join("; ")
  console.log(
    `lint-debt: ${total} diagnostics across ${counts.size} rules; ` +
      `worst complexity ${worstComplexity}/${ceiling.worstComplexity} (${worstSite})` +
      (scopedSummary === "" ? "" : `; ${scopedSummary}`),
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
    console.log(
      `[advisory] below ceiling (${drops.join(", ")}) — run \`bun run lint:debt --tighten\``,
    )
  }
}
