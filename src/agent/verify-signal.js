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
/**
 * Leading command-position boundary: start-of-string, whitespace, or a shell
 * separator (`;`, `&`, `|`). Prevents a runner *name* from matching as a
 * substring inside another word (e.g. `digest`, `ingest` must not match
 * `jest`). Used only for bare-name runners; subcommand forms (`go test`) carry
 * their own `\b` anchors.
 */
const CMD = "(?:^|\\s|[;&|])";
/**
 * The recognition registry — the single source of truth. Ordered by ecosystem;
 * order is irrelevant to correctness (matching is a logical OR) but
 * {@link matchVerifyCommand} returns the FIRST match, so the most specific
 * python forms precede the generic `reproduce`/`repro` token.
 */
export const VERIFY_MATCHERS = [
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
        pattern: /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+\S*test\S*)\b|\bbun\s+test\b|\bnode\b[^|]*--test\b|\bdeno\s+test\b/i,
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
];
/**
 * The first matcher that recognizes `cmd` as a test/reproduction run, or `null`
 * when none does. Returning the matcher (not a bool) lets callers record which
 * ecosystem's verification ran.
 */
export const matchVerifyCommand = (cmd) => {
    for (const m of VERIFY_MATCHERS) {
        if (m.pattern.test(cmd))
            return m;
    }
    return null;
};
/** True iff `cmd` looks like a real test or reproduction invocation. */
export const isTestLikeCommand = (cmd) => matchVerifyCommand(cmd) !== null;
/**
 * Back-compat composed regex, DERIVED from {@link VERIFY_MATCHERS} (so the
 * registry stays the single source of truth). `TEST_LIKE_RE.test(cmd)` is
 * equivalent to {@link isTestLikeCommand}; prefer the function (it also tells
 * you the ecosystem via {@link matchVerifyCommand}). Retained because existing
 * consumers/tests import this symbol.
 */
export const TEST_LIKE_RE = new RegExp(VERIFY_MATCHERS.map((m) => m.pattern.source).join("|"), "i");
