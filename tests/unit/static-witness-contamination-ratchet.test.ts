/**
 * SCAFF-08 — SOURCE-LITERAL contamination ratchet over the NEW static-witness /
 * clean-contract / candidate-family scaffold modules.
 *
 * The Jun-22 scaffold (static-witness IR → static engine adapter → public
 * contracts → candidate families) REPLACES the benchmark-shaped heuristic
 * authority that previously memorized SWE-bench cases. The promotion criterion
 * (plan README) is: "static witness can generate the required co-change family
 * for the Django cases WITHOUT instance/gold/path-regex contamination". This
 * ratchet is the forcing function: it reads the raw SOURCE of every scaffold
 * builder and asserts NONE of them hardcodes benchmark-shaped authority —
 *
 *   - a SWE-bench instance-id prefix (`django__`, `astropy__`, ...),
 *   - a known contaminated target file path from the Django RCA cases
 *     (`db/backends/postgresql`, `.../base/client`, mysql/oracle/sqlite3),
 *   - a hidden-grader field used as a RUNTIME dependency
 *     (FAIL_TO_PASS / PASS_TO_PASS / test_patch / gold_patch),
 *   - a regex literal carrying a real dotted django module path / backend
 *     fragment (issue-family / known-file regex authority).
 *
 * if a future witness/contract builder hardcodes a django backend path or
 * instance id, this goes red.
 *
 * This is the NET-NEW piece of SCAFF-08 and does NOT duplicate
 * `clean-preset-research-knob-allowlist-ratchet.test.ts` (that ratchets clean
 * PRESETS against research-only KNOBS via resolved posture; this ratchets the
 * scaffold MODULE SOURCES against benchmark-shaped LITERALS). The light
 * cross-check at the bottom only confirms the authority taxonomy stays closed —
 * it does not re-derive the preset allowlist.
 *
 * SELF-FALSE-FAIL avoidance: this file must never itself contain a verbatim
 * forbidden literal (or the source scan of OTHER files is fine, but a future
 * grep over the test tree, and the synthetic self-test below, must reason about
 * needles that are ASSEMBLED from fragments at runtime). Every needle is built
 * by concatenation so no forbidden token appears literally in this source.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { SIGNAL_AUTHORITY } from "@/agent/verification-bundle"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const evalDir = path.join(repoRoot, "src", "runner", "batch", "eval")

/** The NEW static-witness / clean-contract / family scaffold modules whose
 *  SOURCE must stay free of benchmark-shaped contamination. A file that does not
 *  exist (renamed / not yet landed) is skipped — but the anti-vacuous floor test
 *  below guarantees a path typo across ALL of them can't silently pass. */
const SCAFFOLD_MODULES = [
  "static-witness.ts",
  "static-witness-adapter.ts",
  "static-witness-contracts.ts",
  "public-contract-bundle.ts",
  "candidate-families.ts",
] as const

interface ScannedSource {
  readonly name: string
  readonly source: string
}

const readScaffoldSources = (): ScannedSource[] => {
  const out: ScannedSource[] = []
  for (const name of SCAFFOLD_MODULES) {
    try {
      const source = readFileSync(path.join(evalDir, name), "utf8")
      out.push({ name, source })
    } catch {
      // missing file → skip; floor test enforces the set isn't empty/typo'd.
    }
  }
  return out
}

// ── forbidden needles, ASSEMBLED from fragments (so this test file itself holds
//    no verbatim forbidden literal — else it would self-false-fail any tree-wide
//    grep and confuse the synthetic self-test below). ────────────────────────

const SEP = "__"
/** SWE-bench instance-id prefixes: e.g. `django` + `__`. */
const INSTANCE_PREFIXES: readonly string[] = [
  "django",
  "astropy",
  "sympy",
  "pytest-dev",
  "scikit-learn",
  "matplotlib",
  "pydata",
  "mwaskom",
  "psf",
  "sphinx-doc",
].map((org) => org + SEP)

/** Known contaminated django RCA target file paths. Built as
 *  `db/backends/<engine>` so no full literal appears here. */
const DB = "db" + "/" + "backends"
const CONTAMINATED_PATHS: readonly string[] = [
  DB + "/" + "postgresql",
  DB + "/" + "base" + "/" + "client",
  DB + "/" + "mysql",
  DB + "/" + "oracle",
  DB + "/" + "sqlite3",
]

/** Hidden grader labels used as a RUNTIME dependency — none should legitimately
 *  appear in these scaffold sources at all. Assembled from fragments. */
const GRADER_FIELDS: readonly string[] = [
  ["FAIL", "TO", "PASS"].join("_"),
  ["PASS", "TO", "PASS"].join("_"),
  ["test", "patch"].join("_"),
  ["gold", "patch"].join("_"),
]

/** Issue-family / known-file regex authority: a regex literal carrying a real
 *  dotted django module path or a backend path fragment. `django` + `\.` + `db`
 *  is the escaped-dot module path that would appear inside a RegExp literal. */
const DOTTED_MODULE_NEEDLES: readonly string[] = [
  "django" + "\\." + "db",
  "django" + "\\." + "db" + "\\." + "backends",
]

const ALL_NEEDLES: readonly string[] = [
  ...INSTANCE_PREFIXES,
  ...CONTAMINATED_PATHS,
  ...GRADER_FIELDS,
  ...DOTTED_MODULE_NEEDLES,
]

/** The single matcher: every forbidden needle found in `source`. The synthetic
 *  self-test and the live ratchet share THIS function so the detector proven to
 *  work is the exact one used against real sources (no parallel drift). */
const contaminationHits = (source: string, needles: readonly string[] = ALL_NEEDLES): string[] =>
  needles.filter((n) => source.includes(n))

describe("SCAFF-08: static-witness scaffold sources carry no benchmark-shaped contamination", () => {
  const scanned = readScaffoldSources()

  // ── anti-vacuous floor (positive control): the scan actually READ non-empty
  // sources. A path typo across the whole set, or empty files, can't pass green. ──
  test("scan read real, non-empty scaffold sources (anti-vacuous floor)", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(4)
    const totalChars = scanned.reduce((sum, s) => sum + s.source.length, 0)
    expect(totalChars).toBeGreaterThan(500)
    // Each scanned file is itself non-empty (a single empty file can't pad).
    for (const s of scanned) {
      expect(s.source.length).toBeGreaterThan(0)
    }
  })

  // ── matcher self-test (teeth): build a synthetic source that EMBEDS one
  // assembled forbidden needle and prove the matcher FLAGS it — then prove the
  // SAME needle is absent from every real scaffold source. This proves the
  // detector is live (not a no-op that returns [] for everything). ──
  test("matcher self-test: flags a synthetic embedded needle, real sources lack it", () => {
    // Build the self-test needles from fragments directly (non-undefined string,
    // and identical by construction to the corresponding ALL_NEEDLES members).
    const instanceNeedle: string = "django" + SEP // e.g. `django` + `__`
    const pathNeedle: string = DB + "/" + "postgresql" // db/backends/postgresql
    const graderNeedle: string = ["FAIL", "TO", "PASS"].join("_") // FAIL_TO_PASS
    // Provenance: each self-test needle IS one of the real forbidden needles.
    expect(ALL_NEEDLES).toContain(instanceNeedle)
    expect(ALL_NEEDLES).toContain(pathNeedle)
    expect(ALL_NEEDLES).toContain(graderNeedle)
    const synthetic = `// memorized case ${instanceNeedle}14315 owner ${pathNeedle}/client.py gate ${graderNeedle}`

    const hits = contaminationHits(synthetic)
    // Detector flags all three embedded needles.
    expect(hits).toContain(instanceNeedle)
    expect(hits).toContain(pathNeedle)
    expect(hits).toContain(graderNeedle)
    expect(hits.length).toBeGreaterThanOrEqual(3)

    // And a clean string yields zero hits (no false positives).
    expect(contaminationHits("const x = computeStaticWitness(ir)")).toEqual([])

    // The exact synthetic needles are NOT present in any real scaffold source.
    for (const s of scanned) {
      expect(s.source.includes(instanceNeedle)).toBe(false)
      expect(s.source.includes(pathNeedle)).toBe(false)
      expect(s.source.includes(graderNeedle)).toBe(false)
    }
  })

  // ── the ratchet body: every scaffold source is free of EVERY forbidden needle.
  // Unconditional assert first (aggregate), then narrow per-category so a checker
  // that silently returned [] would still face the category-level pins below. ──
  test.each(SCAFFOLD_MODULES.map((m): [string] => [m]))(
    "scaffold module %s contains no benchmark-shaped contamination",
    (moduleName: string) => {
      const entry = scanned.find((s) => s.name === moduleName)
      if (entry === undefined) {
        // Missing file is allowed (skipped) — but record a visible skip rather
        // than a silent vacuous pass. The floor test guards the set as a whole.
        expect(SCAFFOLD_MODULES as readonly string[]).toContain(moduleName)
        return
      }
      const hits = contaminationHits(entry.source)
      expect(hits).toEqual([])

      // Per-category narrowing pins (independent of the aggregate matcher):
      for (const prefix of INSTANCE_PREFIXES) {
        expect(entry.source.includes(prefix)).toBe(false) // no SWE-bench instance id
      }
      for (const p of CONTAMINATED_PATHS) {
        expect(entry.source.includes(p)).toBe(false) // no contaminated django RCA path
      }
      for (const g of GRADER_FIELDS) {
        expect(entry.source.includes(g)).toBe(false) // no hidden-grader runtime dependency
      }
      for (const d of DOTTED_MODULE_NEEDLES) {
        expect(entry.source.includes(d)).toBe(false) // no dotted-module regex authority
      }
    },
  )

  // ── light cross-check (NOT a duplicate of the preset allowlist ratchet): every
  // `researchOnly` signal in the authority SSOT stays CLASSIFIED, so a new
  // research signal can't be added unclassified and silently sneak into clean
  // admissibility. We assert the taxonomy is closed and that the known
  // research-only signals retain their class. ──
  test("authority taxonomy stays closed: every researchOnly signal remains classified", () => {
    const entries = Object.entries(SIGNAL_AUTHORITY)
    // Every signal has a non-empty, recognized authority class (closed taxonomy).
    const VALID_CLASSES = new Set([
      "hardExecutable",
      "hardStructural",
      "contractDominance",
      "familyOrdering",
      "softTieBreak",
      "observeOnly",
      "researchOnly",
    ])
    for (const [name, cls] of entries) {
      expect(typeof cls).toBe("string")
      expect(VALID_CLASSES.has(cls)).toBe(true)
      expect(name.length).toBeGreaterThan(0)
    }

    // The benchmark-shaped / answer-key signals stay pinned as researchOnly — a
    // refactor that downgraded one of them into a hard authority class would let
    // it veto a clean candidate. (declaredExpectedMatch = answer-key matcher,
    // rubricScore = LLM rubric, smokeGreen = issue smoke.)
    const researchOnly = entries
      .filter(([, cls]) => cls === "researchOnly")
      .map(([name]) => name)
    expect(researchOnly.length).toBeGreaterThanOrEqual(3)
    expect(researchOnly).toContain("declaredExpectedMatch")
    expect(researchOnly).toContain("rubricScore")
    expect(researchOnly).toContain("smokeGreen")

    // And the executed-witness signals stay hardExecutable (so `discovered`
    // regression remains witness-backed, never a magic score). This pins the
    // boundary the scaffold must not blur.
    expect(SIGNAL_AUTHORITY.regressionGreen).toBe("hardExecutable")
    expect(SIGNAL_AUTHORITY.patchedResolvedKofN).toBe("hardExecutable")
  })
})
