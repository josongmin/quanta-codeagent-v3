/**
 * Outline / skeleton render (RFC jun-6-syntax-aware-chunking §4.4).
 *
 * Collapses a parsed file to its SIGNATURES + structure: each decl's
 * header line(s) verbatim, its body replaced by a single `// … (<N> lines)`
 * indicator, recursing into nested decls (a class emits `class Foo {`, each
 * method signature + `// …`, then `}`). Sized to a char budget so a huge
 * file collapses to a bounded skeleton — "read a 2000-line file for a
 * fraction of the tokens."
 *
 * Pure: no clock, no randomness, no I/O. Deterministic (SOURCE order, no
 * ranking). Surrogate-safe: all cuts are on whole lines (split on `\n`),
 * NEVER mid-line and NEVER inside a UTF-16 surrogate pair — the budget cut
 * happens at a decl boundary, so a lone surrogate in a signature can never be
 * sliced.
 */

import type { DeclNode, ParsedFile } from "@/retrieval/code-parser"

const DEFAULT_BUDGET = 4000

/** Push the verbatim signature lines [startLine .. signatureEndLine]. Returns
 *  the resolved (clamped) signature end line for the caller's body math. */
const pushSignature = (decl: DeclNode, srcLines: readonly string[], out: string[]): number => {
  const sigStart = Math.max(1, decl.startLine)
  const sigEnd = Math.max(sigStart, Math.min(decl.signatureEndLine, srcLines.length))
  for (let ln = sigStart; ln <= sigEnd; ln++) {
    const line = srcLines[ln - 1]
    if (line !== undefined) out.push(line)
  }
  return sigEnd
}

/** Push the `// … (<N> lines)` body indicator for a LEAF decl (none if the
 *  decl has no body). Indent mirrors the signature's leading whitespace. */
const pushBodyIndicator = (decl: DeclNode, srcLines: readonly string[], out: string[]): void => {
  const bodyLines = decl.endLine - decl.signatureEndLine
  if (bodyLines <= 0) return
  const sigText = srcLines[Math.max(0, decl.startLine - 1)] ?? ""
  const indentMatch = /^[ \t]*/.exec(sigText)
  const indent = indentMatch ? indentMatch[0] : ""
  out.push(`${indent}  // … (${bodyLines} ${bodyLines === 1 ? "line" : "lines"})`)
}

/** Render one decl (recursively) into outline lines. Containers emit their
 *  header, each child's outline, and the closing line; leaves emit their
 *  signature + a body indicator. Surrogate-safe (whole-line operations). */
const renderDecl = (decl: DeclNode, srcLines: readonly string[], out: string[]): void => {
  const sigEnd = pushSignature(decl, srcLines, out)
  if (decl.children.length === 0) {
    pushBodyIndicator(decl, srcLines, out)
    return
  }
  // Container: each child's outline, then the closing line (typically `}`).
  const sorted = [...decl.children].sort((a, b) => a.startLine - b.startLine)
  for (const child of sorted) renderDecl(child, srcLines, out)
  const closeLn = Math.min(decl.endLine, srcLines.length)
  if (closeLn > sigEnd) {
    const closeLine = srcLines[closeLn - 1]
    if (closeLine !== undefined) out.push(closeLine)
  }
}

/**
 * Render the collapsed outline of `parsed` over `text`, capped at `budget`
 * chars. When the running size would exceed the budget AFTER a top-level
 * decl, stop and append a `// … (<K> more declarations elided)` marker.
 *
 * @returns the outline string. NEVER throws.
 */
export const renderOutline = (
  text: string,
  parsed: ParsedFile,
  budget: number = DEFAULT_BUDGET,
): string => {
  const srcLines = text.split("\n")
  const decls = [...parsed.decls].sort((a, b) => a.startLine - b.startLine)
  if (decls.length === 0) return "(no declarations)"

  const pieces: string[] = []
  let size = 0
  let rendered = 0
  for (let i = 0; i < decls.length; i++) {
    const decl = decls[i]
    if (decl === undefined) continue
    const declLines: string[] = []
    renderDecl(decl, srcLines, declLines)
    const block = declLines.join("\n")
    // Budget cut happens at a DECL boundary (whole-line, surrogate-safe). The
    // first decl always renders so a tiny budget still produces a useful head.
    const projected = size + (pieces.length > 0 ? 1 : 0) + block.length
    if (rendered > 0 && projected > budget) {
      pieces.push(`// … (${decls.length - i} more declarations elided)`)
      return pieces.join("\n")
    }
    pieces.push(block)
    size = projected
    rendered += 1
  }
  return pieces.join("\n")
}

export { DEFAULT_BUDGET as DEFAULT_OUTLINE_BUDGET }
