/**
 * Unified diff parser → `DiffHunk[]` (ADR-0109).
 *
 * Accepts `git diff` output (with or without `--color`). Extracts hunks as
 * separate `added` / `removed` blocks per contiguous run of `+` / `-`
 * lines. Mixed `+`/`-` hunks (within a single @@ chunk) emit BOTH an
 * `added` and `removed` DiffHunk, sharing the same file but separate
 * startLine/endLine.
 */

import type { DiffHunk } from "./types"

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escapes begin with the literal ESC (0x1b) byte; the regex must contain it.
const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g

/** Strip ANSI CSI escape sequences (ESC `\x1b` + `[…m`). */
const stripAnsi = (s: string): string => s.replaceAll(ANSI_CSI, "")

// biome-ignore lint/suspicious/noControlCharactersInRegex: the rule's intent is to BAN these characters; we need the literal range (NUL..US) to detect them.
const CONTROL_CHARS = /[\x00-\x1f]/

/** Refuse file paths containing control characters (NUL through US,
 *  i.e. 0x00–0x1F). The detector's whole point is to REFUSE those bytes. */
const isSafePath = (path: string): boolean => !CONTROL_CHARS.test(path)

interface ParserState {
  file: string | null
  preLine: number
  postLine: number
  removedBuf: { lines: string[]; startLine: number }
  addedBuf: { lines: string[]; startLine: number }
}

const emptyState = (): ParserState => ({
  file: null,
  preLine: 0,
  postLine: 0,
  removedBuf: { lines: [], startLine: 0 },
  addedBuf: { lines: [], startLine: 0 },
})

const flushBuffers = (state: ParserState, out: DiffHunk[]): void => {
  if (state.file !== null && state.removedBuf.lines.length > 0) {
    out.push({
      file: state.file,
      kind: "removed",
      startLine: state.removedBuf.startLine,
      endLine: state.removedBuf.startLine + state.removedBuf.lines.length - 1,
      body: state.removedBuf.lines.join("\n"),
    })
  }
  if (state.file !== null && state.addedBuf.lines.length > 0) {
    out.push({
      file: state.file,
      kind: "added",
      startLine: state.addedBuf.startLine,
      endLine: state.addedBuf.startLine + state.addedBuf.lines.length - 1,
      body: state.addedBuf.lines.join("\n"),
    })
  }
  state.removedBuf = { lines: [], startLine: 0 }
  state.addedBuf = { lines: [], startLine: 0 }
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/
const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/

const handleFileLine = (match: RegExpExecArray, state: ParserState, out: DiffHunk[]): void => {
  flushBuffers(state, out)
  const file = match[2] ?? match[1] ?? ""
  state.file = isSafePath(file) ? file : null
  state.preLine = 0
  state.postLine = 0
}

const handleHunkLine = (match: RegExpExecArray, state: ParserState, out: DiffHunk[]): void => {
  flushBuffers(state, out)
  const preStr = match[1]
  const postStr = match[2]
  if (preStr === undefined || postStr === undefined) return
  state.preLine = Number.parseInt(preStr, 10)
  state.postLine = Number.parseInt(postStr, 10)
}

const handleAddedLine = (line: string, state: ParserState): void => {
  if (state.addedBuf.lines.length === 0) state.addedBuf.startLine = state.postLine
  state.addedBuf.lines.push(line.slice(1))
  state.postLine += 1
}

const handleRemovedLine = (line: string, state: ParserState): void => {
  if (state.removedBuf.lines.length === 0) state.removedBuf.startLine = state.preLine
  state.removedBuf.lines.push(line.slice(1))
  state.preLine += 1
}

const handleContextLine = (state: ParserState, out: DiffHunk[]): void => {
  flushBuffers(state, out)
  state.preLine += 1
  state.postLine += 1
}

export const parseUnifiedDiff = (rawText: string): readonly DiffHunk[] => {
  const text = stripAnsi(rawText)
  const out: DiffHunk[] = []
  const state = emptyState()

  for (const line of text.split("\n")) {
    const diffMatch = FILE_HEADER.exec(line)
    if (diffMatch) {
      handleFileLine(diffMatch, state, out)
      continue
    }
    const hunkMatch = HUNK_HEADER.exec(line)
    if (hunkMatch) {
      handleHunkLine(hunkMatch, state, out)
      continue
    }
    if (state.file === null) continue
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) {
      handleAddedLine(line, state)
      continue
    }
    if (line.startsWith("-")) {
      handleRemovedLine(line, state)
      continue
    }
    handleContextLine(state, out)
  }
  flushBuffers(state, out)
  return out
}
