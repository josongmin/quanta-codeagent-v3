/**
 * Pure comment-scanner (ADR-0250).
 *
 * Given a file body and a list of marker substrings, return one
 * {@link TriggerEvent} per (file, marker) where the marker is found.
 *
 * The scanner is intentionally TINY — no regex, no escape handling, no
 * comment-syntax awareness. The marker is a literal substring; the
 * caller chooses something unique enough to avoid collision with real
 * code comments (Aider's `AI!` / Cursor's `// fix this AI`).
 *
 * Returns the FIRST line of each marker's first occurrence (1-based).
 * If the same marker appears on multiple lines we still emit ONE event
 * — the host can re-scan the file on a follow-up turn if it wants the
 * full list. This mirrors the sibling watcher's `findMarkerLine` shape
 * (single hit per marker, 1-based line).
 *
 * Empty markers ('') are skipped — they would match every position.
 * Duplicate markers in the list are de-duplicated by first occurrence.
 *
 * Pure: no I/O, no globals, deterministic on input.
 */

import type { TriggerEvent } from "./types"

/** 1-based line number of the first occurrence of `marker` in `body`, or -1. */
const findMarkerLine = (body: string, marker: string): number => {
  if (marker === "") return -1
  const idx = body.indexOf(marker)
  if (idx === -1) return -1
  let line = 1
  for (let i = 0; i < idx; i++) {
    if (body[i] === "\n") line++
  }
  return line
}

/**
 * Scan `content` for each marker in `markers`. Returns one event per
 * marker that hit, in the ORDER the markers appear in the input list
 * (so the caller can rely on stable priority — first marker wins for
 * downstream routing).
 *
 * `file` is the absolute path the events should carry (the scanner
 * never reads disk — the caller supplies the bytes).
 */
export const scanFile = (
  file: string,
  content: string,
  markers: readonly string[],
): TriggerEvent[] => {
  const out: TriggerEvent[] = []
  const seen = new Set<string>()
  for (const marker of markers) {
    if (seen.has(marker)) continue
    seen.add(marker)
    const line = findMarkerLine(content, marker)
    if (line === -1) continue
    out.push({ file, marker, line })
  }
  return out
}

/** Re-export the line helper — the hellgate uses it for HELL-IT-06. */
export { findMarkerLine }
