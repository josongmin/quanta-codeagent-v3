/**
 * Forcing-function ratchet: the bench agent's PROMPT STEERS must be GENERIC
 * METHOD guidance — never benchmark-instance-overfit recipes (answer-key /
 * leaderboard-gaming, banned by the no-heuristic-authority rule).
 *
 * Background: `driver.ts` once carried `*_STEER` constants that hard-coded
 * specific SWE-bench instances' gold-patch recipes (astropy TimeSeries
 * required-columns, django TIME_ZONE backend, django PostgreSQL dbshell) into the
 * agent prompt, keyword-triggered by the issue text. Removed jun-22 (294b40a8).
 *
 * v1 (jun-22) was a DENYLIST of those 3 steers' exact strings and scanned only
 * `*_STEER` consts in driver.ts. Adversarial audit (jun-24) showed it lacked
 * teeth: a NEW overfit steer for a DIFFERENT framework/recipe passed, and the
 * steers IMPORTED from `localize-phase-guard.ts` (LSP / find-refs / spec-fidelity)
 * were never scanned at all. The in-file "red-on-injection" was tautological —
 * it poisoned with a string assembled from its own needles.
 *
 * v2 (jun-24): (a) a framework-AGNOSTIC, class-level `detectOverfitSignals` shape
 * detector — a baked-in repo source path, a benchmark instance-id, or per-instance
 * "for the <X> issue" / "RCA target gate" framing trips it regardless of which
 * framework is named; (b) a WIDENED scan surface (driver.ts + the localize-phase-
 * guard steer module); (c) a REAL red-on-injection using a framework + file path
 * that appear in NO denylist, proving teeth on unseen input; (d) a provenance
 * guard that the dynamic multi-site steer builder never reads the gold patch.
 *
 * Needles/fixtures are assembled from fragments so THIS file never trips its own
 * scan.
 */

import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = (rel: string) => join(import.meta.dir, "../../", rel)
const read = (rel: string) => readFileSync(root(rel), "utf8")

// Every source file that declares a static string injected into the agent prompt.
// jul-02 god-file split: the `*_STEER` / `SWEBENCH_DIRECTIVE*` prompt constants were
// extracted, PURE code motion, from `src/runner/batch/eval/driver.ts` into the
// dedicated `./driver/prompt-directives.ts` module — scan there now.
const STEER_SOURCES = [
  "src/runner/batch/eval/driver/prompt-directives.ts", // SIMPLICITY / SIBLING_COMPLETION / SWEBENCH_DIRECTIVE*
  "src/agent/localize-phase-guard.ts", // LSP_GROUNDING / FIND_REFS / SPEC_FIDELITY
] as const

/** Generic apply_patch (V4A) format example — NOT a real repo path. */
const PLACEHOLDER_PATHS = ["path/to/file.py"]

// Benchmark frameworks (assembled so this file stays clean). A bare framework
// NAME alone is allowed (e.g. "large repos like sympy/django" is a tool-perf
// note); only a framework adjacent to an instance NUMBER trips signal (2).
const FRAMEWORKS = [
  "astro" + "py",
  "django",
  "sym" + "py",
  "sphinx",
  "matplotlib",
  "py" + "test",
  "py" + "lint",
  "xarray",
  "seaborn",
  "requests",
  "scikit",
  "numpy",
  "scipy",
  "pandas",
  "flask",
]

// Exact gold-patch recipe fragments from the 3 removed steers (belt-and-suspenders
// denylist on top of the class detector; assembled from fragments).
const GOLD_RECIPE = [
  "time" + "series",
  "required" + "_columns",
  "time" + "_zone backend",
  "postgresql dbshell",
  "self.connection.timezone" + "_name",
  "registered python udf",
  "udf arity",
  "env or none",
]

/**
 * Framework-AGNOSTIC class detector. Returns the reasons a steer text looks like
 * an answer-key recipe rather than generic method guidance. Empty ⇒ clean.
 */
const detectOverfitSignals = (text: string): string[] => {
  const t = text.toLowerCase()
  const reasons: string[] = []

  // (1) a real MULTI-SEGMENT repo source path baked into a static steer
  //     (e.g. db/backends/mysql/operations.py). Generic steers carry none; the
  //     V4A `path/to/file.py` format example is allowlisted.
  const paths = t.match(/\b[a-z_][\w]*(?:\/[\w.]+)+\.py\b/g) ?? []
  const realPaths = paths.filter((p) => !PLACEHOLDER_PATHS.includes(p))
  if (realPaths.length > 0) reasons.push(`repo-path:${realPaths[0]}`)

  // (2) a benchmark INSTANCE reference: a framework name within ~12 chars of a
  //     3-5 digit id (django-11734, astropy__astropy-13398, "sympy 16597 …").
  for (const fw of FRAMEWORKS) {
    if (new RegExp(`\\b${fw}\\b[\\s\\S]{0,12}?\\d{3,5}\\b`).test(t)) {
      reasons.push(`instance-id:${fw}`)
      break
    }
  }

  // (3) per-instance RCA framing — the signature of the removed steers.
  if (/\bfor the\b[^.\n]{1,40}\bissue\b/.test(t)) reasons.push("per-instance-framing")
  if (/\brca[\s-]?target[\s-]?gate\b/.test(t)) reasons.push("rca-target-gate")

  // (4) exact gold-recipe fragments from the removed steers.
  for (const n of GOLD_RECIPE) {
    if (t.includes(n)) {
      reasons.push(`gold-recipe:${n}`)
      break
    }
  }
  return reasons
}

/** Bodies of every `*_STEER` / `*_DIRECTIVE` constant in one source string
 *  (concatenated "..." / `...` literals and [...] arrays joined, lowercased).
 *  Name CONTAINS _STEER/_DIRECTIVE (not just ends with it) so the lean/noexec/
 *  repro DIRECTIVE variants (…_DIRECTIVE_LEAN_HEAD, …_DIRECTIVE_NOEXEC) are caught. */
const extractSteerBodies = (src: string): { name: string; body: string }[] => {
  const out: { name: string; body: string }[] = []
  const re =
    /(?:const|export const)\s+([A-Za-z_]*(?:_STEER|_DIRECTIVE)[A-Za-z_]*)\b\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*|`(?:[^`\\]|\\.)*`\s*\+?\s*|\[[\s\S]*?\]\s*)+)/g
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const lits = m[2]?.match(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g) ?? []
    out.push({ name: m[1] ?? "", body: lits.join(" ").toLowerCase() })
  }
  return out
}

const steerBodies = (): { name: string; body: string; file: string }[] =>
  STEER_SOURCES.flatMap((file) => extractSteerBodies(read(file)).map((s) => ({ ...s, file })))

describe("no-benchmark-overfit-steer ratchet", () => {
  const steers = steerBodies()

  it("sanity: the scanner finds the surviving generic steers across BOTH sources", () => {
    // v1 only saw 2 (driver.ts locals). v2 must also see the localize-phase-guard
    // steers (LSP / find-refs / spec) + the SWEBENCH_DIRECTIVE family. If this is
    // low the regex broke and every assertion below is vacuous.
    expect(steers.length).toBeGreaterThanOrEqual(10)
    // and it must reach into localize-phase-guard.ts, not just driver.ts
    expect(steers.some((s) => s.file.endsWith("localize-phase-guard.ts"))).toBe(true)
  })

  it("every prompt steer is generic — no answer-key shape signals", () => {
    for (const s of steers) {
      const signals = detectOverfitSignals(s.body)
      expect(`${s.name}:${signals.join(",")}`).toBe(`${s.name}:`)
    }
  })

  it("detector has TEETH: real red-on-injection with a NOVEL framework + path", () => {
    // None of these strings is built from the denylists above — flask + a fresh
    // repo path + per-instance framing. A denylist-only ratchet would MISS them.
    const novelOverfits = [
      "for the " + "flask routing issue, edit src/" + "flask/blueprints.py so register() returns the adapter",
      "rca " + "target gate: patch lib/" + "requests/adapters.py for the redirect case",
      "for the pandas groupby " + "issue change pandas/core/groupby/ops.py",
    ]
    for (const bad of novelOverfits) {
      expect(`${bad.slice(0, 24)}… → ${detectOverfitSignals(bad).length > 0}`).toBe(
        `${bad.slice(0, 24)}… → true`,
      )
    }
    // …and the detector does NOT false-positive on a generic method steer that
    // merely NAMES a framework as a tool-performance example (the find-refs case).
    const benign = "prefer find_references over lsp_references which times out on large repos like sympy/django"
    expect(detectOverfitSignals(benign)).toEqual([])
  })

  it("end-to-end: a NEW overfit steer injected into the scanned surface is caught", () => {
    // The v1 failure mode: a freshly-added steer constant slipped through. Prove
    // the SCAN+DETECT pipeline (not just the detector) catches one. Synthetic
    // source — the real driver.ts is left untouched.
    const injected = [
      "const SIMPLICITY_STEER = \"prefer the simplest existing mechanism.\"",
      "const COLORMAP_STEER =",
      "  \"for the matplotlib colormap issue, edit lib/mpl/cm.py register() and colors.py __eq__\"",
    ].join("\n")
    const found = extractSteerBodies(injected)
    expect(found.map((s) => s.name).sort()).toEqual(["COLORMAP_STEER", "SIMPLICITY_STEER"])
    const dirty = found.filter((s) => detectOverfitSignals(s.body).length > 0).map((s) => s.name)
    expect(dirty).toEqual(["COLORMAP_STEER"]) // the generic one passes, the overfit one is flagged
  })

  it("the removed overfit steer symbols + keyword matchers stay gone", () => {
    const driver = read("src/runner/batch/eval/driver.ts")
    for (const sym of [
      "ADAPTER_FAMILY" + "_STEER",
      "MESSAGE_FORMAT" + "_STEER",
      "EXECUTION_ENV_BOUNDARY" + "_STEER",
      "hasAdapterFamily" + "Issue",
      "hasExecutionEnvBoundary" + "Issue",
      "hasExceptionMessageFormat" + "Issue",
      "buildIssueShape" + "Steers",
    ]) {
      expect(`${sym}:${driver.includes(sym)}`).toBe(`${sym}:false`)
    }
  })

  it("the deleted gold-patch-matcher answer-key files stay gone", () => {
    for (const f of [
      "src/runner/batch/eval/selection-declared-expected" + ".ts",
      "src/runner/knobs/knobs/rca-target-gates" + ".ts",
    ]) {
      expect(`${f}:${existsSync(root(f))}`).toBe(`${f}:false`)
    }
  })

  it("no bench-selection source matches candidate patches against gold file paths/symbols", () => {
    const files = ["src/runner/batch/eval/driver.ts", "src/apps/bench/eval/driver.ts"].map(read)
    const needles = [
      "db/backends/" + "mysql/operations.py",
      "db/backends/" + "postgresql/client.py",
      "create" + "_function('django_datetime",
      "self.connection.timezone" + "_name",
      "self.colnames[:len(required" + "_columns)]",
    ]
    for (const src of files) {
      for (const n of needles) {
        expect(`hit:${src.includes(n)}`).toBe("hit:false")
      }
    }
  })

  it("the dynamic multi-site steer builder never reads the gold patch (provenance)", () => {
    // buildMultisiteSteer interpolates `${file}:${line} (${cls}.${method})` from
    // CHA over the LIVE sandbox — sites are passed IN. A source-string scan can't
    // see runtime output, so guard the SOURCE: it must not read any oracle field.
    const cha = read("src/runner/batch/eval/cha-multisite.ts")
    // strip block + line comments so motivating examples (oracle.DatabaseOperations,
    // mysql/sqlite3) in the doc header don't false-trip the provenance scan.
    const code = cha.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    for (const oracle of ["goldPatch", "gold_patch", "test_patch", "failToPass", "FAIL_TO_PASS"]) {
      expect(`${oracle}:${code.includes(oracle)}`).toBe(`${oracle}:false`)
    }
  })
})
