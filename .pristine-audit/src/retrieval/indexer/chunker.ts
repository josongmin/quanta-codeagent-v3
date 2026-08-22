/**
 * Pure line-window chunker (ADR-0277).
 *
 * Slices a file's content into overlapping windows. Pure — no clock,
 * no I/O, no module-level state. Same inputs ⇒ byte-identical outputs.
 *
 * Behaviour:
 *   - `windowLines` is the chunk size (default 50).
 *   - `overlapLines` is how many lines the next chunk shares with the
 *     previous one (default 20). Must be < `windowLines`.
 *   - Files smaller than `windowLines` produce a single chunk covering
 *     every line.
 *   - 0-byte files / empty strings produce NO chunks (returns `[]`).
 *   - Line numbering is 1-based, inclusive at both ends — matches the
 *     editor convention every downstream renderer uses.
 *   - Line splitting is on `\n`; a trailing `\r` (CRLF) is preserved
 *     inside the chunk text (no re-write).
 */

import type { ChunkerOptions, FileChunk } from "./types"

const DEFAULT_WINDOW = 50
const DEFAULT_OVERLAP = 20

export interface ChunkInput {
  readonly path: string
  readonly text: string
  readonly mtime: number
  readonly sha: string
}

/** Chunk a file's content into overlapping line windows. */
export const chunkFile = (input: ChunkInput, opts: ChunkerOptions = {}): readonly FileChunk[] => {
  const windowLines = opts.windowLines ?? DEFAULT_WINDOW
  const overlapLines = opts.overlapLines ?? DEFAULT_OVERLAP
  // Closed-form sanity gates. Pure — no throws past the boundary; caller
  // bears the contract.
  if (windowLines <= 0) return []
  if (overlapLines < 0) return []
  if (overlapLines >= windowLines) return []
  if (input.text.length === 0) return []

  const lines = input.text.split("\n")
  // A trailing newline produces an empty terminal element; drop it so the
  // last chunk does not carry a phantom empty line.
  if (lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0) return []

  const step = windowLines - overlapLines
  const out: FileChunk[] = []
  let cursor = 0
  while (cursor < lines.length) {
    const startIdx = cursor
    const endIdx = Math.min(cursor + windowLines, lines.length)
    out.push({
      path: input.path,
      // 1-based inclusive line numbers.
      startLine: startIdx + 1,
      endLine: endIdx,
      text: lines.slice(startIdx, endIdx).join("\n"),
      mtime: input.mtime,
      sha: input.sha,
    })
    if (endIdx >= lines.length) break
    cursor += step
  }
  return out
}

export { DEFAULT_OVERLAP as DEFAULT_OVERLAP_LINES, DEFAULT_WINDOW as DEFAULT_WINDOW_LINES }
