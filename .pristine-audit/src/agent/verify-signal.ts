/**
 * verify-signal — verification command/output signals.
 *
 * The command-shape registry lives in `@/shared/verify-command-shape` so the
 * agent guard and bash read-mode preflight share one source of truth. This file
 * re-exports that registry and owns the output pass/fail recognizers used by the
 * verify guard and bench verdict path.
 *
 * ── Soundness contract ──────────────────────────────────────────────────────
 * The matcher is a *signal*, so it must minimize BOTH error directions:
 *   - false NEGATIVE (a real test run not recognized) ⇒ the guard over-forces
 *     a model that already verified — the "over-correction" the maxTrips=1
 *     default fights. Hence the registry spans the major ecosystems, not just
 *     python.
 *   - false POSITIVE (a non-test command counted as verification) ⇒ the guard
 *     is DEFEATED (the model skips real verification). Hence `python <file>.py`
 *     is NOT a blanket match: a bare `python manage.py runserver` /
 *     `python setup.py build` is not verification. Only test/repro-shaped
 *     filenames (`test_*.py`, `*_test.py`, `conftest.py`), django's explicit
 *     `manage.py test`, or the `reproduce`/`repro` token count.
 *
 * The shared command recognizer is pure leaf: no imports, no I/O, no clocks, no
 * randomness. Recognition is over the command STRING only.
 */

export {
  isTestLikeCommand,
  isVerifySignalCommand,
  matchesExactVerifyCommand,
  matchVerifyCommand,
  TEST_LIKE_RE,
  VERIFY_MATCHERS,
  type VerifyMatcher,
} from "@/shared/verify-command-shape"

// ─── Outcome parser (mustPass mode) ────────────────────────────────────────
//
// The presence-only verify-guard answers "did a verify-like call RUN?". The
// mustPass mode asks the harder question — "did it PASS?". This second-pass
// recognizer scans the captured stdout/stderr preview for EXPLICIT failure
// markers per ecosystem. Soundness contract mirrors the presence registry:
//   - false POSITIVE here (declaring pass as fail) ⇒ over-blocking ⇒ wastes
//     turns. Mitigated by anchoring matchers and using explicit failure
//     tokens only (no broad keyword like "Error" alone).
//   - false NEGATIVE here (declaring fail as pass) ⇒ the guard is DEFEATED
//     exactly like the case mustPass was designed to close. Mitigated by
//     covering each major ecosystem's recognizable failure summary line.
//
// Conservative posture: an EMPTY output ⇒ false (no signal, do not override
// the dispatch `ok` field). Any matcher firing ⇒ true (output overrides ok).
// This honors the "no heuristics — clear signal only" project policy.

/** One ecosystem's failure-line recognizer. Stable `id` for telemetry. */
export interface OutcomeFailureMatcher {
  readonly id: string
  readonly ecosystem: string
  /** Anchored regex matching an EXPLICIT failure summary or marker. */
  readonly pattern: RegExp
}

/** One ecosystem's success-line recognizer. Stable `id` for telemetry. */
export interface OutcomeSuccessMatcher {
  readonly id: string
  readonly ecosystem: string
  /** Anchored regex matching an EXPLICIT success summary or marker. */
  readonly pattern: RegExp
}

const ANSI_CSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

const stripAnsiCsi = (output: string): string => output.replace(ANSI_CSI_RE, "")

const normalizeVerifyOutput = (output: string): string | null => {
  if (typeof output !== "string" || output.length === 0) return null
  const normalized = stripAnsiCsi(output)
  return normalized.length === 0 ? null : normalized
}

/**
 * Output-side failure registry. Each pattern targets a specific test-runner's
 * canonical failure summary, NOT a generic "error" keyword (which would over-
 * fire). Multiline (`m`) flag where the marker is line-anchored.
 */
export const OUTCOME_FAILURE_MATCHERS: readonly OutcomeFailureMatcher[] = [
  // pytest: `===== 3 failed in 0.42s =====` / `===== 1 failed, 2 passed =====`
  // also `FAILED tests/test_x.py::test_y` line per failing test.
  {
    id: "pytest-summary",
    ecosystem: "python",
    pattern: /^=+\s+\d+\s+failed(?:[, ]|\s+in\s)/m,
  },
  { id: "pytest-failed-line", ecosystem: "python", pattern: /^FAILED\s+\S/m },
  // pytest short-form summary line: `3 failed, 2 passed in 1.23s`
  {
    id: "pytest-short",
    ecosystem: "python",
    pattern: /^\d+\s+failed(?:[, ]|\s+in\s)/m,
  },
  // python unittest: `FAILED (failures=2)` / `FAILED (errors=1, failures=0)`
  { id: "unittest", ecosystem: "python", pattern: /^FAILED\s*\(/m },
  // jest/vitest: `Tests:       3 failed, 5 passed, 8 total`
  { id: "jest-vitest", ecosystem: "js", pattern: /^Tests:.*\b\d+\s+failed/m },
  // jest/vitest per-file: `FAIL  tests/foo.test.ts`
  { id: "jest-vitest-fail", ecosystem: "js", pattern: /^FAIL\s+\S/m },
  // mocha: `5 failing`
  { id: "mocha", ecosystem: "js", pattern: /^\s*\d+\s+failing\b/m },
  // go test: `--- FAIL: TestFoo` / final `FAIL\tpkg/path`
  { id: "go-fail-marker", ecosystem: "go", pattern: /^---\s+FAIL:/m },
  { id: "go-fail-summary", ecosystem: "go", pattern: /^FAIL\b/m },
  // cargo test: `test result: FAILED. 1 passed; 2 failed; ...`
  { id: "cargo", ecosystem: "rust", pattern: /^test result:\s*FAILED\b/m },
  // Generic non-zero count summaries: `1 passed, 2 errors`, `3 failures`, ...
  // Zero-count summaries (`0 failed`, `0 errors`) are NOT failure signals.
  //
  // The `failures?`/`errors?` words also appear in incidental NON-summary prose
  // ("will raise 2 errors", "fixes 3 failures"), where firing would flip a real
  // PASS to fail-closed. Test-runner summaries always place the count at a
  // segment boundary — start of a summary line, after a `, ` separator
  // (`1 passed, 2 failed in 0.01s`), or after the `= ` banner fill
  // (`===== 3 failed in 0.4s =====`) — so ALL three ambiguous count words
  // (`failed`/`failures?`/`errors?`) anchor to that boundary. #13: `failed` was
  // previously fully unanchored (`\b3 failed\b`), so it fired on a count appearing
  // MID-line in prose / log noise ("retried 3 failed connections, then OK"). The
  // boundary anchor drops that mid-line case while keeping every real summary
  // positive. NOTE (honest scope): with the `m` flag `^` matches every line start,
  // so a line that BEGINS "N failed …" still fires — that is intended (real
  // runner summaries do start a line that way; over-blocking there is the safe
  // direction under maxTrips=1, and false-NEGATIVE would defeat the guard).
  {
    id: "generic-failed-count",
    ecosystem: "generic",
    pattern: /(?:^|,\s|=\s)(?:[1-9]\d*)\s+failed\b/m,
  },
  {
    id: "generic-failure-count",
    ecosystem: "generic",
    pattern: /(?:^|,\s|=\s)(?:[1-9]\d*)\s+failures?\b/m,
  },
  {
    // `=\s` boundary catches the pytest collection-error banner
    // `==================== 2 errors in 0.53s ====================` (count after
    // the `= ` banner, not line-start / `, `); incidental prose ("raise 2 errors")
    // still has no boundary so it does not fire.
    id: "generic-error-count",
    ecosystem: "generic",
    pattern: /(?:^|,\s|=\s)(?:[1-9]\d*)\s+errors?\b/m,
  },
  {
    id: "generic-failure-assignment",
    ecosystem: "generic",
    pattern: /\b(?:failures?|errors?)\s*=\s*(?:[1-9]\d*)\b/m,
  },
  // rspec: `Failures:` + final `5 failures` summary. `0 failures` is an
  // explicit PASS summary and must not over-block verdict salvage.
  { id: "rspec", ecosystem: "ruby", pattern: /^\d+\s+examples?,\s+[1-9]\d*\s+failures?/m },
  // phpunit: `FAILURES! Tests: 5, Assertions: 12, Failures: 3.`
  { id: "phpunit", ecosystem: "php", pattern: /^FAILURES!/m },
  // dotnet test: `Failed!  - Failed:    3, Passed: ...`
  { id: "dotnet", ecosystem: "dotnet", pattern: /^Failed!\s+-\s+Failed:/m },
  // make / generic: `make: *** [target] Error N`
  { id: "make-error", ecosystem: "generic", pattern: /\bmake(?:\[\d+\])?:\s+\*{3}\s/m },
]

/**
 * Output-side success registry. These are explicit "the suite passed" summary
 * lines that are safe enough to salvage a non-zero wrapper exit once we have
 * ALSO ruled out any explicit failure marker. This is intentionally narrower
 * than arbitrary "ok"/"passed" prose: only recognizable test-runner summaries.
 */
export const OUTCOME_SUCCESS_MATCHERS: readonly OutcomeSuccessMatcher[] = [
  // pytest: `===== 5 passed in 0.42s =====` / short `5 passed in 0.42s`
  {
    id: "pytest-summary",
    ecosystem: "python",
    pattern: /^=+\s+[1-9]\d*\s+passed(?:[, ]|\s+in\s)/m,
  },
  { id: "pytest-short", ecosystem: "python", pattern: /^[1-9]\d*\s+passed(?:[, ]|\s+in\s)/m },
  // unittest: `OK` / `OK (skipped=1)`
  { id: "unittest", ecosystem: "python", pattern: /^OK\b(?:\s*\(|\s*$)/m },
  // jest/vitest: `Tests:       5 passed, 5 total`
  { id: "jest-vitest", ecosystem: "js", pattern: /^Tests:.*\b[1-9]\d*\s+passed\b/m },
  // mocha: `10 passing`
  { id: "mocha", ecosystem: "js", pattern: /^\s*[1-9]\d*\s+passing\b/m },
  // go test: `ok  github.com/foo/bar/pkg 0.012s` (or `(cached)`). Require the
  // package + duration/cached TAIL — a bare `/^ok\s+\S+/` matches incidental prose
  // ("ok we should fix this"), a false-GREEN on the non-zero-exit salvage path.
  { id: "go", ecosystem: "go", pattern: /^ok\s+\S+\s+(?:\(cached\)|[\d.]+m?s\b)/m },
  // cargo test: `test result: ok. 3 passed; 0 failed; ...`
  { id: "cargo", ecosystem: "rust", pattern: /^test result:\s*ok\.\s+[1-9]\d*\s+passed;/m },
  // rspec: `5 examples, 0 failures`
  { id: "rspec", ecosystem: "ruby", pattern: /^[1-9]\d*\s+examples?,\s+0\s+failures?\b/m },
  // phpunit: `OK (5 tests, 12 assertions)`
  { id: "phpunit", ecosystem: "php", pattern: /^OK\s+\([1-9]\d*\s+tests?,/m },
  // dotnet: `Passed!  - Failed:    0, Passed:     5, Skipped:     0`
  {
    id: "dotnet",
    ecosystem: "dotnet",
    pattern: /^Passed!\s+-\s+Failed:\s+0,\s+Passed:\s+[1-9]\d*/m,
  },
]

/**
 * True iff the captured tool output contains an EXPLICIT, ecosystem-specific
 * failure marker — meaning a verify ran but DID NOT pass. Pure: no I/O, no
 * mutation, no clock. The first/second args mirror history-entry shape
 * (`name`, `arg`) but are NOT used for routing today: the registry is
 * ecosystem-agnostic on the output side because all failure summaries are
 * distinct enough to recognize without knowing which command produced them.
 * Kept in the signature for forward compatibility (a future per-ecosystem
 * dispatch table would key off `arg`).
 *
 * Conservative contract:
 *   - Empty output ⇒ false (no signal, defer to dispatch `ok`).
 *   - No matcher fires ⇒ false (cannot prove failure ⇒ do not over-block).
 *   - Any matcher fires ⇒ true (we have an explicit failure signal).
 *
 * Order of registry irrelevant to correctness (logical OR).
 */
export const isVerifyOutputFailing = (
  _name: string,
  _arg: string | undefined,
  output: string,
): boolean => {
  const normalized = normalizeVerifyOutput(output)
  if (normalized === null) return false
  return outputHasFailureMarker(normalized)
}

/**
 * Failure-registry scan over an ALREADY-normalized string. Factored out so both
 * public recognizers normalize the output exactly once: `isVerifyOutputPassing`
 * previously re-fed its normalized text through `isVerifyOutputFailing`, which
 * normalized a SECOND time (a redundant `stripAnsiCsi` pass on the hot output
 * path). `stripAnsiCsi` is idempotent, so this is behavior-preserving.
 */
const outputHasFailureMarker = (normalized: string): boolean => {
  for (const m of OUTCOME_FAILURE_MATCHERS) {
    if (m.pattern.test(normalized)) return true
  }
  return false
}

/**
 * The `id` of the FIRST failure matcher that fires on the captured output, or
 * `null` if none / empty. Same recognition as {@link isVerifyOutputFailing} but
 * surfaces WHICH marker matched so the verify-guard can thread it into its
 * (now evidential, not asserted) nudge — the model sees WHY the output looked
 * like a failure and can confirm/deny. Pure: no I/O, no clock.
 */
export const verifyOutputFailureMarkerId = (output: string): string | null => {
  const normalized = normalizeVerifyOutput(output)
  if (normalized === null) return null
  for (const m of OUTCOME_FAILURE_MATCHERS) {
    if (m.pattern.test(normalized)) return m.id
  }
  return null
}

/**
 * True iff the captured tool output contains an EXPLICIT, ecosystem-specific
 * success summary AND no explicit failure summary. This is the exact mirror of
 * {@link isVerifyOutputFailing}: verdict salvage can promote a non-zero wrapper
 * exit only on clear runner-owned evidence like `OK` or `5 examples, 0
 * failures`, never on broad prose.
 */
export const isVerifyOutputPassing = (
  _name: string,
  _arg: string | undefined,
  output: string,
): boolean => {
  const normalized = normalizeVerifyOutput(output)
  if (normalized === null) return false
  // Scan the failure registry directly on the already-normalized string rather
  // than re-entering `isVerifyOutputFailing` (which would normalize a 2nd time).
  if (outputHasFailureMarker(normalized)) return false
  for (const m of OUTCOME_SUCCESS_MATCHERS) {
    if (m.pattern.test(normalized)) return true
  }
  return false
}
