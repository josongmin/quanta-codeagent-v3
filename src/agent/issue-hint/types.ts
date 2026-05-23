/**
 * Issue-text hint extraction (Agentless paper, "localization hint injection").
 *
 * `IssueHint` is the conservative result of scanning a SWE-bench
 * `problem_statement` (typically a GitHub issue body) for *explicit* signals:
 * named file paths, code symbols, exception types, code fences, and traceback
 * locations. The shape is intentionally simple — five readonly string arrays,
 * all unique-and-sorted, all empty-not-undefined for the "nothing found" case.
 *
 * Why a typed shape (not a freeform string): tests pin individual extractor
 * outputs against this contract, and the `composeIssueHint` step is the only
 * place that turns the shape into prompt text. That separation keeps the
 * extractors pure (no I/O, no prompt-shape coupling) and lets the prompt
 * format evolve without re-running every adversarial fixture.
 */
export interface IssueHint {
  /** File paths mentioned in the issue text, e.g. `requests/models.py`. Slash
   *  required for non-traceback contexts; sorted unique; each ≤ 200 chars. */
  readonly files: readonly string[]
  /** Function / class / method names — backtick-quoted identifiers and
   *  language-specific `def`/`class`/`function` definitions. Keywords are
   *  filtered out. Sorted unique. */
  readonly symbols: readonly string[]
  /** Exception type names — `*Error`, `*Exception`, `*Warning`. The bare
   *  word "Error" alone is excluded (too noisy). Sorted unique. */
  readonly errors: readonly string[]
  /** Language-tagged code fence bodies (` ```python ... ``` `). Empty fences
   *  excluded; each body capped at 4 KiB. Order preserved (no sort — the
   *  authoring order is sometimes meaningful, e.g. repro before traceback). */
  readonly codeFences: readonly string[]
  /** File:line locations parsed out of Python `File "...", line N` and
   *  TS/JS `at frame (path:line:col)` style tracebacks. Sorted unique. */
  readonly tracebackPaths: readonly string[]
}

/** The empty hint — used when extraction yields nothing or the input is empty.
 *  Frozen so accidental mutation by callers is caught at runtime. */
export const EMPTY_HINT: IssueHint = Object.freeze({
  files: Object.freeze([]) as readonly string[],
  symbols: Object.freeze([]) as readonly string[],
  errors: Object.freeze([]) as readonly string[],
  codeFences: Object.freeze([]) as readonly string[],
  tracebackPaths: Object.freeze([]) as readonly string[],
})
