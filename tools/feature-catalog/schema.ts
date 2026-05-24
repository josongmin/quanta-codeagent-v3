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

export const FeatureSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case unique id"),
  title: z.string().min(1),
  section: z.number().int().min(1).max(20),
  subsystem: z.string().min(1),
  order: z.number().int().default(0),
  maturity: Maturity,
  status: Status.default("stable"),
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
