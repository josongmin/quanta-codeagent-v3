// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
//
// HELLGATE — durable lock against feature-catalog EVIDENCE ROT.
//
// Background (jun-08): commit 18f22c88 moved many test files (e.g.
// tests/unit/X.test.ts → tests/unit/cli/X.test.ts; auth/→cli/, scheduler/→cli/)
// without updating the fc YAML `evidence:` paths that cite them, leaving ~30
// dangling citations. `bun fc validate --strict` already exits non-zero on
// these, but that gate only runs when someone invokes the CLI; this test puts
// the SAME invariant into the unit suite so the standard `bun test` run is
// red-on-rot.
//
// Invariant: EVERY fc feature's evidence.code + evidence.tests.{unit,
// integration,contract} path must resolve to a real file on disk. The exact
// path strings cited in YAML must equal where the file actually lives — no
// silent drift.
//
// Red-on-injection: the second describe-block fabricates a feature with a
// dangling evidence path and asserts the checker flags it, proving the gate has
// teeth (it can't vacuously pass).
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Feature } from "../../tools/feature-catalog/schema"
import { loadFeaturesStrict } from "../../tools/feature-catalog/schema"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const FEATURES_DIR = resolve(REPO_ROOT, "tools/feature-catalog/features")

async function pathExists(repoRelative: string): Promise<boolean> {
  try {
    await access(resolve(REPO_ROOT, repoRelative))
    return true
  } catch {
    return false
  }
}

/** Collect every (kind, path) evidence citation that does NOT resolve on disk.
 *  Mirrors `cmdValidate`'s code+tests evidence-on-disk check (ADRs excluded —
 *  those resolve by number, covered elsewhere). Pure: I/O via pathExists only. */
async function danglingEvidence(
  feature: Feature,
): Promise<Array<{ kind: string; path: string }>> {
  const out: Array<{ kind: string; path: string }> = []
  const checks: Array<{ kind: string; paths: string[] }> = [
    { kind: "code", paths: feature.evidence.code },
    { kind: "test.unit", paths: feature.evidence.tests.unit },
    { kind: "test.integration", paths: feature.evidence.tests.integration },
    { kind: "test.contract", paths: feature.evidence.tests.contract },
  ]
  for (const { kind, paths } of checks) {
    for (const p of paths) {
      if (!(await pathExists(p))) out.push({ kind, path: p })
    }
  }
  return out
}

describe("feature-catalog evidence existence (durable anti-rot lock)", () => {
  test("every fc entry's evidence code + test paths exist on disk", async () => {
    const features = await loadFeaturesStrict(FEATURES_DIR)
    expect(features.length).toBeGreaterThan(0)

    const errors: string[] = []
    for (const { feature, path } of features) {
      const dangling = await danglingEvidence(feature)
      for (const d of dangling) {
        errors.push(`${path}: dangling evidence.${d.kind} "${d.path}"`)
      }
    }

    // Surface the full list on failure so the fix is mechanical.
    expect(errors, errors.join("\n")).toEqual([])
  })
})

describe("evidence-existence checker — red-on-injection (has teeth)", () => {
  function makeFeature(overrides: Partial<Feature["evidence"]>): Feature {
    return {
      id: "injection-probe",
      title: "injection probe",
      section: 1,
      subsystem: "x",
      order: 0,
      maturity: "L3",
      status: "stable",
      owners: [],
      labels: [],
      depends_on: [],
      lifecycle_stage: "active",
      supersedes: [],
      ui_surfaces: [],
      monitoring: "n-a",
      modes: [],
      configurable: "n-a",
      telemetry_keys: [],
      config_refs: { env: [], runtime: [], cli: [], prefs: [] },
      purpose: "x",
      evidence: {
        code: [],
        adrs: [],
        tests: { unit: [], integration: [], contract: [] },
        ...overrides,
      },
      knobs: [],
      deliberate_hold: null,
    } as Feature
  }

  test("a fabricated dangling evidence.code path is flagged", async () => {
    const f = makeFeature({
      code: ["src/this/path/definitely/does/not/exist-zzz.ts"],
    })
    const dangling = await danglingEvidence(f)
    expect(dangling).toEqual([
      { kind: "code", path: "src/this/path/definitely/does/not/exist-zzz.ts" },
    ])
  })

  test("a fabricated dangling evidence.tests.unit path is flagged", async () => {
    const f = makeFeature({
      tests: {
        unit: ["tests/unit/this-test-does-not-exist-zzz.test.ts"],
        integration: [],
        contract: [],
      },
    })
    const dangling = await danglingEvidence(f)
    expect(dangling).toEqual([
      { kind: "test.unit", path: "tests/unit/this-test-does-not-exist-zzz.test.ts" },
    ])
  })

  test("a real path is NOT flagged (no false positives)", async () => {
    const f = makeFeature({
      code: ["tools/feature-catalog/schema.ts"],
    })
    const dangling = await danglingEvidence(f)
    expect(dangling).toEqual([])
  })
})

// Exit-code contract: `bun fc validate --strict` must EXIT NON-ZERO when an
// evidence path is dangling — never silently print-and-pass. This drives the
// REAL CLI composition root (the path CI/pre-push runs) as a subprocess. cli.ts
// resolves its features dir relative to process.cwd(), so we point cwd at a temp
// fixture catalog (cli.ts's own relative imports still resolve from its script
// path). This locks the exit code so it can never regress to 0-on-rot.
describe("fc validate --strict — exit-code contract (anti silent-pass)", () => {
  const CLI = resolve(REPO_ROOT, "tools/feature-catalog/cli.ts")

  /** Write a minimal one-feature fixture catalog under `dir`. */
  async function writeFixtureCatalog(dir: string, codePath: string): Promise<void> {
    const featDir = join(dir, "tools/feature-catalog/features/01-agent-loop")
    await mkdir(featDir, { recursive: true })
    await writeFile(
      join(featDir, "probe.yaml"),
      [
        "id: exit-code-probe",
        "title: exit code probe",
        "section: 1",
        "subsystem: x",
        "maturity: L3",
        "purpose: x",
        "evidence:",
        "  code:",
        `    - ${codePath}`,
        "",
      ].join("\n"),
      "utf8",
    )
  }

  const runValidate = (cwd: string) =>
    spawnSync(process.execPath, [CLI, "validate", "--strict"], { cwd, encoding: "utf8" })

  test("dangling evidence ⇒ exit 1 (NOT a silent 0)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-exit-dangling-"))
    try {
      await writeFixtureCatalog(dir, "src/this/does/not/exist-zzz.ts")
      const out = runValidate(dir)
      expect(out.status).toBe(1)
      expect(out.stderr).toContain("missing evidence.code")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("all-resolvable evidence ⇒ exit 0 (no false fail)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-exit-clean-"))
    try {
      // A file that exists under the fixture cwd.
      await writeFixtureCatalog(dir, "real-evidence.ts")
      await writeFile(join(dir, "real-evidence.ts"), "export {}\n", "utf8")
      const out = runValidate(dir)
      expect(out.status).toBe(0)
      expect(out.stdout).toContain("all evidence resolved")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
