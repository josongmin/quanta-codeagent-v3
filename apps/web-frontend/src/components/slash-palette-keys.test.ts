/**
 * WS-F polish (UUX-5-26) — the palette's key routing as a pure function.
 *
 *   - IME guard: an Enter that finalizes a Korean/Japanese/Chinese composition
 *     (`isComposing` / key "Process" / legacy keyCode 229) must NOT accept a
 *     palette row — pre-fix the composition Enter fired the active command.
 *   - Accept must also STOP PROPAGATION at the host so the composer's own
 *     Enter handler cannot double-execute the command (palette accept + submit
 *     both resolving the same slash ran network commands twice).
 */

import { describe, expect, it } from "vitest"
import { resolvePaletteKey } from "./SlashPalette"

describe("resolvePaletteKey", () => {
  it("ArrowDown/ArrowUp move with wraparound", () => {
    expect(resolvePaletteKey({ key: "ArrowDown" }, 0, 3)).toEqual({ type: "move", nextIndex: 1 })
    expect(resolvePaletteKey({ key: "ArrowDown" }, 2, 3)).toEqual({ type: "move", nextIndex: 0 })
    expect(resolvePaletteKey({ key: "ArrowUp" }, 0, 3)).toEqual({ type: "move", nextIndex: 2 })
  })

  it("Tab and Enter accept the active row", () => {
    expect(resolvePaletteKey({ key: "Enter" }, 1, 3)).toEqual({ type: "accept" })
    expect(resolvePaletteKey({ key: "Tab" }, 1, 3)).toEqual({ type: "accept" })
  })

  it("Escape dismisses; other keys are ignored", () => {
    expect(resolvePaletteKey({ key: "Escape" }, 0, 3)).toEqual({ type: "dismiss" })
    expect(resolvePaletteKey({ key: "a" }, 0, 3)).toEqual({ type: "none" })
  })

  it("IME guard: composing Enter never accepts (isComposing)", () => {
    expect(resolvePaletteKey({ key: "Enter", isComposing: true }, 0, 3)).toEqual({ type: "none" })
  })

  it("IME guard: key 'Process' and legacy keyCode 229 never accept", () => {
    expect(resolvePaletteKey({ key: "Process" }, 0, 3)).toEqual({ type: "none" })
    expect(resolvePaletteKey({ key: "Enter", keyCode: 229 }, 0, 3)).toEqual({ type: "none" })
  })

  it("empty list: every key is a no-op (no phantom accept)", () => {
    expect(resolvePaletteKey({ key: "Enter" }, 0, 0)).toEqual({ type: "none" })
    expect(resolvePaletteKey({ key: "ArrowDown" }, 0, 0)).toEqual({ type: "none" })
  })
})
