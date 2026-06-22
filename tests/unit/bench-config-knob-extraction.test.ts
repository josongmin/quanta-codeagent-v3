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
  it("parses any subset of topk/tree/files", () => {
    expect(p("topk=8")).toEqual({ topK: 8 })
    expect(p("tree=20000,files=4000")).toEqual({ maxTreeChars: 20000, maxFiles: 4000 })
    expect(p("topk=8,tree=20000,files=4000")).toEqual({
      topK: 8,
      maxTreeChars: 20000,
      maxFiles: 4000,
    })
  })
  it("clamps each field's domain; out-of-range ⇒ undefined (whole value rejected)", () => {
    expect(p("topk=0")).toBeUndefined()
    expect(p("topk=51")).toBeUndefined()
    expect(p("tree=999")).toBeUndefined()
    expect(p("files=99")).toBeUndefined()
  })
  it("rejects unknown keys / garbage / present-but-empty", () => {
    expect(p("bogus=5")).toBeUndefined()
    expect(p("topk=abc")).toBeUndefined()
    expect(p("topk")).toBeUndefined()
  })
})
