import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent"
import { DEFAULT_BASE, renderPostureBase } from "@/agent/prompt-rules"
import { resolveCliDefaultEnvPosture } from "@/agent/system-prompt"

/**
 * jul-9 — the `default` env posture + `QUANTA_ENV_DEFAULT` CLI knob (Finding 1 fix).
 *
 * The general CLI defaulted to `frozen`, imposing SWE-bench "don't install / stop when
 * env-blocked" on a developer at their OWN machine. The `default` posture is an
 * install-permitted local-dev rule set; the knob (default-OFF, byte-identical) opts the CLI
 * into it. Efficacy is measure-first — OFF stays byte-identical so there is zero regression.
 */

const idOf = (r: { id: string }): string => r.id

describe("DEFAULT_BASE — install-permitted local-dev posture", () => {
  test("EXACT roster + order (honesty rails + owned R-NO-SHIM + R-ENV-LOCAL)", () => {
    expect(DEFAULT_BASE.map(idOf)).toEqual([
      "R-SEARCH-FIRST",
      "R-READ-FAILURE",
      "R-NO-THRASH",
      "R-FAILURE-MODE",
      "R-NO-SHIM",
      "R-ENV-LOCAL",
    ])
  })

  test("OMITS the frozen install-prohibition rules (R-ENV / R-STOP-ENV)", () => {
    const ids = DEFAULT_BASE.map(idOf)
    expect(ids).not.toContain("R-ENV")
    expect(ids).not.toContain("R-STOP-ENV")
    const joined = renderPostureBase("default").join("\n")
    expect(joined).not.toContain("[R-ENV]")
    expect(joined).not.toContain("[R-STOP-ENV]")
    // no "declare the environment unavailable and stop" — that's the frozen tail.
    expect(joined).not.toContain("declare the environment unavailable")
  })

  test("CONTAINS R-ENV-LOCAL with its install-permitted, not-graded contract", () => {
    expect(DEFAULT_BASE.map(idOf)).toContain("R-ENV-LOCAL")
    const joined = renderPostureBase("default").join("\n")
    expect(joined).toContain("[R-ENV-LOCAL]")
    expect(joined).toContain("You MAY")
    expect(joined.toLowerCase()).toContain("install")
    expect(joined).toContain("not a graded sandbox")
    // it is NOT the owned "a working environment IS the deliverable / clean exit is the proof"
    // grading framing — default is a plain local dev machine.
    expect(joined).not.toContain("is the proof")
  })

  test("KEEPS the four honesty rails (shared CORE objects, no divergence)", () => {
    for (const id of ["R-SEARCH-FIRST", "R-READ-FAILURE", "R-NO-THRASH", "R-FAILURE-MODE"]) {
      expect(DEFAULT_BASE.map(idOf)).toContain(id)
    }
  })
})

describe("resolveCliDefaultEnvPosture — QUANTA_ENV_DEFAULT knob (default-OFF)", () => {
  test("unset ⇒ 'frozen' (byte-identical default)", () => {
    expect(resolveCliDefaultEnvPosture({})).toBe("frozen")
  })

  test("truthy (1/on/true/yes) ⇒ 'default'", () => {
    for (const on of ["1", "on", "true", "yes", "ON", "True"]) {
      expect(resolveCliDefaultEnvPosture({ QUANTA_ENV_DEFAULT: on })).toBe("default")
    }
  })

  test("falsy / empty / unrecognized ⇒ 'frozen' (opt-in only)", () => {
    for (const off of ["0", "off", "false", "no", "", "garbage"]) {
      expect(resolveCliDefaultEnvPosture({ QUANTA_ENV_DEFAULT: off })).toBe("frozen")
    }
  })
})

describe("buildSystemPrompt — default posture swaps ONLY the env rules", () => {
  test("envPosture:'default' ⇒ R-ENV-LOCAL present, frozen R-ENV/R-STOP-ENV gone", () => {
    const p = buildSystemPrompt("/w", { envPosture: "default" })
    expect(p).toContain("[R-ENV-LOCAL]")
    expect(p).not.toContain("[R-ENV]")
    expect(p).not.toContain("[R-STOP-ENV]")
  })

  test("byte-identical: no envPosture === envPosture:'frozen' (OFF path untouched)", () => {
    expect(buildSystemPrompt("/w", {})).toBe(buildSystemPrompt("/w", { envPosture: "frozen" }))
  })

  test("frozen still carries the SWE install-prohibition (default posture did NOT change it)", () => {
    const p = buildSystemPrompt("/w", { envPosture: "frozen" })
    expect(p).toContain("[R-ENV]")
    expect(p).not.toContain("[R-ENV-LOCAL]")
  })
})
