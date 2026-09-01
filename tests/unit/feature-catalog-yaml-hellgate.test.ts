// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
//
// HELLGATE — durable lock against feature-catalog YAML SSOT CORRUPTION.
//
// This ratchet locks out DUPLICATE MAPPING KEYS. The compact parser's
// last-key-wins behavior
//      would silently overwrite the first value, so `loadFeatures` now first
//      requires standard YAML with unique keys. The raw-text scan below keeps
//      a pinpointed regression signal for duplicated test evidence keys.
// Stale evidence paths have one stronger owner in
// `feature-catalog-evidence-existence-hellgate.test.ts`: it de-duplicates the
// citations, probes them concurrently, and carries its own red-on-injection
// and CLI exit-code contracts. Repeating that full sweep here added no witness.
//
// Anti-vacuous: asserts the real catalog has >0 YAML files before scanning, so
// an empty glob can't make the check pass by iterating nothing.
//
// Red-on-injection: a synthetic YAML block with a duplicate mapping key proves
// the check actually goes RED and cannot vacuously pass.
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { assertScanPopulation } from "./_shared/scan-population"

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

// --- No duplicate mapping keys ---------------------------------------------

describe("fc YAML — no duplicate mapping keys (anti last-key-wins silent drop)", () => {
  test("no fc YAML declares unit/integration/contract twice at the same indent", async () => {
    const files = await gatherYamlFiles(FEATURES_DIR)
    assertScanPopulation(files, FEATURES_DIR, {
      collectable: (name) => name.endsWith(".yaml"),
      id: "tests/unit/feature-catalog-yaml-hellgate.test.ts#FEATURE-YAMLS",
    })

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
    // The catalog currently has >1k files. Keep the full scan, but allow the
    // shared eight-shard CI run enough I/O headroom; this is not a reduced
    // coverage timeout.
  }, 300000)
})

// --- Red-on-injection: the check has teeth ---------------------------------

describe("fc YAML hellgate — red-on-injection (has teeth)", () => {
  function fixtureYaml(): string {
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
      '    unit: ["tests/unit/probe.test.ts"]',
      '    unit: ["tests/unit/probe.test.ts"]',
      "    integration: []",
      "    contract: []",
      "",
    ].join("\n")
  }

  test("scanner flags the injected duplicate `unit:` key", () => {
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
})
