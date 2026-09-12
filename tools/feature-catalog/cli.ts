#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: CLI tool — plain console.log/console.error is the intended IO surface.
/**
 * Feature-catalog CLI.
 *
 * Commands:
 *   build              — render docs/10.feature-catalog.md
 *   validate           — zod + cross-feature + evidence-on-disk checks
 *   list [filters]     — print id · title · maturity (filters: --maturity, --status, --section)
 *   show <id>          — full YAML for one feature
 *   add <section> <slug> — scaffold a template YAML
 *   diff               — compare current MD against fresh render (line diff)
 *   ci                 — validate → diff → lint from one loaded YAML snapshot
 *   check-evidence     — verify evidence files exist
 *   graph              — emit DOT dependency DAG (depends_on) to stdout
 *
 * Exit codes: 0=ok, 1=error, 2=usage.
 *
 * No logger — plain console.log/console.error.
 */
import { execFileSync } from "node:child_process"
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  type AdrRecord,
  type AuditReport,
  formatAuditReport,
  parseAdrStatus,
  runAudit,
} from "./audit"
import {
  mergeDiffSources,
  parseDiffNameStatus,
  parseUntrackedFiles,
  runCheckChanged,
} from "./check-changed"
import { createFeatureEvidenceSnapshot, type FeatureEvidenceSnapshot } from "./evidence-snapshot"
import { loadFcBaseline, runLint, saveFcBaseline, snapshotBaseline } from "./lint"
import { computeReachability, computeSymbolReachability } from "./reachability"
import { loadBaseline, loadProse, renderCatalog } from "./render"
import {
  computeGrade,
  computeJudgment,
  type Feature,
  type LoadedFeature,
  loadFeaturesStrict,
  SECTION_NAMES,
  SECTION_SLUGS,
  validateInvariants,
} from "./schema"
import { applyAuditedVerdicts, deriveSurfaceIntegration } from "./surface-derive"
import {
  compareTestAuditBaseline,
  formatTestAuditReport,
  loadTestAuditBaseline,
  runTestAuditFromDisk,
  saveTestAuditBaseline,
  type TestAuditBaselineComparison,
  type TestAuditReport,
} from "./test-audit"
import { parseYaml, stringifyYaml } from "./yaml"

// The repo root, anchored on THIS file rather than on the ambient cwd.
//
// Every evidence path in the catalog is repo-relative (`src/…`), and this is what
// resolves them. As `process.cwd()` it produced two different silent failures at
// once: from the repo root everything resolved, and from anywhere else nothing
// did — which combined with the equally cwd-relative catalog directory to make
// `validate` report "0 feature(s), all evidence resolved" and exit 0. Anchoring
// the catalog alone turned that into 9,593 errors; anchoring the evidence root
// too is what makes the two runs identical.
/**
 * `--repo-root <abs>` points the whole tool at another tree.
 *
 * The escape hatch that replaces cwd injection. `feature-catalog-evidence-existence-hellgate`
 * built a fixture catalog in a temp dir and ran the CLI with `cwd` set to it; once
 * the tool stopped trusting the cwd, that fixture became unreachable and its
 * companion assertion silently started measuring the REAL catalog instead — a test
 * that passed for the wrong reason. An explicit absolute root keeps the fixture
 * reachable without letting the ambient cwd decide anything.
 */
/**
 * The commit being rendered, for baseline provenance. Returns `null` when git is
 * unavailable or the tree is dirty.
 *
 * A DIRTY tree deliberately reads as no-commit: the measurement would describe
 * the committed state while the doc describes the working tree, and "close
 * enough" is how the footer came to assert two toolchain failures that did not
 * exist. Failing to stale is the safe direction — the footer then reports what
 * was measured instead of claiming a verdict.
 */
const headCommit = (): string | null => {
  try {
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (dirty !== "") return null
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

const resolveRepoRoot = (): string => {
  // Both spellings. Matching only the exact token meant `--repo-root=<abs>` was
  // not recognised as an override AND was not rejected by four commands that do
  // not validate their argv — so a fixture pointed at with the equals form ran
  // green against the real 1,068-feature catalog, which is the "passed for the
  // wrong reason" mode this flag exists to prevent.
  const inline = process.argv.find((a) => a.startsWith("--repo-root="))
  const i = process.argv.indexOf("--repo-root")
  if (inline === undefined && i === -1) return ANCHORED_ROOT
  const v = inline?.slice("--repo-root=".length) ?? process.argv[i + 1]
  if (v === undefined || !isAbsolute(v)) {
    throw new Error(`--repo-root requires an ABSOLUTE path (got ${v ?? "nothing"})`)
  }
  return v
}

const ROOT = resolveRepoRoot()
const {
  featuresDir: FEATURES_DIR,
  proseDir: PROSE_DIR,
  baselinePath: BASELINE,
} = catalogPathsFor(ROOT)

// Anchored on the catalog module itself — see tools/feature-catalog/paths.ts.
// The literals these replaced resolved to nothing outside the repo root, and
// every command read that as a clean catalog.
import { REPO_ROOT as ANCHORED_ROOT, catalogPathsFor } from "./paths"

// Anchored: `bun fc diff` is a hard CI gate (ci.yml:108) and this is the file it
// compares against. Left cwd-relative it reported `docs/10.feature-catalog.md
// differs from fresh render` from any other working directory — and `bun fc
// build` would have WRITTEN the catalog into the wrong tree entirely.
const OUTPUT_MD = resolve(ROOT, "docs/10.feature-catalog.md")

function usage(): never {
  console.error(
    [
      "usage: bun fc <command> [args]",
      "",
      "commands:",
      "  build              render docs/10.feature-catalog.md",
      "  validate [--strict]  schema + cross-feature + evidence + structural invariants",
      "  list [--maturity X] [--status X] [--section N]",
      "  show <id>",
      "  add <section> <slug>",
      "  diff               compare current MD with fresh render",
      "  ci                 validate + diff + lint from one loaded YAML snapshot",
      "  check-evidence     verify evidence files exist",
      "  audit              4-lens sweep (orphan ADRs / orphan src / empty stubs)",
      "  lint [--update-baseline]   ratchet on empty stubs + orphan Accepted ADRs",
      "  check-changed [<base-ref>]  PR-time gate: new src files must be in fc",
      "  grade [<letter>]            evidence-completeness scorecard (A-F)",
      "  stale                       flag entries where source newer than yaml >7d",
      "  query label:X owner:Y ...   filter by label/owner/section/maturity/depends/grade/ui/monitoring/mode/configurable",
      "  judge [--min=L4] [--section=N] [--verbose] [--overclaimed]",
      "                              4-axis composite (monitoring/hellgate/wiring/structure) → solid/thin/overclaimed verdict",
      "  gates [--strict]            maturity-promotion-gate audit (warn / strict-fail)",
      "  test-audit [--strict] [--update-baseline] [--max-per-rule N]   13-rule admissibility audit; strict rejects net-new violations",
      "  graph [--section N] [--id X] [--depth N]   emit DOT dependency DAG to stdout",
      "  reachability [--strict] [--symbols]    code-grounded: flag L4+ features unreachable (or --symbols dead-API) via real import graph",
    ].join("\n"),
  )
  process.exit(2)
}

async function cmdBuild(): Promise<void> {
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const prose = await loadProse(PROSE_DIR)
  const baseline = await loadBaseline(BASELINE)
  const md = renderCatalog({ features, prose, baseline, commit: headCommit() })
  await mkdir(dirname(OUTPUT_MD), { recursive: true })
  await writeFile(OUTPUT_MD, md, "utf8")
  console.log(`wrote ${OUTPUT_MD} (${md.length} bytes, ${features.length} features)`)
}

async function collectFeatureEvidenceErrors(
  feature: Feature,
  path: string,
  snapshot: FeatureEvidenceSnapshot,
): Promise<string[]> {
  const errors: string[] = []
  for (const code of feature.evidence.code) {
    if (!(await snapshot.pathExists(code))) {
      errors.push(`${rel(path)}: missing evidence.code "${code}"`)
    }
  }
  for (const adr of feature.evidence.adrs) {
    if (typeof adr === "string" && adr.includes("/")) {
      if (!(await snapshot.pathExists(adr))) {
        errors.push(`${rel(path)}: missing ADR path "${adr}"`)
      }
      continue
    }
    const padded = String(adr).padStart(4, "0")
    if (!(await snapshot.adrExists(padded))) {
      errors.push(`${rel(path)}: missing ADR-${adr} (docs/decisions/${padded}-*.md)`)
    }
  }
  await collectMissingTests(feature.evidence.tests.unit, "unit test", path, errors, snapshot)
  await collectMissingTests(
    feature.evidence.tests.integration,
    "integration test",
    path,
    errors,
    snapshot,
  )
  await collectMissingTests(
    feature.evidence.tests.contract,
    "contract test",
    path,
    errors,
    snapshot,
  )
  return errors
}

async function collectMissingTests(
  tests: string[],
  label: string,
  path: string,
  out: string[],
  snapshot: FeatureEvidenceSnapshot,
): Promise<void> {
  for (const t of tests) {
    if (!(await snapshot.pathExists(t))) out.push(`${rel(path)}: missing ${label} "${t}"`)
  }
}

async function cmdValidate(
  argv: string[] = [],
  loadedFeatures?: readonly LoadedFeature[],
): Promise<void> {
  const strict = argv.includes("--strict")
  for (const a of argv) {
    if (a !== "--strict") {
      console.error(`validate: unknown arg "${a}"`)
      process.exit(2)
    }
  }
  const features = loadedFeatures ?? (await loadFeaturesStrict(FEATURES_DIR))
  const evidenceSnapshot = createFeatureEvidenceSnapshot(ROOT)
  // Evidence paths recur across the catalog. Probe each exact ROOT+path once,
  // concurrently, while Promise.all preserves feature order for diagnostics.
  const errors = (
    await Promise.all(
      features.map(({ feature, path }) =>
        collectFeatureEvidenceErrors(feature, path, evidenceSnapshot),
      ),
    )
  ).flat()
  // Structural invariants (advisory by default; promoted to errors via --strict).
  const invariantViolations = validateInvariants(features)
  const invariantLines = invariantViolations.map(
    (v) => `${rel(v.path)}: [${v.invariant}] ${v.message}`,
  )
  if (strict) {
    errors.push(...invariantLines)
  } else {
    for (const line of invariantLines) console.error(`warn: ${line}`)
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(e)
    console.error(
      `validate: ${errors.length} error(s)` +
        (strict
          ? ` (--strict; includes ${invariantViolations.length} invariant violation(s))`
          : ""),
    )
    process.exit(1)
  }
  const invSuffix =
    invariantViolations.length > 0
      ? ` (${invariantViolations.length} invariant warning(s); pass --strict to fail)`
      : ""
  console.log(`validate: ${features.length} feature(s), all evidence resolved${invSuffix}`)
}

interface ListFilters {
  maturity: string | null
  status: string | null
  section: number | null
}

async function cmdList(argv: string[]): Promise<void> {
  const filters: ListFilters = { maturity: null, status: null, section: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--maturity") {
      filters.maturity = argv[++i] ?? null
    } else if (a === "--status") {
      filters.status = argv[++i] ?? null
    } else if (a === "--section") {
      const v = argv[++i]
      filters.section = v !== undefined ? Number(v) : null
    } else {
      console.error(`list: unknown arg "${a}"`)
      process.exit(2)
    }
  }
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const filtered = features.filter(({ feature }) => {
    if (filters.maturity && feature.maturity !== filters.maturity) return false
    if (filters.status && feature.status !== filters.status) return false
    if (filters.section !== null && feature.section !== filters.section) return false
    return true
  })
  for (const { feature } of filtered) {
    console.log(`${feature.id}\t${feature.title}\t${feature.maturity}`)
  }
}

async function cmdShow(argv: string[]): Promise<void> {
  const id = argv[0]
  if (!id) {
    console.error("show: <id> required")
    process.exit(2)
  }
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const match = features.find(({ feature }) => feature.id === id)
  if (!match) {
    console.error(`show: no feature with id "${id}"`)
    process.exit(1)
  }
  console.log(stringifyYaml(match.feature as unknown as Record<string, unknown>))
}

async function cmdAdd(argv: string[]): Promise<void> {
  const sectionStr = argv[0]
  const slug = argv[1]
  if (!sectionStr || !slug) {
    console.error("add: <section> <slug> required")
    process.exit(2)
  }
  const section = Number(sectionStr)
  if (!Number.isInteger(section) || !(section in SECTION_NAMES)) {
    console.error(`add: invalid section "${sectionStr}" (1..10)`)
    process.exit(2)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error(`add: invalid slug "${slug}" (kebab-case)`)
    process.exit(2)
  }
  const sectionSlug = SECTION_SLUGS[section] ?? `section-${section}`
  const dir = join(FEATURES_DIR, `${pad2(section)}-${sectionSlug}`)
  const file = join(dir, `${slug}.yaml`)
  if (await pathExists(file)) {
    console.error(`add: file already exists: ${file}`)
    process.exit(1)
  }
  const template = buildTemplate(section, slug)
  await mkdir(dir, { recursive: true })
  await writeFile(file, template, "utf8")
  console.log(`wrote ${file}`)
}

async function cmdDiff(loadedFeatures?: readonly LoadedFeature[]): Promise<void> {
  const features = loadedFeatures ?? (await loadFeaturesStrict(FEATURES_DIR))
  const prose = await loadProse(PROSE_DIR)
  const baseline = await loadBaseline(BASELINE)
  const fresh = renderCatalog({ features, prose, baseline, commit: headCommit() })
  let current = ""
  try {
    current = await readFile(OUTPUT_MD, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw err
  }
  if (current === fresh) {
    console.log("diff: no changes")
    return
  }
  const diff = lineDiff(current, fresh)
  for (const line of diff) console.log(line)
  console.error(`diff: ${OUTPUT_MD} differs from fresh render`)
  process.exit(1)
}

async function cmdCheckEvidence(argv: string[] = []): Promise<void> {
  // Same as validate, but kept as a separate command for parity with the spec.
  await cmdValidate(argv)
}

/** True iff this file path counts as a src-tracked .ts file (excludes tests,
 *  type-only declarations, and barrel re-exports). */
function isTrackedSrcFile(path: string, basename: string): boolean {
  if (!path.endsWith(".ts")) return false
  if (path.endsWith(".test.ts") || path.endsWith(".spec.ts") || path.endsWith(".d.ts")) return false
  if (basename === "index.ts") return false
  return true
}

/** Walk a directory recursively and return repo-relative .ts paths, excluding
 *  test/spec/d.ts/barrel files. Pure I/O helper for cmdAudit. */
async function collectSrcFiles(root = "src"): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[]
    try {
      entries = (await readdir(resolve(ROOT, dir), {
        withFileTypes: true,
      })) as unknown as import("node:fs").Dirent[]
    } catch (err) {
      // `catch { return }` here silently shrank the corpus behind `orphanSrcFiles`:
      // one unreadable subdirectory and every file under it counts as "referenced
      // by a feature" because it was never seen at all.
      throw new Error(
        `feature catalog: cannot read ${resolve(ROOT, dir)} — an unreadable source ` +
          `directory silently shrinks the orphan-source scan. (${
            err instanceof Error ? err.message : String(err)
          })`,
      )
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile() && isTrackedSrcFile(p, e.name)) {
        out.push(p)
      }
    }
  }
  await walk(root)
  return out.sort()
}

/** Read all ADRs from docs/decisions/ and parse their status fields. */
async function collectAdrs(dir: string = resolve(ROOT, "docs/decisions")): Promise<AdrRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(resolve(ROOT, dir))
  } catch (err) {
    // The sibling of `adrExists`, and it was missed when that one was fixed —
    // same file, same directory, same collapse. `catch { return [] }` reports
    // "the decisions directory could not be read" as "there are no ADRs", and
    // `runAudit` then derives `orphanAdrs: 0` from it, so `fc lint` prints
    // `ok — orphan Accepted ADRs=0`. Measured before the change: the real
    // directory yields 572 records, an unreadable one yielded 0 and did not
    // throw.
    throw new Error(
      `feature catalog: cannot read ${resolve(ROOT, dir)} — an unreachable decisions ` +
        `directory is not an empty one; every downstream orphan verdict would be ` +
        `derived from a scan that never happened. (${
          err instanceof Error ? err.message : String(err)
        })`,
    )
  }
  const out: AdrRecord[] = []
  for (const name of entries) {
    const m = /^(\d{4})-.*\.md$/.exec(name)
    if (!m || m[1] === undefined) continue
    const number = Number(m[1])
    if (!Number.isFinite(number)) continue
    const text = await readFile(resolve(ROOT, dir, name), "utf8")
    // Repo-RELATIVE, because this path is the key of the grandfather ledger in
    // baseline.json. `dir` is now absolute (anchored on ROOT), and an absolute
    // path in a committed ledger would be machine-specific — it would forgive
    // nothing on anyone else's checkout, so every orphan would read as new.
    out.push({ number, path: relative(ROOT, join(dir, name)), status: parseAdrStatus(text) })
  }
  return out.sort((a, b) => a.number - b.number)
}

/** Run all three audit lenses by reading the real filesystem. */
async function buildAuditReport(loadedFeatures?: readonly LoadedFeature[]): Promise<AuditReport> {
  const [features, srcFiles, adrs] = await Promise.all([
    loadedFeatures ?? loadFeaturesStrict(FEATURES_DIR),
    collectSrcFiles("src"),
    collectAdrs(resolve(ROOT, "docs/decisions")),
  ])
  return runAudit({ features, srcFiles, adrs })
}

async function cmdAudit(): Promise<void> {
  const report = await buildAuditReport()
  console.log(formatAuditReport(report))
}

async function cmdLint(argv: string[], loadedFeatures?: readonly LoadedFeature[]): Promise<void> {
  const updateBaseline = argv.includes("--update-baseline")
  const report = await buildAuditReport(loadedFeatures)

  if (updateBaseline) {
    const next = snapshotBaseline(report)
    await saveFcBaseline(next, BASELINE)
    console.log(
      `lint: baseline updated — empty_stubs_max=${next.empty_stubs_max}, ` +
        `orphan_adr_paths_grandfathered=[${next.orphan_adr_paths_grandfathered.join(", ")}]`,
    )
    return
  }

  const baseline = await loadFcBaseline(BASELINE)
  const result = runLint(report, baseline)
  for (const w of result.warnings) console.error(`warn: ${w}`)
  if (!result.ok) {
    for (const e of result.errors) console.error(`error: ${e}`)
    console.error(
      `lint: ${result.errors.length} error(s) — empty stubs=${report.counts.emptyStubs}/${baseline.empty_stubs_max} ` +
        `orphan Accepted ADRs=${report.counts.orphanAdrs}`,
    )
    process.exit(1)
  }
  console.log(
    `lint: ok — empty stubs=${report.counts.emptyStubs}/${baseline.empty_stubs_max} ` +
      `orphan Accepted ADRs=${report.counts.orphanAdrs} (grandfathered)`,
  )
}

export interface FcCiSteps {
  readonly load: () => Promise<readonly LoadedFeature[]>
  readonly validate: (features: readonly LoadedFeature[]) => Promise<void>
  readonly diff: (features: readonly LoadedFeature[]) => Promise<void>
  readonly lint: (features: readonly LoadedFeature[]) => Promise<void>
}

/** Fail-fast CI composite. Every step sees the same immutable parsed snapshot. */
export const runFcCi = async (steps: FcCiSteps): Promise<void> => {
  const features = await steps.load()
  await steps.validate(features)
  await steps.diff(features)
  await steps.lint(features)
}

async function cmdCi(argv: string[]): Promise<void> {
  if (argv.length > 0) {
    console.error(`ci: unknown arg "${argv[0]}"`)
    process.exit(2)
  }
  await runFcCi({
    load: () => loadFeaturesStrict(FEATURES_DIR),
    validate: (features) => cmdValidate([], features),
    diff: (features) => cmdDiff(features),
    lint: (features) => cmdLint([], features),
  })
}

// --- Maturity-promotion gates ----------------------------------------------
//
// Per-tier evidence requirements. Default-OFF (advisory) — `--strict` exits 1
// if any feature at a given tier (or above) violates its tier's gate. This is
// a separate audit step from `validate` (validate keeps existing yamls green).
//
// Rules:
//   L2: evidence.code.length >= 1  OR  notes present (e.g. "principle-only").
//   L3: L2  AND  (tests.unit.length >= 1  OR  tests.integration.length >= 1).
//   L4: L3  AND  (evidence.adrs.length >= 1  OR  notes present).
//   L5: L4  AND  owners.length >= 1  AND  deliberate_hold == null.

type GateKey = "L2" | "L3" | "L4" | "L5"

interface GateDef {
  readonly key: GateKey
  readonly label: string
  readonly applies: (m: string) => boolean
  readonly passes: (f: Feature) => boolean
}

interface GateOutcome {
  readonly def: GateDef
  readonly applicable: number
  readonly passed: number
  readonly violators: string[]
}

function notesPresent(f: Feature): boolean {
  return typeof f.notes === "string" && f.notes.trim().length > 0
}

function hasCode(f: Feature): boolean {
  return f.evidence.code.length >= 1
}

function hasTests(f: Feature): boolean {
  return f.evidence.tests.unit.length >= 1 || f.evidence.tests.integration.length >= 1
}

function hasAdrs(f: Feature): boolean {
  return f.evidence.adrs.length >= 1
}

function hasOwners(f: Feature): boolean {
  // `owners` is not in the zod schema today; a future extension may add it.
  // Read defensively from the raw object so gates can promote ahead of schema.
  const raw = (f as unknown as { owners?: unknown }).owners
  return Array.isArray(raw) && raw.length >= 1
}

function passesL2(f: Feature): boolean {
  return hasCode(f) || notesPresent(f)
}

function passesL3(f: Feature): boolean {
  return passesL2(f) && hasTests(f)
}

function passesL4(f: Feature): boolean {
  return passesL3(f) && (hasAdrs(f) || notesPresent(f))
}

function passesL5(f: Feature): boolean {
  return passesL4(f) && hasOwners(f) && f.deliberate_hold === null
}

const GATES: readonly GateDef[] = [
  {
    key: "L2",
    label: "L2 (needs evidence.code>=1 OR notes)",
    applies: (m) => m === "L2" || m === "L3" || m === "L4" || m === "L5",
    passes: passesL2,
  },
  {
    key: "L3",
    label: "L3 (L2 + tests>=1)",
    applies: (m) => m === "L3" || m === "L4" || m === "L5",
    passes: passesL3,
  },
  {
    key: "L4",
    label: "L4 (L3 + adrs>=1 OR notes)",
    applies: (m) => m === "L4" || m === "L5",
    passes: passesL4,
  },
  {
    key: "L5",
    label: "L5 (L4 + owners>=1 + deliberate_hold==null)",
    applies: (m) => m === "L5",
    passes: passesL5,
  },
]

/** Pure: compute per-gate outcomes from loaded features. */
export function runGates(features: readonly LoadedFeature[]): GateOutcome[] {
  return GATES.map((def) => {
    const applicable = features.filter(({ feature }) => def.applies(feature.maturity))
    const violators: string[] = []
    for (const { feature } of applicable) {
      if (!def.passes(feature)) violators.push(feature.id)
    }
    violators.sort()
    return {
      def,
      applicable: applicable.length,
      passed: applicable.length - violators.length,
      violators,
    }
  })
}

async function cmdGates(argv: string[]): Promise<void> {
  const strict = argv.includes("--strict")
  for (const a of argv) {
    if (a !== "--strict") {
      console.error(`gates: unknown arg "${a}"`)
      process.exit(2)
    }
  }
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const outcomes = runGates(features)

  console.log("Maturity promotion gates:")
  let totalViolations = 0
  for (const o of outcomes) {
    const violateCount = o.violators.length
    totalViolations += violateCount
    console.log(`  ${o.def.label}: ${o.passed}/${o.applicable} PASS, ${violateCount} VIOLATE`)
    for (const id of o.violators) {
      console.log(`    - ${id}`)
    }
  }

  if (totalViolations === 0) {
    console.log(`gates: ok — ${features.length} feature(s), no violations`)
    return
  }
  if (strict) {
    console.error(`gates: ${totalViolations} violation(s) across ${GATES.length} gate(s) — strict`)
    process.exit(1)
  }
  console.log(
    `gates: ${totalViolations} advisory violation(s) across ${GATES.length} gate(s) ` +
      `(pass --strict to fail on these)`,
  )
}

/** Run one read-only git command, or exit(1) naming the command that failed. */
function gitOrExit(args: readonly string[], label: string): string {
  // `cwd: ROOT`, and it is the whole correctness of this gate. Without it, git ran
  // against whatever repository the caller was standing in: outside a work tree it
  // failed loudly, but INSIDE ANY OTHER git tree it succeeded against the wrong
  // repo and the gate inverted — `exit 1 / BLOCK` at the repo root became
  // `exit 0 / ok` over a repository it never read. This runs at
  // `.github/workflows/fc-gate.yml`, `ci.yml`, and as the first step of
  // `test:ci` via `test:admission`.
  //
  // `stale`'s three git calls were anchored in an earlier pass; this one was
  // missed because the sweep was scoped to the commands it was looking at rather
  // than to every git call in the tool.
  const proc = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr)
    console.error(`check-changed: \`git ${args.join(" ")}\` failed (${label}): ${err.trim()}`)
    process.exit(1)
  }
  return new TextDecoder().decode(proc.stdout)
}

/**
 * The comparison base, in precedence order.
 *
 * TVH item 12: this read the mutable `origin/main` ref every time. A campaign
 * freezes a base OID and records it in its receipt, but handed the child
 * nothing — so a `git fetch` landing mid-campaign moved what this gate compared
 * against while the receipt still named the base as of the start. The receipt
 * described a comparison that did not happen.
 *
 * An explicit argument still wins: an operator asking about a specific base is
 * not overridden by an ambient one.
 */
export const checkChangedBase = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const explicit = argv[0]
  if (explicit !== undefined && explicit !== "") return explicit
  const frozen = env.QUANTA_VERIFICATION_BASE_OID
  // `<absent>` is the campaign's own sentinel for "there is no origin/main
  // here", and it is not a ref. Falling back is right; treating it as one
  // would turn a missing remote into `fatal: bad revision` mid-gate.
  if (frozen !== undefined && /^[0-9a-f]{40}$/.test(frozen)) return frozen
  return "origin/main"
}

async function cmdCheckChanged(argv: string[]): Promise<void> {
  const base = checkChangedBase(argv, process.env)
  // Use git via the system shell; we don't have a direct git lib and one-shot
  // child process is sufficient.
  //
  // THREE sources, not one (aug-22 audit). `diff <base>...HEAD` sees committed
  // history only, so the gate a developer runs BEFORE committing could not see
  // the new file they were about to commit — the exact "new standalone file"
  // case this gate's docstring calls out. Measured on the aug-21/22 bench
  // campaign: `bun fc check-changed` printed ok while 99 added `src/` files had
  // no fc evidence; the same command against the pre-campaign base listed all
  // of them. On a clean CI checkout the two extra sources are empty, so this is
  // a no-op there and fail-closed locally.
  const diff = mergeDiffSources(
    parseDiffNameStatus(gitOrExit(["diff", "--name-status", `${base}...HEAD`], "committed")),
    parseDiffNameStatus(gitOrExit(["diff", "--name-status", "HEAD"], "working tree")),
    parseUntrackedFiles(gitOrExit(["ls-files", "--others", "--exclude-standard"], "untracked")),
  )
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const result = runCheckChanged(diff, features)

  if (result.modifiedUntracked.length > 0) {
    console.error(
      `check-changed: ${result.modifiedUntracked.length} modified file(s) not in any fc evidence (informational):`,
    )
    for (const p of result.modifiedUntracked) console.error(`  ${p}`)
  }

  if (!result.ok) {
    console.error(
      `check-changed: ${result.addedUntracked.length} ADDED file(s) not in any fc evidence — BLOCK:`,
    )
    for (const p of result.addedUntracked) console.error(`  ${p}`)
    console.error(
      "Add an fc entry referencing these in `evidence.code`, or extend an existing entry.",
    )
    process.exit(1)
  }
  console.log(
    `check-changed: ok — ${diff.length} file(s) in diff, all added src files referenced in fc`,
  )
}

// --- graph -----------------------------------------------------------------

interface GraphFilters {
  section: number | null
  id: string | null
  depth: number | null
}

/**
 * Re-read a feature's raw YAML and extract `depends_on:` (a list of feature
 * ids).  We bypass the zod schema because `depends_on` is not a declared field
 * yet — the schema would strip it.  Missing / non-list values yield `[]`.
 */
async function readDependsOn(path: string): Promise<string[]> {
  let raw: unknown
  try {
    const text = await readFile(path, "utf8")
    raw = parseYaml(text)
  } catch (err) {
    // A file that cannot be read or parsed is NOT a feature with no dependencies.
    // Collapsing the two made the dependency graph lose edges silently, and the
    // reachability BFS that walks it then reported a smaller graph as a clean one.
    throw new Error(
      `feature catalog: cannot read dependencies from ${path} — an unreadable feature ` +
        `is not a feature without dependencies. (${
          err instanceof Error ? err.message : String(err)
        })`,
    )
  }
  if (!raw || typeof raw !== "object") return []
  const value = (raw as Record<string, unknown>).depends_on
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item)
  }
  return out
}

/** Build adjacency: id -> deps (forward) and id -> dependents (reverse). */
async function buildDepGraph(
  features: LoadedFeature[],
): Promise<{ forward: Map<string, string[]>; reverse: Map<string, string[]> }> {
  const forward = new Map<string, string[]>()
  const reverse = new Map<string, string[]>()
  for (const { feature } of features) {
    forward.set(feature.id, [])
    reverse.set(feature.id, [])
  }
  for (const { feature, path } of features) {
    const deps = await readDependsOn(path)
    forward.set(feature.id, deps)
    for (const d of deps) {
      const list = reverse.get(d) ?? []
      list.push(feature.id)
      reverse.set(d, list)
    }
  }
  return { forward, reverse }
}

/** BFS up to `depth` (or unbounded if null) from `start` over `adj`. */
function bfs(start: string, adj: Map<string, string[]>, depth: number | null): Set<string> {
  const visited = new Set<string>([start])
  let frontier: string[] = [start]
  let d = 0
  while (frontier.length > 0 && (depth === null || d < depth)) {
    const next: string[] = []
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (!visited.has(m)) {
          visited.add(m)
          next.push(m)
        }
      }
    }
    frontier = next
    d++
  }
  return visited
}

/** Escape a string for use as a DOT identifier (quoted). */
function dotEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function parseGraphArgs(argv: string[]): GraphFilters {
  const filters: GraphFilters = { section: null, id: null, depth: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--section") {
      const v = argv[++i]
      filters.section = v !== undefined ? Number(v) : null
    } else if (a === "--id") {
      filters.id = argv[++i] ?? null
    } else if (a === "--depth") {
      const v = argv[++i]
      filters.depth = v !== undefined ? Number(v) : null
    } else {
      console.error(`graph: unknown arg "${a}"`)
      process.exit(2)
    }
  }
  return filters
}

function computeIncluded(
  features: LoadedFeature[],
  filters: GraphFilters,
  forward: Map<string, string[]>,
  reverse: Map<string, string[]>,
): Set<string> {
  let included = new Set<string>(features.map((f) => f.feature.id))
  if (filters.id !== null) {
    if (!included.has(filters.id)) {
      console.error(`graph: no feature with id "${filters.id}"`)
      process.exit(1)
    }
    const ancestors = bfs(filters.id, reverse, filters.depth) // who depends on me
    const descendants = bfs(filters.id, forward, filters.depth) // who do I depend on
    included = new Set<string>([...ancestors, ...descendants])
  }
  if (filters.section !== null) {
    const inSection = new Set<string>(
      features
        .filter(({ feature }) => feature.section === filters.section)
        .map(({ feature }) => feature.id),
    )
    included = new Set<string>([...included].filter((id) => inSection.has(id)))
  }
  return included
}

function groupBySection(
  features: LoadedFeature[],
  included: Set<string>,
): Map<number, LoadedFeature[]> {
  const bySection = new Map<number, LoadedFeature[]>()
  for (const lf of features) {
    if (!included.has(lf.feature.id)) continue
    const list = bySection.get(lf.feature.section) ?? []
    list.push(lf)
    bySection.set(lf.feature.section, list)
  }
  return bySection
}

function emitClusters(bySection: Map<number, LoadedFeature[]>): string[] {
  const lines: string[] = []
  for (const sec of [...bySection.keys()].sort((a, b) => a - b)) {
    const slug = SECTION_SLUGS[sec] ?? `section-${sec}`
    lines.push(`  subgraph cluster_section${sec} {`)
    lines.push(`    label="${dotEscape(`${pad2(sec)}-${slug}`)}";`)
    for (const { feature } of bySection.get(sec) ?? []) {
      lines.push(`    "${dotEscape(feature.id)}";`)
    }
    lines.push("  }")
  }
  return lines
}

function emitEdges(
  features: LoadedFeature[],
  included: Set<string>,
  forward: Map<string, string[]>,
): string[] {
  const lines: string[] = []
  for (const { feature } of features) {
    if (!included.has(feature.id)) continue
    for (const d of forward.get(feature.id) ?? []) {
      if (!included.has(d)) continue
      lines.push(`  "${dotEscape(feature.id)}" -> "${dotEscape(d)}" [label="depends_on"];`)
    }
  }
  return lines
}

function emitGraphDot(
  features: LoadedFeature[],
  included: Set<string>,
  forward: Map<string, string[]>,
): string {
  const bySection = groupBySection(features, included)
  return [
    "digraph catalog {",
    "  rankdir=LR;",
    "  node [shape=box, style=rounded];",
    ...emitClusters(bySection),
    ...emitEdges(features, included, forward),
    "}",
  ].join("\n")
}

async function cmdGraph(argv: string[]): Promise<void> {
  const filters = parseGraphArgs(argv)
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const { forward, reverse } = await buildDepGraph(features)
  const included = computeIncluded(features, filters, forward, reverse)
  console.log(emitGraphDot(features, included, forward))
}

// --- Helpers ---------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(resolve(ROOT, p))
    return true
  } catch {
    return false
  }
}

function rel(p: string): string {
  return relative(ROOT, p) || p
}

function buildTemplate(section: number, slug: string): string {
  const sectionName = SECTION_NAMES[section] ?? `section-${section}`
  const obj: Record<string, unknown> = {
    id: slug,
    title: `TODO: ${slug}`,
    section,
    subsystem: `TODO subsystem (${sectionName})`,
    order: 0,
    maturity: "L3",
    status: "new",
    purpose: "TODO: 1-3 lines describing what + why",
    evidence: {
      code: [],
      adrs: [],
      tests: { unit: [], integration: [], contract: [] },
    },
    knobs: [],
    deliberate_hold: null,
  }
  return stringifyYaml(obj)
}

function lineDiff(a: string, b: string): string[] {
  const la = a.split("\n")
  const lb = b.split("\n")
  const out: string[] = []
  const max = Math.max(la.length, lb.length)
  for (let i = 0; i < max; i++) {
    const av = la[i]
    const bv = lb[i]
    if (av === bv) continue
    if (av !== undefined) out.push(`- ${i + 1}: ${av}`)
    if (bv !== undefined) out.push(`+ ${i + 1}: ${bv}`)
  }
  return out
}

// --- SOTA++ Tier-1 commands ------------------------------------------------

async function cmdGrade(argv: string[]): Promise<void> {
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const onlyGrade = argv[0]?.replace(/^--?/, "")
  const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 }
  const rows: Array<{ id: string; grade: string; section: number; title: string }> = []
  for (const { feature } of features) {
    const grade = computeGrade(feature)
    counts[grade] = (counts[grade] ?? 0) + 1
    rows.push({ id: feature.id, grade, section: feature.section, title: feature.title })
  }
  if (onlyGrade) {
    for (const r of rows) if (r.grade === onlyGrade) console.log(`${r.grade}\t${r.id}\t${r.title}`)
    return
  }
  console.log("Catalog grade distribution:")
  for (const g of ["A", "B", "C", "D", "F"]) {
    const n = counts[g] ?? 0
    const pct = ((n / features.length) * 100).toFixed(1)
    console.log(`  ${g}  ${String(n).padStart(4)}  ${pct}%`)
  }
  console.log(`  total: ${features.length}`)
}

async function cmdStale(_argv: string[]): Promise<void> {
  const { execSync } = await import("node:child_process")
  // Every verdict below comes from `git log`, so the precondition is checked ONCE
  // and loudly instead of being swallowed 1,068 times. Outside a worktree the
  // per-file catches turned 868 stale features into `stale: 0 feature(s)` with
  // exit 0 — a report that cannot distinguish "nothing is stale" from "git never
  // ran".
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: ROOT, stdio: "pipe" })
  } catch (err) {
    throw new Error(
      `feature catalog: ${ROOT} is not a git work tree — staleness is derived entirely ` +
        `from git history, so there is no verdict to give here. (${
          err instanceof Error ? err.message : String(err)
        })`,
    )
  }
  const features = await loadFeaturesStrict(FEATURES_DIR)
  let staleCount = 0
  for (const { feature, path } of features) {
    if (feature.evidence.code.length === 0) continue
    try {
      const yamlTime = execSync(`git log -1 --format=%ct -- "${path}"`, {
        encoding: "utf8",
        cwd: ROOT,
      }).trim()
      if (!yamlTime) continue
      const yt = Number(yamlTime)
      let newestSrc = 0
      for (const code of feature.evidence.code) {
        try {
          const t = execSync(`git log -1 --format=%ct -- "${code}"`, {
            encoding: "utf8",
            cwd: ROOT,
          }).trim()
          if (t) newestSrc = Math.max(newestSrc, Number(t))
        } catch (err) {
          // `git log` on a tracked path with no commits prints nothing and exits
          // 0; a THROW here means git itself failed, which is not "this file has
          // no history". Swallowing it (with `2>/dev/null` hiding the reason) is
          // what made `stale` report 0 of 868 features and exit 0 outside a
          // worktree.
          throw new Error(
            `feature catalog: git failed for evidence path "${code}" — a git error is not ` +
              `an absent history. (${err instanceof Error ? err.message : String(err)})`,
          )
        }
      }
      if (newestSrc > yt + 60 * 60 * 24 * 7) {
        const days = Math.floor((newestSrc - yt) / (60 * 60 * 24))
        console.log(`${feature.id}\tstale ${days}d\t${path}`)
        staleCount++
      }
    } catch {}
  }
  console.log(`\nstale: ${staleCount} feature(s) (source newer than yaml by >7d)`)
}

// SOTA Tier-4 — multi-axis composite judge for L4+ features.
//
// Per user request: factor monitoring + hellgate + callsite-integration +
// modularization into the maturity verdict so registered-but-unwired L4
// features are visible. Reports per-feature axis breakdown + verdict.
async function cmdJudge(argv: string[]): Promise<void> {
  const features = await loadFeaturesStrict(FEATURES_DIR)
  // Parse flags
  const verbose = argv.includes("--verbose") || argv.includes("-v")
  const onlyOverclaimed = argv.includes("--overclaimed")
  const minMaturity = (argv.find((a) => a.startsWith("--min="))?.slice(6) ?? "L4") as
    | "L1"
    | "L2"
    | "L3"
    | "L4"
    | "L5"
  const sectionFilter = argv.find((a) => a.startsWith("--section="))
  const sectionN = sectionFilter ? Number(sectionFilter.slice(10)) : undefined

  const matLevels = ["L1", "L2", "L3", "L4", "L5"] as const
  const minIdx = matLevels.indexOf(minMaturity)

  const verdictCounts: Record<string, number> = {
    solid: 0,
    thin: 0,
    overclaimed: 0,
    appropriate: 0,
    "deliberate-hold": 0,
  }
  const compositeCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 }
  const overclaimedRows: Array<{
    id: string
    section: number
    maturity: string
    composite: string
    axes: { mon: number; hell: number; wire: number; struct: number; total: number }
  }> = []

  for (const { feature } of features) {
    const fIdx = matLevels.indexOf(feature.maturity)
    if (fIdx < minIdx) continue
    if (sectionN !== undefined && feature.section !== sectionN) continue
    const j = computeJudgment(feature)
    verdictCounts[j.verdict] = (verdictCounts[j.verdict] ?? 0) + 1
    compositeCounts[j.composite] = (compositeCounts[j.composite] ?? 0) + 1
    if (j.verdict === "overclaimed" || (verbose && j.verdict === "thin")) {
      overclaimedRows.push({
        id: feature.id,
        section: feature.section,
        maturity: feature.maturity,
        composite: j.composite,
        axes: {
          mon: j.axes.monitoring,
          hell: j.axes.hellgate,
          wire: j.axes.wiring,
          struct: j.axes.structure,
          total: j.axes.total,
        },
      })
    }
  }

  console.log(
    `4-axis composite judgment for maturity >= ${minMaturity}${
      sectionN !== undefined ? ` (section ${sectionN})` : ""
    }`,
  )
  console.log("")
  console.log("Composite letter distribution (0..12 total → A/B/C/D/F):")
  for (const g of ["A", "B", "C", "D", "F"]) {
    const n = compositeCounts[g] ?? 0
    console.log(`  ${g}  ${String(n).padStart(4)}`)
  }
  console.log("")
  console.log("Verdict distribution:")
  for (const v of ["solid", "thin", "overclaimed", "appropriate", "deliberate-hold"]) {
    const n = verdictCounts[v] ?? 0
    console.log(`  ${v.padEnd(18)} ${String(n).padStart(4)}`)
  }
  if (overclaimedRows.length > 0) {
    console.log("")
    console.log(
      `${onlyOverclaimed ? "Overclaimed" : verbose ? "Thin + Overclaimed" : "Overclaimed"} features (axes: mon/hell/wire/struct = total):`,
    )
    console.log("  id\tsection\tmaturity\tcomposite\tmon\thell\twire\tstruct\ttotal")
    for (const r of overclaimedRows) {
      console.log(
        `  ${r.id}\ts${r.section}\t${r.maturity}\t${r.composite}\t${r.axes.mon}\t${r.axes.hell}\t${r.axes.wire}\t${r.axes.struct}\t${r.axes.total}`,
      )
    }
  }
  console.log("")
  console.log(
    "axis legend: mon=monitoring(0..3) hell=hellgate-test-count(0..3) wire=callsite-integration(0..3) struct=modularization(0..3)",
  )
}

async function cmdQuery(argv: string[]): Promise<void> {
  const filters: Array<(f: Feature) => boolean> = []
  for (const a of argv) {
    const colonIdx = a.indexOf(":")
    if (colonIdx < 0) continue
    const k = a.slice(0, colonIdx)
    const v = a.slice(colonIdx + 1)
    switch (k) {
      case "label":
        filters.push((f) => f.labels.includes(v))
        break
      case "owner":
        filters.push((f) => f.owners.includes(v))
        break
      case "section":
        filters.push((f) => f.section === Number(v))
        break
      case "maturity":
        filters.push((f) => f.maturity === v)
        break
      case "depends":
        filters.push((f) => f.depends_on.includes(v))
        break
      case "lifecycle":
        filters.push((f) => f.lifecycle_stage === v)
        break
      case "grade":
        filters.push((f) => computeGrade(f) === v)
        break
      case "ui":
        filters.push((f) => f.ui_surfaces.includes(v as never))
        break
      case "monitoring":
        filters.push((f) => f.monitoring === v)
        break
      case "mode":
        filters.push((f) => f.modes.includes(v as never))
        break
      case "configurable":
        filters.push((f) => f.configurable === v)
        break
      default:
        console.error(
          `query: unknown filter "${k}" (label/owner/section/maturity/depends/lifecycle/grade/ui/monitoring/mode/configurable)`,
        )
        process.exit(2)
    }
  }
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const matched = features.filter(({ feature }) => filters.every((fn) => fn(feature)))
  for (const { feature } of matched) {
    const grade = computeGrade(feature)
    console.log(`${grade}\t${feature.id}\t${feature.maturity}\t${feature.title}`)
  }
  console.log(`\n${matched.length} of ${features.length} match`)
}

// --- test-audit ------------------------------------------------------------

interface TestAuditArgs {
  readonly strict: boolean
  readonly updateBaseline: boolean
  readonly maxPerRule: number
}

function parseTestAuditArgs(argv: string[]): TestAuditArgs {
  let strict = false
  let updateBaseline = false
  let maxPerRule = 10
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--strict") {
      strict = true
    } else if (a === "--update-baseline") {
      updateBaseline = true
    } else if (a === "--max-per-rule") {
      const v = argv[++i]
      const n = v !== undefined ? Number(v) : Number.NaN
      if (!Number.isFinite(n) || n < 0) {
        console.error(`test-audit: --max-per-rule needs a non-negative integer (got "${v}")`)
        process.exit(2)
      }
      maxPerRule = Math.floor(n)
    } else {
      console.error(`test-audit: unknown arg "${a}"`)
      process.exit(2)
    }
  }
  return { strict, updateBaseline, maxPerRule }
}

async function reconcileTestAuditBaseline(
  report: TestAuditReport,
  updateBaseline: boolean,
): Promise<TestAuditBaselineComparison | null> {
  const baselinePath = join(ROOT, "tools/feature-catalog/test-audit-baseline.json")
  if (updateBaseline) {
    const baseline = await saveTestAuditBaseline(report, baselinePath)
    console.log(
      `test-audit: baseline updated (${baseline.violations.length} violation fingerprint(s))`,
    )
    return null
  }
  const baseline = await loadTestAuditBaseline(baselinePath)
  return compareTestAuditBaseline(report, baseline)
}

async function cmdTestAudit(argv: string[]): Promise<void> {
  const { strict, updateBaseline, maxPerRule } = parseTestAuditArgs(argv)
  const { report } = await runTestAuditFromDisk(ROOT)
  console.log(formatTestAuditReport(report, { maxPerRule, showSemantic: true }))
  const comparison = await reconcileTestAuditBaseline(report, updateBaseline)
  if (comparison === null) return
  if (comparison.resolvedViolations.length > 0) {
    console.warn(
      `test-audit: ${comparison.resolvedViolations.length} baseline violation(s) resolved; run --update-baseline to tighten`,
    )
  }
  if (strict && comparison.newViolations.length > 0) {
    console.error(`test-audit: ${comparison.newViolations.length} net-new violation(s) — strict`)
    for (const violation of comparison.newViolations.slice(0, maxPerRule)) {
      console.error(`  ${violation.replaceAll("\t", "  ")}`)
    }
    process.exit(1)
  }
}

// --- Entrypoint ------------------------------------------------------------

// --- reachability ----------------------------------------------------------

/** One reachability overclaim: a `maturity >= floor` feature whose declared
 *  `evidence.code` src files are ALL dead (unreachable OR — with `--symbols` —
 *  dead-API) via the real import graph. */
export interface ReachOffender {
  readonly id: string
  readonly maturity: string
  readonly first: string
  readonly kind: string
}

/** Numeric rank for `L1..L5` so the reachability floor can be `>= L3` (not an
 *  L4/L5 literal match). Unknown labels rank 0 (never gated). */
export const maturityRank = (m: string): number => {
  const n = Number.parseInt(m.replace(/^L/, ""), 10)
  return Number.isFinite(n) ? n : 0
}

/** Default overclaim floor. A slice claiming `maturity >= L3` (declared-wired
 *  with tests) whose src files are all dead is an overclaim — the manual
 *  "don't overclaim maturity" policy, enforced. L1/L2 are scaffold/principle
 *  tiers and legitimately need no production importer. */
export const REACHABILITY_FLOOR: string = "L3"

/**
 * PURE overclaim computer: given loaded features + the real import-graph reach
 * result (+ optional symbol-level result), return every feature at
 * `maturity >= floor` whose declared `evidence.code` src files are ALL dead.
 *
 * Keyword-FREE: the "dead" verdict comes ONLY from the import/re-export graph
 * (`reach.reached`) and, when supplied, the symbol-level dead-API set — never a
 * string/keyword match on the feature. Exported for the injection hellgate
 * (a synthetic L3 feature with an unreachable src file must be flagged; raising
 * the floor back to L4 must make it disappear → RED-on-injection).
 */
export function computeReachabilityOffenders(
  features: readonly LoadedFeature[],
  reach: { readonly reached: ReadonlySet<string> },
  sym: { readonly deadApi: ReadonlySet<string> } | null,
  floor: string = REACHABILITY_FLOOR,
): ReachOffender[] {
  const floorRank = maturityRank(floor)
  const isDead = (c: string): boolean => !reach.reached.has(c) || (sym?.deadApi.has(c) ?? false)
  const offenders: ReachOffender[] = []
  for (const { feature } of features) {
    if (maturityRank(feature.maturity) < floorRank) continue
    const src = feature.evidence.code.filter((c) => c.startsWith("src/") && c.endsWith(".ts"))
    if (src.length === 0) continue // tools/tests-only feature — not app-reachable by design
    if (src.every(isDead)) {
      const kind = src.some((c) => !reach.reached.has(c)) ? "unreachable" : "dead-API"
      offenders.push({ id: feature.id, maturity: feature.maturity, first: src[0] as string, kind })
    }
  }
  offenders.sort((a, b) => a.id.localeCompare(b.id))
  return offenders
}

/**
 * Code-grounded overclaim detector: flags features at `maturity >= L3` whose
 * `evidence.code` src files are NOT reachable from ANY production entrypoint
 * (`src/apps/<surface>/index.ts`), via the real import/re-export graph
 * (`./reachability`). This is the ground truth the self-declared `judge` axes
 * cannot give — no `.js`-mirror / barrel / basename-collision noise. A
 * maturity ≥ L3 (declared-wired, has tests) claim on an UNREACHABLE feature is
 * an overclaim: L3 asserts "wired with tests", so zero production importers is
 * a lie. L1 (scaffold) / L2 (principle) legitimately need no importer and are
 * exempt.
 *
 * `--strict` exits 1 when any are found (CI gate — the hard-gate that turns the
 * manual policy into an enforced floor). Features whose evidence.code is tools/-
 * or tests-only are skipped (not app-reachable by design).
 *
 * `--symbols` adds the finer symbol-level pass: a feature whose every src file
 * is EITHER unreachable OR "dead-API" (module loads via a barrel re-export but
 * no own export is ever named-imported AND it self-registers nothing at load) —
 * the blind spot module reachability cannot see (e.g. a helper re-exported from
 * a barrel but never called by any tool). Stricter signal; still spot-verify
 * before downgrading.
 */
/** Read the L3-reachability grandfather list from baseline.json — the set of
 *  PRE-EXISTING ≥L3 orphans captured when the floor dropped from L4 to L3
 *  (ALBB-15). New offenders NOT in this list fail `--strict`; grandfathered ones
 *  warn (ratchet can tighten). Mirrors the `fc lint` / `dod-ratchet` idiom:
 *  fail-closed on REGRESSION, monotonic shrink for the backlog. Defensive read
 *  (missing file/field ⇒ empty set ⇒ every offender is net-new). */
async function loadL3ReachabilityGrandfathered(): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(BASELINE, "utf8")) as {
      fc?: { l3_reachability_grandfathered?: unknown }
    }
    const list = raw.fc?.l3_reachability_grandfathered
    if (!Array.isArray(list)) return new Set()
    return new Set(list.filter((x): x is string => typeof x === "string"))
  } catch {
    return new Set()
  }
}

/**
 * PARTIAL-dead evidence: an `≥L3` feature whose `evidence.code` contains dead src
 * files while at least one is live.
 *
 * `computeReachabilityOffenders` only fires when ALL of a feature's src evidence is
 * dead, so one live file hides any number of dead ones. Measured at this commit:
 * 0 all-dead (the existing gate is genuinely clean) and 85 features carrying 107
 * dead evidence files between them. `evidence.code` fan-in is ~1.95x, so appending
 * to an entry makes the all-dead test strictly less likely to fire — the blind spot
 * widens with use.
 *
 * NOT flipped to `some(isDead)`. That would fail 85 features at once, and the
 * difference between a dead WIRING file and a dead auxiliary one is not recorded
 * anywhere in the schema, so the gate could not tell a real overclaim from a
 * barrel. `.d.ts` files are excluded outright: a type declaration is never
 * "reached" by an import graph, so counting one is a measurement error, not a
 * finding.
 *
 * Surfaced and ratcheted instead, so the number cannot grow while the decision
 * about primary-vs-auxiliary evidence is made deliberately.
 */
export interface PartialDeadRow {
  readonly id: string
  readonly maturity: string
  readonly dead: readonly string[]
  readonly total: number
}

export const computePartialDeadEvidence = (
  features: readonly LoadedFeature[],
  reach: { readonly reached: ReadonlySet<string> },
  floor: string = REACHABILITY_FLOOR,
): PartialDeadRow[] => {
  const floorRank = maturityRank(floor)
  const rows: PartialDeadRow[] = []
  for (const { feature } of features) {
    if (maturityRank(feature.maturity) < floorRank) continue
    const src = feature.evidence.code.filter(
      (c) => c.startsWith("src/") && c.endsWith(".ts") && !c.endsWith(".d.ts"),
    )
    if (src.length === 0) continue
    const dead = src.filter((c) => !reach.reached.has(c))
    if (dead.length === 0 || dead.length === src.length) continue
    rows.push({ id: feature.id, maturity: feature.maturity, dead, total: src.length })
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id))
}

async function cmdReachability(argv: string[]): Promise<void> {
  const strict = argv.includes("--strict")
  const symbols = argv.includes("--symbols")
  const [reach, sym, features, grandfathered] = await Promise.all([
    computeReachability(),
    symbols ? computeSymbolReachability() : Promise.resolve(null),
    loadFeaturesStrict(FEATURES_DIR),
    loadL3ReachabilityGrandfathered(),
  ])
  const offenders = computeReachabilityOffenders(features, reach, sym)
  const mode = symbols
    ? "unreachable OR dead-API (symbol-level)"
    : "UNREACHABLE from any entrypoint"
  const netNew = offenders.filter((o) => !grandfathered.has(o.id))
  const known = offenders.filter((o) => grandfathered.has(o.id))
  console.log(
    `reachability: ${reach.reached.size}/${reach.allFiles.size} src files reached; ` +
      `${offenders.length} feature(s) ≥${REACHABILITY_FLOOR} ${mode} (overclaim) ` +
      `— ${netNew.length} net-new, ${known.length} grandfathered:`,
  )
  const partial = computePartialDeadEvidence(features, reach)
  const partialFiles = partial.reduce((n, r) => n + r.dead.length, 0)
  console.log(
    `reachability: partial-dead evidence — ${partial.length} feature(s) carry ` +
      `${partialFiles} dead src file(s) alongside live ones (the all-dead test above ` +
      `cannot see these; .d.ts excluded)`,
  )
  for (const o of netNew) console.log(`  NEW  ${o.id} [${o.maturity}] (${o.kind}) ${o.first}`)
  for (const o of known) console.log(`  (gf) ${o.id} [${o.maturity}] (${o.kind}) ${o.first}`)
  if (offenders.length === 0)
    console.log(`  (none — every ≥${REACHABILITY_FLOOR} feature is code-reachable)`)
  // Ratchet-tighten hint: a grandfathered id that is NO LONGER an offender
  // (someone wired or demoted it) should be pruned from baseline.json.
  const offenderIds = new Set(offenders.map((o) => o.id))
  const resolved = [...grandfathered].filter((id) => !offenderIds.has(id)).sort()
  if (resolved.length > 0) {
    console.log(
      `\n  ratchet can tighten — ${resolved.length} grandfathered id(s) no longer offend ` +
        `(prune from baseline.json fc.l3_reachability_grandfathered): ${resolved.join(", ")}`,
    )
  }
  // Fail-closed ONLY on net-new ≥L3 overclaims (the class can never regress);
  // the grandfathered backlog shrinks monotonically via the tighten hint.
  if (strict && netNew.length > 0) {
    console.error(`reachability: ${netNew.length} NEW ≥${REACHABILITY_FLOOR} overclaim(s) — strict`)
    process.exit(1)
  }
}

// `bun fc surface [--gap web|cli|any] [--audited] [--id <substr>] [--json]`
// Report per-surface (CLI/web) integration coverage from `surface_integration`.
// The "거기서 확인" affordance: answer "is X wired into CLI / the web app?" and
// "what's the web-gap backlog?" from the catalog instead of re-greping the tree.
async function cmdSurface(argv: string[]): Promise<void> {
  const features = (await loadFeaturesStrict(FEATURES_DIR)).map((l) => l.feature)
  let gap: string | null = null
  let onlyAudited = false
  let idFilter: string | null = null
  let asJson = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--gap") gap = argv[++i] ?? null
    else if (a === "--audited") onlyAudited = true
    else if (a === "--id") idFilter = argv[++i] ?? null
    else if (a === "--json") asJson = true
  }
  const rows = features
    .filter((f) => (idFilter ? f.id.includes(idFilter) : true))
    .filter((f) => (onlyAudited ? f.surface_integration.method !== "unverified" : true))
  const audited = rows.filter((f) => f.surface_integration.method !== "unverified")
  const tally = (key: "cli" | "web"): Record<string, number> => {
    const t: Record<string, number> = { full: 0, partial: 0, missing: 0, na: 0, unknown: 0 }
    for (const f of rows) t[f.surface_integration[key]] = (t[f.surface_integration[key]] ?? 0) + 1
    return t
  }
  const isGap = (f: Feature): boolean => {
    const si = f.surface_integration
    const bad = (s: string): boolean => s === "missing" || s === "partial"
    if (gap === "web") return bad(si.web)
    if (gap === "cli") return bad(si.cli)
    if (gap === "any") return bad(si.web) || bad(si.cli)
    return false
  }
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          total: rows.length,
          audited: audited.length,
          cli: tally("cli"),
          web: tally("web"),
          gaps: gap ? rows.filter(isGap).map((f) => ({ id: f.id, ...f.surface_integration })) : [],
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(
    `surface_integration coverage — ${audited.length}/${rows.length} audited (${
      rows.length - audited.length
    } unverified)`,
  )
  console.log(`  cli: ${JSON.stringify(tally("cli"))}`)
  console.log(`  web: ${JSON.stringify(tally("web"))}`)
  if (gap !== null) {
    const g = rows.filter(isGap)
    console.log(`\n${gap}-gap features (${g.length}):`)
    for (const f of g) {
      const si = f.surface_integration
      console.log(`  [cli=${si.cli} web=${si.web}] ${f.id}`)
      const e = gap === "cli" ? si.evidence?.cli : si.evidence?.web
      if (e !== undefined && e.length > 0) {
        console.log(`      ${e.replace(/\s+/g, " ").slice(0, 160)}`)
      }
    }
  }
}

// `bun fc surface-derive [--write]` — MECHANICALLY fill surface_integration for
// every feature from per-surface import reachability (no LLM). Dry-run by
// default; --write applies. Skips features that already carry a block.
async function cmdSurfaceDerive(argv: string[]): Promise<void> {
  const write = argv.includes("--write")
  const rows = await deriveSurfaceIntegration({ write })
  const filled = rows.filter((r) => !r.skipped)
  const tally = (k: "cli" | "web"): Record<string, number> => {
    const t: Record<string, number> = {}
    for (const r of filled) t[r[k]] = (t[r[k]] ?? 0) + 1
    return t
  }
  console.log(`surface-derive ${write ? "(WROTE)" : "(dry-run — pass --write to apply)"}`)
  console.log(
    `  ${filled.length} derived · ${rows.length - filled.length} skipped (already have a block)`,
  )
  console.log(`  cli: ${JSON.stringify(tally("cli"))}`)
  console.log(`  web: ${JSON.stringify(tally("web"))}`)
}

// `bun fc surface-apply <verdicts.json>` — apply LLM-audited verdicts
// (method:audited) over the derived baseline via the single trusted writer.
async function cmdSurfaceApply(argv: string[]): Promise<void> {
  const file = argv[0]
  if (file === undefined) {
    console.error("usage: bun fc surface-apply <verdicts.json>")
    process.exit(2)
  }
  const verdicts = JSON.parse(await readFile(file, "utf8"))
  const { applied, skipped } = await applyAuditedVerdicts(verdicts)
  console.log(`surface-apply: ${applied} audited block(s) written · ${skipped.length} skipped`)
  for (const s of skipped.slice(0, 25)) console.log(`  skip: ${s}`)
}

async function main(): Promise<void> {
  // `--repo-root <abs>` is consumed at module load (see resolveRepoRoot) and is
  // stripped here so per-command arg validators never see it as an unknown flag.
  const raw = process.argv.slice(2)
  const rootAt = raw.indexOf("--repo-root")
  const argv = raw
    .filter((_, i) => rootAt === -1 || (i !== rootAt && i !== rootAt + 1))
    .filter((a) => !a.startsWith("--repo-root="))
  const cmd = argv[0]
  const rest = argv.slice(1)
  switch (cmd) {
    case "build":
      await cmdBuild()
      return
    case "validate":
      await cmdValidate(rest)
      return
    case "list":
      await cmdList(rest)
      return
    case "show":
      await cmdShow(rest)
      return
    case "add":
      await cmdAdd(rest)
      return
    case "diff":
      await cmdDiff()
      return
    case "ci":
      await cmdCi(rest)
      return
    case "check-evidence":
      await cmdCheckEvidence(rest)
      return
    case "audit":
      await cmdAudit()
      return
    case "lint":
      await cmdLint(rest)
      return
    case "check-changed":
      await cmdCheckChanged(rest)
      return
    case "grade":
      await cmdGrade(rest)
      return
    case "judge":
      await cmdJudge(rest)
      return
    case "stale":
      await cmdStale(rest)
      return
    case "query":
      await cmdQuery(rest)
      return
    case "gates":
      await cmdGates(rest)
      return
    case "graph":
      await cmdGraph(rest)
      return
    case "reachability":
      await cmdReachability(rest)
      return
    case "test-audit":
      await cmdTestAudit(rest)
      return
    case "surface":
      await cmdSurface(rest)
      return
    case "surface-derive":
      await cmdSurfaceDerive(rest)
      return
    case "surface-apply":
      await cmdSurfaceApply(rest)
      return
    case undefined:
    case "-h":
    case "--help":
    case "help":
      usage()
      return
    default:
      console.error(`unknown command: ${cmd}`)
      usage()
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

export type { Feature, LoadedFeature }
// For tests / programmatic use
export {
  buildAuditReport,
  cmdAdd,
  cmdAudit,
  cmdBuild,
  cmdCheckChanged,
  cmdCi,
  cmdDiff,
  cmdGates,
  cmdGraph,
  cmdLint,
  cmdList,
  cmdReachability,
  cmdShow,
  cmdValidate,
  collectAdrs,
  collectSrcFiles,
  main,
}
