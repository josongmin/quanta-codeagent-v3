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
import { CLI_FEATURE_GATE_NAMES } from "@/apps/cli/cli-feature-gates"

const GATES = CLI_FEATURE_GATE_NAMES

/** Does any file under src/ OTHER than the declaring data leaf (and the seed
 *  loop in index.ts) mention this knob (i.e. consume it)? A consumer reads it
 *  via `gateOn(env,"X")` / `parseEnvFlag(env.X)` / `env["X"]` /
 *  `runtimeConfig().<field>` — all of which contain the literal `QUANTA_X`
 *  somewhere in the consuming source. */
const isConsumedSomewhere = (knob: string): boolean => {
  try {
    const out = execSync(
      `rg -l --fixed-strings ${knob} src --type ts -g '!apps/cli/index.ts' -g '!apps/cli/cli-feature-gates.ts'`,
      { encoding: "utf8" },
    )
    return out.trim().length > 0
  } catch {
    return false // rg exit 1 ⇒ no matches
  }
}

describe("CLI_FEATURE_GATES drift guard", () => {
  test("the array is non-empty and parsed", () => {
    expect(GATES.length).toBeGreaterThan(0)
  })

  test("every seeded CLI gate has a real consumer in src/ (no stale/typo seed)", () => {
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
