/**
 * Issue-text hint extraction (Agentless paper §3.1, "reproduction test
 * generation" + "localization hint injection").
 *
 * `IssueHint` is the conservative result of scanning a SWE-bench
 * `problem_statement` (typically a GitHub issue body) for *explicit* signals,
 * carrying the bytes themselves where possible so the model decides what to
 * weight rather than us pre-digesting it.
 *
 * Verbatim-evidence policy
 * ========================
 * Two fields carry **VERBATIM CONTENT** (no summarization, ever):
 *
 *   - `codeFences`  — body between ``` … ``` boundaries
 *   - `tracebacks`  — `Traceback (most recent call last):` blocks
 *
 * Both are bounded (per-entry cap + total-block cap) but the cap path is
 * "keep head + tail with the exception line" — never "summarize". The original
 * issue body is also passed unchanged elsewhere; this struct is the *evidence
 * surface*, not a digest.
 *
 * Filtered fields (extractors apply tight regex but emit verbatim tokens):
 *
 *   - `files`           — extension-matched path tokens (slash optional)
 *   - `symbols`         — backtick-fenced identifiers + Python `def`/`class`
 *                         headers + TS function/class
 *   - `errors`          — `…Error/Exception/Warning` with optional `: message`
 *                         tail retained verbatim
 *   - `refs`            — `#1234` / `PROJ-456` PR/issue references
 *   - `tracebackPaths`  — legacy `path:line` pairs (kept for back-compat with
 *                         existing wiring; new code should prefer `tracebacks`)
 *   - `expectedActual?` — opt-in only (`QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL=1`).
 *                         Sentence-bounded `expected/actual/should/got` matches.
 *                         False-positive-prone, default-OFF.
 *
 * Why a typed shape (not a freeform string): tests pin individual extractor
 * outputs against this contract, and the `composeIssueHint` step is the only
 * place that turns the shape into prompt text. That separation keeps the
 * extractors pure (no I/O, no prompt-shape coupling) and lets the prompt
 * format evolve without re-running every adversarial fixture.
 */
export interface IssueHint {
  /** File paths mentioned in the issue text. Both `requests/models.py`
   *  (slash form) AND `models.py` (single-name with extension) match — the
   *  spec change from "slash required" to "extension whitelist" makes the
   *  extractor align with how human authors actually write Python file refs.
   *  Sorted unique; each ≤ 200 chars. */
  readonly files: readonly string[]
  /** Function / class / method names — backtick-quoted identifiers and
   *  language-specific `def`/`class`/`function` definitions. Keywords are
   *  filtered out. Sorted unique. */
  readonly symbols: readonly string[]
  /** Exception/warning type names with VERBATIM `: message` tail when
   *  present. Examples:
   *    - `"TypeError"`              — bare type (no message)
   *    - `"InvalidURL: URL has an invalid label."`
   *                                  — type + verbatim message body
   *  The tail (if any) is retained up to the next newline; not summarized.
   *  Sorted unique by the full string. */
  readonly errors: readonly string[]
  /** Code-fence VERBATIM BODIES — content between ``` … ``` boundaries.
   *  Each body has been:
   *    - trimmed of trailing whitespace only (no internal reflow)
   *    - capped at 4 KiB; over-cap entries are head + "\n…\n" + tail (the
   *      tail retains the last 10 non-empty lines so an exception-bearing
   *      final line survives the cap)
   *  Order preserved (no sort — authoring order matters: "repro" before
   *  "traceback" before "expected output" is a common pattern). Empty
   *  (whitespace-only) bodies dropped. */
  readonly codeFences: readonly string[]
  /** Traceback blocks VERBATIM — full text from
   *  `Traceback (most recent call last):` through to a blank line or input
   *  end. Each block capped at 4 KiB with the same head + tail policy as
   *  code fences so the final exception line survives. Order preserved
   *  (deduped on the verbatim body). Empty when issue has no Python trace.
   *  JS/Java/Rust tracebacks emit through `tracebackPaths` only — block-level
   *  capture for those formats is intentionally NOT absorbed (heuristic
   *  ambiguity vs. ROI). */
  readonly tracebacks: readonly string[]
  /** File:line locations parsed out of Python `File "...", line N` and
   *  TS/JS `at frame (path:line:col)` style tracebacks. Sorted unique.
   *  Legacy field kept for back-compat with existing regex callers; new
   *  code should prefer the verbatim `tracebacks` blocks above. */
  readonly tracebackPaths: readonly string[]
  /** PR / issue references — `#1234` (GitHub-style) or `PROJ-456`
   *  (JIRA-style). Sorted unique. Numeric `#abc` does NOT match (digit
   *  required); single-letter project prefixes accepted. */
  readonly refs: readonly string[]
  /** Expected/actual extraction — OPTIONAL field, only populated when
   *  `QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL=1`. Sentence-bounded matches
   *  of `expected/actual/should/got/but/instead` patterns, 200-char hard
   *  cap as fallback when no sentence terminator appears. Default-OFF
   *  because the pattern is false-positive-prone in prose. */
  readonly expectedActual?: readonly string[]
}

/** The empty hint — used when extraction yields nothing or the input is empty.
 *  Frozen so accidental mutation by callers is caught at runtime. */
export const EMPTY_HINT: IssueHint = Object.freeze({
  files: Object.freeze([]) as readonly string[],
  symbols: Object.freeze([]) as readonly string[],
  errors: Object.freeze([]) as readonly string[],
  codeFences: Object.freeze([]) as readonly string[],
  tracebacks: Object.freeze([]) as readonly string[],
  tracebackPaths: Object.freeze([]) as readonly string[],
  refs: Object.freeze([]) as readonly string[],
})
