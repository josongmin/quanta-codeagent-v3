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
 *   check-evidence     — verify evidence files exist
 *
 * Exit codes: 0=ok, 1=error, 2=usage.
 *
 * No logger — plain console.log/console.error.
 */
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import {
  type AdrRecord,
  type AuditReport,
  formatAuditReport,
  parseAdrStatus,
  runAudit,
} from "./audit"
import { parseDiffNameStatus, runCheckChanged } from "./check-changed"
import { loadFcBaseline, runLint, saveFcBaseline, snapshotBaseline } from "./lint"
import { loadBaseline, loadProse, renderCatalog } from "./render"
import {
  type Feature,
  type LoadedFeature,
  loadFeaturesStrict,
  SECTION_NAMES,
  SECTION_SLUGS,
} from "./schema"
import { stringifyYaml } from "./yaml"

const ROOT = process.cwd()
const FEATURES_DIR = "tools/feature-catalog/features"
const PROSE_DIR = "tools/feature-catalog/prose"
const BASELINE = "tools/feature-catalog/baseline.json"
const OUTPUT_MD = "docs/10.feature-catalog.md"

function usage(): never {
  console.error(
    [
      "usage: bun fc <command> [args]",
      "",
      "commands:",
      "  build              render docs/10.feature-catalog.md",
      "  validate           schema + cross-feature + evidence checks",
      "  list [--maturity X] [--status X] [--section N]",
      "  show <id>",
      "  add <section> <slug>",
      "  diff               compare current MD with fresh render",
      "  check-evidence     verify evidence files exist",
      "  audit              4-lens sweep (orphan ADRs / orphan src / empty stubs)",
      "  lint [--update-baseline]   ratchet on empty stubs + orphan Accepted ADRs",
      "  check-changed [<base-ref>]  PR-time gate: new src files must be in fc",
    ].join("\n"),
  )
  process.exit(2)
}

async function cmdBuild(): Promise<void> {
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const prose = await loadProse(PROSE_DIR)
  const baseline = await loadBaseline(BASELINE)
  const md = renderCatalog({ features, prose, baseline })
  await mkdir(dirname(OUTPUT_MD), { recursive: true })
  await writeFile(OUTPUT_MD, md, "utf8")
  console.log(`wrote ${OUTPUT_MD} (${md.length} bytes, ${features.length} features)`)
}

async function collectFeatureEvidenceErrors(feature: Feature, path: string): Promise<string[]> {
  const errors: string[] = []
  for (const code of feature.evidence.code) {
    if (!(await pathExists(code))) {
      errors.push(`${rel(path)}: missing evidence.code "${code}"`)
    }
  }
  for (const adr of feature.evidence.adrs) {
    const padded = String(adr).padStart(4, "0")
    if (!(await adrExists(padded))) {
      errors.push(`${rel(path)}: missing ADR-${adr} (docs/decisions/${padded}-*.md)`)
    }
  }
  await collectMissingTests(feature.evidence.tests.unit, "unit test", path, errors)
  await collectMissingTests(feature.evidence.tests.integration, "integration test", path, errors)
  await collectMissingTests(feature.evidence.tests.contract, "contract test", path, errors)
  return errors
}

async function collectMissingTests(
  tests: string[],
  label: string,
  path: string,
  out: string[],
): Promise<void> {
  for (const t of tests) {
    if (!(await pathExists(t))) out.push(`${rel(path)}: missing ${label} "${t}"`)
  }
}

async function cmdValidate(): Promise<void> {
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const errors: string[] = []
  for (const { feature, path } of features) {
    errors.push(...(await collectFeatureEvidenceErrors(feature, path)))
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(e)
    console.error(`validate: ${errors.length} error(s)`)
    process.exit(1)
  }
  console.log(`validate: ${features.length} feature(s), all evidence resolved`)
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

async function cmdDiff(): Promise<void> {
  const features = await loadFeaturesStrict(FEATURES_DIR)
  const prose = await loadProse(PROSE_DIR)
  const baseline = await loadBaseline(BASELINE)
  const fresh = renderCatalog({ features, prose, baseline })
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

async function cmdCheckEvidence(): Promise<void> {
  // Same as validate, but kept as a separate command for parity with the spec.
  await cmdValidate()
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
    } catch {
      return
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
async function collectAdrs(dir = "docs/decisions"): Promise<AdrRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(resolve(ROOT, dir))
  } catch {
    return []
  }
  const out: AdrRecord[] = []
  for (const name of entries) {
    const m = /^(\d{4})-.*\.md$/.exec(name)
    if (!m || m[1] === undefined) continue
    const number = Number(m[1])
    if (!Number.isFinite(number)) continue
    const text = await readFile(resolve(ROOT, dir, name), "utf8")
    out.push({ number, status: parseAdrStatus(text) })
  }
  return out.sort((a, b) => a.number - b.number)
}

/** Run all three audit lenses by reading the real filesystem. */
async function buildAuditReport(): Promise<AuditReport> {
  const [features, srcFiles, adrs] = await Promise.all([
    loadFeaturesStrict(FEATURES_DIR),
    collectSrcFiles("src"),
    collectAdrs("docs/decisions"),
  ])
  return runAudit({ features, srcFiles, adrs })
}

async function cmdAudit(): Promise<void> {
  const report = await buildAuditReport()
  console.log(formatAuditReport(report))
}

async function cmdLint(argv: string[]): Promise<void> {
  const updateBaseline = argv.includes("--update-baseline")
  const report = await buildAuditReport()

  if (updateBaseline) {
    const next = snapshotBaseline(report)
    await saveFcBaseline(next)
    console.log(
      `lint: baseline updated — empty_stubs_max=${next.empty_stubs_max}, ` +
        `orphan_adrs_grandfathered=[${next.orphan_adrs_grandfathered.join(", ")}]`,
    )
    return
  }

  const baseline = await loadFcBaseline()
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

async function cmdCheckChanged(argv: string[]): Promise<void> {
  const base = argv[0] ?? "origin/main"
  // Use git via the system shell; we don't have a direct git lib and one-shot
  // child process is sufficient.
  const proc = Bun.spawnSync(["git", "diff", "--name-status", `${base}...HEAD`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr)
    console.error(`check-changed: \`git diff ${base}...HEAD\` failed: ${err.trim()}`)
    process.exit(1)
  }
  const stdout = new TextDecoder().decode(proc.stdout)
  const diff = parseDiffNameStatus(stdout)
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

async function adrExists(padded: string): Promise<boolean> {
  // docs/decisions/NNNN-*.md — check by listing.
  const dir = "docs/decisions"
  let entries: string[]
  try {
    const { readdir } = await import("node:fs/promises")
    entries = await readdir(dir)
  } catch {
    return false
  }
  return entries.some((e) => e.startsWith(`${padded}-`) && e.endsWith(".md"))
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

// --- Entrypoint ------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const rest = argv.slice(1)
  switch (cmd) {
    case "build":
      await cmdBuild()
      return
    case "validate":
      await cmdValidate()
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
    case "check-evidence":
      await cmdCheckEvidence()
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
  cmdDiff,
  cmdLint,
  cmdList,
  cmdShow,
  cmdValidate,
  collectAdrs,
  collectSrcFiles,
  main,
}
