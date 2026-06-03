import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { extractImports, listSliceTsFiles } from "./_arch/slice-boundary-scanner"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const APPS_DIR = join(REPO_ROOT, "src", "apps")

// EVERY surface tree under src/apps/, DERIVED from the filesystem — never a
// hand-maintained literal. A surface absent from this set is NOT skipped-as-
// clean: it is a silent hole, because `collectCrossSurfaceImports` only inspects
// files whose FROM-surface is a member. `web-daemon` was historically omitted
// from a hardcoded list, which let `apps/web-daemon/runtime-factory.ts` import
// `@/apps/agent/...` undetected (the shared assembler now lives in
// `@/host/runtime`). Deriving the set from `readdirSync` means a NEW surface is
// covered the moment its directory exists — no one has to remember to add it.
const APP_NAMES: ReadonlySet<string> = new Set(
  readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name),
)

const ALLOWED_CROSS_SURFACE_IMPORTS = new Set<string>()

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
          "Surfaces must stay thin; move reusable logic below src/apps/.",
          "",
          "Unexpected edges:",
          ...unexpected.map((edge) => `- ${edge}`),
        ].join("\n"),
      )
    }

    expect(unexpected).toEqual([])
  })

  test("temporary debt ceiling does not grow (beyond the sanctioned allowlist)", () => {
    // Count only edges NOT in the explicit allowlist — the ceiling is "zero
    // UNSANCTIONED cross-surface imports". A new edge fails here AND in the
    // `no new runtime imports` test above unless it is added (with justification)
    // to ALLOWED_CROSS_SURFACE_IMPORTS.
    const unsanctioned = [...new Set(collectCrossSurfaceImports())].filter(
      (edge) => !ALLOWED_CROSS_SURFACE_IMPORTS.has(edge),
    )
    expect(unsanctioned.length).toBe(0)
  })
})
