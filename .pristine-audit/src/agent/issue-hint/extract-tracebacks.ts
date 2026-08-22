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
 *     The cap policy is OWNED by the shared `budget-collector.ts` (the same
 *     collector the code-fence extractor uses) so there is ONE head/tail
 *     reservation decision, not two opportunistic truncations. The tail is
 *     reserved FIRST and NEVER dropped — even when the tail alone would have
 *     exhausted the budget (the former C-12 tail-drop bug).
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
import { type BudgetOverflow, type BudgetSegment, collectBudgeted } from "./budget-collector"
import { stripAnsi } from "./normalize"

const MAX_BLOCK_BYTES = 4 * 1024
const TAIL_LINES = 10
const TB_ELLIPSIS = "\n…\n"

/** Anchor: the literal Python traceback header. Capture group 1 is the
 *  block body INCLUDING the header through the next blank line OR end of
 *  input. Lazy match `[\s\S]*?` plus the alternation `(?=\n\s*\n|$)` keeps
 *  consecutive tracebacks from merging. */
const TB_BLOCK_RE = /(Traceback \(most recent call last\):[\s\S]*?)(?=\n\s*\n|$)/g

/** Head + tail compression for over-cap blocks. Delegates to the shared budget
 *  collector (`budget-collector.ts`) — the SAME owner the code-fence extractor
 *  uses. The collector reserves the tail FIRST (the exception summary always
 *  sits at the end of a Python traceback) so it is NEVER dropped, even in the
 *  pathological case where the tail alone exhausts the budget (former C-12). */
const compress = (block: string): BudgetSegment =>
  collectBudgeted(block, {
    maxBytes: MAX_BLOCK_BYTES,
    tailLines: TAIL_LINES,
    ellipsis: TB_ELLIPSIS,
  })

/** A traceback block with its (possibly compacted) verbatim body and an
 *  OBSERVABLE `overflow` record — `null` when the block fit, populated when
 *  compaction fired. Surfaces compaction to downstream consumers rather than
 *  hiding it behind the `…` glyph. */
export interface TracebackSegment {
  readonly body: string
  readonly overflow: BudgetOverflow | null
}

/** Extract traceback blocks WITH observable overflow metadata. The string-only
 *  `extractTracebacks` is a thin projection of this (`.body`), kept for the
 *  `IssueHint.tracebacks` shape and existing callers that expect `string[]`. */
export const extractTracebackSegments = (text: string): readonly TracebackSegment[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const out: TracebackSegment[] = []
  const seen = new Set<string>()
  TB_BLOCK_RE.lastIndex = 0
  for (const m of cleaned.matchAll(TB_BLOCK_RE)) {
    const body = m[1]
    if (typeof body !== "string") continue
    const trimmed = body.replace(/\s+$/g, "")
    if (trimmed.length === 0) continue
    const seg = compress(trimmed)
    if (seen.has(seg.text)) continue
    seen.add(seg.text)
    out.push({ body: seg.text, overflow: seg.overflow })
  }
  return out
}

export const extractTracebacks = (text: string): readonly string[] =>
  extractTracebackSegments(text).map((s) => s.body)
