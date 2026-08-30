import { sliceWholeChars } from "./slice-whole-chars"

/** Display-only model label. Never use this lossy text as an accounting key. */
export const MODEL_DISPLAY_LABEL_MAX_LENGTH = 64

export const sanitizeModelDisplayLabel = (model: string): string => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control/newline display injection
  const withoutControls = model.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "")
  return sliceWholeChars(withoutControls, MODEL_DISPLAY_LABEL_MAX_LENGTH)
}
