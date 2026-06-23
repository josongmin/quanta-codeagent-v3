/** jun-6 — paste-burst coalescing types + pure display projection, extracted
 *  from `raw-line-reader.ts`. `pasteBurstPlaceholder` and `projectPasteDisplay`
 *  are part of the reader's public surface and are re-exported from the parent
 *  module so importers stay byte-compatible. */

/** jun-6 — paste-burst coalescing config (closed-port DI; the slice never reads
 *  env). `minChars` is the inclusive threshold: a single keypress carrying ≥
 *  this many chars is collapsed to a placeholder on echo. */
export interface PasteBurstOptions {
  readonly minChars: number
}

/** jun-6 — a recorded paste segment. `text` is the EXACT pasted substring (the
 *  source of truth lives in `buf`); `placeholder` is the `[Pasted Content <n>
 *  chars]` echo shown in its place. Display rendering replaces the first
 *  occurrence of `text` in `buf` with `placeholder`; submission ignores this
 *  list entirely (the buffer is already the full text). */
export interface PasteSegment {
  readonly text: string
  readonly placeholder: string
}

/** jun-6 — render the placeholder for a pasted blob of `n` chars. Pure; the
 *  exact wording mirrors the Codex CLI ("[Pasted Content <n> chars]"). */
export const pasteBurstPlaceholder = (n: number): string => `[Pasted Content ${n} chars]`

/** jun-6 — project `buf` to its echo form by collapsing each recorded paste
 *  segment to its placeholder (first occurrence, left-to-right). Pure: returns
 *  `buf` unchanged when there are no segments (so the OFF / no-paste path is
 *  byte-identical). A segment whose text is no longer present (the user edited
 *  across it) is skipped — the raw chars then show, never a crash. */
export const projectPasteDisplay = (buf: string, segments: readonly PasteSegment[]): string => {
  if (segments.length === 0) return buf
  let out = ""
  let rest = buf
  // Replace each segment's text in document order. Pastes are large unique
  // blobs, so a left-to-right first-occurrence replace is unambiguous.
  const ordered = [...segments].sort((a, b) => buf.indexOf(a.text) - buf.indexOf(b.text))
  for (const seg of ordered) {
    const at = rest.indexOf(seg.text)
    if (at < 0) continue // edited away — leave the raw chars in place
    out += rest.slice(0, at) + seg.placeholder
    rest = rest.slice(at + seg.text.length)
  }
  return out + rest
}
