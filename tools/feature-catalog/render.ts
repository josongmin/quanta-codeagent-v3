// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: renderCatalog is a linear template walker over canonical sections; covered by golden-snapshot tests.
/**
 * YAML-loaded features → docs/10.feature-catalog.md renderer (thin).
 *
 * Pure deterministic output: same inputs → byte-identical MD. Run via
 * `bun fc build` (see cli.ts). Tests assert against golden fixtures.
 */
import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Feature, LoadedFeature, Maturity } from "./schema"
import { SECTION_NAMES } from "./schema"

export interface Baseline {
  pass: number
  fail: number
  skip: number
  expect: number
  files: number
  generated_at: string
}

export interface RenderInput {
  features: LoadedFeature[]
  prose: ProseFiles
  baseline: Baseline | null
}

export interface ProseFiles {
  /** Inserted after the H1, before the per-section tables. */
  intro: string
  /** Inserted after the summary blocks, before the footer. */
  trailers: { name: string; content: string }[]
}

/** Build the final MD as a deterministic string. */
export function renderCatalog(input: RenderInput): string {
  const out: string[] = []
  out.push("<!-- AUTO-GENERATED from tools/feature-catalog/. Do not edit. Run `bun fc build`. -->")
  out.push("")
  out.push("# 10. 기능 카탈로그 (Feature Catalog)")
  out.push("")
  if (input.prose.intro.trim() !== "") {
    out.push(input.prose.intro.trimEnd())
    out.push("")
  }
  out.push("---")
  out.push("")

  // Per-section tables (only sections that have features). Within a section,
  // features are sorted by their subsystem-group (using the first `order` seen
  // for each subsystem as the group key) and then by individual `order` within
  // the group — so same-subsystem rows are contiguous and rowspan-emulation
  // (blank "중" cell for continuation rows) works correctly. Ties broken by id
  // for determinism.
  const bySection = groupBySection(input.features)
  const sectionNums = [...bySection.keys()].sort((a, b) => a - b)
  for (const section of sectionNums) {
    const name = SECTION_NAMES[section] ?? `Section ${section}`
    out.push(`## 대 ${section}. ${name}`)
    out.push("")
    out.push("| 중 | 소 | 등급 | 핵심 |")
    out.push("|---|---|---|---|")
    const entries = sortWithinSection(bySection.get(section) ?? [])
    let lastSubsystem = ""
    for (const { feature } of entries) {
      const subsystem = feature.subsystem === lastSubsystem ? "" : feature.subsystem
      lastSubsystem = feature.subsystem
      const summary = buildEvidenceSummary(feature)
      const purpose = oneLine(feature.purpose)
      const core = summary ? `${purpose} · ${summary}` : purpose
      out.push(
        `| ${escapeCell(subsystem)} | ${escapeCell(feature.title)} | **${feature.maturity}** | ${escapeCell(core)} |`,
      )
    }
    out.push("")
  }

  out.push("---")
  out.push("")

  // E2E integration coverage
  out.push("## E2E 통합 커버리지")
  out.push("")
  const e2e = collectE2E(input.features)
  if (e2e.length === 0) {
    out.push("_(없음)_")
  } else {
    for (const { name, title } of e2e) {
      out.push(`- ${name} · ${title}`)
    }
  }
  out.push("")

  // Maturity distribution — counts only for L5/L4 (the long tail), titles for
  // L3/L2/L1 (the interesting "what's not finished" set).
  out.push("## 등급 분포 요약")
  out.push("")
  const dist = computeMaturityDistribution(input.features)
  for (const level of ["L5", "L4", "L3", "L2", "L1"] as Maturity[]) {
    const bucket = dist.get(level) ?? []
    if (level === "L5" || level === "L4") {
      out.push(`- **${level}** (${bucket.length})`)
    } else {
      const titles = bucket.map((f) => `${f.title} (대 ${f.section})`).join(", ")
      out.push(`- **${level}** (${bucket.length})${titles ? `: ${titles}` : ""}`)
    }
  }
  out.push("")

  // Deliberate holds
  out.push("## 잔류 deliberate-boundary")
  out.push("")
  const holds = input.features.map((lf) => lf.feature).filter((f) => f.deliberate_hold !== null)
  if (holds.length === 0) {
    out.push("_(없음)_")
  } else {
    for (const f of holds) {
      const dh = f.deliberate_hold
      if (!dh) continue
      const promo = dh.promotion_path ? ` → ${dh.promotion_path}` : ""
      out.push(`- **${f.title}** (${f.maturity}) — ${dh.reason}${promo}`)
    }
  }
  out.push("")

  // Trailer prose
  if (input.prose.trailers.length > 0) {
    out.push("---")
    out.push("")
    for (const trailer of input.prose.trailers) {
      const c = trailer.content.trim()
      if (c !== "") {
        out.push(c)
        out.push("")
      }
    }
  }

  out.push("---")
  out.push("")
  // Footer with baseline
  if (input.baseline) {
    const b = input.baseline
    out.push(
      `> 검증 베이스라인: tsc 0 · biome clean · ${b.pass}/${b.fail}/${b.skip}/${b.expect} (${b.files} files). 최종 빌드: ${b.generated_at}.`,
    )
  } else {
    out.push("> 검증 베이스라인: (baseline.json 없음)")
  }
  out.push("")
  return out.join("\n")
}

// --- Helpers ---------------------------------------------------------------

function groupBySection(features: LoadedFeature[]): Map<number, LoadedFeature[]> {
  const map = new Map<number, LoadedFeature[]>()
  for (const lf of features) {
    const arr = map.get(lf.feature.section)
    if (arr) arr.push(lf)
    else map.set(lf.feature.section, [lf])
  }
  return map
}

/** Order within a section so same-subsystem rows are contiguous. Subsystems
 *  are ordered by the minimum `order` they contain; within a subsystem rows
 *  are sorted by `order` then `id`. Pure + deterministic — fixture-tested. */
function sortWithinSection(entries: LoadedFeature[]): LoadedFeature[] {
  const minOrderBySubsystem = new Map<string, number>()
  for (const { feature } of entries) {
    const prev = minOrderBySubsystem.get(feature.subsystem)
    if (prev === undefined || feature.order < prev) {
      minOrderBySubsystem.set(feature.subsystem, feature.order)
    }
  }
  return [...entries].sort((a, b) => {
    const f = a.feature
    const g = b.feature
    const sa = minOrderBySubsystem.get(f.subsystem) ?? 0
    const sb = minOrderBySubsystem.get(g.subsystem) ?? 0
    if (sa !== sb) return sa - sb
    if (f.subsystem !== g.subsystem) {
      return f.subsystem < g.subsystem ? -1 : 1
    }
    if (f.order !== g.order) return f.order - g.order
    return f.id < g.id ? -1 : f.id > g.id ? 1 : 0
  })
}

export function buildEvidenceSummary(feature: Feature): string {
  const parts: string[] = []
  const code = feature.evidence.code
  if (code.length > 0) {
    parts.push(code.slice(0, 2).join(", "))
  }
  const adrs = feature.evidence.adrs
  if (adrs.length > 0) {
    parts.push(`ADR-${adrs.join(",")}`)
  }
  const u = feature.evidence.tests.unit.length
  const i = feature.evidence.tests.integration.length
  const c = feature.evidence.tests.contract.length
  if (u + i + c > 0) {
    const bits: string[] = []
    if (u > 0) bits.push(`${u}u`)
    if (i > 0) bits.push(`${i}i`)
    if (c > 0) bits.push(`${c}c`)
    parts.push(bits.join("/"))
  }
  if (feature.knobs.length > 0) {
    parts.push(`⚙️${feature.knobs.join(", ")}`)
  }
  return parts.join(" · ")
}

interface E2EEntry {
  name: string
  title: string
}

function collectE2E(features: LoadedFeature[]): E2EEntry[] {
  const out: E2EEntry[] = []
  for (const { feature } of features) {
    for (const t of feature.evidence.tests.integration) {
      if (t.endsWith("-e2e.test.ts")) {
        const base = basename(t).replace(/-e2e\.test\.ts$/, "")
        out.push({ name: base, title: feature.title })
      }
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

function computeMaturityDistribution(features: LoadedFeature[]): Map<Maturity, Feature[]> {
  const map = new Map<Maturity, Feature[]>()
  for (const lf of features) {
    const bucket = map.get(lf.feature.maturity)
    if (bucket) bucket.push(lf.feature)
    else map.set(lf.feature.maturity, [lf.feature])
  }
  return map
}

function basename(p: string): string {
  const ix = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return ix >= 0 ? p.slice(ix + 1) : p
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function escapeCell(s: string): string {
  // Escape "|" inside markdown table cells.
  return s.replace(/\|/g, "\\|")
}

// --- Convenience loaders for prose + baseline ------------------------------

export async function loadProse(dir = "tools/feature-catalog/prose"): Promise<ProseFiles> {
  let entries: Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { intro: "", trailers: [] }
    throw err
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort()
  let intro = ""
  const trailers: { name: string; content: string }[] = []
  for (const name of files) {
    const content = await readFile(join(dir, name), "utf8")
    if (name.startsWith("00-")) {
      intro = content
    } else {
      trailers.push({ name, content })
    }
  }
  return { intro, trailers }
}

/** Read `baseline.json` produced by `refresh-baseline.ts`. The on-disk schema
 *  is rich (tsc/biome/per-tier breakdown) but the renderer only needs the flat
 *  totals shown in the footer — flatten here so the renderer stays tight. */
interface BaselineFileShape {
  generated_at?: string
  tests?: {
    pass?: number
    fail?: number
    skip?: number
    expect_count?: number
    files?: number
  }
}

export async function loadBaseline(
  path = "tools/feature-catalog/baseline.json",
): Promise<Baseline | null> {
  try {
    const text = await readFile(path, "utf8")
    const raw = JSON.parse(text) as BaselineFileShape
    const t = raw.tests
    if (
      typeof raw.generated_at === "string" &&
      t &&
      typeof t.pass === "number" &&
      typeof t.fail === "number" &&
      typeof t.skip === "number" &&
      typeof t.expect_count === "number" &&
      typeof t.files === "number"
    ) {
      return {
        pass: t.pass,
        fail: t.fail,
        skip: t.skip,
        expect: t.expect_count,
        files: t.files,
        generated_at: raw.generated_at,
      }
    }
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    throw err
  }
}
