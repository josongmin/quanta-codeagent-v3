/**
 * Hellgate — `@/shared/env-flag` truth tables (jun-7 gate-vocab unification).
 *
 * Two SSOT readers with DELIBERATELY DIFFERENT empty-string semantics:
 *
 *   - `parseEnvFlag(raw, defaultOn)` — the default-ON half. Empty string ("")
 *     means "the var is exported with no value" ⇒ ON; an UNKNOWN value falls
 *     back to `defaultOn`. This is the CLI status-pill `envFlag` semantics.
 *   - `gateOn(env, name)` — the default-OFF opt-in half. Empty string is NOT
 *     "on" (you did not opt in by exporting `QUANTA_X=`); ONLY the recognized
 *     truthy tokens flip it ON.
 *
 * The jun-7 migration BROADENED `gateOn`'s accepted spellings to the uniform
 * `{1,on,true,yes}` superset (previously scattered strict `=== "1"` / `=== "on"`).
 * This file LOCKS that broadened vocabulary AND the empty-string divergence so a
 * regression that conflates the two readers (or narrows the vocab) goes red.
 *
 * Pure + hermetic: every value is passed in explicitly — no `process.env` reads,
 * no mutation.
 */

import { describe, expect, test } from "bun:test"
import { gateDisabled, gateDisabledStrict, gateOn, gateOnStrict, parseEnvFlag } from "@/shared"

describe("parseEnvFlag — default-ON half (empty ⇒ default, unknown ⇒ default)", () => {
  test("undefined ⇒ the default (both polarities)", () => {
    expect(parseEnvFlag(undefined, true)).toBe(true)
    expect(parseEnvFlag(undefined, false)).toBe(false)
  })

  test('empty string "" ⇒ the default (exported-with-no-value reads as ON when default-ON)', () => {
    expect(parseEnvFlag("", true)).toBe(true)
    expect(parseEnvFlag("", false)).toBe(true) // "" is an explicit truthy token here
  })

  test("unknown / garbage ⇒ the default (NOT a hard false)", () => {
    expect(parseEnvFlag("garbage", true)).toBe(true)
    expect(parseEnvFlag("garbage", false)).toBe(false)
    expect(parseEnvFlag("2", true)).toBe(true)
  })

  test("explicit falsy tokens ⇒ false even when default-ON", () => {
    for (const v of ["off", "0", "false", "no"]) {
      expect(parseEnvFlag(v, true)).toBe(false)
    }
  })

  test("explicit truthy tokens ⇒ true even when default-OFF", () => {
    for (const v of ["1", "yes", "on", "true"]) {
      expect(parseEnvFlag(v, false)).toBe(true)
    }
  })

  test("case-insensitive + surrounding whitespace tolerant", () => {
    expect(parseEnvFlag("  OFF  ", true)).toBe(false)
    expect(parseEnvFlag("  ON  ", false)).toBe(true)
    expect(parseEnvFlag("True", false)).toBe(true)
  })
})

describe("gateOn — default-OFF opt-in half (empty is NOT on; broadened vocab)", () => {
  const NAME = "QUANTA_X"

  test("the broadened truthy superset all flip ON (1 AND on AND true AND yes)", () => {
    for (const v of ["1", "on", "true", "yes"]) {
      expect(gateOn({ [NAME]: v }, NAME)).toBe(true)
    }
  })

  test('"0" / "" / absent / unknown do NOT flip ON', () => {
    expect(gateOn({ [NAME]: "0" }, NAME)).toBe(false)
    expect(gateOn({ [NAME]: "" }, NAME)).toBe(false) // empty ≠ opt-in (divergence vs parseEnvFlag)
    expect(gateOn({}, NAME)).toBe(false) // absent
    expect(gateOn({ [NAME]: "garbage" }, NAME)).toBe(false)
    expect(gateOn({ [NAME]: "off" }, NAME)).toBe(false)
  })

  test("case-insensitive + whitespace tolerant", () => {
    expect(gateOn({ [NAME]: "  ON  " }, NAME)).toBe(true)
    expect(gateOn({ [NAME]: "TRUE" }, NAME)).toBe(true)
  })

  test("EMPTY-STRING DIVERGENCE is the load-bearing contract: parseEnvFlag('')≠gateOn('')", () => {
    // parseEnvFlag treats "" as an explicit truthy; gateOn treats "" as NOT-opted-in.
    expect(parseEnvFlag("", false)).toBe(true)
    expect(gateOn({ [NAME]: "" }, NAME)).toBe(false)
  })
})

describe("gateDisabled — default-ON kill-switch half (broadened falsy superset)", () => {
  const NAME = "QUANTA_K"

  test("the broadened falsy superset all DISABLE (0 AND off AND false AND no)", () => {
    for (const v of ["0", "off", "false", "no"]) {
      expect(gateDisabled({ [NAME]: v }, NAME)).toBe(true)
    }
  })

  test("absent / empty / truthy / unknown do NOT disable (feature stays ON)", () => {
    expect(gateDisabled({}, NAME)).toBe(false)
    expect(gateDisabled({ [NAME]: "" }, NAME)).toBe(false)
    expect(gateDisabled({ [NAME]: "1" }, NAME)).toBe(false)
    expect(gateDisabled({ [NAME]: "garbage" }, NAME)).toBe(false)
  })
})

describe("STRICT security gates — only the exact literal flips (loose spellings refused)", () => {
  const NAME = "QUANTA_DANGER"

  test('gateOnStrict ON only for exact "1" — loose truthy REFUSED', () => {
    expect(gateOnStrict({ [NAME]: "1" }, NAME)).toBe(true)
    for (const v of ["on", "true", "yes", " 1 ", "1 ", ""]) {
      expect(gateOnStrict({ [NAME]: v }, NAME)).toBe(false)
    }
    expect(gateOnStrict({}, NAME)).toBe(false)
  })

  test('gateDisabledStrict DISABLED only for exact "off" — loose falsy REFUSED', () => {
    expect(gateDisabledStrict({ [NAME]: "off" }, NAME)).toBe(true)
    for (const v of ["0", "false", "no", " off ", ""]) {
      expect(gateDisabledStrict({ [NAME]: v }, NAME)).toBe(false)
    }
    expect(gateDisabledStrict({}, NAME)).toBe(false)
  })
})
