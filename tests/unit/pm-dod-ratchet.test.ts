/**
 * ★ RATCHET — tools/pm Definition-of-Done, enforced in CI ("빵꾸 안나게").
 *
 * The DoD (catalog + TDD + e2e-hellgate, see tools/pm/README.md) is currently
 * unmet by a grandfathered set of pre-existing features (tools/pm/baseline.json).
 * This ratchet makes the bar BITE on new work WITHOUT forcing a big-bang cleanup:
 *
 *   1. NO NEW HOLES — a feature that fails the DoD and is NOT in the baseline
 *      fails this test. So every NEW or newly-touched feature must ship the full
 *      bar (catalog + unit tests + a *-hellgate/e2e test).
 *   2. MONOTONIC SHRINK — a baseline id that now PASSES (or no longer exists)
 *      must be REMOVED from baseline. The grandfathered set can only get smaller,
 *      never grow, and never goes stale.
 *
 * Remediation when this fails:
 *   - new failure  → add the missing piece (most often: a *-hellgate.test.ts
 *     driving the real composition path) and list it in the catalog entry.
 *   - fixed feature → delete its id from tools/pm/baseline.json.
 *   Regenerate is intentionally manual (edit baseline.json) so a regression
 *   cannot silently re-baseline itself.
 */

import { describe, expect, test } from "bun:test"
import { FEATURES_DIR as ANCHORED_FEATURES_DIR } from "../../tools/feature-catalog/paths"
import { loadFeaturesStrict } from "../../tools/feature-catalog/schema"
import baseline from "../../tools/pm/baseline.json"
import { checkFeatureDoD } from "../../tools/pm/definition-of-done"

// ANCHORED, not cwd-relative: `loadFeatures` now REFUSES a relative path,
// because a repo path built from the ambient cwd resolves to nothing outside
// the repo root and an empty catalog is indistinguishable from a clean one
// (`2845e206c`). The anchored constant is the SSOT both the tool and this test
// must read.
const FEATURES_DIR = ANCHORED_FEATURES_DIR
describe("Definition-of-Done ratchet (tools/pm)", () => {
  const baselineSet = new Set(baseline as string[])
  // Both monotonic directions inspect the same immutable catalog. Share the
  // one expensive evidence walk so host contention cannot turn the second
  // assertion into a duplicate full-corpus scan.
  let verdictsOnce:
    | Promise<readonly { readonly id: string; readonly verdict: "pass" | "fail" }[]>
    | undefined
  const featureVerdicts = () =>
    (verdictsOnce ??= loadFeaturesStrict(FEATURES_DIR).then((features) =>
      features.map((loaded) => {
        const result = checkFeatureDoD(loaded.feature)
        return { id: result.id, verdict: result.verdict }
      }),
    ))

  test("NO NEW HOLES — every DoD failure is grandfathered in baseline.json", async () => {
    const failingNow = (await featureVerdicts())
      .filter((result) => result.verdict === "fail")
      .map((result) => result.id)

    const newFailures = failingNow.filter((id) => !baselineSet.has(id))
    if (newFailures.length > 0) {
      throw new Error(
        `${newFailures.length} feature(s) FAIL the Definition of Done but are not grandfathered:\n` +
          newFailures.map((id) => `  - ${id}`).join("\n") +
          `\n\nEvery new/touched feature must ship: catalog entry + unit tests + a` +
          ` *-hellgate/e2e test (see tools/pm/README.md). Run` +
          ` \`bun tools/pm/check.ts ${newFailures[0]}\` for the per-axis breakdown.`,
      )
    }
    expect(newFailures).toEqual([])
  }, 300_000)

  test("MONOTONIC SHRINK — no stale baseline entries (a fixed/removed feature must leave baseline)", async () => {
    const results = await featureVerdicts()
    const byId = new Set(results.map((result) => result.id))
    const verdict = new Map(results.map((result) => [result.id, result.verdict]))

    const stale = (baseline as string[]).filter((id) => {
      const exists = byId.has(id)
      // Stale if the id is gone, OR it now PASSES the DoD (no longer needs grandfathering).
      return !exists || verdict.get(id) === "pass"
    })
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} baseline id(s) are stale (fixed or removed) — delete them from ` +
          `tools/pm/baseline.json so the grandfathered set shrinks monotonically:\n` +
          stale.map((id) => `  - ${id}`).join("\n"),
      )
    }
    expect(stale).toEqual([])
  }, 300_000)

  test("baseline is a clean string[] with no duplicates", () => {
    const arr = baseline as string[]
    expect(Array.isArray(arr)).toBe(true)
    expect(new Set(arr).size).toBe(arr.length)
  })
})
