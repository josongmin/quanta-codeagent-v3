import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import {
  assertWalkFloor,
  extractImports,
  listSliceTsFiles,
  readWalkedFiles,
  type WalkCoverage,
} from "./_arch/slice-boundary-scanner"
import { assertScanPopulation } from "./_shared/scan-population"

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

// Documented, reviewed cross-surface edges. Each entry is a DECLARED contract
// defended at review time — a new UNLISTED cross-surface import (including the
// const-alias dynamic-import trick the scanner now resolves) still fails.
//
//  • `agent/mode-presets/batch.ts -> @/apps/bench/eval` — the batch mode-preset's
//    LAZY fallback to the app-owned bench eval driver. The PRIMARY path is the
//    injected `req.seams?.runInstance` seam (assemble.ts keeps the preset
//    slice-isolated from `apps/bench`); the `import("@/apps/bench/eval")` in
//    `resolveRunInstance` only runs when no seam was injected (a real
//    `bun run bench`-style production call). The specifier was hoisted into the
//    `BENCH_EVAL_MODULE` const, which previously hid this edge from the literal-
//    only dynamic-import scanner; the scanner now const-resolves it, so the edge
//    is VISIBLE and explicitly sanctioned here rather than silent. (RFC
//    may-22-unified-agent-runtime / Phase 4+; see the batch.ts docblock.)
const ALLOWED_CROSS_SURFACE_IMPORTS = new Set<string>([
  "agent/mode-presets/batch.ts -> @/apps/bench/eval",
  // `quanta serve --stdio` reuses the headless surface's session opener
  // (`openHeadlessRuntimeSession` + `RecordingStream`) via a lazy `await
  // import("@/apps/headless")` — the stdio server IS a headless-style session
  // runner, so it genuinely shares that runtime helper rather than duplicating
  // it. Sanctioned reuse (same class as the batch→bench/eval edge); the
  // permanent home-move below src/apps/ is tracked with the serve-stdio refactor.
  "cli/serve-stdio-cmd.ts -> @/apps/headless",
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

/**
 * Enumerate, read, and report — with the read TOCTOU-safe and the coverage
 * handed back so the caller can assert a floor.
 *
 * `readWalkedFiles` skips a file that vanished between the walk and the read
 * (this tree churns under concurrent sessions, and an ENOENT here used to be an
 * unhandled throw). That skip is scoped to walk-derived paths only — a constant
 * path would still throw — but the moment ANY skip exists, "read nothing,
 * report no edges" becomes a way to be green, so every arm below asserts
 * {@link assertWalkFloor} on this coverage before it concludes anything.
 */
const collectCrossSurfaceImports = (): {
  readonly edges: readonly string[]
  readonly coverage: WalkCoverage
} => {
  const found: string[] = []
  const enumerated = listSliceTsFiles(APPS_DIR, false)
  assertScanPopulation(enumerated, APPS_DIR, {
    id: "tests/unit/surface-coupling-ratchet.test.ts#APPS-DIR",
    collectable: (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts") &&
      !name.includes(".from-worktree") &&
      !name.includes(".my-backup"),
    skipDirs: ["__tests__"],
  })
  const { files, coverage } = readWalkedFiles(APPS_DIR, enumerated, false)
  for (const { file, src } of files) {
    const rel = toPosix(relative(APPS_DIR, file))
    const fromSurface = rel.split("/")[0] ?? ""
    if (!APP_NAMES.has(fromSurface)) continue
    for (const { spec } of extractImports(src)) {
      const toSurface = targetSurfaceFor(file, spec)
      if (toSurface === null || toSurface === fromSurface) continue
      found.push(`${rel} -> ${spec}`)
    }
  }
  return { edges: found, coverage }
}

/** The scan plus its floor, asserted. Every arm goes through this. */
const scanned = (arm: string): readonly string[] => {
  const { edges, coverage } = collectCrossSurfaceImports()
  assertWalkFloor(coverage, `surface-coupling ratchet — ${arm}`)
  return edges
}

describe("surface coupling ratchet", () => {
  test("no new runtime imports cross app surfaces", () => {
    const unexpected = [...new Set(scanned("new cross-surface imports"))]
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
    const unsanctioned = [...new Set(scanned("debt ceiling"))].filter(
      (edge) => !ALLOWED_CROSS_SURFACE_IMPORTS.has(edge),
    )
    expect(unsanctioned.length).toBe(0)
  })

  test("FLOOR: the scan covered every surface under src/apps, not merely some files", () => {
    // "No unexpected edges" is only evidence if the walk actually reached every
    // surface. A global `read > 0` does not establish that — losing all of
    // `apps/cli/**` still leaves thousands of files and looks perfectly healthy.
    // MEASURED: with `src/apps/agent` silently dropped from the walk, the two
    // arms above stayed GREEN pre-floor. So: every surface directory that exists
    // must be a subtree that was BOTH enumerated AND read. `assertWalkFloor`
    // enforces this inside every arm above; this arm makes the coverage visible.
    const { coverage } = collectCrossSurfaceImports()
    assertWalkFloor(coverage, "surface-coupling ratchet — floor")
    const covered = new Set(coverage.readSubtrees.keys())
    const uncovered = [...APP_NAMES].filter((name) => !covered.has(name))
    expect(uncovered, "these src/apps surfaces contributed ZERO read files").toEqual([])
    expect(coverage.read.length).toBeGreaterThan(0)
  })
})
