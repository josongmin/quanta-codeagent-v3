/**
 * jun-22 magic-number config-extraction hellgate. Two previously-hardcoded
 * operational constants are now bench knobs:
 *   - repro-exec-timeout (per-repro-script exec timeout; was 60s, un-tunable)
 *   - localize-budget (agentless one-shot localizer topK/treeChars/maxFiles)
 *
 * Asserts: domain clamping, structured parse, and unset ⇒ undefined (so the
 * driver keeps the hardcoded default = byte-identical).
 */
import { describe, expect, it } from "bun:test"
import { localizeBudgetKnob } from "@/runner/knobs/knobs/localize-budget"
import { noPatchForceFractionKnob } from "@/runner/knobs/knobs/no-patch-force-fraction"
import { regressionMaxTestsKnob } from "@/runner/knobs/knobs/regression-max-tests"
import { reproExecTimeoutKnob } from "@/runner/knobs/knobs/repro-exec-timeout"

describe("repro-exec-timeout knob", () => {
  const p = reproExecTimeoutKnob.parse
  it("unset / empty ⇒ undefined (driver keeps the 60s default, byte-identical)", () => {
    expect(p(undefined)).toBeUndefined()
    expect(p("")).toBeUndefined()
  })
  it("parses a valid ms value", () => {
    expect(p("120000")).toBe(120000)
  })
  it("clamps the domain [5000, 600000] — out-of-range ⇒ undefined", () => {
    expect(p("4999")).toBeUndefined()
    expect(p("600001")).toBeUndefined()
    expect(p("60000")).toBe(60000)
  })
  it("rejects non-integer / garbage", () => {
    expect(p("12.5")).toBeUndefined()
    expect(p("abc")).toBeUndefined()
    expect(p("-1")).toBeUndefined()
  })
  it("envKey + apply-noop (consumed out of band)", () => {
    expect(reproExecTimeoutKnob.envKey).toBe("QUANTA_BENCH_REPRO_EXEC_TIMEOUT_MS")
  })
})

describe("localize-budget knob (structured)", () => {
  const p = localizeBudgetKnob.parse
  it("unset ⇒ undefined (localizer keeps 5/12000/3000 defaults, byte-identical)", () => {
    expect(p(undefined)).toBeUndefined()
    expect(p("")).toBeUndefined()
  })
  it("parses any subset of topk/tree/files/chafiles", () => {
    expect(p("topk=8")).toEqual({ topK: 8 })
    expect(p("tree=20000,files=4000")).toEqual({ maxTreeChars: 20000, maxFiles: 4000 })
    expect(p("topk=8,tree=20000,files=4000")).toEqual({
      topK: 8,
      maxTreeChars: 20000,
      maxFiles: 4000,
    })
    // jun-25: chafiles replaces the frozen CHA_MULTISITE_MAX_FILES literal —
    // the CHA-multisite file budget is now a documented, sweepable config field.
    expect(p("chafiles=7")).toEqual({ chaMultisiteFiles: 7 })
    expect(p("topk=10,chafiles=2")).toEqual({ topK: 10, chaMultisiteFiles: 2 })
  })
  it("clamps each field's domain; out-of-range ⇒ undefined (whole value rejected)", () => {
    expect(p("topk=0")).toBeUndefined()
    expect(p("topk=51")).toBeUndefined()
    expect(p("tree=999")).toBeUndefined()
    expect(p("files=99")).toBeUndefined()
    expect(p("chafiles=0")).toBeUndefined()
    expect(p("chafiles=51")).toBeUndefined()
    expect(p("chafiles=1")).toEqual({ chaMultisiteFiles: 1 })
    expect(p("chafiles=50")).toEqual({ chaMultisiteFiles: 50 })
  })
  it("rejects unknown keys / garbage / present-but-empty", () => {
    expect(p("bogus=5")).toBeUndefined()
    expect(p("topk=abc")).toBeUndefined()
    expect(p("topk")).toBeUndefined()
  })
})

describe("no-patch-force-fraction knob (float)", () => {
  const p = noPatchForceFractionKnob.parse
  it("unset ⇒ undefined (breaker keeps 0.8 default, byte-identical)", () => {
    expect(p(undefined)).toBeUndefined()
    expect(p("")).toBeUndefined()
  })
  it("parses a float in (0,1)", () => {
    expect(p("0.6")).toBe(0.6)
    expect(p(".9")).toBe(0.9)
  })
  it("rejects out-of-range / non-float (0, 1, integers, >1)", () => {
    expect(p("0")).toBeUndefined()
    expect(p("1")).toBeUndefined()
    expect(p("1.2")).toBeUndefined()
    expect(p("8")).toBeUndefined()
    expect(p("abc")).toBeUndefined()
  })
})

describe("regression-max-tests knob (int)", () => {
  const p = regressionMaxTestsKnob.parse
  it("unset ⇒ undefined (keeps 12 default SSOT, byte-identical)", () => {
    expect(p(undefined)).toBeUndefined()
    expect(p("")).toBeUndefined()
  })
  it("parses + clamps [1,200]", () => {
    expect(p("30")).toBe(30)
    expect(p("0")).toBeUndefined()
    expect(p("201")).toBeUndefined()
    expect(p("1")).toBe(1)
    expect(p("200")).toBe(200)
  })
  it("rejects non-integer", () => {
    expect(p("12.5")).toBeUndefined()
    expect(p("x")).toBeUndefined()
  })
})
