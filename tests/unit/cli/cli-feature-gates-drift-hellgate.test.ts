/**
 * CLI_FEATURE_GATES DRIFT GUARD (jun-7).
 *
 * `src/apps/cli/index.ts` hand-maintains `CLI_FEATURE_GATES` — the list of
 * CLI-surface BEHAVIOR knobs (not LLM tools, so not in the tool-surface
 * manifest) that the CLI host seeds to "1" by default. It is a HAND LIST, so it
 * can drift two ways:
 *   1. STALE / TYPO entry — a name in the list that NOTHING in `src/` ever reads
 *      ⇒ the CLI seeds a dead env var (the feature it was meant to enable never
 *      turns on, or the name is misspelled). This guard FAILS on that.
 *   2. (Documented, not auto-caught) a NEW CLI-behavior knob added to a consumer
 *      but FORGOTTEN here ⇒ it stays default-OFF in the CLI. That direction has
 *      no mechanical signal (a knob legitimately may be opt-in), so we only pin
 *      direction (1): every seeded gate must have a real consumer.
 *
 * WS-E jul-10: the gate list moved out of side-effecting index.ts into the
 * pure data leaf `cli-feature-gates.ts` (so `/help` derives its env rows from
 * the SAME list) — this guard now imports the list directly. The consumer scan
 * must exclude the DECLARING module (its own `gate:` literals would make the
 * guard vacuous), and `help-render.ts` renders via import (no literals), so
 * the scan stays meaningful.
 */

import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { CLI_FEATURE_GATE_NAMES } from "@/apps/cli/cli-feature-gates"
import { assertScanPopulation } from "../_shared/scan-population"

const GATES = CLI_FEATURE_GATE_NAMES

/** Does any file under src/ OTHER than the declaring data leaf (and the seed
 *  loop in index.ts) mention this knob (i.e. consume it)? A consumer reads it
 *  via `gateOn(env,"X")` / `parseEnvFlag(env.X)` / `env["X"]` /
 *  `runtimeConfig().<field>` — all of which contain the literal `QUANTA_X`
 *  somewhere in the consuming source. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * How many `.ts` files the consumer search can actually see.
 *
 * The floor this guard never had. Its verdict is `orphans === []`, and a search
 * that reaches NO files finds no consumers either — every gate would read as
 * consumed and the guard would pass over a `src/` that is not there. Proven by
 * the empty-corpus oracle: with `src/` emptied this file was green.
 */
const searchableSourcePaths = (): string[] => {
  const out = execSync(`rg --files --type ts ${SEARCH_ROOT}`, { encoding: "utf8", cwd: REPO_ROOT })
  return out.split("\n").filter((line) => line.trim().length > 0)
}

/**
 * The tree the search runs over, resolved from THIS file.
 *
 * Absolute, not the bare `src` it used to pass with `cwd: REPO_ROOT`. That form
 * pinned the search to the real repository no matter which tree the test itself
 * was loaded from, so the guard could not notice its own corpus being absent —
 * it was reading a different `src/` than the one under test.
 */
const SEARCH_ROOT = join(REPO_ROOT, "src")

const isConsumedSomewhere = (knob: string): boolean => {
  const proc = Bun.spawnSync(
    [
      "rg",
      "-l",
      "--fixed-strings",
      knob,
      SEARCH_ROOT,
      "--type",
      "ts",
      // `**/` is load-bearing. A glob containing a slash is ANCHORED at the
      // search root, and the root is absolute, so `!apps/cli/index.ts` matched
      // nothing rg ever emits — it prints `<root>/src/apps/cli/…`. Both
      // exclusions were therefore no-ops, and the DECLARING module
      // (`cli-feature-gates.ts`, which contains every gate name verbatim) matched
      // every search. `isConsumedSomewhere` returned true unconditionally, so a
      // seeded gate that nothing reads was reported as consumed — the exact
      // defect this file exists to catch. Measured: 8 hits with the exclusions,
      // 8 without.
      "-g",
      "!**/apps/cli/index.ts",
      "-g",
      "!**/apps/cli/cli-feature-gates.ts",
    ],
    { cwd: REPO_ROOT },
  )
  // exit 1 is "no matches" and is a real answer. Anything else — a bad path, rg
  // missing (127), a crash — is NOT "unconsumed", and the old `catch { return
  // false }` reported all three as the same thing.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(
      `rg failed with exit ${proc.exitCode} searching for "${knob}" — that is not the same ` +
        `as finding no consumer. ${new TextDecoder().decode(proc.stderr).trim()}`,
    )
  }
  return new TextDecoder().decode(proc.stdout).trim().length > 0
}

describe("CLI_FEATURE_GATES drift guard", () => {
  test("the array is non-empty and parsed", () => {
    expect(GATES.length).toBeGreaterThan(0)
  })

  test("every seeded CLI gate has a real consumer in src/ (no stale/typo seed)", () => {
    // Anti-vacuity, derived from the real tree (3,600+ `.ts` under src/ today).
    // Without it the assertion below passes over a search that reached nothing.
    const sourcePaths = searchableSourcePaths()
    assertScanPopulation(sourcePaths, SEARCH_ROOT, {
      collectable: (name) => name.endsWith(".ts"),
      id: "tests/unit/cli/cli-feature-gates-drift-hellgate.test.ts#SRC",
    })
    expect(
      sourcePaths.length,
      "the consumer search reached no source files — every gate would read as consumed",
    ).toBeGreaterThan(3000)
    const orphans = GATES.filter((g) => !isConsumedSomewhere(g))
    // Any entry here is a gate the CLI seeds to "1" that NOTHING reads — either a
    // typo or a feature whose consumer was removed. Delete it from the list (or
    // fix the name) so the CLI never seeds a dead env var.
    expect(orphans).toEqual([])
  })

  test("no duplicate entries", () => {
    expect(new Set(GATES).size).toBe(GATES.length)
  })
})
