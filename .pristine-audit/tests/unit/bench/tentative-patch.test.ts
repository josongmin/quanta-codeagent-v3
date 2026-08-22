/**
 * Hellgate — tentative-patch retention core (P0, Sonar absorption 2026-06-20).
 *
 * The recorder keeps the agent's verified-green intermediate patches and, on a
 * BAD ending (max_turns / abort / empty final), emits the last verified one
 * instead of the regressed/empty final tree. On a CLEAN finish it is a no-op
 * (byte-identical to the pre-feature path). Teeth assert EXACT emitted diffs so a
 * mutant that returns the wrong candidate (or the final) is caught.
 */
import { describe, expect, test } from "bun:test"
import { createTentativeRecorder } from "../../../src/runner/batch/eval/tentative-patch"

const SRC = (tag: string) => `diff --git a/src/foo.py b/src/foo.py\n@@ -1 +1 @@\n-old\n+${tag}\n`

describe("tentative-patch recorder — selection policy", () => {
  test("clean finish + non-empty final → returns the final UNTOUCHED (byte-identical), even with verified candidates present", () => {
    const r = createTentativeRecorder()
    r.record(SRC("verified-mid"), true, 1)
    const final = SRC("final")
    expect(r.selectEmitted(final, /*finalOk*/ true)).toBe(final)
  })

  test("max_turns + verified candidate + EMPTY final → returns the verified candidate (the core win)", () => {
    const r = createTentativeRecorder()
    const verified = SRC("the-working-fix")
    r.record(verified, true, 5)
    expect(r.selectEmitted("", /*finalOk*/ false)).toBe(verified)
  })

  test("max_turns + verified candidate + REGRESSED non-empty final → returns the verified candidate, NOT the regression", () => {
    const r = createTentativeRecorder()
    const verified = SRC("the-working-fix")
    r.record(verified, true, 3)
    const regressed = SRC("regressed-garbage")
    const out = r.selectEmitted(regressed, /*finalOk*/ false)
    expect(out).toBe(verified)
    expect(out).not.toBe(regressed)
  })

  test("LAST verified-green wins when several verified candidates exist", () => {
    const r = createTentativeRecorder()
    r.record(SRC("v1"), true, 1)
    r.record(SRC("v2-latest"), true, 9)
    expect(r.selectEmitted("", false)).toBe(SRC("v2-latest"))
  })

  test("no verified candidate + non-empty final → KEEP the final (don't downgrade to an unverified snapshot)", () => {
    const r = createTentativeRecorder()
    r.record(SRC("unverified-guess"), false, 2)
    const final = SRC("final-nonempty")
    expect(r.selectEmitted(final, /*finalOk*/ false)).toBe(final)
  })

  test("no verified + EMPTY final + an unverified candidate → fall back to the last non-empty snapshot", () => {
    const r = createTentativeRecorder()
    r.record(SRC("unverified-but-something"), false, 4)
    expect(r.selectEmitted("", false)).toBe(SRC("unverified-but-something"))
  })

  test("nothing recorded + empty final → returns the final (empty)", () => {
    const r = createTentativeRecorder()
    expect(r.selectEmitted("", false)).toBe("")
  })

  test("empty/whitespace diffs are NEVER recorded (an empty snapshot is not an answer)", () => {
    const r = createTentativeRecorder()
    r.record("", true, 1)
    r.record("   \n  ", true, 2)
    expect(r.count).toBe(0)
    // with only empty snapshots, an empty final stays empty
    expect(r.selectEmitted("", false)).toBe("")
  })

  test("count reflects only non-empty recorded candidates (wiring-proof telemetry)", () => {
    const r = createTentativeRecorder()
    r.record(SRC("a"), false, 1)
    r.record("", true, 2) // ignored
    r.record(SRC("b"), true, 3)
    expect(r.count).toBe(2)
  })

  test("deterministic: identical record sequence → identical selection", () => {
    const build = () => {
      const r = createTentativeRecorder()
      r.record(SRC("x"), false, 1)
      r.record(SRC("y"), true, 2)
      r.record(SRC("z"), false, 3)
      return r
    }
    expect(build().selectEmitted("", false)).toBe(build().selectEmitted("", false))
    // and the verified 'y' (not the later unverified 'z') is what wins
    expect(build().selectEmitted("", false)).toBe(SRC("y"))
  })
})
