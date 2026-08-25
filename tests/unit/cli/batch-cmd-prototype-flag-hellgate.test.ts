/**
 * HELLGATE — a flag named after an `Object.prototype` member is UNKNOWN, not a
 * handler.
 *
 * `parseBatchArgs` dispatches through a plain object literal, so a bare
 * `FLAG_HANDLERS[a]` lookup resolves inherited members. Measured before the
 * guard, on the shipped CLI surface:
 *
 *   quanta batch toString x        → returned the STRING "[object Undefined]"
 *                                    where the contract is a `Result`
 *   quanta batch hasOwnProperty x  → THREW (the inherited function was called
 *                                    with an accumulator and a raw value)
 *
 * Neither is exotic input in the sense that matters: argv is attacker-adjacent
 * on any surface that forwards a user string, and the failure is a crash or a
 * type-contract violation rather than the `unknown flag` the parser promises.
 *
 * The fix is `Object.hasOwn`. This pins it, because the bug is invisible to
 * every test that only passes REAL flag names — which is every other test of
 * this parser.
 */

import { describe, expect, test } from "bun:test"

import { parseBatchArgs } from "@/apps/cli/batch-cmd"

/** Members every object literal inherits, and which therefore look like keys. */
const PROTOTYPE_NAMES = [
  "toString",
  "hasOwnProperty",
  "constructor",
  "valueOf",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
] as const

describe("batch flag table — prototype members are not flags", () => {
  for (const name of PROTOTYPE_NAMES) {
    test(`\`${name}\` is rejected as an unknown flag, and does not throw`, () => {
      // A Result, not a throw and not a string: the parser's whole contract.
      const out = parseBatchArgs([name, "some-value"])
      expect(out.ok, `${name} was accepted as a handler`).toBe(false)
      if (out.ok) throw new Error("narrow")
      expect(typeof out.error).toBe("string")
      expect(out.error).toContain("unknown flag")
      expect(out.error).toContain(name)
    })
  }

  test("ANTI-VACUITY — a real flag still dispatches, so the guard is not a blanket reject", () => {
    // Without this the whole file would pass against a parser that rejected
    // everything, which is the obvious wrong way to make the cases above green.
    const out = parseBatchArgs([
      "--in",
      "rows.jsonl",
      "--out",
      "out.jsonl",
      "--instruction",
      "do the thing",
    ])
    expect(out.ok, out.ok ? "" : out.error).toBe(true)
  })

  test("a prototype-named flag among real ones does not corrupt the parse", () => {
    // Order matters: the real flags before it must not have been half-applied
    // into an accumulator that then escapes.
    const out = parseBatchArgs([
      "--in",
      "rows.jsonl",
      "--instruction",
      "do the thing",
      "toString",
      "x",
      "--out",
      "o.jsonl",
    ])
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("narrow")
    expect(out.error).toContain("unknown flag")
  })
})
