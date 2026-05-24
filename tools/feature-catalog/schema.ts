/**
 * Feature-catalog zod schema + loader.
 *
 * Canonical schema for YAML-backed feature entries. See README.md for layout.
 * Mini-YAML parser lives in ./yaml.ts (no external yaml dep).
 */
import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { z } from "zod"
import { parseYaml } from "./yaml"

export const Maturity = z.enum(["L1", "L2", "L3", "L4", "L5"])
export const Status = z.enum(["stable", "new", "refined", "hold", "deprecated"])
export const LifecycleStage = z.enum([
  "proposed",
  "active",
  "deprecated",
  "sunset",
  "removed",
])

// SOTA Tier-3 — integration tracking axes.
export const UiSurface = z.enum(["cli", "web", "ide", "tauri", "api", "none", "n-a"])
export const IntegrationStatus = z.enum(["integrated", "partial", "planned", "none", "n-a"])
export const ConfigStatus = z.enum([
  "integrated",
  "partial",
  "planned",
  "static",
  "none",
  "n-a",
])
export const RunMode = z.enum([
  "interactive",
  "headless",
  "batch",
  "daemon",
  "ide",
  "ci-bot",
  "n-a",
])

export const FeatureSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case unique id"),
  title: z.string().min(1),
  section: z.number().int().min(1).max(20),
  subsystem: z.string().min(1),
  order: z.number().int().default(0),
  maturity: Maturity,
  status: Status.default("stable"),
  owners: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
  lifecycle_stage: LifecycleStage.default("active"),
  supersedes: z.array(z.string()).default([]),
  superseded_by: z.string().optional(),
  sunset_date: z.string().optional(),
  // SOTA Tier-3 — 4-axis integration tracking (all optional, defaults to "n-a").
  ui_surfaces: z.array(UiSurface).default([]),
  monitoring: IntegrationStatus.default("n-a"),
  modes: z.array(RunMode).default([]),
  configurable: ConfigStatus.default("n-a"),
  telemetry_keys: z.array(z.string()).default([]),
  config_refs: z
    .object({
      env: z.array(z.string()).default([]),
      runtime: z.array(z.string()).default([]),
      cli: z.array(z.string()).default([]),
      prefs: z.array(z.string()).default([]),
    })
    .partial()
    .default({}),
  purpose: z.string().min(1),
  evidence: z
    .object({
      code: z.array(z.string()).default([]),
      adrs: z.array(z.union([z.number().int(), z.string()])).default([]),
      tests: z
        .object({
          unit: z.array(z.string()).default([]),
          integration: z.array(z.string()).default([]),
          contract: z.array(z.string()).default([]),
        })
        .default({ unit: [], integration: [], contract: [] }),
    })
    .default({ code: [], adrs: [], tests: { unit: [], integration: [], contract: [] } }),
  knobs: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          where: z.string().optional(),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          purpose: z.string().optional(),
        }),
      ]),
    )
    .default([]),
  deliberate_hold: z
    .object({
      reason: z.string(),
      promotion_path: z.string().optional(),
    })
    .nullable()
    .default(null),
  notes: z.string().optional(),
})

export type Feature = z.infer<typeof FeatureSchema>
export type Maturity = z.infer<typeof Maturity>
export type Status = z.infer<typeof Status>
export type LifecycleStage = z.infer<typeof LifecycleStage>

export function computeGrade(f: Feature): "A" | "B" | "C" | "D" | "F" {
  const evidenceCount =
    f.evidence.code.length +
    f.evidence.tests.unit.length +
    f.evidence.tests.integration.length +
    f.evidence.tests.contract.length
  const hasAdr = f.evidence.adrs.length > 0
  const hasOwner = f.owners.length > 0
  if (evidenceCount === 0) return "F"
  if (evidenceCount === 1) return "D"
  if (evidenceCount <= 3) return "C"
  if (evidenceCount <= 5) return hasAdr || hasOwner ? "B" : "C"
  return hasAdr && hasOwner ? "A" : "B"
}

// --- SOTA Tier-4 — 4-axis composite judgment ------------------------------
//
// `computeGrade` above scores documentation/evidence quantity only.
// `computeAxisScores` / `computeJudgment` add operational coverage axes used
// to decide whether a registered L4+ feature is really wired-and-watched, or
// just "slice exists, never called". Use these to detect overclaimed-L4
// drift uncovered by the wave-2/wave-6 audits.
//
// Each axis is scored 0..3; total 0..12 maps to a composite letter.
//
// monitoring (0..3): "n-a"|"none" → 0, "planned" → 1, "partial" → 2,
//   "integrated" → 3
// hellgate   (0..3): count of test paths containing "hellgate" in
//   evidence.tests.{unit,integration,contract} (capped at 3)
// wiring     (0..3): callsite integration — ui_surfaces ∪ configurable.
//   0 = empty or [none]/[n-a]; 1 = ui_surfaces has any non-CLI surface or
//   ui_surfaces=[cli] but configurable=planned; 2 = ui_surfaces=[cli] +
//   configurable in {static, partial}; 3 = ui_surfaces=[cli] +
//   configurable=integrated
// structure  (0..3): modularization signal from evidence.code.
//   0 = empty; 1 = single file; 2 = 2..4 files; 3 = ≥5 files OR slice
//   barrel detected (any path matching `src/<slice>/index.ts`)
export interface AxisScores {
  readonly monitoring: 0 | 1 | 2 | 3
  readonly hellgate: 0 | 1 | 2 | 3
  readonly wiring: 0 | 1 | 2 | 3
  readonly structure: 0 | 1 | 2 | 3
  readonly total: number // 0..12
}

export function computeAxisScores(f: Feature): AxisScores {
  // monitoring
  const monMap = { integrated: 3, partial: 2, planned: 1, static: 0, none: 0, "n-a": 0 } as const
  const monitoring = (monMap[f.monitoring] ?? 0) as 0 | 1 | 2 | 3

  // hellgate
  const allTests = [
    ...f.evidence.tests.unit,
    ...f.evidence.tests.integration,
    ...f.evidence.tests.contract,
  ]
  const hellCount = allTests.filter((t) => t.includes("hellgate")).length
  const hellgate = (Math.min(hellCount, 3) as 0 | 1 | 2 | 3)

  // wiring
  const hasCli = f.ui_surfaces.includes("cli")
  const hasAnyRealSurface = f.ui_surfaces.some((s) => s !== "none" && s !== "n-a")
  let wiring: 0 | 1 | 2 | 3 = 0
  if (!hasAnyRealSurface) {
    wiring = 0
  } else if (!hasCli) {
    wiring = 1
  } else {
    const cfg = f.configurable
    if (cfg === "integrated") wiring = 3
    else if (cfg === "partial" || cfg === "static") wiring = 2
    else wiring = 1
  }

  // structure
  const codeLen = f.evidence.code.length
  const hasSliceBarrel = f.evidence.code.some((p) => /^src\/[^/]+\/index\.ts$/.test(p))
  let structure: 0 | 1 | 2 | 3 = 0
  if (codeLen === 0) structure = 0
  else if (codeLen === 1) structure = 1
  else if (codeLen <= 4) structure = 2
  else structure = 3
  if (hasSliceBarrel && structure < 3) structure = 3

  return {
    monitoring,
    hellgate,
    wiring,
    structure,
    total: monitoring + hellgate + wiring + structure,
  }
}

// Composite letter from 0..12 total + maturity adjustment.
// L4+ features with total<6 are flagged as "L4-overclaimed" via the
// `judge` command; this letter still maps cleanly so it composes with the
// evidence-only grade for two-axis viewing.
export function compositeLetter(total: number): "A" | "B" | "C" | "D" | "F" {
  if (total >= 10) return "A"
  if (total >= 7) return "B"
  if (total >= 4) return "C"
  if (total >= 2) return "D"
  return "F"
}

// Final judgment: combines axis composite with maturity claim. Flags
// overclaim when maturity = L4/L5 but operational composite is weak.
export interface FeatureJudgment {
  readonly axes: AxisScores
  readonly composite: "A" | "B" | "C" | "D" | "F"
  readonly evidenceGrade: "A" | "B" | "C" | "D" | "F"
  readonly verdict:
    | "solid" // L4+ and composite >= B
    | "thin" // L4+ and composite C
    | "overclaimed" // L4+ and composite D/F (registered, not really wired/watched)
    | "appropriate" // L1..L3 — no operational expectation
    | "deliberate-hold" // explicit hold record present
}

export function computeJudgment(f: Feature): FeatureJudgment {
  const axes = computeAxisScores(f)
  const composite = compositeLetter(axes.total)
  const evidenceGrade = computeGrade(f)
  let verdict: FeatureJudgment["verdict"]
  if (f.deliberate_hold !== null) verdict = "deliberate-hold"
  else if (f.maturity === "L1" || f.maturity === "L2" || f.maturity === "L3")
    verdict = "appropriate"
  else if (composite === "A" || composite === "B") verdict = "solid"
  else if (composite === "C") verdict = "thin"
  else verdict = "overclaimed"
  return { axes, composite, evidenceGrade, verdict }
}

/** Canonical section name map (1..10). */
export const SECTION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "에이전트 코어 루프 (ReAct)",
  2: "도구 시스템",
  3: "권한 & 안전",
  4: "컨텍스트 관리",
  5: "장기 메모리",
  6: "Tier-1 능력",
  7: "복원력",
  8: "관측성",
  9: "통합 (MCP/LSP/Hooks)",
  10: "앱/영속/정책",
})

/** ASCII slug map for filesystem directory naming (1..10). */
export const SECTION_SLUGS: Readonly<Record<number, string>> = Object.freeze({
  1: "agent-loop",
  2: "tool-system",
  3: "permission-safety",
  4: "context-management",
  5: "memory",
  6: "tier1",
  7: "resilience",
  8: "observability",
  9: "integration",
  10: "app",
})

/** Recursively gather *.yaml files under `dir`, sorted by relative path. */
async function gatherYamlFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return []
    throw err
  }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      out.push(...(await gatherYamlFiles(full)))
    } else if (ent.isFile() && ent.name.endsWith(".yaml")) {
      out.push(full)
    }
  }
  out.sort()
  return out
}

/** Loaded feature with its source path (for error reporting / diagnostics). */
export interface LoadedFeature {
  feature: Feature
  path: string
}

/**
 * Load + validate all features under `dir`. Throws on first parse/zod error
 * with a clear message including the source path.
 */
export async function loadFeatures(
  dir = "tools/feature-catalog/features",
): Promise<LoadedFeature[]> {
  const files = await gatherYamlFiles(dir)
  const loaded: LoadedFeature[] = []
  for (const path of files) {
    const text = await readFile(path, "utf8")
    let raw: unknown
    try {
      raw = parseYaml(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`YAML parse failed at ${relative(process.cwd(), path)}: ${msg}`)
    }
    const result = FeatureSchema.safeParse(raw)
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")
      throw new Error(`Schema validation failed at ${relative(process.cwd(), path)}:\n${issues}`)
    }
    loaded.push({ feature: result.data, path })
  }
  return loaded
}

/**
 * Load + cross-feature validation (unique id, valid section, deterministic
 * ordering). Throws on first cross-feature violation.
 */
export async function loadFeaturesStrict(
  dir = "tools/feature-catalog/features",
): Promise<LoadedFeature[]> {
  const loaded = await loadFeatures(dir)
  const seen = new Map<string, string>()
  for (const { feature, path } of loaded) {
    const prev = seen.get(feature.id)
    if (prev !== undefined) {
      throw new Error(
        `Duplicate feature id "${feature.id}": ${relative(process.cwd(), prev)} and ${relative(
          process.cwd(),
          path,
        )}`,
      )
    }
    seen.set(feature.id, path)
    if (!(feature.section in SECTION_NAMES)) {
      throw new Error(
        `Unknown section ${feature.section} in ${relative(process.cwd(), path)} (id=${feature.id})`,
      )
    }
  }
  // Stable sort: section → order → id
  loaded.sort((a, b) => {
    const sa = a.feature.section - b.feature.section
    if (sa !== 0) return sa
    const oa = a.feature.order - b.feature.order
    if (oa !== 0) return oa
    return a.feature.id < b.feature.id ? -1 : a.feature.id > b.feature.id ? 1 : 0
  })
  return loaded
}
