/**
 * GOAL-08 rail 14 — STATIC structural proof: the web goal-wake composition
 * hands a continuation to the atomic `turn.submit` path (`submitGoalContinuation`)
 * and never the split `input.append` + `turn.run` pair. Anti-vacuum: the same
 * predicate must FAIL on an injected split-call variant of the source.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SOURCE = join(import.meta.dir, "../../../../src/apps/web-daemon/goal-wake-compose.ts")

const usesAtomicSubmitOnly = (source: string): boolean =>
  /await submit\.call\(args\.session\.turn,/.test(source) &&
  !/\.input\s*\.append\s*\(/.test(source) &&
  !/\.turn\s*\.run\s*\(/.test(source) &&
  !/session\.dispatch\s*\(/.test(source) &&
  !/"input\.append"|"turn\.run"/.test(source)

describe("GOAL-08 rail 14 — controller calls turn.submit, never split append/run", () => {
  test("the shipped composition passes the predicate", () => {
    expect(usesAtomicSubmitOnly(readFileSync(SOURCE, "utf8"))).toBe(true)
  })
  test("anti-vacuum: an injected split-call variant fails the predicate", () => {
    const shipped = readFileSync(SOURCE, "utf8")
    const split = shipped.replace(
      /await submit\.call\([^)]*\{/,
      "await args.session.input.append(text); await args.session.turn.run({",
    )
    expect(split).not.toBe(shipped)
    expect(usesAtomicSubmitOnly(split)).toBe(false)
    expect(usesAtomicSubmitOnly("const x = 1")).toBe(false)
  })

  test("anti-vacuum: a raw-dispatch variant (split wire command next to the helper) fails too", () => {
    const shipped = readFileSync(SOURCE, "utf8")
    const raw = shipped.replace(
      /await submit\.call\(args\.session\.turn,/,
      'await args.session.dispatch({ type: "input.append" } as never); await submit.call(args.session.turn,',
    )
    expect(raw).not.toBe(shipped)
    expect(usesAtomicSubmitOnly(raw)).toBe(false)
  })
})
