/**
 * Forcing-function ratchet (jun-22): the bench agent's PROMPT STEERS must be
 * GENERIC METHOD guidance — never benchmark-instance-overfit recipes.
 *
 * Background: `driver.ts` once carried `*_STEER` constants that hard-coded
 * specific SWE-bench instances' gold-patch recipes (astropy TimeSeries
 * required-columns, django TIME_ZONE backend, django PostgreSQL dbshell) into the
 * agent prompt, triggered by keyword-matching the issue text. That is answer-key
 * / leaderboard-gaming — banned by the no-heuristic-authority rule. They were
 * removed; this ratchet keeps them out and catches any re-introduction.
 *
 * The forbidden needles are assembled from fragments so THIS file does not trip
 * its own scan.
 */

import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DRIVER = join(import.meta.dir, "../../src/runner/batch/eval/driver.ts")
const source = readFileSync(DRIVER, "utf8")

/** Extract the string contents of every `*_STEER` constant (the text that is
 *  appended into the agent prompt). Concatenated string literals are joined. */
const steerConstantBodies = (): { name: string; body: string }[] => {
  const out: { name: string; body: string }[] = []
  const re = /const\s+([A-Z_]+_STEER)\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*|\[[\s\S]*?\]\s*)+)/g
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const lits = m[2]?.match(/"((?:[^"\\]|\\.)*)"/g) ?? []
    out.push({ name: m[1] ?? "", body: lits.join(" ").toLowerCase() })
  }
  return out
}

// Instance-overfit needles (fragments → assembled, so this file stays clean).
const FRAMEWORK = ["astro" + "py", "django", "sym" + "py", "sphinx", "scikit"]
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
const INSTANCE_FRAMING = ["rca target gate", "for the " + "django", "for the " + "astropy"]

describe("no-benchmark-overfit-steer ratchet", () => {
  const steers = steerConstantBodies()

  it("sanity: the scanner actually finds the surviving generic steers", () => {
    // If this is 0 the regex broke and every assertion below is vacuous.
    expect(steers.length).toBeGreaterThanOrEqual(2)
  })

  it("no *_STEER constant names a specific benchmark framework", () => {
    for (const s of steers) {
      for (const fw of FRAMEWORK) {
        expect(`${s.name}:${s.body.includes(fw)}`).toBe(`${s.name}:false`)
      }
    }
  })

  it("no *_STEER constant embeds an instance gold-patch recipe", () => {
    for (const s of steers) {
      for (const needle of GOLD_RECIPE) {
        expect(`${s.name}:${s.body.includes(needle)}`).toBe(`${s.name}:false`)
      }
    }
  })

  it("no *_STEER constant uses per-instance RCA-target framing", () => {
    for (const s of steers) {
      for (const needle of INSTANCE_FRAMING) {
        expect(`${s.name}:${s.body.includes(needle)}`).toBe(`${s.name}:false`)
      }
    }
  })

  it("the removed overfit steer symbols stay gone", () => {
    for (const sym of [
      "ADAPTER_FAMILY" + "_STEER",
      "MESSAGE_FORMAT" + "_STEER",
      "EXECUTION_ENV_BOUNDARY" + "_STEER",
      "hasAdapterFamily" + "Issue",
      "buildIssueShape" + "Steers",
    ]) {
      expect(`${sym}:${source.includes(sym)}`).toBe(`${sym}:false`)
    }
  })

  it("RED-ON-INJECTION: the scanner WOULD catch a re-added overfit recipe", () => {
    const poisoned = [{ name: "X_STEER", body: "for the django time" + "_zone backend issue" }]
    const tripped = poisoned.some((s) =>
      [...GOLD_RECIPE, ...INSTANCE_FRAMING, ...FRAMEWORK].some((n) => s.body.includes(n)),
    )
    expect(tripped).toBe(true)
  })

  it("the deleted gold-patch-matcher answer-key files stay gone", () => {
    // selection-declared-expected.ts matched candidate patches against the EXACT
    // gold-patch file paths + symbol/arity literals for django/astropy instances.
    // rca-target-gates was the knob that wired it. Both deleted jun-22.
    for (const f of [
      "src/runner/batch/eval/selection-declared-expected" + ".ts",
      "src/runner/knobs/knobs/rca-target-gates" + ".ts",
    ]) {
      expect(`${f}:${existsSync(join(import.meta.dir, "../../", f))}`).toBe(`${f}:false`)
    }
  })

  it("no bench-selection source matches candidate patches against gold file paths/symbols", () => {
    // A gold-patch matcher hardcodes specific repo file paths + gold code fragments
    // and tests the candidate patch against them. Scan the selection/driver sources.
    const files = [
      "../../src/runner/batch/eval/driver.ts",
      "../../src/apps/bench/eval/driver.ts",
    ].map((p) => readFileSync(join(import.meta.dir, p), "utf8"))
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
})
