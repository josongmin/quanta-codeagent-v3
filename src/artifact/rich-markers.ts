/**
 * A2 — mermaid + katex inline DETECTION (rich-render markers).
 *
 * The CHEAPEST rich-artifact increment: a PURE, read-only assistant-text
 * post-processor that DETECTS renderable spans (fenced ```mermaid blocks and
 * `$$…$$` display-math) and marks them for a downstream renderer, WITHOUT
 * bundling any heavy renderer (no mermaid.js / KaTeX WASM in this task). It emits
 * a structured segmentation of the text into `text` / `mermaid` / `katex`
 * segments; a surface that can render draws the marked spans, and a text-only
 * surface (CLI) re-joins the ORIGINAL source verbatim (see {@link segmentsToText}).
 *
 * PURE leaf — imports nothing (no clock / RNG / IO). DEFAULT-OFF is enforced by
 * the CALLER (gate on the artifacts capability bit): unset ⇒ the caller never
 * invokes this ⇒ plain text byte-identical. When invoked with no renderable
 * span, {@link detectRichSegments} returns a single `text` segment carrying the
 * source verbatim, so even an always-on caller is text-safe.
 */

/** A detected renderable span, or a plain-text run between/around spans. The
 *  `source` of every segment is the EXACT substring of the input it covers, so
 *  concatenating all `source`s reproduces the input byte-for-byte. For a
 *  `mermaid` / `katex` segment, `body` is the inner payload (the fence/delimiter
 *  stripped) a renderer would consume. */
export interface RichSegment {
  readonly kind: "text" | "mermaid" | "katex"
  /** The exact source substring this segment covers (verbatim, lossless). */
  readonly source: string
  /** Renderable payload for a non-`text` segment (fence/delimiter stripped);
   *  absent on a `text` segment. */
  readonly body?: string
}

/** One detection rule: a global regex whose match[1] capture is the renderable
 *  body. Order matters — the first-registered rule that matches at the earliest
 *  index wins (fenced blocks before inline math). */
interface DetectRule {
  readonly kind: "mermaid" | "katex"
  readonly re: RegExp
}

/** ```mermaid … ``` fenced block. The opening fence tolerates trailing
 *  whitespace on its line; the body is everything up to the closing fence
 *  (non-greedy). `[\s\S]` (not the `s` flag) keeps this portable + explicit. */
const MERMAID_RE = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n?```/g

/** `$$ … $$` DISPLAY math (KaTeX). Non-greedy body; requires a closing `$$`.
 *  Single-`$` inline math is intentionally NOT detected here (too ambiguous
 *  with prose containing a lone `$`); display math is the unambiguous marker. */
const KATEX_RE = /\$\$([\s\S]+?)\$\$/g

const RULES: readonly DetectRule[] = [
  { kind: "mermaid", re: MERMAID_RE },
  { kind: "katex", re: KATEX_RE },
]

interface Hit {
  readonly kind: "mermaid" | "katex"
  readonly start: number
  readonly end: number
  readonly body: string
}

/** Collect every non-overlapping renderable hit, earliest-start-wins. Each rule
 *  is scanned independently; hits are then sorted by start and a hit that
 *  overlaps an already-accepted earlier hit is dropped (e.g. a `$$` inside a
 *  mermaid block never double-marks). */
const collectHits = (text: string): readonly Hit[] => {
  const raw: Hit[] = []
  for (const rule of RULES) {
    // Fresh lastIndex per call — the module-level regexes are stateful.
    rule.re.lastIndex = 0
    for (let m = rule.re.exec(text); m !== null; m = rule.re.exec(text)) {
      raw.push({ kind: rule.kind, start: m.index, end: m.index + m[0].length, body: m[1] ?? "" })
      // Guard against a zero-width match looping forever.
      if (m[0].length === 0) rule.re.lastIndex += 1
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const accepted: Hit[] = []
  let cursor = 0
  for (const hit of raw) {
    if (hit.start < cursor) continue
    accepted.push(hit)
    cursor = hit.end
  }
  return accepted
}

/**
 * Segment assistant text into plain-text runs + detected renderable spans.
 * LOSSLESS: `detectRichSegments(t).map(s => s.source).join("") === t` for ALL
 * `t`. When nothing renderable is present, returns a single `text` segment
 * carrying `t` verbatim (never an empty array — so a caller can always re-join).
 */
export const detectRichSegments = (text: string): readonly RichSegment[] => {
  const hits = collectHits(text)
  if (hits.length === 0) return [{ kind: "text", source: text }]
  const out: RichSegment[] = []
  let idx = 0
  for (const hit of hits) {
    if (hit.start > idx) out.push({ kind: "text", source: text.slice(idx, hit.start) })
    out.push({ kind: hit.kind, source: text.slice(hit.start, hit.end), body: hit.body })
    idx = hit.end
  }
  if (idx < text.length) out.push({ kind: "text", source: text.slice(idx) })
  return out
}

/** Re-join segments to the ORIGINAL source text (the CLI text-safe passthrough).
 *  Byte-identical to the input of {@link detectRichSegments}. */
export const segmentsToText = (segments: readonly RichSegment[]): string =>
  segments.map((s) => s.source).join("")

/** True iff the text contains at least one renderable (mermaid/katex) span. A
 *  cheap gate for a caller that only wants to KNOW whether to bother segmenting. */
export const hasRichSegments = (text: string): boolean => collectHits(text).length > 0

/**
 * CAPABILITY-GATED segmentation. When `enabled` is false (the artifacts
 * capability bit is unset — no Canvas store), returns a SINGLE verbatim `text`
 * segment WITHOUT scanning, so a surface that always calls this is plain-text
 * byte-identical to the pre-A2 behaviour. When true, delegates to
 * {@link detectRichSegments}. The gate lives HERE (not only at the caller) so the
 * default-OFF guarantee is enforced at the one seam every surface shares.
 */
export const detectRichSegmentsGated = (text: string, enabled: boolean): readonly RichSegment[] =>
  enabled ? detectRichSegments(text) : [{ kind: "text", source: text }]
