/**
 * One budgeted head/tail segment collector shared by the two verbatim-evidence
 * extractors (`extract-code.ts` code fences, `extract-tracebacks.ts` Python
 * traceback blocks).
 *
 * THE OWNING SEAM (T05A / audit L3 C-11/C-12)
 * ===========================================
 * Both extractors carry the same contract: when a verbatim body exceeds a byte
 * budget, keep the **head** plus an ellipsis plus the **tail** (the last N
 * non-empty lines). The tail is the highest-signal region — it holds the
 * exception type, the wrong result, or the final assertion that actually drives
 * localization.
 *
 * Previously each extractor inlined its own `compress` with the SAME latent
 * bug: when the *tail alone* met or exceeded the budget, the fallback returned
 * `head + ellipsis` and **silently dropped the tail** — losing exactly the line
 * that matters most, in exactly the case where the body is largest. Two copies
 * of the policy meant two copies of the bug (G2: "if the same bug exists via
 * two adapters, the port is wrong").
 *
 * This module is that port. It decides head/tail reservation ONCE and is the
 * single source of the overflow policy:
 *
 *   1. Tail is reserved FIRST (it is load-bearing). Up to `tailLines` non-empty
 *      lines from the end are kept, joined with `\n`.
 *   2. If the tail itself exceeds the budget (pathological — a single enormous
 *      final line), the tail is kept by trimming it from the FRONT to
 *      `maxBytes - ellipsis.length`, never dropped. The ellipsis still precedes
 *      it so the truncation is visible.
 *   3. Otherwise the head fills the remaining budget
 *      (`maxBytes - ellipsis.length - tail.length`), then ellipsis, then tail.
 *
 * Overflow is OBSERVABLE: `collectBudgeted` returns a `BudgetSegment` whose
 * `overflow` field is `null` when the body fit, or a populated `BudgetOverflow`
 * describing the compaction (original byte length, retained head/tail byte
 * counts, dropped middle byte count, retained tail line count). Downstream
 * consumers can tell compaction occurred instead of guessing from a `…` glyph.
 *
 * Pure: no I/O, deterministic on input. The collector does NOT strip ANSI or
 * parse anything — callers pre-process (e.g. ANSI strip for tracebacks) and
 * pass an already-bounded verbatim body. The ellipsis marker is a parameter so
 * both extractors keep their established byte-identical `"\n…\n"` separator.
 */

/** Observable record of a compaction event. `null`-typed sibling is the
 *  "no overflow" signal returned inline. */
export interface BudgetOverflow {
  /** Byte length (`String#length`, UTF-16 code units) of the original body
   *  before compaction. */
  readonly originalLength: number
  /** Byte length of the retained head slice (may be 0 when the tail consumes
   *  the whole budget). */
  readonly headLength: number
  /** Byte length of the retained tail text — ALWAYS > 0 when overflow fired
   *  (the tail is never dropped). */
  readonly tailLength: number
  /** Byte length of the dropped middle region
   *  (`originalLength - headLength - tailLength`, never negative). */
  readonly droppedLength: number
  /** Number of non-empty tail lines retained (≤ the requested `tailLines`). */
  readonly tailLines: number
}

/** A budgeted segment: the (possibly compacted) `text` plus an OBSERVABLE
 *  `overflow` record (`null` when the body fit within budget). */
export interface BudgetSegment {
  readonly text: string
  readonly overflow: BudgetOverflow | null
}

export interface BudgetOptions {
  /** Hard ceiling on the returned `text` byte length. */
  readonly maxBytes: number
  /** Number of trailing non-empty lines to reserve as the high-signal tail. */
  readonly tailLines: number
  /** Separator inserted between head and tail when compaction fires. Both
   *  extractors use `"\n…\n"`; passed in so the collector owns no policy on
   *  the marker glyph itself. */
  readonly ellipsis: string
}

/** Collect up to `tailLines` non-empty lines from the END of `lines`, in
 *  source order. Walks backward so the most recent (closest-to-exception)
 *  lines win when the budget can't hold all `tailLines`. */
const collectTail = (lines: readonly string[], tailLines: number): string[] => {
  const tail: string[] = []
  for (let i = lines.length - 1; i >= 0 && tail.length < tailLines; i--) {
    const line = lines[i]
    if (line === undefined) continue
    if (line.trim() === "") continue
    tail.unshift(line)
  }
  return tail
}

/**
 * Budget a single verbatim body to `maxBytes`, preserving the high-signal tail.
 *
 * Returns the body unchanged with `overflow: null` when it already fits. When
 * it overflows, returns `head + ellipsis + tail` (tail ALWAYS present) and a
 * populated `overflow` record.
 */
export const collectBudgeted = (body: string, opts: BudgetOptions): BudgetSegment => {
  const { maxBytes, tailLines, ellipsis } = opts
  if (body.length <= maxBytes) {
    return { text: body, overflow: null }
  }

  const lines = body.split("\n")
  const tail = collectTail(lines, tailLines)
  let tailText = tail.join("\n")
  let retainedTailLines = tail.length

  // Reserve the tail first; the head fills whatever budget remains.
  const ellipsisLen = ellipsis.length
  const headBudget = maxBytes - ellipsisLen - tailText.length

  if (headBudget > 0) {
    const head = body.slice(0, headBudget)
    const text = `${head}${ellipsis}${tailText}`
    return {
      text,
      overflow: {
        originalLength: body.length,
        headLength: head.length,
        tailLength: tailText.length,
        droppedLength: body.length - head.length - tailText.length,
        tailLines: retainedTailLines,
      },
    }
  }

  // Pathological: the reserved tail alone meets/exceeds the budget. Keep the
  // tail (it is load-bearing) by trimming it from the FRONT to fit, with NO
  // head. We never drop the tail — that was the C-11/C-12 bug. The ellipsis
  // still precedes the tail so the truncation stays visible.
  const tailRoom = maxBytes - ellipsisLen
  if (tailRoom <= 0) {
    // Degenerate budget (smaller than the marker itself): emit the marker's
    // best-effort tail slice. Still tail-biased, never head-only.
    const text = tailText.slice(Math.max(0, tailText.length - maxBytes))
    return {
      text,
      overflow: {
        originalLength: body.length,
        headLength: 0,
        tailLength: text.length,
        droppedLength: body.length - text.length,
        tailLines: retainedTailLines,
      },
    }
  }
  // Keep the trailing `tailRoom` bytes of the tail (closest to the exception).
  tailText = tailText.slice(Math.max(0, tailText.length - tailRoom))
  // Re-derive how many whole non-empty lines actually survived the front trim.
  retainedTailLines = tailText.split("\n").filter((l) => l.trim() !== "").length
  const text = `${ellipsis}${tailText}`
  return {
    text,
    overflow: {
      originalLength: body.length,
      headLength: 0,
      tailLength: tailText.length,
      droppedLength: body.length - tailText.length,
      tailLines: retainedTailLines,
    },
  }
}
