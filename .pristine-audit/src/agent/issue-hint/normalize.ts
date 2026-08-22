/**
 * Shared text-normalization used by every extractor in this slice.
 *
 * Currently a single transform: strip ANSI CSI escape sequences. Issue bodies
 * frequently include pasted terminal output — when the ESC byte (`\x1b`)
 * appears in the input, our lookbehind / word-boundary patterns can fail
 * because the surrounding context becomes word-character-only. Stripping
 * ANSI is safe (only the extraction scan sees the stripped copy; the agent
 * still receives the original problem statement verbatim).
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip must target the ESC byte
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

export const stripAnsi = (s: string): string => {
  if (typeof s !== "string" || s === "") return ""
  return s.replace(ANSI_RE, "")
}
