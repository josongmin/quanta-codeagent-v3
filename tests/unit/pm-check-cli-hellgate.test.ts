/**
 * ★ HELLGATE — tools/pm/check.ts CLI composition root (the real CI/pre-push entry).
 *
 * The pure judge `checkFeatureDoD` is covered by pm-definition-of-done.test.ts, but
 * the composition root `main()` in tools/pm/check.ts — argv parsing, the load-bearing
 * exit-code contract `process.exit(failed>0||missing>0 ? 1 : 0)` (with no-args ⇒ 2),
 * --strict propagation into `checkFeatureDoD(feature, strict)`, and the MISSING path —
 * had ZERO end-to-end coverage. One real subprocess pins the executable wrapper;
 * the remaining cases call the exported application boundary with one preloaded
 * on-disk catalog and exact stdout/stderr capture.
 *
 * Exit-code contract under test:
 *   - no args / no --all      ⇒ 2  (usage error)
 *   - all checked ids PASS    ⇒ 0
 *   - any id FAILS the DoD    ⇒ 1
 *   - any id MISSING          ⇒ 1  (+ a "MISSING <id>" line on stderr)
 *   - --strict holds an L2 seam to the full bar ⇒ a default-PASS flips to FAIL (1)
 *
 * The id fixtures below are chosen from the committed catalog and re-derived live in
 * the "self-consistency" guard so this stays honest if the catalog shifts.
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { FEATURES_DIR as ANCHORED_FEATURES_DIR } from "../../tools/feature-catalog/paths"
import { type LoadedFeature, loadFeaturesStrict } from "../../tools/feature-catalog/schema"
import { runPmCheck } from "../../tools/pm/check"
import { checkFeatureDoD } from "../../tools/pm/definition-of-done"

// ANCHORED on this file, never a machine path: a hardcoded absolute repo root
// makes the whole file hard-red in a worktree or on any other checkout, which
// is exactly the portability trap the `FEATURES_DIR` anchoring below fixes.
const REPO = join(import.meta.dir, "..", "..")
// ANCHORED, not cwd-relative: `loadFeatures` now REFUSES a relative path,
// because a repo path built from the ambient cwd resolves to nothing outside
// the repo root and an empty catalog is indistinguishable from a clean one
// (`2845e206c`). The anchored constant is the SSOT both the tool and this test
// must read.
const FEATURES_DIR = ANCHORED_FEATURES_DIR
// This guard re-parses the whole production catalog to verify the subprocess
// fixtures. It is an integrity census, so use the established finite full-scan
// allowance rather than a latency budget under an eight-shard host.
const FULL_CATALOG_SCAN_TIMEOUT_MS = 300_000

/** Run the REAL CLI composition root as a subprocess (the path CI/pre-push runs). */
const runCheck = (...args: string[]) =>
  spawnSync(process.execPath, ["tools/pm/check.ts", ...args], {
    cwd: REPO,
    encoding: "utf8",
  })

let features: readonly LoadedFeature[] = []
beforeAll(async () => {
  features = await loadFeaturesStrict(FEATURES_DIR)
})

const runApplication = async (...args: string[]) => {
  let stdout = ""
  let stderr = ""
  const status = await runPmCheck(args, {
    features,
    stdout: (chunk) => {
      stdout += chunk
    },
    stderr: (chunk) => {
      stderr += chunk
    },
  })
  return { status, stdout, stderr }
}

// Stable fixtures from the committed catalog (asserted in the self-consistency guard).
const PASSING_ID = "skill-mcp-deps" // full-bar L3 with catalog + unit + hellgate.
const FAILING_ID = "image-gen" // fails the DoD on the committed tree (catalog axis).
const L2_SEAM_ID = "special-path-resolver" // L2 seam: catalog-only bar ⇒ passes unless --strict.
const UNKNOWN_ID = "totally-not-a-real-feature-id-xyz"

describe("tools/pm/check.ts CLI — exit-code contract end-to-end", () => {
  test("no args ⇒ exit 2 + usage on stderr (does NOT silently pass)", async () => {
    const out = await runApplication()
    expect(out.status).toBe(2)
    expect(out.stderr).toContain("usage: bun tools/pm/check.ts")
  })

  test("a passing id ⇒ exit 0 (real load → checkFeatureDoD → process.exit path)", async () => {
    const out = runCheck(PASSING_ID)
    const application = await runApplication(PASSING_ID)
    expect(out.status).toBe(0)
    expect(out.stdout).toBe(application.stdout)
    expect(out.stderr).toBe(application.stderr)
    expect(out.stdout).toContain("PASS")
    expect(out.stdout).toContain(PASSING_ID)
  }, 30_000)

  test("a DoD-failing id ⇒ exit 1 + FAIL in report", async () => {
    const out = await runApplication(FAILING_ID)
    expect(out.status).toBe(1)
    expect(out.stdout).toContain("FAIL")
    expect(out.stdout).toContain(FAILING_ID)
  })

  test("an unknown id ⇒ exit 1 + a MISSING line on stderr", async () => {
    const out = await runApplication(UNKNOWN_ID)
    expect(out.status).toBe(1)
    expect(out.stderr).toContain("MISSING")
    expect(out.stderr).toContain(UNKNOWN_ID)
  })

  test("mixed passing + unknown ⇒ still exit 1 (missing forces non-zero)", async () => {
    const out = await runApplication(PASSING_ID, UNKNOWN_ID)
    expect(out.status).toBe(1)
    expect(out.stdout).toContain("PASS")
    expect(out.stderr).toContain("MISSING")
  })

  test("--strict propagates: an L2 seam passes by default but FAILS under --strict", async () => {
    const lax = await runApplication(L2_SEAM_ID)
    expect(lax.status).toBe(0)
    expect(lax.stdout).toContain("PASS")

    const strict = await runApplication(L2_SEAM_ID, "--strict")
    expect(strict.status).toBe(1)
    expect(strict.stdout).toContain("FAIL")
    // The strict summary line annotates the mode so the flip is visible.
    expect(strict.stdout).toContain("strict")
  })

  test("--strict flag order is immaterial (flag before id parses the same)", async () => {
    const a = await runApplication("--strict", L2_SEAM_ID)
    const b = await runApplication(L2_SEAM_ID, "--strict")
    expect(a.status).toBe(1)
    expect(b.status).toBe(1)
    expect(a.status).toBe(b.status)
  })
})

describe("tools/pm/check.ts CLI — fixture self-consistency (keeps this honest if catalog shifts)", () => {
  test(
    "the chosen fixtures still have the verdicts the exit-code tests assume",
    async () => {
      const byId = new Map(features.map((lf) => [lf.feature.id, lf.feature]))

      const passing = byId.get(PASSING_ID)
      expect(passing, `${PASSING_ID} must exist in the catalog`).toBeDefined()
      if (passing) {
        expect(checkFeatureDoD(passing).verdict).toBe("pass")
      }

      const failing = byId.get(FAILING_ID)
      expect(failing, `${FAILING_ID} must exist in the catalog`).toBeDefined()
      if (failing) {
        expect(checkFeatureDoD(failing).verdict).toBe("fail")
      }

      const seam = byId.get(L2_SEAM_ID)
      expect(seam, `${L2_SEAM_ID} must exist in the catalog`).toBeDefined()
      if (seam) {
        // L2 seam: catalog-only bar passes lax, full bar fails under strict.
        expect(checkFeatureDoD(seam, false).verdict).toBe("pass")
        expect(checkFeatureDoD(seam, true).verdict).toBe("fail")
      }

      // The "unknown" id must genuinely be absent.
      expect(byId.has(UNKNOWN_ID)).toBe(false)
    },
    FULL_CATALOG_SCAN_TIMEOUT_MS,
  )
})
