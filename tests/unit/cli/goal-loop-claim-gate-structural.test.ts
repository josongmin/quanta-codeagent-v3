/**
 * GOAL-08 round 3/4 — structural proof that the CLI interactive loop GATES the
 * agent body on the attempt claim: a GOAL continuation whose claim is refused
 * (fail-stopped / occupied slot) is dropped and re-armed, never run
 * unattributed (an unmetered autonomous turn outside the hard cap); plain
 * prompts never touch the slot. Source read with a REAL anti-vacuum control:
 * the same predicate is applied to mutated sources and must reject them.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../../..")
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8")
const source = readSrc("src/apps/cli/repl/session-loop/interactive-loop.ts")

/** The gate as shipped: goal prompts only, refused claim ⇒ `continue`. */
const GATE =
  /if \(\s*prompt\.goalContinuation !== undefined &&\s*!claimGoalAttempt\(objectiveAttemptSlot, objectiveStore, prompt\),?\s*\) \{[\s\S]*?continue\n\s*\}/

describe("GOAL-08 round 3 — interactive loop gates the turn on the claim", () => {
  test("the claim result guards a `continue` (drop) before the turn runs — for GOAL prompts only", () => {
    expect(source).toMatch(GATE)
    const gateIndex = source.search(GATE)
    const runIndex = source.indexOf("writeBackgroundHint(", gateIndex)
    expect(runIndex).toBeGreaterThan(gateIndex)
    // The drop is announced (agent-state visibility) and re-arms the wake host.
    const gated = source.slice(gateIndex, runIndex)
    expect(gated).toMatch(/[dD]ropped/)
    expect(gated).toContain("onGoalMutation()")
  })

  test("anti-vacuum control: the SAME predicate rejects an ungated variant and a gate without the drop", () => {
    const bare = source.replace(
      GATE,
      "claimGoalAttempt(objectiveAttemptSlot, objectiveStore, prompt)",
    )
    expect(bare).not.toBe(source)
    expect(bare).not.toMatch(GATE)
    const noDrop = source.replace(GATE, (m) => m.replace(/\n\s*continue\n/, "\n"))
    expect(noDrop).not.toBe(source)
    expect(noDrop).not.toMatch(GATE)
  })

  test("both surfaces hand the wake host THE surface's attempt slot (fail-stop gate is WIRED to the real instance)", () => {
    const setup = readSrc("src/apps/cli/repl/session-loop/interactive-setup.ts")
    expect(setup).toContain("const attemptSlot = args.objectiveAttemptSlot")
    expect(setup).toContain("...(attemptSlot !== undefined ? { attemptSlot } : {})")
    const compose = readSrc("src/apps/web-daemon/goal-wake-compose.ts")
    expect(compose).toContain("const attemptSlot = args.runtime.objectiveAttemptSlot")
    expect(compose).toContain("...(attemptSlot !== undefined ? { attemptSlot } : {})")
    const factory = readSrc("src/apps/web-daemon/runtime-factory.ts")
    // BOTH args stay pinned (the authority AND the base's attempt slot) — only the
    // receiver qualifier is tolerated (`parts.objective` after the aug-27 god-fn
    // extraction). Dropping either argument still reds this; the instance
    // identity is proven at runtime by objective-ports.test.ts.
    expect(factory).toMatch(
      /\.\.\.objectivePorts\(\s*(?:parts\.)?objective,\s*base\.objectiveAttemptSlot\s*\)/,
    )
  })
})
