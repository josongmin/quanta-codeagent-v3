import { describe, expect, test } from "bun:test"
import {
  clearInputLane,
  enterLaneMode,
  exitLaneMode,
  INPUT_LANE_PROMPT,
  renderInputLane,
} from "@/apps/cli/repl/input-lane"

// §11.5 / ticket-08b — the bottom-anchored input lane render. Pure ANSI byte
// builder; pin the EXACT escape sequences (DECSC/CUP/EL2/DECRC) so a regression
// in the control codes is caught (a wrong sequence corrupts the user's terminal).

const SAVE = "\x1b7"
const RESTORE = "\x1b8"
const ERASE = "\x1b[2K"
const cup = (r: number, c: number) => `\x1b[${r};${c}H`

describe("renderInputLane", () => {
  test("draws prompt+buffer at the BOTTOM row, cursor saved/restored", () => {
    expect(renderInputLane("hi", { rows: 24 })).toBe(
      `${SAVE}${cup(24, 1)}${ERASE}${INPUT_LANE_PROMPT}hi${RESTORE}`,
    )
  })

  test("empty buffer ⇒ bare prompt (still drawn so the lane is visible)", () => {
    expect(renderInputLane("", { rows: 10 })).toBe(
      `${SAVE}${cup(10, 1)}${ERASE}${INPUT_LANE_PROMPT}${RESTORE}`,
    )
  })

  test("custom prompt honored", () => {
    expect(renderInputLane("x", { rows: 5, prompt: "steer> " })).toContain("steer> x")
  })

  test("over-width line keeps the PROMPT + buffer TAIL (audit R1 #2)", () => {
    // prompt "» " (2) + "abcdef" = 8; cols 5 ⇒ avail 3 ⇒ "» " + "def".
    const out = renderInputLane("abcdef", { rows: 24, cols: 5 })
    expect(out).toBe(`${SAVE}${cup(24, 1)}${ERASE}${INPUT_LANE_PROMPT}def${RESTORE}`)
  })

  test("rows floored to >=1 (never emits row 0 / negative)", () => {
    expect(renderInputLane("a", { rows: 0 })).toContain(cup(1, 1))
    expect(renderInputLane("a", { rows: -3 })).toContain(cup(1, 1))
  })
})

describe("clearInputLane", () => {
  test("erases the bottom row with cursor save/restore, no content", () => {
    expect(clearInputLane({ rows: 24 })).toBe(`${SAVE}${cup(24, 1)}${ERASE}${RESTORE}`)
  })
})

describe("renderInputLane — audit R1 #2: prompt preserved on narrow terminals", () => {
  // NOTE: the over-width "prompt + buffer tail" case is pinned EXACTLY by the
  // `.toBe` superset at the line-36 test above; no weaker substring duplicate here.
  test("cols ≤ prompt width ⇒ degrade to bare buffer tail (never crash)", () => {
    const out = renderInputLane("abcdef", { rows: 24, cols: 2 })
    expect(out).toBe(`${SAVE}${cup(24, 1)}${ERASE}ef${RESTORE}`)
  })
})

describe("enter/exitLaneMode — audit R2#1/#2: scroll-region reserve + teardown", () => {
  test("enterLaneMode reserves rows 1..r-1 (DECSTBM) + parks cursor in region", () => {
    expect(enterLaneMode(24)).toBe(`\x1b[1;23r${cup(23, 1)}`)
  })
  test("exitLaneMode resets region to full + erases the lane row", () => {
    expect(exitLaneMode(24)).toBe(`\x1b[r${cup(24, 1)}${ERASE}`)
  })
  test("a <2-row terminal can't host a lane ⇒ both are no-ops (empty)", () => {
    expect(enterLaneMode(1)).toBe("")
    expect(enterLaneMode(0)).toBe("")
    expect(exitLaneMode(1)).toBe("")
  })
})
