/**
 * GOAL-08 round 3 — structural proof that the CLI interactive loop GATES the
 * agent body on the attempt claim: a continuation whose claim is refused
 * (fail-stopped / occupied slot) is dropped and re-armed, never run
 * unattributed (an unmetered autonomous turn outside the hard cap). Source
 * read with an anti-vacuum control, same shape as the GOAL-08 rail-14 proof.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../../..")
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8")
const source = readSrc("src/apps/cli/repl/session-loop/interactive-loop.ts")

describe("GOAL-08 round 3 — interactive loop gates the turn on the claim", () => {
  test("the claim result guards a `continue` (drop) before the turn runs — for GOAL prompts only (plain prompts never touch the slot)", () => {
    const gate =
      /if \(\s*prompt\.goalContinuation !== undefined &&\s*!claimGoalAttempt\(objectiveAttemptSlot, objectiveStore, prompt\),?\s*\) \{[\s\S]*?continue\n\s*\}/
    expect(source).toMatch(gate)
    const gateIndex = source.search(gate)
    const runIndex = source.indexOf("writeBackgroundHint(", gateIndex)
    expect(runIndex).toBeGreaterThan(gateIndex)
    // The drop is announced (agent-state visibility) and re-arms the wake host.
    const gated = source.slice(gateIndex, runIndex)
    expect(gated).toContain("continuation dropped")
    expect(gated).toContain("onGoalMutation()")
  })

  test("anti-vacuum control: a bare, ungated call would NOT satisfy the gate", () => {
    const bare = "    claimGoalAttempt(objectiveAttemptSlot, objectiveStore, prompt)\n"
    expect(source).not.toContain(bare)
    const mutated = source.replace(
      /if \(\s*prompt\.goalContinuation !== undefined &&\s*!claimGoalAttempt\(objectiveAttemptSlot, objectiveStore, prompt\),?\s*\) \{[\s\S]*?continue\n\s*\}/,
      bare.trim(),
    )
    expect(mutated).not.toMatch(/!claimGoalAttempt\(/)
  })

  test("both surfaces hand the wake host their attempt slot status (fail-stop gate is WIRED, not just available)", () => {
    const setup = readSrc("src/apps/cli/repl/session-loop/interactive-setup.ts")
    expect(setup).toContain("attemptSlotStatus: () => attemptSlot.status()")
    const compose = readSrc("src/apps/web-daemon/goal-wake-compose.ts")
    expect(compose).toContain("attemptSlotStatus: () => attemptSlot.status()")
    const factory = readSrc("src/apps/web-daemon/runtime-factory.ts")
    expect(factory).toContain("objectivePorts(objective, base.objectiveAttemptSlot)")
  })
})
