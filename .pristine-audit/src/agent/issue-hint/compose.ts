/**
 * Compose a verbatim-evidence markdown hint block from an `IssueHint`.
 *
 * Output contract:
 *   - empty hint (all arrays empty, no opt-in fields populated) ⇒ empty
 *     string (""). This is the byte-identity sentinel — the caller in
 *     bench/driver only prepends when `hint !== ""`, so default-OFF or
 *     "nothing found" leaves the user message exactly as before.
 *   - non-empty hint ⇒ a self-contained markdown block. Empty sections are
 *     OMITTED (no "0 fences" placeholders). The block ends with a
 *     calibration line that tells the model NOT to blindly trust the hints.
 *
 * Verbatim-evidence sections (the bytes are passed through unchanged):
 *
 *   ### Reproduction code
 *   ```
 *   <body verbatim>
 *   ```
 *
 *   ### Traceback
 *   ```
 *   <traceback block verbatim>
 *   ```
 *
 *   ### Errors
 *   - `TypeError: x is not a function`
 *   - `UnicodeError`
 *
 *   ### Likely files
 *   - `requests/models.py`
 *
 *   ### Symbols mentioned
 *   - `prepare_url`, `InvalidUrl`
 *
 *   ### Refs
 *   - #774
 *
 * Code fences in the source are re-emitted with triple-backtick boundaries.
 * The fence body itself is bounded by the extractor (4KiB cap with head+tail
 * compression); the composer does NOT additionally truncate.
 *
 * Calibration: the last non-empty line is always
 * "Use these as starting points but verify with your own tools." — same as
 * the legacy format, so existing prompts that scan for this phrase still
 * work.
 */
import type { IssueHint } from "./types"

const BACKTICK = "`"
const FENCE = "```"

const isEmpty = (h: IssueHint): boolean =>
  h.files.length === 0 &&
  h.symbols.length === 0 &&
  h.errors.length === 0 &&
  h.codeFences.length === 0 &&
  h.tracebacks.length === 0 &&
  h.tracebackPaths.length === 0 &&
  h.refs.length === 0 &&
  (h.expectedActual === undefined || h.expectedActual.length === 0)

const codeList = (items: readonly string[]): string =>
  items.map((s) => `${BACKTICK}${s}${BACKTICK}`).join(", ")

const bulletList = (items: readonly string[]): string =>
  items.map((s) => `- ${BACKTICK}${s}${BACKTICK}`).join("\n")

const bulletPlain = (items: readonly string[]): string => items.map((s) => `- ${s}`).join("\n")

/** Render a triple-backtick block around a verbatim body. We DO NOT escape
 *  the body — code-fence semantics inside the body (nested ```) are passed
 *  through unmodified. This is safe because the *prompt* doesn't parse
 *  markdown; the model sees the bytes. If a fence contains literal ```, the
 *  model handles it correctly (it sees the embedded fence as content). */
const fenceBlock = (body: string, label?: string): string => {
  const head = label !== undefined ? `${FENCE}${label}` : FENCE
  return `${head}\n${body}\n${FENCE}`
}

/** Push a section header + body lines onto `lines`. Section is emitted ONLY
 *  when `body` is a non-empty string. Keeps the dispatcher under biome's
 *  cognitive-complexity ceiling. */
const pushSection = (lines: string[], heading: string, body: string): void => {
  if (body === "") return
  lines.push("")
  lines.push(`### ${heading}`)
  lines.push(body)
}

/** Build the codeFences section body (multi-block joined) or "" when empty. */
const renderFences = (fences: readonly string[]): string => {
  if (fences.length === 0) return ""
  return fences.map((body) => fenceBlock(body)).join("\n")
}

/** Build the tracebacks section body or "" when empty. */
const renderTracebacks = (blocks: readonly string[]): string => {
  if (blocks.length === 0) return ""
  return blocks.map((body) => fenceBlock(body)).join("\n")
}

const fenceHeading = (count: number): string =>
  count === 1 ? "Reproduction code" : "Reproduction code blocks"
const tbHeading = (count: number): string => (count === 1 ? "Traceback" : "Tracebacks")

export const composeIssueHint = (h: IssueHint): string => {
  if (isEmpty(h)) return ""

  const lines: string[] = ["## Issue evidence (verbatim)"]

  // 1. Reproduction code (VERBATIM fences). Each fence in its own block.
  pushSection(lines, fenceHeading(h.codeFences.length), renderFences(h.codeFences))

  // 2. Traceback (VERBATIM block).
  pushSection(lines, tbHeading(h.tracebacks.length), renderTracebacks(h.tracebacks))

  // 3. Errors (Type or "Type: message").
  pushSection(lines, "Errors", h.errors.length > 0 ? bulletList(h.errors) : "")

  // 4. Likely files (bullet per path).
  pushSection(lines, "Likely files", h.files.length > 0 ? bulletList(h.files) : "")

  // 5. Symbols (comma-joined on one bullet).
  pushSection(lines, "Symbols mentioned", h.symbols.length > 0 ? `- ${codeList(h.symbols)}` : "")

  // 6. Traceback paths (legacy). Only when no verbatim block was emitted.
  const showLegacyPaths = h.tracebackPaths.length > 0 && h.tracebacks.length === 0
  pushSection(lines, "Traceback locations", showLegacyPaths ? bulletList(h.tracebackPaths) : "")

  // 7. Refs (#1234, PROJ-456). Plain bullets.
  pushSection(lines, "Refs", h.refs.length > 0 ? bulletPlain(h.refs) : "")

  // 8. Expected/Actual (opt-in).
  const ea = h.expectedActual ?? []
  pushSection(lines, "Expected/Actual phrases", ea.length > 0 ? bulletPlain(ea) : "")

  lines.push("")
  lines.push("Use these as starting points but verify with your own tools.")
  return lines.join("\n")
}
