/**
 * verify-signal — the "is this shell command a real test / reproduction run?"
 * signal, as a first-class, inspectable, per-ecosystem registry.
 *
 * Extracted from `verify-guard.ts` (which only owns the *gating* state machine)
 * so the recognition logic is structured data, not one opaque regex. Each
 * ecosystem is an independently testable {@link VerifyMatcher}; adding a runner
 * is a one-line registry entry, and {@link matchVerifyCommand} reports WHICH
 * ecosystem fired (a usable signal for telemetry / debugging), not just a bool.
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
 * Pure leaf module: no imports, no I/O, no clocks, no randomness. Recognition
 * is over the command STRING only (the guard supplies it).
 */

/** One ecosystem's recognizer. `id` is stable for telemetry / debugging. */
export interface VerifyMatcher {
  /** Stable identifier, e.g. `"python-pytest"`, `"js-runner"`, `"go"`. */
  readonly id: string
  /** Ecosystem bucket, e.g. `"python"`, `"js"`, `"rust"`, `"generic"`. */
  readonly ecosystem: string
  /** Recognizes a test/reproduction invocation for this ecosystem. */
  readonly pattern: RegExp
}

const normalizeVerifyCommand = (cmd: string): string => cmd.trim().replace(/\s+/g, " ")

/**
 * Leading command-position boundary: start-of-string, whitespace, or a shell
 * separator (`;`, `&`, `|`). Prevents a runner *name* from matching as a
 * substring inside another word (e.g. `digest`, `ingest` must not match
 * `jest`). Used only for bare-name runners; subcommand forms (`go test`) carry
 * their own `\b` anchors.
 */
const CMD = "(?:^|\\s|[;&|])"

/**
 * The recognition registry — the single source of truth. Ordered by ecosystem;
 * order is irrelevant to correctness (matching is a logical OR) but
 * {@link matchVerifyCommand} returns the FIRST match, so the most specific
 * python forms precede the generic `reproduce`/`repro` token.
 */
export const VERIFY_MATCHERS: readonly VerifyMatcher[] = [
  {
    id: "python-pytest",
    ecosystem: "python",
    pattern: new RegExp(`${CMD}pytest\\b|\\bpython3?\\s+-m\\s+(?:pytest|unittest)\\b`, "i"),
  },
  {
    id: "python-toolrunner",
    ecosystem: "python",
    pattern: new RegExp(`${CMD}(?:tox|nox)\\b`, "i"),
  },
  {
    id: "python-testfile",
    ecosystem: "python",
    pattern: /\bpython3?\s+\S*(?:test|conftest)\S*\.py\b/i,
  },
  { id: "python-django", ecosystem: "python", pattern: /\bmanage\.py\s+test\b/i },
  {
    id: "js-runner",
    ecosystem: "js",
    pattern: new RegExp(`${CMD}(?:jest|vitest|mocha|jasmine|cypress|playwright)\\b`, "i"),
  },
  {
    id: "js-pm",
    ecosystem: "js",
    pattern:
      /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+\S*test\S*)\b|\bbun\s+test\b|\bnode\b[^|]*--test\b|\bdeno\s+test\b/i,
  },
  { id: "go", ecosystem: "go", pattern: /\bgo\s+test\b/i },
  { id: "rust", ecosystem: "rust", pattern: /\bcargo\s+(?:test|nextest)\b/i },
  {
    id: "ruby",
    ecosystem: "ruby",
    pattern: new RegExp(`${CMD}rspec\\b|\\brake\\s+test\\b`, "i"),
  },
  { id: "php", ecosystem: "php", pattern: new RegExp(`${CMD}phpunit\\b`, "i") },
  { id: "dotnet", ecosystem: "dotnet", pattern: /\bdotnet\s+test\b/i },
  { id: "jvm", ecosystem: "jvm", pattern: /\bmvn\s+(?:test|verify)\b|\bgradlew?\s+\S*test\b/i },
  { id: "cpp", ecosystem: "cpp", pattern: new RegExp(`${CMD}ctest\\b`, "i") },
  { id: "elixir", ecosystem: "elixir", pattern: /\bmix\s+test\b/i },
  { id: "swift", ecosystem: "swift", pattern: /\bswift\s+test\b/i },
  { id: "make", ecosystem: "generic", pattern: /\bmake\s+(?:test|check)\b/i },
  { id: "reproduction", ecosystem: "generic", pattern: /reproduce|\brepro\b/i },
]

/**
 * The first matcher that recognizes `cmd` as a test/reproduction run, or `null`
 * when none does. Returning the matcher (not a bool) lets callers record which
 * ecosystem's verification ran.
 */
export const matchVerifyCommand = (cmd: string): VerifyMatcher | null => {
  for (const m of VERIFY_MATCHERS) {
    if (m.pattern.test(cmd)) return m
  }
  return null
}

/** True iff `cmd` looks like a real test or reproduction invocation. */
export const isTestLikeCommand = (cmd: string): boolean => matchVerifyCommand(cmd) !== null

/** Bench/host-wired exact verifier authority. Unlike the ecosystem registry,
 *  this is NOT heuristic recognition: the caller already knows the command is
 *  authoritative (e.g. bench `instance.testCmd`) and wants an exact-string
 *  allowance without widening generic shell noise into a verify signal. */
export const matchesExactVerifyCommand = (
  cmd: string,
  exactCommands: readonly string[] | undefined,
): boolean => {
  if (exactCommands === undefined || exactCommands.length === 0) return false
  const normalized = normalizeVerifyCommand(cmd)
  if (normalized === "") return false
  for (const candidate of exactCommands) {
    if (normalizeVerifyCommand(candidate) === normalized) return true
  }
  return false
}

/** True iff `cmd` is either a recognized test/repro command OR an exact
 *  caller-declared verifier authority command. */
export const isVerifySignalCommand = (
  cmd: string,
  exactCommands: readonly string[] | undefined,
): boolean => isTestLikeCommand(cmd) || matchesExactVerifyCommand(cmd, exactCommands)

/**
 * Back-compat composed regex, DERIVED from {@link VERIFY_MATCHERS} (so the
 * registry stays the single source of truth). `TEST_LIKE_RE.test(cmd)` is
 * equivalent to {@link isTestLikeCommand}; prefer the function (it also tells
 * you the ecosystem via {@link matchVerifyCommand}). Retained because existing
 * consumers/tests import this symbol.
 */
export const TEST_LIKE_RE = new RegExp(VERIFY_MATCHERS.map((m) => m.pattern.source).join("|"), "i")

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
  // segment boundary — start of a summary line, or after a `, ` separator
  // (`1 passed, 2 errors in 0.01s`) — so anchor those two ambiguous words to
  // that boundary. `failed` is left unanchored: the bare verb is summary-only
  // (no common prose like "raise N failed"), so it keeps its broader reach.
  { id: "generic-failed-count", ecosystem: "generic", pattern: /\b(?:[1-9]\d*)\s+failed\b/m },
  {
    id: "generic-failure-count",
    ecosystem: "generic",
    pattern: /(?:^|,\s)(?:[1-9]\d*)\s+failures?\b/m,
  },
  {
    id: "generic-error-count",
    ecosystem: "generic",
    pattern: /(?:^|,\s)(?:[1-9]\d*)\s+errors?\b/m,
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
  // go test: `ok  github.com/foo/bar/pkg 0.012s`
  { id: "go", ecosystem: "go", pattern: /^ok\s+\S+/m },
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
  for (const m of OUTCOME_FAILURE_MATCHERS) {
    if (m.pattern.test(normalized)) return true
  }
  return false
}

/**
 * True iff the captured tool output contains an EXPLICIT, ecosystem-specific
 * success summary AND no explicit failure summary. This is the exact mirror of
 * {@link isVerifyOutputFailing}: verdict salvage can promote a non-zero wrapper
 * exit only on clear runner-owned evidence like `OK` or `5 examples, 0
 * failures`, never on broad prose.
 */
export const isVerifyOutputPassing = (
  name: string,
  arg: string | undefined,
  output: string,
): boolean => {
  const normalized = normalizeVerifyOutput(output)
  if (normalized === null) return false
  if (isVerifyOutputFailing(name, arg, normalized)) return false
  for (const m of OUTCOME_SUCCESS_MATCHERS) {
    if (m.pattern.test(normalized)) return true
  }
  return false
}
