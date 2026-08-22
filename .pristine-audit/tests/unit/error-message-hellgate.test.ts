/**
 * Hellgate — R1-audit guard for the 19-site silent-undefined log hole.
 *
 * The 2026-05-25 audit found that a prior catch-logger fix had swapped
 * 19 silent catch blocks to `logger.warn(\`...: ${(e as Error).message}\`)`.
 * That cast is a LIE for non-Error throws: when `e` is a string / null / plain
 * object / symbol / number / boolean / BigInt / function / cross-realm Error /
 * frozen Error, `(e as Error).message` evaluates to `undefined` and the user
 * sees `"...: undefined"` — re-introducing the silent-debug failure mode
 * the swap was supposed to eliminate.
 *
 * The 19 call sites now use `errMessage(e)` (canonical helper in
 * `src/shared/errors.ts`, exported from `@/shared`). It implements the
 * legacy `e instanceof Error ? e.message : String(e)` pattern.
 *
 * This hellgate pins the FULL adversarial surface — broader than the
 * baseline `errMessage` test in `tests/unit/errors.test.ts`, which only
 * covers 7 textbook cases. The cases below are what hostile / buggy
 * adapters actually throw at runtime.
 *
 * Honest scope: errMessage is NOT a silver bullet — `errMessage(undefined)`
 * returns the string `"undefined"` (matching `String(undefined)`), so a
 * literal `throw undefined` STILL renders `"label: undefined"`. The audit
 * fix is about the much more common case of `(e as Error).message`
 * returning the *value* `undefined` (when `e` lacks a `.message`), which
 * is now eliminated. The `throw undefined` case is documented and
 * intentionally preserved (byte-identical to legacy log shape).
 *
 * Two adversarial inputs surface known `errMessage` limitations (NOT fixed
 * here — outside this audit's scope; errMessage is pinned by 70+ call
 * sites and an anti-recursion doc-comment): `Object.create(null)` and
 * objects with a throwing `.toString()`. Both throw inside `String(e)`,
 * which propagates out of `errMessage` and would crash the catch block.
 * Pinned here as known-bad so a future hardening pass detects them.
 */

import { describe, expect, test } from "bun:test"
import { errMessage } from "@/shared"

describe("errMessage hellgate — R1 silent-undefined guard", () => {
  test("string throw → returns the string verbatim", () => {
    expect(errMessage("boom")).toBe("boom")
    expect(errMessage("")).toBe("")
  })

  test("null throw → 'null' (not undefined)", () => {
    const out = errMessage(null)
    expect(out).toBe("null")
    expect(out).not.toBe("undefined")
  })

  test("undefined throw → 'undefined' literal (legacy String(e) shape, byte-identical)", () => {
    // Pinned: a literal `throw undefined` STILL renders "label: undefined".
    // errMessage matches legacy `String(undefined) → "undefined"`. NOT in
    // scope of this audit fix — the audit was about `(e as Error).message`
    // returning the VALUE undefined when `e` had no `.message`. That case
    // (e.g. throw of a plain object) is fixed; this case is preserved.
    expect(errMessage(undefined)).toBe("undefined")
  })

  test("plain object throw (the actual audit hole) → '[object Object]', NOT undefined", () => {
    // The most common audit hole: many libraries throw `{ code, msg }`
    // plain objects. `(e as Error).message` returns the VALUE `undefined`
    // (no message property). errMessage falls back to String(e) →
    // "[object Object]". The interpolated log line no longer ends in
    // ": undefined" — the audit symptom is gone.
    const e = { code: "E_FOO", msg: "details" }
    const out = errMessage(e)
    expect(out).toBe("[object Object]")
    expect(`label: ${out}`).not.toBe("label: undefined")
  })

  test("symbol throw → 'Symbol(...)', not undefined", () => {
    const out = errMessage(Symbol("sym"))
    expect(typeof out).toBe("string")
    expect(out).toBe("Symbol(sym)")
    expect(out).not.toBe("undefined")
  })

  test("number throw → numeric string, not undefined", () => {
    expect(errMessage(0)).toBe("0")
    expect(errMessage(42)).toBe("42")
    expect(errMessage(Number.NaN)).toBe("NaN")
    expect(errMessage(Number.POSITIVE_INFINITY)).toBe("Infinity")
    expect(errMessage(-1)).toBe("-1")
  })

  test("boolean throw → 'true'/'false', not undefined", () => {
    expect(errMessage(false)).toBe("false")
    expect(errMessage(true)).toBe("true")
  })

  test("BigInt throw → numeric string, not undefined", () => {
    expect(errMessage(123n)).toBe("123")
    expect(errMessage(0n)).toBe("0")
  })

  test("function throw → string representation, not undefined", () => {
    const out = errMessage(() => 1)
    expect(typeof out).toBe("string")
    expect(out).not.toBe("undefined")
    expect(out.length).toBeGreaterThan(0)
  })

  test("circular object throw → '[object Object]', no stack overflow, not undefined", () => {
    // String(e) on a circular object via the default toString returns
    // "[object Object]" (does NOT recurse). Worst case for naive
    // JSON.stringify fallback — errMessage uses String(), not JSON.
    const a: Record<string, unknown> = { name: "a" }
    const b: Record<string, unknown> = { name: "b", a }
    a.b = b
    const out = errMessage(a)
    expect(out).toBe("[object Object]")
    expect(out).not.toBe("undefined")
  })

  test("cross-realm Error analog (not instanceof Error) → falls back to String(e), not undefined", () => {
    // Hazard: an Error from a different realm (vm / worker / web-worker
    // boundary) is NOT `instanceof Error` in the receiving realm.
    // errMessage falls through to String(e), which honors a custom
    // toString() and preserves message text.
    const fake = {
      message: "cross-realm boom",
      stack: "at foo",
      toString() {
        return `Error: ${this.message}`
      },
    }
    const out = errMessage(fake)
    expect(out).toBe("Error: cross-realm boom")
    expect(out.includes("undefined")).toBe(false)
  })

  test("frozen Error → message still extracted (instanceof still true)", () => {
    const e = Object.freeze(new Error("frozen"))
    expect(errMessage(e)).toBe("frozen")
  })

  test("Error subclass with empty .message → empty string, not undefined", () => {
    class Empty extends Error {
      constructor() {
        super("")
      }
    }
    const out = errMessage(new Empty())
    expect(out).toBe("")
    expect(out).not.toBe("undefined")
  })

  test("Error subclass with extra fields → uses .message (instanceof Error path)", () => {
    class Rich extends Error {
      code = "E_RICH"
      constructor() {
        super("rich message")
      }
    }
    expect(errMessage(new Rich())).toBe("rich message")
  })

  test("R5/R8 audit closure: Object.create(null) returns tagged sentinel", () => {
    // R5 wrapped String(e) in try/catch → <unstringifiable> sentinel.
    // R8 added a best-effort throw shape tag (typeof + constructor.name).
    // null-prototype object: typeof=object, no constructor → "object".
    const nullProto = Object.create(null) as Record<string, unknown>
    nullProto.code = "E_NULLPROTO"
    expect(errMessage(nullProto)).toBe("<unstringifiable:object>")
  })

  test("R5/R8 audit closure: throwing toString returns tagged sentinel", () => {
    const hostile = {
      toString(): string {
        throw new Error("toString throws")
      },
    }
    // Plain object literal: typeof=object, constructor.name="Object".
    expect(errMessage(hostile)).toBe("<unstringifiable:object/Object>")
  })

  test("R5/R8 audit closure: throwing @@toPrimitive returns tagged sentinel", () => {
    const hostile = {
      [Symbol.toPrimitive](): string {
        throw new Error("toPrimitive throws")
      },
    }
    expect(errMessage(hostile)).toBe("<unstringifiable:object/Object>")
  })

  test("R8 audit closure: custom-class throwing toString preserves constructor name", () => {
    class HostileEvent {
      toString(): string {
        throw new Error("blocked")
      }
    }
    // Custom class name leaks into the sentinel for forensic — what threw
    // is now traceable even when String(e) blew up.
    expect(errMessage(new HostileEvent())).toBe("<unstringifiable:object/HostileEvent>")
  })

  test("19-site invariant: template interpolation NEVER yields '...: undefined' for the audit hole class", () => {
    // The audit hole was specifically `(e as Error).message` returning
    // the VALUE undefined when `e` was a non-Error with no `.message`.
    // Iterate the adversarial set EXCLUDING `throw undefined` (which is
    // a separate, intentionally-preserved legacy shape — see test above).
    const adversarial: readonly unknown[] = [
      new Error("ok"),
      "str",
      "",
      null,
      { code: "E" },
      Symbol("s"),
      0,
      42,
      Number.NaN,
      true,
      false,
      123n,
      () => 1,
      Object.freeze(new Error("frozen")),
    ]
    for (const e of adversarial) {
      const line = `label: ${errMessage(e)}`
      expect(line.endsWith(": undefined")).toBe(false)
      expect(line).toMatch(/^label: /)
    }
  })

  test("19-site invariant: legacy `(e as Error).message` WOULD have produced 'undefined' for the same set", () => {
    // Reverse demonstration: this is what the 19 call sites used to do.
    // Pins WHY the swap was necessary — for these inputs, the legacy
    // pattern produced the silent-undefined log line.
    const wouldHaveBroken: readonly unknown[] = [
      "str",
      null,
      { code: "E" },
      Symbol("s"),
      0,
      42,
      true,
      false,
      123n,
      () => 1,
    ]
    for (const e of wouldHaveBroken) {
      // Reproduce the legacy access: `(e as Error).message`.
      // Cast widens to a record so the property access compiles for
      // primitives too (autoboxing handles symbol/number/bool/string;
      // null short-circuits via the `?.`).
      const legacy = (e as { message?: unknown } | null)?.message
      // Primitives autobox: String(...).message is undefined → property
      // access yields `undefined`. Object literal: no `.message` → undefined.
      // Symbol: no `.message` on Symbol.prototype → undefined.
      expect(legacy).toBeUndefined()
    }
  })
})
