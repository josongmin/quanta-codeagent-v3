/**
 * Goal-continuation host wiring ratchet.
 *
 * The continuation engine and ticker can both be individually green while the
 * CLI loop has zero callers. Keep this structural because constructing the full
 * interactive session loop would hide that regression behind terminal/runtime
 * setup. The sibling ticker test owns behavior; this file owns reachability.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const sessionLoopPath = join(import.meta.dir, "..", "..", "src", "apps", "cli", "repl", "session-loop.ts")

/** Match an invocation with an object argument; imports, comments, and a bare
 * identifier do not satisfy the reachability obligation. */
const tickerCalls = (source: string): readonly number[] =>
  [...source.matchAll(/\bstartGoalContinuationTicker\s*\(\s*\{/g)].map((match) => match.index ?? -1)

describe("goal-continuation host wiring ratchet", () => {
  const source = readFileSync(sessionLoopPath, "utf8")

  test("the interactive session loop has exactly one live ticker construction", () => {
    // Anti-vacuum floor: a zero-match regex drift must fail rather than silently
    // bless a dead continuation machine. One owner-local construction prevents
    // duplicate timers for the same session.
    expect(tickerCalls(source)).toHaveLength(1)
    expect(source).toMatch(/enabled:\s*runtimeConfig\(\)\.goalContinuationEnforce/)
    expect(source).toMatch(/closeStack\.push\(\{\s*label:\s*"goalTicker\.stop"/)
  })

  test("red-on-injection: removing the call leaves no live caller", () => {
    const injectedRemoval = source.replace(
      /\bstartGoalContinuationTicker\s*\(\s*\{/,
      "removedGoalContinuationTicker({",
    )
    expect(tickerCalls(injectedRemoval)).toHaveLength(0)
  })
})
