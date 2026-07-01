/**
 * Parity guard: every `SLICE_BOUNDARY_CONFIGS` key MUST have a matching
 * `tests/unit/<slice>-slice-boundary.test.ts` entrypoint, and vice-versa.
 *
 * Why this exists: a per-slice config is INERT unless an entrypoint file calls
 * `registerSliceBoundarySuite(getSliceBoundaryConfig(slice))`. A config that is
 * registered but never wired to an entrypoint is dead config — it silently
 * enforces nothing. This guard makes that failure mode impossible: add a config
 * without its entrypoint (or delete an entrypoint's config) and this test trips.
 */

import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { SLICE_BOUNDARY_CONFIGS } from "./_arch/slice-boundary-configs"

const UNIT_DIR = dirname(fileURLToPath(import.meta.url))
const ENTRYPOINT_RE = /^([a-z0-9-]+)-slice-boundary\.test\.ts$/

const entrypointSlices = (): Set<string> => {
  const out = new Set<string>()
  for (const name of readdirSync(UNIT_DIR)) {
    const m = ENTRYPOINT_RE.exec(name)
    // Exclude the composite proof suite (slice-boundary-up-import-proof.test.ts
    // does not match the `<slice>-slice-boundary.test.ts` shape anyway).
    if (m && join(UNIT_DIR, name)) out.add(m[1])
  }
  return out
}

describe("slice-boundary config <-> entrypoint parity", () => {
  test("every registered config has a wired entrypoint (no inert/dead config)", () => {
    const configs = new Set(Object.keys(SLICE_BOUNDARY_CONFIGS))
    const entrypoints = entrypointSlices()
    const configsWithoutEntrypoint = [...configs].filter((s) => !entrypoints.has(s)).sort()
    expect(configsWithoutEntrypoint).toEqual([])
  })

  test("every entrypoint maps to a registered config (no dangling entrypoint)", () => {
    const configs = new Set(Object.keys(SLICE_BOUNDARY_CONFIGS))
    const entrypoints = entrypointSlices()
    const entrypointsWithoutConfig = [...entrypoints].filter((s) => !configs.has(s)).sort()
    expect(entrypointsWithoutConfig).toEqual([])
  })
})
