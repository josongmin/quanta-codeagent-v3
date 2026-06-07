/**
 * CLI knob accessor (ADR-0503 P4) — typed read with session > env > default
 * precedence + live `/config set` overrides.
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetCliKnobOverrides,
  cliKnobOverrides,
  readCliKnob,
  setCliKnobOverride,
} from "@/apps/cli/cli-knobs-accessor"

afterEach(() => __resetCliKnobOverrides())

describe("readCliKnob — typed read + precedence (ADR-0503 P4)", () => {
  test("kind parsing: bool (truthy vocab) / int / string", () => {
    expect(readCliKnob("QUANTA_PILLS", "bool", { QUANTA_PILLS: "on" })).toBe(true)
    expect(readCliKnob("QUANTA_PILLS", "bool", { QUANTA_PILLS: "0" })).toBe(false)
    expect(readCliKnob("QUANTA_FLASH_ERROR_MS", "int", { QUANTA_FLASH_ERROR_MS: "1200" })).toBe(1200)
    expect(readCliKnob("QUANTA_MD_MODE", "string", { QUANTA_MD_MODE: "strict" })).toBe("strict")
  })

  test("unset env falls through to the REGISTRY default (declared in cli-knobs)", () => {
    // QUANTA_FLASH_ERROR_MS default is 4000 in cli-knobs.ts; QUANTA_PILLS default true.
    expect(readCliKnob("QUANTA_FLASH_ERROR_MS", "int", {})).toBe(4000)
    expect(readCliKnob("QUANTA_PILLS", "bool", {})).toBe(true)
  })

  test("unknown knob + unset ⇒ undefined (caller applies its own default)", () => {
    expect(readCliKnob("QUANTA_NOT_A_KNOB", "int", {})).toBeUndefined()
    expect(readCliKnob("QUANTA_NOT_A_KNOB", "string", {})).toBeUndefined()
  })

  test("precedence: session override beats env beats default", () => {
    // default 4000, env 1200, session 9000 → session wins
    setCliKnobOverride("QUANTA_FLASH_ERROR_MS", "9000")
    expect(readCliKnob("QUANTA_FLASH_ERROR_MS", "int", { QUANTA_FLASH_ERROR_MS: "1200" })).toBe(9000)
    // env beats default when no session
    __resetCliKnobOverrides()
    expect(readCliKnob("QUANTA_FLASH_ERROR_MS", "int", { QUANTA_FLASH_ERROR_MS: "1200" })).toBe(1200)
  })

  test("setCliKnobOverride / clear / snapshot", () => {
    setCliKnobOverride("QUANTA_PILLS", "0")
    expect(cliKnobOverrides()).toEqual({ QUANTA_PILLS: "0" })
    expect(readCliKnob("QUANTA_PILLS", "bool", {})).toBe(false) // session override applies
    setCliKnobOverride("QUANTA_PILLS", undefined) // clear
    expect(cliKnobOverrides()).toEqual({})
    expect(readCliKnob("QUANTA_PILLS", "bool", {})).toBe(true) // back to default
  })

  test("int parse rejects non-finite ⇒ undefined", () => {
    expect(readCliKnob("QUANTA_FLASH_ERROR_MS", "int", { QUANTA_FLASH_ERROR_MS: "abc" })).toBeUndefined()
  })
})
