import { describe, expect, test } from "bun:test"
import { formatKnobValue } from "@/runner/batch/eval/knobs-bench"

/**
 * Knob values are self-describing: a number always carries its UNIT so a bare
 * "5" never appears in the report or a preset table ("5 turns", not "5").
 */
describe("formatKnobValue", () => {
  test("number + unit ⇒ 'N unit'", () => {
    expect(formatKnobValue(3, "rounds")).toBe("3 rounds")
    expect(formatKnobValue(40, "samples")).toBe("40 samples")
  })

  test("object-wrapped number (localize-phase/repro-test shapes) ⇒ pulls the number", () => {
    expect(formatKnobValue({ phase1Turns: 5 }, "turns")).toBe("5 turns")
    expect(formatKnobValue({ samples: 5 }, "samples")).toBe("5 samples")
  })

  test("no unit ⇒ boolean ON flag (not a count)", () => {
    expect(formatKnobValue(true, undefined)).toBe("on")
    expect(formatKnobValue(1, undefined)).toBe("on")
  })

  test("string value + unit (mode) ⇒ 'value (unit)'", () => {
    expect(formatKnobValue("agentless", "mode")).toBe("agentless (mode)")
  })
})
