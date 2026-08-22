// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
//
// HELLGATE — durable lock against feature-catalog YAML SSOT CORRUPTION.
//
// Two rot classes this ratchet locks out:
//
//  (A) DUPLICATE MAPPING KEYS. The compact parser's last-key-wins behavior
//      would silently overwrite the first value, so `loadFeatures` now first
//      requires standard YAML with unique keys. The raw-text scan below keeps
//      a pinpointed regression signal for duplicated test evidence keys.
//
//  (B) STALE EVIDENCE PATHS.  Every evidence.code + evidence.tests.* citation
//      must resolve to a real file on disk (mirrors `fc validate --strict`).
//
// Anti-vacuous: asserts the real catalog has >0 YAML files before scanning, so
// an empty glob can't make either check pass by iterating nothing.
//
// Red-on-injection: a temp fixture YAML with (1) a duplicate mapping key and
// (2) a fabricated dangling path proves each check actually goes RED — the
// gates have teeth and cannot vacuously pass.
import { describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import type { Feature } from "../../tools/feature-catalog/schema"
import { loadFeaturesStrict } from "../../tools/feature-catalog/schema"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const FEATURES_DIR = resolve(REPO_ROOT, "tools/feature-catalog/features")

// Mapping keys whose accidental double-declaration silently drops a list under
// the last-key-wins mini-YAML parser. Scoped to the tests block schema.
const DUP_SENSITIVE_KEYS = ["unit", "integration", "contract"] as const

interface DupKeyHit {
  readonly key: string
  readonly indent: number
  readonly firstLine: number
  readonly dupLine: number
}

/**
 * Raw-text scan for a mapping key declared twice at the SAME indentation.
 * Standard-YAML validation rejects any duplicate first; this supplements that
 * gate with a focused message for the test-evidence lists most prone to drift.
 */
function isDupSensitive(key: string): boolean {
  return DUP_SENSITIVE_KEYS.includes(key as (typeof DUP_SENSITIVE_KEYS)[number])
}

/** Drop indent-buckets deeper than `indent` — a key at indent N closes every
 *  deeper block, so a same-name key nested elsewhere doesn't collide. */
function closeDeeperScopes(seenByIndent: Map<number, Map<string, number>>, indent: number): void {
  for (const seenIndent of [...seenByIndent.keys()]) {
    if (seenIndent > indent) seenByIndent.delete(seenIndent)
  }
}

function findDuplicateKeys(text: string): DupKeyHit[] {
  const hits: DupKeyHit[] = []
  const lines = text.split("\n")
  // (indent -> (key -> first-seen 1-based lineno)) — reset on dedent so a key
  // reused in a DIFFERENT sibling block is not a false positive.
  const seenByIndent = new Map<number, Map<string, number>>()
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(/^( *)([A-Za-z_][A-Za-z0-9_-]*):(\s|$)/)
    if (!m) continue
    const indent = (m[1] ?? "").length
    const key = m[2] ?? ""
    closeDeeperScopes(seenByIndent, indent)
    if (!isDupSensitive(key)) continue
    const bucket = seenByIndent.get(indent) ?? new Map<string, number>()
    seenByIndent.set(indent, bucket)
    const first = bucket.get(key)
    if (first !== undefined) hits.push({ key, indent, firstLine: first, dupLine: i + 1 })
    else bucket.set(key, i + 1)
  }
  return hits
}

async function gatherYamlFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises")
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await gatherYamlFiles(full)))
    else if (ent.isFile() && ent.name.endsWith(".yaml")) out.push(full)
  }
  return out
}

async function pathExists(repoRelative: string): Promise<boolean> {
  try {
    await access(resolve(REPO_ROOT, repoRelative))
    return true
  } catch {
    return false
  }
}

function evidencePaths(feature: Feature): Array<{ kind: string; path: string }> {
  return [
    ...feature.evidence.code.map((p) => ({ kind: "code", path: p })),
    ...feature.evidence.tests.unit.map((p) => ({ kind: "test.unit", path: p })),
    ...feature.evidence.tests.integration.map((p) => ({ kind: "test.integration", path: p })),
    ...feature.evidence.tests.contract.map((p) => ({ kind: "test.contract", path: p })),
  ]
}

// --- Check 1: no duplicate mapping keys ------------------------------------

describe("fc YAML — no duplicate mapping keys (anti last-key-wins silent drop)", () => {
  test("no fc YAML declares unit/integration/contract twice at the same indent", async () => {
    const files = await gatherYamlFiles(FEATURES_DIR)
    expect(files.length).toBeGreaterThan(0) // anti-vacuous

    const errors: string[] = []
    for (const file of files) {
      const text = await readFile(file, "utf8")
      for (const hit of findDuplicateKeys(text)) {
        errors.push(
          `${relative(REPO_ROOT, file)}: duplicate "${hit.key}:" key ` +
            `(indent ${hit.indent}) — first at line ${hit.firstLine}, again at line ${hit.dupLine}; ` +
            `first list is silently dropped by last-key-wins parse`,
        )
      }
    }
    expect(errors, `\n${errors.join("\n")}`).toEqual([])
  }, 30000)
})

// --- Check 2: evidence paths resolve on disk -------------------------------

describe("fc YAML — evidence paths resolve on disk (anti-drift)", () => {
  test("every evidence.code + evidence.tests.* path exists", async () => {
    const features = await loadFeaturesStrict(FEATURES_DIR)
    expect(features.length).toBeGreaterThan(0) // anti-vacuous

    const errors: string[] = []
    for (const { feature, path } of features) {
      for (const { kind, path: p } of evidencePaths(feature)) {
        if (!(await pathExists(p))) {
          errors.push(`${relative(REPO_ROOT, path)}: stale evidence.${kind} "${p}"`)
        }
      }
    }
    expect(errors, `\n${errors.join("\n")}`).toEqual([])
  }, 30000)
})

// --- Red-on-injection: both checks have teeth ------------------------------

describe("fc YAML hellgate — red-on-injection (has teeth)", () => {
  const FIXTURE_UNIT = "tests/unit/probe.test.ts" // a real file (no false path fail)
  const FIXTURE_FAKE = "tests/unit/this-fc-hellgate-fixture-does-not-exist-zzz.test.ts"

  function fixtureYaml({
    withDuplicate = true,
  }: {
    readonly withDuplicate?: boolean
  } = {}): string {
    return [
      "id: fc-hellgate-injection-probe",
      "title: injection probe",
      "section: 1",
      "subsystem: x",
      "maturity: L3",
      "purpose: x",
      "evidence:",
      "  code: []",
      "  tests:",
      // (1) duplicate `unit:` key at indent 4 → first list silently dropped.
      // The dangling-evidence rail below deliberately disables this separate
      // syntax violation so it can reach its own assertion.
      `    unit: ["${FIXTURE_UNIT}"]`,
      ...(withDuplicate ? [`    unit: ["${FIXTURE_UNIT}"]`] : []),
      // (2) a fabricated dangling path
      `    integration: ["${FIXTURE_FAKE}"]`,
      "    contract: []",
      "",
    ].join("\n")
  }

  test("check-1 scanner flags the injected duplicate `unit:` key", () => {
    const hits = findDuplicateKeys(fixtureYaml())
    const unitDup = hits.find((h) => h.key === "unit")
    expect(unitDup).toBeDefined()
    expect(unitDup?.indent).toBe(4)
  })

  test("a clean single-key block is NOT flagged (no false positive)", () => {
    const clean = [
      "evidence:",
      "  tests:",
      '    unit: ["a.test.ts"]',
      '    integration: ["b.test.ts"]',
      "    contract: []",
      "",
    ].join("\n")
    expect(findDuplicateKeys(clean)).toEqual([])
  })

  test("check-2 existence gate flags the injected dangling path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-yaml-hellgate-"))
    try {
      const featDir = join(dir, "01-agent-loop")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(featDir, { recursive: true })
      await writeFile(join(featDir, "probe.yaml"), fixtureYaml({ withDuplicate: false }), "utf8")

      const features = await loadFeaturesStrict(dir)
      expect(features.length).toBe(1)

      const missing: string[] = []
      for (const { feature } of features) {
        for (const { path: p } of evidencePaths(feature)) {
          if (!(await pathExists(p))) missing.push(p)
        }
      }
      expect(missing).toContain(FIXTURE_FAKE)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
