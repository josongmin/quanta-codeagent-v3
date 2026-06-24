import { describe, expect, it } from "bun:test"
import { collectBenchKnobsTelemetry } from "@/runner/batch/core"
import { resolveBenchKnobs } from "@/runner/batch/eval/knobs-bench"
import { withKnobModules } from "@/runner/batch/eval/posture/knob-module"

// #5: a PRESENT-but-malformed bench knob env (e.g. out-of-domain) silently fell
// through to the hardcoded default AND was recorded in `inactive` — byte-
// indistinguishable from "operator never set it". The resolver is a pure
// closed-port (warnings are the SURFACE's job) and existing tests pin its parsers
// to return undefined (not throw) on bad input, so the fix lives here in the
// surface: classify present+non-empty+parse-rejected env as `rejected`, distinct
// from `inactive` (unset). The report SSOT then shows REJECTED(env="300") instead
// of a silent default.

const REGRESSION_KEY = "QUANTA_BENCH_REGRESSION_MAX_TESTS" // domain [1,200]

describe("resolveBenchKnobs rejected loudness (#5)", () => {
  it("flags a present-but-out-of-domain env as `rejected`, NOT a silent inactive", () => {
    const state = resolveBenchKnobs({ envVars: { [REGRESSION_KEY]: "300" } })
    expect(state.rejected).toEqual([
      { id: "regression-max-tests", envKey: REGRESSION_KEY, raw: "300" },
    ])
    // it did NOT resolve a value (fell through to default) …
    expect(state.values.has("regression-max-tests")).toBe(false)
    // … and it is NOT silently lumped in with genuinely-unset knobs.
    expect(state.inactive).not.toContain("regression-max-tests")
  })

  it("flags garbage (non-numeric) the same way", () => {
    const state = resolveBenchKnobs({ envVars: { [REGRESSION_KEY]: "lots" } })
    expect(state.rejected.map((r) => r.id)).toContain("regression-max-tests")
  })

  it("does NOT flag a valid value (it resolves, not rejected)", () => {
    const state = resolveBenchKnobs({ envVars: { [REGRESSION_KEY]: "50" } })
    expect(state.rejected).toEqual([])
    expect(state.values.has("regression-max-tests")).toBe(true)
  })

  it("does NOT flag unset (genuinely inactive, intentional default)", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    expect(state.rejected).toEqual([])
    expect(state.inactive).toContain("regression-max-tests")
  })

  it("does NOT flag an explicitly-empty env (intentional 'use defaults')", () => {
    const state = resolveBenchKnobs({ envVars: { [REGRESSION_KEY]: "  " } })
    expect(state.rejected).toEqual([])
  })

  // A boolean ON/OFF flag (unit omitted) may resolve to an explicit FALSE.
  // `=0/=off/=false` is an intentional opt-out, not a misconfig, so it must not
  // show up under `rejected`.
  it("does NOT flag a boolean knob turned off with 0/false/off (intentional opt-out)", () => {
    for (const off of ["0", "false", "off"]) {
      const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_LSP: off } })
      expect(state.rejected).toEqual([])
      expect(state.values.get("lsp")?.value).toBe(false)
      expect(state.inactive).not.toContain("lsp")
      // and it is treated as a normal explicit off knob, not a misconfig
      expect(state.rejected.map((r) => r.envKey)).not.toContain("QUANTA_BENCH_LSP")
    }
  })

  it("STILL flags a VALUED knob with garbage even if the garbage looks falsy-ish", () => {
    // a numeric knob set to non-numeric garbage is a real typo regardless of spelling
    const state = resolveBenchKnobs({ envVars: { [REGRESSION_KEY]: "nope" } })
    expect(state.rejected.map((r) => r.id)).toContain("regression-max-tests")
  })

  it("a phase module that ACTIVATES a rejected knob clears it from `rejected` (symmetry with inactive)", () => {
    // env raw is invalid (rejected) …
    const base = resolveBenchKnobs({ envVars: { [REGRESSION_KEY]: "300" } })
    expect(base.rejected.map((r) => r.id)).toContain("regression-max-tests")
    // … but a phase module supplies a VALID value ⇒ the knob is now active and
    // must NOT linger in `rejected` (stale otherwise via the `...base` spread).
    const folded = withKnobModules(base, [{ id: "m", knobs: { "regression-max-tests": "50" } }])
    expect(folded.values.has("regression-max-tests")).toBe(true)
    expect(folded.rejected).toEqual([])
  })

  it("WIRING: the rejected list reaches the report SSOT (collectBenchKnobsTelemetry)", () => {
    const had = Object.hasOwn(process.env, REGRESSION_KEY)
    const prev = process.env[REGRESSION_KEY]
    process.env[REGRESSION_KEY] = "300"
    try {
      const report = collectBenchKnobsTelemetry()
      expect(report.rejected).toEqual([
        { id: "regression-max-tests", envKey: REGRESSION_KEY, raw: "300" },
      ])
    } finally {
      if (had) process.env[REGRESSION_KEY] = prev
      else delete process.env[REGRESSION_KEY]
    }
  })
})
