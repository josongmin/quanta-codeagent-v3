/**
 * ADR-0440 — canvas theme tokens (Cursor `cursor/canvas` `canvas-tokens`
 * mirror, light + dark).
 *
 * Single source of truth for every diff / usage color so the render-side
 * components never hardcode a hex (mirrors the canvas SDK rule: colors come
 * from tokens, not literals). The web-frontend is dark-by-default
 * (`<html class="dark">`); both palettes are exposed so a future light-mode
 * detector can switch (v2).
 */

/** Diff background + accent-strip tokens, per theme. Alpha-blended so the
 *  line background reads against the editor surface; the strip uses higher
 *  alpha as a non-color signal (accessibility). */
export const diffTokens = {
  dark: {
    insertedLine: "#3FA26633",
    removedLine: "#B8004933",
    stripAdded: "#3FA2668F",
    stripRemoved: "#FC6B838F",
  },
  light: {
    insertedLine: "#1F8A651F",
    removedLine: "#CF2D5614",
    stripAdded: "#1F8A65CC",
    stripRemoved: "#CF2D56CC",
  },
} as const

export type DiffTheme = keyof typeof diffTokens

/** 7-color categorical palette (Cursor `colorPalette`). Used by the UsageBar
 *  when a segment does not specify its own color. */
export const colorPalette = {
  gray: "#8888A8E0",
  purple: "#7B64B8F0",
  green: "#1F8A65E8",
  yellow: "#E8C030E0",
  pink: "#C85898E0",
  blue: "#2E79B5E0",
  orange: "#F0A040E0",
} as const

export type PaletteColor = keyof typeof colorPalette

/** Auto-rotation sequence for un-colored usage segments (Cursor
 *  `usageColorSequence`). Index `i % length` picks the color. */
export const usageColorSequence: readonly string[] = [
  colorPalette.blue,
  colorPalette.green,
  colorPalette.purple,
  colorPalette.yellow,
  colorPalette.pink,
  colorPalette.orange,
  colorPalette.gray,
]

/** Remainder (unused-window) fill — a low-contrast neutral. */
export const usageRemainderColor = "#8888A833"
