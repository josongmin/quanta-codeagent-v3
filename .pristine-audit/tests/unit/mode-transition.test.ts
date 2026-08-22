/**
 * ADR-0036: developer-message collaboration-mode transitions.
 *
 * Sticky-set semantics: identical-mode is a no-op (not an error); only
 * explicit `mode=plan` / `mode=default` directives transition; any other
 * `mode=…` value throws.
 */

import { describe, expect, test } from "bun:test"
import { applyDeveloperModeTransition, InvalidModeTransitionError } from "@/agent/mode"

describe("applyDeveloperModeTransition (ADR-0036)", () => {
  test("'mode=plan' from default ⇒ plan", () => {
    expect(applyDeveloperModeTransition("default", "mode=plan")).toBe("plan")
  })
  test("'mode=default' from plan ⇒ default", () => {
    expect(applyDeveloperModeTransition("plan", "mode=default")).toBe("default")
  })
  test("'mode=plan' from plan ⇒ no-op stays plan (sticky)", () => {
    expect(applyDeveloperModeTransition("plan", "mode=plan")).toBe("plan")
  })
  test("'mode=default' from default ⇒ no-op stays default", () => {
    expect(applyDeveloperModeTransition("default", "mode=default")).toBe("default")
  })
  test("leading/trailing whitespace tolerated", () => {
    expect(applyDeveloperModeTransition("default", "  mode = plan  ")).toBe("plan")
  })
  test("non-directive message ⇒ returns current mode unchanged", () => {
    expect(applyDeveloperModeTransition("plan", "hello, the weather is nice")).toBe("plan")
    expect(applyDeveloperModeTransition("default", "please be careful")).toBe("default")
  })
  test("partial-match attempt ⇒ treated as non-directive (regex is anchored)", () => {
    expect(applyDeveloperModeTransition("default", "please switch to mode=plan now")).toBe(
      "default",
    )
  })
  test("'mode=review' ⇒ throws InvalidModeTransitionError (only plan/default allowed)", () => {
    expect(() => applyDeveloperModeTransition("default", "mode=review")).toThrow(
      InvalidModeTransitionError,
    )
  })
  test("'mode=audit' ⇒ throws", () => {
    expect(() => applyDeveloperModeTransition("default", "mode=audit")).toThrow(
      InvalidModeTransitionError,
    )
  })
  test("'mode=' (empty) ⇒ regex does not match — non-directive", () => {
    // Empty value fails the [a-z_]+ char class ⇒ no match ⇒ non-directive ⇒ no transition.
    expect(applyDeveloperModeTransition("default", "mode=")).toBe("default")
  })
  test("InvalidModeTransitionError carries attempted mode for diagnostics", () => {
    try {
      applyDeveloperModeTransition("default", "mode=bypass")
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidModeTransitionError)
      expect((err as InvalidModeTransitionError).attempted).toBe("bypass")
    }
  })
  test("uppercase MODE=PLAN ⇒ not a directive (lowercase only by contract)", () => {
    expect(applyDeveloperModeTransition("default", "MODE=PLAN")).toBe("default")
  })
})
