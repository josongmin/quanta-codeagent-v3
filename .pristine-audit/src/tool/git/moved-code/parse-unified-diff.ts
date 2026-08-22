/**
 * Unified-diff text → {@link DiffHunk}[] parser (ADR-0109).
 *
 * Accepts the output of `git diff` (with or without `--color-moved=zebra`).
 * Color escapes are stripped before parsing — `--color-moved=zebra` emits
 * ANSI markers but the textual structure (`diff --git`, `@@`, `+`/`-`) is
 * unchanged.
 *
 * Output contract:
 *   - One `DiffHunk` per maximal contiguous run of `-` lines, one per
 *     maximal contiguous run of `+` lines. Mixed `-`/`+` interleavings are
 *     split into separate hunks at the polarity flip.
 *   - `file` is the post-image path for `+` hunks, pre-image for `-` hunks
 *     (the file the lines belong to).
 *   - Line numbers are 1-based and reflect the source/target line of the
 *     FIRST changed line in the run, with `endLine` = `startLine + count - 1`.
 *   - Lines containing `\n` in file names are rejected (malformed section
 *     drops its paths) — the rest of the diff parses normally. Per
 *     ADR-0109 §함정.
 *
 * SECURITY: no eval, no exec — pure string scanning. No path canonicalization
 * (out of scope: detector is post-diff, paths come from git itself).
 *
 * The parser is structured as a small state machine + per-line handlers so
 * each function stays under the cognitive-complexity cap.
 */
import type { DiffHunk } from "./types"

/** Strip ANSI CSI escapes (`ESC [ … letter`). */
const stripAnsi = (s: string): string => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC by design
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
}

/** `diff --git a/foo b/bar` → {a, b}. Returns null if malformed. */
const parseDiffGitHeader = (line: string): { a: string; b: string } | null => {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
  if (!m) return null
  const a = m[1]
  const b = m[2]
  if (a === undefined || b === undefined) return null
  if (a.includes("\n") || b.includes("\n")) return null
  return { a, b }
}

interface HunkHeader {
  readonly oldStart: number
  readonly newStart: number
}

const parseHunkHeader = (line: string): HunkHeader | null => {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
  if (!m) return null
  const oldStart = Number(m[1])
  const newStart = Number(m[2])
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return null
  return { oldStart, newStart }
}

/** Mutable parser state. Kept local to {@link parseUnifiedDiff}. */
interface ParserState {
  aFile: string
  bFile: string
  oldLine: number
  newLine: number
  inHunk: boolean
  runKind: "added" | "removed" | null
  runStartOld: number
  runStartNew: number
  runBody: string[]
  hunks: DiffHunk[]
}

const newState = (): ParserState => ({
  aFile: "",
  bFile: "",
  oldLine: 0,
  newLine: 0,
  inHunk: false,
  runKind: null,
  runStartOld: 0,
  runStartNew: 0,
  runBody: [],
  hunks: [],
})

/** Commit the in-progress polarity run as a single DiffHunk. */
const flushRun = (s: ParserState): void => {
  if (s.runKind === null || s.runBody.length === 0) {
    s.runKind = null
    s.runBody = []
    return
  }
  const file = s.runKind === "removed" ? s.aFile : s.bFile
  if (file.length === 0) {
    s.runKind = null
    s.runBody = []
    return
  }
  const startLine = s.runKind === "removed" ? s.runStartOld : s.runStartNew
  s.hunks.push({
    file,
    startLine,
    endLine: startLine + s.runBody.length - 1,
    kind: s.runKind,
    body: s.runBody.join("\n"),
  })
  s.runKind = null
  s.runBody = []
}

/** Header lines — return true if `raw` was consumed by header handling. */
const tryHeader = (s: ParserState, raw: string): boolean => {
  if (raw.startsWith("diff --git ")) {
    flushRun(s)
    const h = parseDiffGitHeader(raw)
    s.aFile = h?.a ?? ""
    s.bFile = h?.b ?? ""
    s.inHunk = false
    return true
  }
  if (raw.startsWith("--- a/")) {
    flushRun(s)
    s.aFile = raw.slice(6)
    s.inHunk = false
    return true
  }
  if (raw.startsWith("--- /dev/null")) {
    flushRun(s)
    s.aFile = "/dev/null"
    s.inHunk = false
    return true
  }
  if (raw.startsWith("+++ b/")) {
    flushRun(s)
    s.bFile = raw.slice(6)
    s.inHunk = false
    return true
  }
  if (raw.startsWith("+++ /dev/null")) {
    flushRun(s)
    s.bFile = "/dev/null"
    s.inHunk = false
    return true
  }
  if (raw.startsWith("@@")) {
    flushRun(s)
    const h = parseHunkHeader(raw)
    if (h === null) {
      s.inHunk = false
    } else {
      s.oldLine = h.oldStart
      s.newLine = h.newStart
      s.inHunk = true
    }
    return true
  }
  return false
}

/** Body line — consumed only when {@link ParserState.inHunk}. */
const consumeBody = (s: ParserState, raw: string): void => {
  if (raw.startsWith("\\")) return // "\ No newline at end of file"
  if (raw.startsWith("+") && !raw.startsWith("+++")) {
    if (s.runKind !== "added") {
      flushRun(s)
      s.runKind = "added"
      s.runStartOld = s.oldLine
      s.runStartNew = s.newLine
    }
    s.runBody.push(raw.slice(1))
    s.newLine += 1
    return
  }
  if (raw.startsWith("-") && !raw.startsWith("---")) {
    if (s.runKind !== "removed") {
      flushRun(s)
      s.runKind = "removed"
      s.runStartOld = s.oldLine
      s.runStartNew = s.newLine
    }
    s.runBody.push(raw.slice(1))
    s.oldLine += 1
    return
  }
  // Context line (` `-prefix) or empty line — close any in-progress run.
  flushRun(s)
  if (raw.startsWith(" ")) {
    s.oldLine += 1
    s.newLine += 1
  }
}

/**
 * Parse a unified-diff text into removed/added hunks.
 *
 * Robust to:
 *   - Multiple file sections (`diff --git` repeats).
 *   - `--color-moved=zebra` ANSI noise.
 *   - Hunks with no count after the comma (defaults to 1 per git format).
 *   - Renames (`similarity index … / rename from … / rename to …`) —
 *     the textual body still has `@@` hunks and parses normally.
 */
export const parseUnifiedDiff = (text: string): DiffHunk[] => {
  if (text.length === 0) return []
  const lines = stripAnsi(text).split("\n")
  const state = newState()
  for (const raw of lines) {
    if (tryHeader(state, raw)) continue
    if (!state.inHunk) continue
    consumeBody(state, raw)
  }
  flushRun(state)
  return state.hunks
}
