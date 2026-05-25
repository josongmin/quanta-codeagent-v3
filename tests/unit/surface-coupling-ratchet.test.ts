import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { extractImports, listSliceTsFiles } from "./_arch/slice-boundary-scanner"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const APPS_DIR = join(REPO_ROOT, "src", "apps")
const APP_NAMES = new Set(["agent", "bench", "cli", "eval", "probe"])

const ALLOWED_CROSS_SURFACE_IMPORTS = new Set([
  "agent/index.ts -> ../cli/dotenv",
  "agent/index.ts -> ../cli/sandbox-wire",
  "agent/mode-presets/interactive.ts -> ../../cli/repl",
  "cli/internal.ts -> ../agent/search-pipeline-wire",
])

const toPosix = (path: string): string => path.replaceAll("\\", "/")

const targetSurfaceFor = (fromFile: string, spec: string): string | null => {
  if (spec.startsWith("@/apps/")) {
    const surface = spec.slice("@/apps/".length).split("/")[0] ?? ""
    return APP_NAMES.has(surface) ? surface : null
  }
  if (!spec.startsWith(".")) return null
  const abs = resolve(dirname(fromFile), spec)
  const rel = toPosix(relative(APPS_DIR, abs))
  if (rel.startsWith("..")) return null
  const surface = rel.split("/")[0] ?? ""
  return APP_NAMES.has(surface) ? surface : null
}

const collectCrossSurfaceImports = (): readonly string[] => {
  const found: string[] = []
  for (const file of listSliceTsFiles(APPS_DIR, false)) {
    const rel = toPosix(relative(APPS_DIR, file))
    const fromSurface = rel.split("/")[0] ?? ""
    if (!APP_NAMES.has(fromSurface)) continue
    const imports = extractImports(readFileSync(file, "utf8"))
    for (const { spec } of imports) {
      const toSurface = targetSurfaceFor(file, spec)
      if (toSurface === null || toSurface === fromSurface) continue
      found.push(`${rel} -> ${spec}`)
    }
  }
  return found
}

describe("surface coupling ratchet", () => {
  test("no new runtime imports cross app surfaces", () => {
    const unexpected = [...new Set(collectCrossSurfaceImports())]
      .sort()
      .filter((edge) => !ALLOWED_CROSS_SURFACE_IMPORTS.has(edge))

    if (unexpected.length > 0) {
      throw new Error(
        [
          "New cross-surface runtime imports detected under src/apps/.",
          "Surfaces must stay thin; move reusable logic below src/apps/ or add a typed port.",
          "",
          "Unexpected edges:",
          ...unexpected.map((edge) => `- ${edge}`),
          "",
          "Current documented temporary debt:",
          ...[...ALLOWED_CROSS_SURFACE_IMPORTS].sort().map((edge) => `- ${edge}`),
        ].join("\n"),
      )
    }

    expect(unexpected).toEqual([])
  })

  test("temporary debt ceiling does not grow", () => {
    const found = new Set(collectCrossSurfaceImports())
    expect(found.size).toBeLessThanOrEqual(ALLOWED_CROSS_SURFACE_IMPORTS.size)
  })
})
