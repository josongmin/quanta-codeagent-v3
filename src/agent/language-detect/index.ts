/**
 * N1 — assistant language auto-detect (absorb: Cursor `whichlang` /
 * `assistant-language-tracking`). quanta vendors NO ML language model, so this
 * is a PURE, deterministic Unicode-script classifier — a VALIDATED proxy (the
 * Unicode script of a char is standardized), NOT an arbitrary heuristic:
 *
 *   1. Count "meaningful" chars by Unicode script (whitespace / digits / ASCII
 *      punctuation / symbols / emoji are NOT meaningful and never counted).
 *   2. Take the argmax script (NO magic percentage threshold — pure majority).
 *   3. Map script → language + a confidence:
 *        - single-language scripts (Hangul→ko, Kana→ja, Cyrillic→ru, Arabic→ar,
 *          Hebrew→he, Thai→th, Devanagari→hi, Greek→el) ⇒ `high`
 *        - Han: kana present anywhere ⇒ ja (Chinese never uses kana), else zh
 *        - Latin: ambiguous across en/es/fr/de/... ⇒ en / `low`
 *
 * The prompt-hint wiring (default-OFF `QUANTA_LANG_DETECT`) only injects a
 * "respond in <lang>" notice on a `high`-confidence non-English signal, so an
 * English / ambiguous / mixed-but-Latin-dominant message stays byte-identical.
 */

export type LanguageConfidence = "high" | "low"
export interface DetectedLanguage {
  readonly lang: string
  readonly confidence: LanguageConfidence
}

/** The scripts we classify. `latin` is the only multi-language (ambiguous) one. */
type Script =
  | "hangul"
  | "hiragana"
  | "katakana"
  | "han"
  | "cyrillic"
  | "arabic"
  | "hebrew"
  | "thai"
  | "devanagari"
  | "greek"
  | "latin"

/** One inclusive code-point range and the script it belongs to. */
type ScriptRange = readonly [lo: number, hi: number, script: Script]

/**
 * The script table. A TABLE rather than an if-chain because every entry is the
 * identical predicate — `lo <= cp <= hi` — and the only thing that varied was
 * the three constants. Ranges are DISJOINT, so order carries no meaning; they
 * are listed grouped by script for readability.
 */
const SCRIPT_RANGES: readonly ScriptRange[] = [
  // Hangul: syllables + Jamo + compatibility Jamo.
  [0xac00, 0xd7a3, "hangul"],
  [0x1100, 0x11ff, "hangul"],
  [0x3130, 0x318f, "hangul"],
  [0x3040, 0x309f, "hiragana"],
  [0x30a0, 0x30ff, "katakana"],
  // Han / CJK unified ideographs (+ extension A).
  [0x4e00, 0x9fff, "han"],
  [0x3400, 0x4dbf, "han"],
  [0x0400, 0x04ff, "cyrillic"],
  [0x0600, 0x06ff, "arabic"],
  [0x0590, 0x05ff, "hebrew"],
  [0x0e00, 0x0e7f, "thai"],
  [0x0900, 0x097f, "devanagari"],
  [0x0370, 0x03ff, "greek"],
  // Latin: ASCII letters + Latin-1 supplement / extended letters (accented).
  [0x41, 0x5a, "latin"],
  [0x61, 0x7a, "latin"],
  [0x00c0, 0x024f, "latin"],
]

/** Classify ONE code point to a tracked script, or null if not meaningful
 *  (whitespace / digit / punctuation / symbol / emoji / untracked). */
const scriptOf = (cp: number): Script | null => {
  for (const [lo, hi, script] of SCRIPT_RANGES) {
    if (cp >= lo && cp <= hi) return script
  }
  return null
}

/**
 * Detect the dominant language of `text`. Returns `undefined` when there are no
 * meaningful (script-bearing) chars. Pure + allocation-light.
 */
export const detectLanguage = (text: string): DetectedLanguage | undefined => {
  const counts: Partial<Record<Script, number>> = {}
  let meaningful = 0
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0) ?? 0)
    if (s === null) continue
    counts[s] = (counts[s] ?? 0) + 1
    meaningful += 1
  }
  if (meaningful === 0) return undefined

  // argmax script (pure majority — no magic threshold).
  let top: Script | undefined
  let topN = 0
  for (const [s, n] of Object.entries(counts) as [Script, number][]) {
    if (n > topN) {
      top = s
      topN = n
    }
  }
  if (top === undefined) return undefined

  const kanaPresent = (counts.hiragana ?? 0) + (counts.katakana ?? 0) > 0

  switch (top) {
    case "hangul":
      return { lang: "ko", confidence: "high" }
    case "hiragana":
    case "katakana":
      return { lang: "ja", confidence: "high" }
    case "han":
      // Chinese never uses kana; any kana anywhere ⇒ Japanese.
      return { lang: kanaPresent ? "ja" : "zh", confidence: "high" }
    case "cyrillic":
      return { lang: "ru", confidence: "high" }
    case "arabic":
      return { lang: "ar", confidence: "high" }
    case "hebrew":
      return { lang: "he", confidence: "high" }
    case "thai":
      return { lang: "th", confidence: "high" }
    case "devanagari":
      return { lang: "hi", confidence: "high" }
    case "greek":
      return { lang: "el", confidence: "high" }
    default:
      // Latin is multi-language — never force a guess; the wiring ignores `low`.
      return { lang: "en", confidence: "low" }
  }
}

/**
 * Build the per-turn DYNAMIC-slot language notice from the latest user text.
 * Returns `undefined` (⇒ nothing pushed ⇒ byte-identical) when:
 *   - the gate is OFF, or
 *   - there is no detectable language, or
 *   - confidence is `low` (Latin/ambiguous — never force a guess), or
 *   - the detected language is English (the model's default).
 * Pure: the caller reads the `QUANTA_LANG_DETECT` gate and the latest user text;
 * this stays free of `runtimeConfig()` so it is trivially unit-testable.
 */
export const buildLanguageHint = (
  latestUserText: string | undefined,
  enabled: boolean,
): string | undefined => {
  if (!enabled || latestUserText === undefined || latestUserText.length === 0) return undefined
  const d = detectLanguage(latestUserText)
  if (d === undefined || d.confidence !== "high" || d.lang === "en") return undefined
  const name = languageName(d.lang)
  return `User language: the user is writing in ${name} (${d.lang}). Respond in ${name} unless they switch languages or explicitly ask otherwise. Keep code identifiers, file paths, and quoted shell/CLI verbatim.`
}

/** Human-readable language name for the prompt hint (the model maps codes fine,
 *  but the English name removes any ambiguity in the notice). */
export const languageName = (lang: string): string =>
  ({
    ko: "Korean",
    ja: "Japanese",
    zh: "Chinese",
    ru: "Russian",
    ar: "Arabic",
    he: "Hebrew",
    th: "Thai",
    hi: "Hindi",
    el: "Greek",
    en: "English",
  })[lang] ?? lang
