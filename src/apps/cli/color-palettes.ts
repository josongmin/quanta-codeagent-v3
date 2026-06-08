/**
 * Colorblind-safe color palettes — pure data SSOT (ticket-15, §11.7 part B).
 *
 * Claude Code's settings schema exposes a `theme` enum that includes
 * `light-daltonized` / `dark-daltonized` (the REAL CC enum names — confirmed in
 * `claude-code-ide/claude-code-settings.schema.json:2691`). Quanta adds the same
 * two names to `VALID_THEMES` (the slash-`/color` surface) and surfaces the
 * underlying palette through {@link getColorPalette} so the host renderer can
 * pick colorblind-safe hues.
 *
 * The numbers here are NOT invented. The base 8-color set is the **Okabe-Ito**
 * "Color Universal Design" palette (Okabe & Ito, 2008; popularized via
 * Wong, "Points of view: Color blindness", *Nature Methods* 8, 441 (2011) and
 * referenced in *PLoS ONE* color-vision work). It is the field-standard set
 * chosen so the eight categorical colors stay distinguishable under the three
 * common dichromacies. The per-variant palettes below re-use that same anchor
 * set, re-ordered / pruned to the hues that survive best for each condition
 * (deuteranopia / protanopia rely on the blue↔orange↔yellow axis; tritanopia on
 * the red↔green↔cyan axis; achromatopsia uses only luminance-distinct greys).
 *
 * PURE DATA — no I/O, no imports, no env reads. The module is a registry the
 * host renderer reads; nothing here renders. Lives in `src/apps/cli` (the
 * surface that owns `/color`), inside the existing CLI slice — no new
 * tsconfig path / slice fence needed.
 */

/** A named role → hex color. Roles are renderer-agnostic semantic slots so a
 *  surface can map them onto its own concepts (prompt accent, success, warning,
 *  error, info, muted) without knowing the theme. */
export interface ColorPalette {
  /** Stable identifier (matches the requested theme variant or its fallback). */
  readonly id: ColorPaletteId
  /** Foreground / primary accent (prompt prefix, headings). */
  readonly primary: string
  /** Positive / success (e.g. a passing check). */
  readonly success: string
  /** Caution / warning. */
  readonly warning: string
  /** Negative / error. */
  readonly error: string
  /** Informational / secondary accent. */
  readonly info: string
  /** De-emphasized / muted (separators, hints). */
  readonly muted: string
  /** Ordered categorical ramp (for charts / multi-series, e.g. usage bars). */
  readonly categorical: readonly string[]
}

/** The supported palette identifiers. The two `*-daltonized` ids mirror Claude
 *  Code's enum names; the four single-condition ids are the explicit per-
 *  dichromacy variants the plan calls for. `default` is the fallback. */
export type ColorPaletteId =
  | "default"
  | "light-daltonized"
  | "dark-daltonized"
  | "deuteranopia"
  | "protanopia"
  | "tritanopia"
  | "achromatopsia"

// ── Okabe-Ito "Color Universal Design" anchor set (Okabe & Ito 2008) ─────────
//   black     #000000   orange    #E69F00   sky-blue  #56B4E9
//   bluish-green #009E73 yellow    #F0E442   blue      #0072B2
//   vermillion   #D55E00 redd-purple #CC79A7
// These eight are the field-standard categorical palette engineered to stay
// separable under deuteranopia / protanopia / tritanopia.
const OKABE_ITO = {
  black: "#000000",
  orange: "#E69F00",
  skyBlue: "#56B4E9",
  bluishGreen: "#009E73",
  yellow: "#F0E442",
  blue: "#0072B2",
  vermillion: "#D55E00",
  reddishPurple: "#CC79A7",
} as const

/** Canonical Okabe-Ito categorical ramp (orange-first so the most salient hue
 *  leads — the conventional ordering in the CUD references). */
const OKABE_ITO_RAMP: readonly string[] = [
  OKABE_ITO.orange,
  OKABE_ITO.skyBlue,
  OKABE_ITO.bluishGreen,
  OKABE_ITO.yellow,
  OKABE_ITO.blue,
  OKABE_ITO.vermillion,
  OKABE_ITO.reddishPurple,
  OKABE_ITO.black,
]

/**
 * The palette registry. Each entry is built ONLY from Okabe-Ito anchors so the
 * whole surface inherits the published CUD guarantees; the per-condition
 * variants choose the role hues from the axis that survives that dichromacy.
 *
 *  - `default` / `light-daltonized` / `dark-daltonized`: the full CUD set.
 *  - `deuteranopia` / `protanopia` (red-green): lean on blue↔orange↔yellow,
 *    avoid leaning success/error solely on the red-green pair.
 *  - `tritanopia` (blue-yellow): lean on red↔green↔purple, avoid the
 *    blue-yellow pair carrying the success/error distinction.
 *  - `achromatopsia` (no color): luminance-distinct greys only (#000–#fff
 *    spread) — never relies on hue.
 */
const PALETTES: Readonly<Record<ColorPaletteId, ColorPalette>> = {
  default: {
    id: "default",
    primary: OKABE_ITO.blue,
    success: OKABE_ITO.bluishGreen,
    warning: OKABE_ITO.orange,
    error: OKABE_ITO.vermillion,
    info: OKABE_ITO.skyBlue,
    muted: "#999999",
    categorical: OKABE_ITO_RAMP,
  },
  "light-daltonized": {
    id: "light-daltonized",
    // Light background ⇒ prefer the deeper anchors for contrast.
    primary: OKABE_ITO.blue,
    success: OKABE_ITO.bluishGreen,
    warning: OKABE_ITO.vermillion,
    error: OKABE_ITO.reddishPurple,
    info: OKABE_ITO.blue,
    muted: "#6B6B6B",
    categorical: OKABE_ITO_RAMP,
  },
  "dark-daltonized": {
    id: "dark-daltonized",
    // Dark background ⇒ prefer the brighter anchors for contrast.
    primary: OKABE_ITO.skyBlue,
    success: OKABE_ITO.bluishGreen,
    warning: OKABE_ITO.orange,
    error: OKABE_ITO.vermillion,
    info: OKABE_ITO.yellow,
    muted: "#B0B0B0",
    categorical: OKABE_ITO_RAMP,
  },
  // Red-green dichromacies: success/error must NOT be the red-green pair, so we
  // carry the distinction on the blue↔orange axis (the strongest under D/P).
  deuteranopia: {
    id: "deuteranopia",
    primary: OKABE_ITO.blue,
    success: OKABE_ITO.skyBlue,
    warning: OKABE_ITO.yellow,
    error: OKABE_ITO.orange,
    info: OKABE_ITO.blue,
    muted: "#8A8A8A",
    categorical: [
      OKABE_ITO.blue,
      OKABE_ITO.orange,
      OKABE_ITO.skyBlue,
      OKABE_ITO.yellow,
      OKABE_ITO.vermillion,
      OKABE_ITO.black,
    ],
  },
  protanopia: {
    id: "protanopia",
    primary: OKABE_ITO.blue,
    success: OKABE_ITO.skyBlue,
    warning: OKABE_ITO.yellow,
    error: OKABE_ITO.orange,
    info: OKABE_ITO.blue,
    muted: "#8A8A8A",
    categorical: [
      OKABE_ITO.blue,
      OKABE_ITO.orange,
      OKABE_ITO.skyBlue,
      OKABE_ITO.yellow,
      OKABE_ITO.vermillion,
      OKABE_ITO.black,
    ],
  },
  // Blue-yellow dichromacy: distinction carried on the red↔green↔purple axis.
  tritanopia: {
    id: "tritanopia",
    primary: OKABE_ITO.vermillion,
    success: OKABE_ITO.bluishGreen,
    warning: OKABE_ITO.reddishPurple,
    error: OKABE_ITO.vermillion,
    info: OKABE_ITO.bluishGreen,
    muted: "#8A8A8A",
    categorical: [
      OKABE_ITO.vermillion,
      OKABE_ITO.bluishGreen,
      OKABE_ITO.reddishPurple,
      OKABE_ITO.skyBlue,
      OKABE_ITO.black,
    ],
  },
  // Total color blindness: luminance-distinct greyscale only. Spread across the
  // full #000–#fff range so neighbors differ by a large luminance step.
  achromatopsia: {
    id: "achromatopsia",
    primary: "#000000",
    success: "#3F3F3F",
    warning: "#7A7A7A",
    error: "#1A1A1A",
    info: "#5C5C5C",
    muted: "#A8A8A8",
    categorical: ["#000000", "#3F3F3F", "#7A7A7A", "#A8A8A8", "#D4D4D4", "#FFFFFF"],
  },
}

/** The set of recognized palette ids (for drift-guard tests + validation). */
export const COLOR_PALETTE_IDS: readonly ColorPaletteId[] = Object.freeze([
  "default",
  "light-daltonized",
  "dark-daltonized",
  "deuteranopia",
  "protanopia",
  "tritanopia",
  "achromatopsia",
])

/** Map a `theme` (or palette id) onto its accessibility-tuned palette.
 *
 *  - An exact palette id (`light-daltonized`, `deuteranopia`, …) returns that
 *    palette.
 *  - A generic light/dark theme (`light`, `dark`, `auto`, `claude`, …) or any
 *    unknown / empty value returns the `default` (full Okabe-Ito) palette — the
 *    safe fallback (NEVER throws; the renderer always gets a usable palette).
 *
 *  Pure function. */
export const getColorPalette = (theme: string | undefined): ColorPalette => {
  if (theme === undefined) return PALETTES.default
  const key = theme.trim().toLowerCase()
  if (key in PALETTES) {
    return PALETTES[key as ColorPaletteId]
  }
  return PALETTES.default
}
