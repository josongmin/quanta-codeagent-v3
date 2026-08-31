/**
 * Hellgate — the feature catalog cannot report success over a catalog it never read.
 *
 * ## The defect, reproduced on main before this file existed
 *
 * ```
 * repo cwd    : validate: 1068 feature(s), all evidence resolved   exit=0
 * foreign cwd : validate:    0 feature(s), all evidence resolved   exit=0
 * ```
 *
 * Checking 1,068 features and checking zero emit the same success. The same shape
 * held for two more commands: `surface-derive` printed `web: {}` and `lint` printed
 * `ok — empty stubs=0/0`, both exit 0.
 *
 * ## Why the previous fix did not hold
 *
 * `loadFeaturesStrict`'s DEFAULT was anchored on `import.meta.dir` in an earlier
 * pass. It made no difference, because no consumer uses the default:
 * `cli.ts`, `surface-derive.ts` and `pm/check.ts` each declare
 * `const FEATURES_DIR = "tools/feature-catalog/features"` and pass it explicitly —
 * ten call sites in `cli.ts` alone. Fixing a default that every caller overrides
 * is a fix that reports as landed and changes nothing.
 *
 * So the rule enforced here is not "the default is anchored" but **"a relative
 * path is refused"**. That cannot be overridden by a caller, because passing the
 * bad value is the thing that throws.
 *
 * ## The three-way distinction that makes the guard meaningful
 *
 * A loader has to tell three states apart, and the old one collapsed them into
 * `[]`:
 *
 *   - **relative path** — the caller cannot say where the repo is → THROW,
 *     because the answer depends on the cwd and is therefore not an answer.
 *   - **absolute path that does not exist** — the caller pointed at nothing →
 *     THROW, since "the catalog is missing" is never a clean catalog.
 *   - **absolute path that exists and is empty** → `[]`, the one case where an
 *     empty result is a real finding.
 *
 * `tests/unit/feature-catalog-schema.test.ts` previously asserted the second case
 * returns `[]` — a test pinning the defect as correct. It is replaced by the
 * three cases below.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadFeatures, loadFeaturesStrict } from "@/../tools/feature-catalog/schema"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const FEATURES = join(REPO_ROOT, "tools", "feature-catalog", "features")

describe("feature catalog — a scan cannot report clean over a catalog it never read", () => {
  test("anti-vacuity: the real catalog is large, so the cases below are not empty-vs-empty", async () => {
    // Every assertion here is about telling "zero features" from "many". If the
    // real catalog were itself near-empty the distinction would be untestable and
    // this file would pass for free.
    const real = await loadFeaturesStrict(FEATURES)
    expect(real.length).toBeGreaterThan(500)
    // This parses the full >1k-feature corpus. Preserve that anti-vacuity
    // coverage, but leave shared eight-shard CI adequate I/O headroom.
  }, 120000)

  test("🔴 a RELATIVE path is refused — the cwd is not an answer", async () => {
    // The exact literal three consumers hardcode. Under a foreign cwd it resolved
    // to nothing and every caller read that as a clean catalog.
    await expect(loadFeatures("tools/feature-catalog/features")).rejects.toThrow(/absolute/i)
    await expect(loadFeaturesStrict("tools/feature-catalog/features")).rejects.toThrow(/absolute/i)
  })

  test("🔴 an ABSENT directory throws — it is not an empty catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-absent-"))
    try {
      await expect(loadFeatures(join(dir, "missing"))).rejects.toThrow(/not found|does not exist/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an EMPTY directory returns [] — the one case where empty is a real finding", async () => {
    // The other half of the distinction. Without this the fix could be "throw on
    // everything", which would be a different way of not knowing.
    const dir = mkdtempSync(join(tmpdir(), "fc-empty-"))
    try {
      expect(await loadFeatures(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the anchored constants resolve to the real catalog, from any cwd", async () => {
    // Pins the consumers' side of the fix: the shared anchored paths must point at
    // a populated directory, not merely be absolute.
    const { FEATURES_DIR, PROSE_DIR, BASELINE_PATH } = await import(
      "@/../tools/feature-catalog/paths"
    )
    for (const p of [FEATURES_DIR, PROSE_DIR, BASELINE_PATH]) {
      expect(p.startsWith("/"), `${p} must be absolute`).toBe(true)
    }
    expect((await loadFeaturesStrict(FEATURES_DIR)).length).toBeGreaterThan(500)
  }, 120000)
})
