/**
 * Traceback block VERBATIM extraction (Python-specific).
 *
 * Two facets share this slice:
 *   - **traceback BLOCKS** — full Python `Traceback (most recent call last):`
 *     through to blank line / end. The body is preserved verbatim because the
 *     model (per Agentless §3.1) makes better reproduction-test decisions when
 *     it sees the actual exception line rather than just file:line pairs.
 *   - **head + tail cap** — when a single block exceeds 4 KiB we keep the
 *     head + a `\n…\n` ellipsis + the last 10 non-empty lines. Why "last 10":
 *     the exception type + message + the closest user-frame are the lines that
 *     actually drive localization; the middle of a deep call stack rarely does.
 *
 * JS/Java/Rust traceback formats are NOT block-extracted here — only
 * `tracebackPaths` (file:line pairs) covers them. The decision is conservative:
 * those formats have higher false-positive risk for block boundaries and the
 * paper's SWE-bench Python corpus doesn't motivate the work.
 *
 * Hardening:
 *   - ANSI escape codes stripped before scanning (paste-from-terminal safety)
 *   - block capped at 4 KiB with head + tail policy (never silently truncated)
 *   - duplicates (same verbatim body) deduped, authoring order preserved
 *   - input scanned in a single pass — no quadratic backtracking
 */
import { stripAnsi } from "./normalize"

const MAX_BLOCK_BYTES = 4 * 1024
const TAIL_LINES = 10

/** Anchor: the literal Python traceback header. Capture group 1 is the
 *  block body INCLUDING the header through the next blank line OR end of
 *  input. Lazy match `[\s\S]*?` plus the alternation `(?=\n\s*\n|$)` keeps
 *  consecutive tracebacks from merging. */
const TB_BLOCK_RE = /(Traceback \(most recent call last\):[\s\S]*?)(?=\n\s*\n|$)/g

/** Head + tail compression for over-cap blocks. We keep the entire prefix up
 *  to `MAX_BLOCK_BYTES - tailBytes - ellipsisLen` then "\n…\n" then the last
 *  `TAIL_LINES` non-empty lines (the exception summary always sits at the
 *  end of a Python traceback). */
const compress = (block: string): string => {
  if (block.length <= MAX_BLOCK_BYTES) return block
  const lines = block.split("\n")
  // Walk from the end collecting up to TAIL_LINES non-empty lines.
  const tail: string[] = []
  for (let i = lines.length - 1; i >= 0 && tail.length < TAIL_LINES; i--) {
    const line = lines[i]
    if (line === undefined) continue
    if (line.trim() === "") continue
    tail.unshift(line)
  }
  const tailText = tail.join("\n")
  const ellipsis = "\n…\n"
  // Budget for head = MAX - len(tailText) - len(ellipsis)
  const headBudget = MAX_BLOCK_BYTES - tailText.length - ellipsis.length
  if (headBudget <= 0) {
    // Edge case: tail alone exceeds the cap (pathological — single 4KB line).
    // Fall back to a hard head slice + ellipsis.
    return `${block.slice(0, MAX_BLOCK_BYTES - ellipsis.length)}${ellipsis}`
  }
  const head = block.slice(0, headBudget)
  return `${head}${ellipsis}${tailText}`
}

export const extractTracebacks = (text: string): readonly string[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const out: string[] = []
  const seen = new Set<string>()
  TB_BLOCK_RE.lastIndex = 0
  for (const m of cleaned.matchAll(TB_BLOCK_RE)) {
    const body = m[1]
    if (typeof body !== "string") continue
    const trimmed = body.replace(/\s+$/g, "")
    if (trimmed.length === 0) continue
    const compressed = compress(trimmed)
    if (seen.has(compressed)) continue
    seen.add(compressed)
    out.push(compressed)
  }
  return out
}
