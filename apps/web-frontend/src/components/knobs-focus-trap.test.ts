/**
 * WS-F polish (UUX-5-26 half 2) — KnobsPanel focus trap wrap logic.
 *
 * `aria-modal="true"` without a focus trap lies to screen readers: Tab walks
 * out of the dialog into the inert background. The wrap computation is pure
 * (node test env, no DOM); the panel's Tab keydown handler applies it over the
 * dialog's live focusable list.
 */

import { describe, expect, it } from "vitest"
import { nextFocusTrapIndex } from "./KnobsPanel"

describe("nextFocusTrapIndex", () => {
  it("Tab advances and wraps last → first", () => {
    expect(nextFocusTrapIndex(0, 3, false)).toBe(1)
    expect(nextFocusTrapIndex(2, 3, false)).toBe(0)
  })

  it("Shift+Tab retreats and wraps first → last", () => {
    expect(nextFocusTrapIndex(1, 3, true)).toBe(0)
    expect(nextFocusTrapIndex(0, 3, true)).toBe(2)
  })

  it("focus outside the dialog (index -1) enters at first / last", () => {
    expect(nextFocusTrapIndex(-1, 3, false)).toBe(0)
    expect(nextFocusTrapIndex(-1, 3, true)).toBe(2)
  })

  it("empty focusable list yields -1 (caller keeps focus put)", () => {
    expect(nextFocusTrapIndex(0, 0, false)).toBe(-1)
    expect(nextFocusTrapIndex(-1, 0, true)).toBe(-1)
  })
})
