/**
 * Compose a markdown hint block from an `IssueHint`.
 *
 * Output contract:
 *   - empty hint (all five arrays empty) ⇒ empty string ("")
 *     This is the byte-identity sentinel — the caller in bench/driver
 *     only prepends when `hint !== ""`, so default-OFF or "nothing found"
 *     leaves the user message exactly as before.
 *   - non-empty hint ⇒ a self-contained markdown block, ending with a
 *     calibration line that tells the model NOT to blindly trust the hints.
 *     This matters: Agentless reports +5pp on localization with hints, but
 *     uncritical hint-following can also push the model into the wrong file
 *     when the issue body's path is stale or wrong (e.g. a permalink to an
 *     OLD line that has since moved).
 *
 * The block does NOT include code-fence bodies — those would balloon the
 * prompt and the original issue text (still passed verbatim) already carries
 * them. We summarize "N code blocks present" instead.
 *
 * Sort order is the caller's responsibility (extractors already sort); this
 * file is a pure formatter.
 */
import type { IssueHint } from "./types"

const BACKTICK = "`"

const codeList = (items: readonly string[]): string =>
  items.map((s) => `${BACKTICK}${s}${BACKTICK}`).join(", ")

export const composeIssueHint = (h: IssueHint): string => {
  // Empty in every dimension ⇒ empty output (byte-identical sentinel).
  if (
    h.files.length === 0 &&
    h.symbols.length === 0 &&
    h.errors.length === 0 &&
    h.codeFences.length === 0 &&
    h.tracebackPaths.length === 0
  ) {
    return ""
  }

  const lines: string[] = ["## Issue Hints (auto-extracted)"]
  if (h.files.length > 0) lines.push(`- Likely files: ${codeList(h.files)}`)
  if (h.symbols.length > 0) lines.push(`- Symbols mentioned: ${codeList(h.symbols)}`)
  if (h.errors.length > 0) lines.push(`- Errors referenced: ${codeList(h.errors)}`)
  if (h.tracebackPaths.length > 0) {
    lines.push(`- Traceback locations: ${codeList(h.tracebackPaths)}`)
  }
  if (h.codeFences.length > 0) {
    const noun = h.codeFences.length === 1 ? "block" : "blocks"
    lines.push(`- Code ${noun} present: ${h.codeFences.length}`)
  }
  lines.push("")
  lines.push("Use these as starting points but verify with your own tools.")
  return lines.join("\n")
}
