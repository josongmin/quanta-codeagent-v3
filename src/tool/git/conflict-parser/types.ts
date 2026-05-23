/**
 * Pure git merge-conflict parser — typed contract (ADR-0111, fix-merge-conflicts
 * skill prerequisite).
 *
 * # Contract (mirrored verbatim from the parser-slice spec)
 *
 * 1. **Pure.** No I/O, no `Buffer`, no `child_process`. Input: `string` (entire
 *    file contents). Output: typed {@link ConflictParseResult}. The parser does
 *    NOT consult the filesystem to verify a conflict is real — caller's concern.
 *
 * 2. **No-throw.** Malformed conflicts → typed {@link ConflictParseDiagnostic} on
 *    the result, NEVER thrown. ONLY thrown: {@link ConflictParserInputError}
 *    when input isn't a string (programmer bug).
 *
 * 3. **exactOptionalPropertyTypes.** Optional fields (`base`, `baseLabel`) are
 *    OMITTED, never `undefined`. Construction uses condition-spread.
 *
 * 4. **Plane-clean.** Imports only `@/shared` (for the {@link QuantaError}
 *    base). Zero `@/agent`, `@/tool`, `@/permission` deps.
 *
 * 5. **Segment-anchored markers.** A marker is recognised ONLY at column 0.
 *    A literal `<<<<<<< ` inside a string-literal or comment WILL match — the
 *    parser is NOT a language tokenizer (documented limitation).
 */

import { QuantaError } from "@/shared"

/** Closed union of marker styles. `diff3` is reserved for a future
 *  verbose-merge-base heuristic; today the parser emits `"two-way"` or
 *  `"three-way"` only. The literal is in the union so callers that branch on
 *  `merge.conflictStyle = diff3` keep a stable vocabulary without a future
 *  breaking change. */
export type ConflictMarkerStyle = "two-way" | "three-way" | "diff3"

/** Runtime mirror of the union for exhaustive-coverage assertions. */
export const ALL_MARKER_STYLES: ReadonlyArray<ConflictMarkerStyle> = [
  "two-way",
  "three-way",
  "diff3",
]

/** One parsed conflict block. */
export interface ConflictBlock {
  /** Discriminator. `two-way` lacks `base`/`baseLabel`; `three-way`/`diff3`
   *  have both (possibly empty). */
  readonly style: ConflictMarkerStyle
  /** Text after `<<<<<<< ` on the open line (verbatim, may be `""`). */
  readonly oursLabel: string
  /** Text after `>>>>>>> ` on the close line. */
  readonly theirsLabel: string
  /** Text after `||||||| ` on the base line — present for three-way / diff3
   *  only. OMITTED for two-way (never `undefined`). */
  readonly baseLabel?: string
  /** Content between the open marker and the separator / base marker. */
  readonly ours: string
  /** Content between the separator and the close marker. */
  readonly theirs: string
  /** Content between the base marker and the separator. Present for three-way
   *  / diff3 only. OMITTED for two-way (never `undefined`). */
  readonly base?: string
  /** 1-indexed line of `<<<<<<<`. */
  readonly startLine: number
  /** 1-indexed line of `>>>>>>>`. */
  readonly endLine: number
  /** 0-indexed char offset of the `<` of the open marker. */
  readonly startOffset: number
  /** 0-indexed char offset one past the last char of the close-marker LINE,
   *  exclusive of the trailing line-terminator. So
   *  `source.slice(startOffset, endOffset)` reproduces the conflict block
   *  excluding the trailing newline. */
  readonly endOffset: number
}

/** Closed union — extending requires every exhaustive switch to be updated. */
export interface ConflictParseDiagnostic {
  readonly kind:
    | "unterminated" // open with no `>>>>>>>` reached EOF
    | "no_separator" // open + close but no `=======` between
    | "marker_at_offset" // marker present but malformed (length mismatch, no space, etc.)
    | "nested" // a second `<<<<<<<` opened while another was open
    | "missing_ours" // close marker without preceding open
    | "missing_theirs" // separator without preceding open
  /** 1-indexed; may equal `lineCount + 1` for EOF-overrun. */
  readonly line: number
  /** Human-readable explanation. Stable enough to log; do not pattern-match. */
  readonly message: string
}

export interface ConflictParseResult {
  readonly blocks: ReadonlyArray<ConflictBlock>
  readonly diagnostics: ReadonlyArray<ConflictParseDiagnostic>
}

/** Thrown ONLY when the input isn't a string. Domain failures (malformed
 *  conflicts) are reported via {@link ConflictParseDiagnostic}. */
export class ConflictParserInputError extends QuantaError {
  constructor(message: string) {
    super("conflict_parser_input", message)
  }
}
