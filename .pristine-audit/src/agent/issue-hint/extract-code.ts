/**
 * Code-fence and traceback-path extraction.
 *
 * Two separate signals share a file because both are "structured code regions":
 *
 *   - **codeFences**: triple-backtick blocks ` ```lang ... ``` `. We keep the
 *     body **VERBATIM** (callers may want to do their own scan over it). Empty
 *     bodies (whitespace-only) are dropped. Per-body cap is 4 KiB with a
 *     head+tail compression (head + "\n…\n" + last 10 non-empty lines) so
 *     when a fence overflows, the most localization-relevant lines — the ones
 *     at the end of the snippet (commonly the exception, the wrong result,
 *     or the final assertion) — survive intact. The overflow policy is OWNED
 *     by the shared `budget-collector.ts` (one collector decides head/tail
 *     reservation once); `extractCodeFenceSegments` surfaces the overflow as
 *     OBSERVABLE metadata, and `extractCodeFences` projects to body strings.
 *
 *   - **tracebackPaths**: file:line pairs parsed from two common traceback
 *     formats:
 *       * Python:  `File "requests/models.py", line 401`
 *       * TS/JS:   `at frameName (path/file.ts:42:7)`
 *     We emit `path:line` (no col) for byte-stable output. Note: full
 *     verbatim traceback BLOCKS now live in `extract-tracebacks.ts`; this
 *     extractor is the legacy file:line path that the existing wiring
 *     consumers still call.
 *
 * Both signals are deduped; codeFences preserves authoring order (sometimes
 * meaningful, e.g. "repro" before "traceback"), tracebackPaths are sorted
 * unique.
 *
 * Traceback scanning strips ANSI before matching (paste-from-terminal safety);
 * code fences do NOT strip ANSI — the body is preserved verbatim because
 * downstream callers may want the original (it could be a legitimate part of
 * a coded example).
 */
import { type BudgetOverflow, type BudgetSegment, collectBudgeted } from "./budget-collector"
import { stripAnsi } from "./normalize"

const MAX_FENCE_BYTES = 4 * 1024
const FENCE_TAIL_LINES = 10
const FENCE_ELLIPSIS = "\n…\n"
const MAX_PATH_LEN = 200

/** Triple-backtick fence with optional language tag. Lazy body so consecutive
 *  fences don't merge. Accepts `\r\n` or `\n` line endings — GitHub issue
 *  bodies often arrive with CRLF. We capture the body (group 1). */
const FENCE_RE = /```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)```/g

/** Python `File "…", line N` — the path inside the quotes is what we want. */
const PY_TB_RE = /File\s+"([^"\n]+)",\s+line\s+(\d+)/g

/** Generic stack `at frame (path:line:col)` — captures path, line, col. We
 *  emit only path:line. */
const STACK_RE = /\bat\s+[\w.$<>]+\s*\(([^)\n]+?):(\d+)(?::\d+)?\)/g

/** Head + tail compression for over-cap fence bodies. Delegates to the shared
 *  budget collector (`budget-collector.ts`) — the SINGLE owner of the overflow
 *  policy that both this extractor and the traceback extractor share. The
 *  collector reserves the tail FIRST so the final lines (commonly the
 *  exception / wrong result / final assertion) ALWAYS survive, even when the
 *  tail alone would have exhausted the budget (the former C-11 tail-drop bug). */
const compressFence = (body: string): BudgetSegment =>
  collectBudgeted(body, {
    maxBytes: MAX_FENCE_BYTES,
    tailLines: FENCE_TAIL_LINES,
    ellipsis: FENCE_ELLIPSIS,
  })

/** A code fence with its (possibly compacted) verbatim body and an OBSERVABLE
 *  `overflow` record — `null` when the body fit, populated when compaction
 *  fired. Lets downstream consumers tell that the head/middle was elided
 *  instead of inferring it from the `…` glyph. */
export interface CodeFenceSegment {
  readonly body: string
  readonly overflow: BudgetOverflow | null
}

/** Extract code fences WITH observable overflow metadata. The string-only
 *  `extractCodeFences` is a thin projection of this (`.body`), kept for the
 *  many callers and the `IssueHint.codeFences` shape that expect `string[]`. */
export const extractCodeFenceSegments = (text: string): readonly CodeFenceSegment[] => {
  if (typeof text !== "string" || text === "") return []
  const out: CodeFenceSegment[] = []
  const seen = new Set<string>()
  FENCE_RE.lastIndex = 0
  for (const m of text.matchAll(FENCE_RE)) {
    const body = m[1]
    if (typeof body !== "string") continue
    const trimmed = body.replace(/\s+$/g, "") // strip trailing whitespace only
    if (trimmed.trim() === "") continue
    const seg = compressFence(trimmed)
    if (seen.has(seg.text)) continue
    seen.add(seg.text)
    out.push({ body: seg.text, overflow: seg.overflow })
  }
  return out
}

export const extractCodeFences = (text: string): readonly string[] =>
  extractCodeFenceSegments(text).map((s) => s.body)

const acceptTbEntry = (
  rawPath: string | undefined,
  line: string | undefined,
  found: Set<string>,
): void => {
  if (typeof rawPath !== "string" || typeof line !== "string") return
  const trimmed = rawPath.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_PATH_LEN) return
  found.add(`${trimmed}:${line}`)
}

export const extractTracebackPaths = (text: string): readonly string[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const found = new Set<string>()
  PY_TB_RE.lastIndex = 0
  for (const m of cleaned.matchAll(PY_TB_RE)) acceptTbEntry(m[1], m[2], found)
  STACK_RE.lastIndex = 0
  for (const m of cleaned.matchAll(STACK_RE)) acceptTbEntry(m[1], m[2], found)
  return Array.from(found).sort()
}
