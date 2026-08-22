/**
 * D2 — `BoundedBuffer` (jun-7-naive-impl-hardening §2.2).
 *
 * WHY THIS EXISTS — `bash-bg-registry.ts` accumulated background-shell output
 * with `handle.stdout += chunk` / `handle.stderr += chunk`, which has NO
 * per-handle byte cap. The LRU (`DEFAULT_MAX_BG_SHELLS`) caps the NUMBER of
 * shells, not the SIZE of one — so a single `tail -f` / `yes` / chatty dev
 * server grows the accumulator without bound until the agent OOMs (and the LRU
 * never evicts the newest entry). Codex caps the accumulator itself
 * (`max_output_tokens`), not just the rendered view.
 *
 * POLICY SOURCE — this mirrors the FOREGROUND `capToolOutput`
 * (`src/tool/output-spill.ts`) EXACTLY: keep the output VERBATIM while it is at
 * or under the `maxBytes` budget (the registry passes the same
 * 200K budget — see `DEFAULT_TOOL_OUTPUT_MAX`); only ONCE it exceeds that budget
 * do we elide the middle, keeping an 8k HEAD (what the command was doing) + a
 * 4k TAIL (errors / exit summaries surface last) with a
 * `…(+N bytes elided)…` marker. We deliberately do NOT import across the
 * `@/runtime` ↔ `@/tool` slice fence; the split is trivial, so it is
 * re-implemented here with named consts that cite that policy source. This
 * keeps the ADR-0411 contract (a background COMPLETED result under budget is
 * preserved in full) while bounding the unbounded-stream OOM.
 *
 * MEMORY — even under the budget the retained string is O(maxBytes): once an
 * append would push the retained string past the budget we compact it down to
 * `head + tail`, folding the elided middle into a `dropped` counter. So a 10MB
 * stream never retains 10MB.
 *
 * SURROGATE-SAFE — the head/tail cuts never split a UTF-16 surrogate pair
 * (jun-06-permanent-guards). NO-THROW — `append`/`value`/`droppedBytes` never
 * throw; this feeds a background accumulator that must never crash the bash
 * tool's result.
 */

/** Head retained once over budget — mirrors `capToolOutput` HEAD_CHARS (8k). */
export const BOUNDED_BUFFER_HEAD_CHARS = 8_000

/** Tail retained once over budget — mirrors `capToolOutput` TAIL_CHARS (4k). */
export const BOUNDED_BUFFER_TAIL_CHARS = 4_000

export interface BoundedBuffer {
  /** Append a chunk of already-decoded text. Cheap; under budget it just
   *  concatenates, over budget it maintains the head + rolling tail. */
  append(chunk: string): void
  /** Render the bounded view: at/under budget ⇒ verbatim; over budget ⇒
   *  `head + "…(+N bytes elided)…" + tail`. */
  value(): string
  /** Total chars elided from the middle (0 while at/under budget). */
  droppedBytes(): number
}

/** True iff `code` is a UTF-16 high surrogate (the FIRST unit of a pair). */
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** Slice `[0, end)` but never end ON a lone high surrogate — back off one unit
 *  so the pair stays whole (the low surrogate moves to the elided middle). */
const safeHeadSlice = (s: string, end: number): string => {
  if (end <= 0) return ""
  if (end >= s.length) return s
  const cut = isHighSurrogate(s.charCodeAt(end - 1)) ? end - 1 : end
  return s.slice(0, cut)
}

/** Slice from `start` but never start ON a lone low surrogate — advance one
 *  unit so the preceding high surrogate (now elided) is not orphaned. */
const safeTailSlice = (s: string, start: number): string => {
  if (start <= 0) return s
  if (start >= s.length) return ""
  const code = s.charCodeAt(start)
  const isLow = code >= 0xdc00 && code <= 0xdfff
  const from = isLow ? start + 1 : start
  return s.slice(from)
}

/**
 * Build a head+tail bounded buffer with a VERBATIM budget of `maxBytes`.
 *
 * Phases:
 *  - UNDER budget: keep the whole string in `head` (no tail, no drop) — a
 *    completed result that fits the budget is returned byte-identical.
 *  - The append that crosses the budget freezes `head` at the 8k head cap
 *    (surrogate-safe) and starts a rolling 4k `tail`, counting the elided
 *    middle. From here memory is O(head + tail), not O(stream).
 */
export const createBoundedBuffer = (maxBytes: number): BoundedBuffer => {
  const headCap = Math.min(BOUNDED_BUFFER_HEAD_CHARS, maxBytes)
  const tailCap = Math.max(0, Math.min(BOUNDED_BUFFER_TAIL_CHARS, maxBytes - headCap))

  // Phase 1 (under budget): `head` holds the FULL string verbatim, `over` false.
  // Phase 2 (over budget): `head` frozen at headCap, `tail` is the rolling
  // window, `dropped` counts the elided middle.
  let head = ""
  let tail = ""
  let dropped = 0
  let over = false

  const startEliding = (full: string): void => {
    over = true
    const frozenHead = safeHeadSlice(full, headCap)
    head = frozenHead
    const rest = full.slice(frozenHead.length)
    tail = ""
    appendToTail(rest)
  }

  // Append into the rolling tail, evicting the oldest chars (counted as
  // dropped) so the tail never exceeds tailCap. Surrogate-safe at eviction.
  const appendToTail = (chunk: string): void => {
    if (tailCap === 0) {
      dropped += chunk.length
      return
    }
    const merged = tail + chunk
    if (merged.length <= tailCap) {
      tail = merged
      return
    }
    const cutAt = merged.length - tailCap
    const kept = safeTailSlice(merged, cutAt)
    dropped += merged.length - kept.length
    tail = kept
  }

  const append = (chunk: string): void => {
    if (chunk.length === 0) return
    if (over) {
      appendToTail(chunk)
      return
    }
    // Still under budget — concatenate into head until it would cross.
    if (head.length + chunk.length <= maxBytes) {
      head += chunk
      return
    }
    // This append crosses the budget: switch to head+tail elision mode.
    startEliding(head + chunk)
  }

  const value = (): string => {
    if (!over) return head
    return `${head}…(+${dropped} bytes elided)…${tail}`
  }

  return {
    append,
    value,
    droppedBytes: () => dropped,
  }
}
