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
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
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
export { cmdAdd, cmdBuild, cmdDiff, cmdList, cmdShow, cmdValidate, main }
