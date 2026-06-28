/**
 * Phase A — regression test-set selection (SOTA++ dual-guard, the missing half).
 *
 * Faithful pure reimplementation of `agentless/test/select_regression_tests.py`
 * (MIT, studied at .extracted_source/agentless-ref/): given the tests that PASS on
 * the UN-patched repo, ask the LLM which to EXCLUDE (functionality the fix may
 * legitimately change); the regression set = `passing − excluded`. A context-fit
 * guard halves the passing list (head slice) until the prompt fits.
 *
 * CLEAN TOGGLE / no-leak:
 *  - Every export is a PURE function (prompt / parse / set-diff / fit) plus ONE
 *    injected-LLM orchestrator. Nothing executes unless a caller invokes it, so the
 *    whole dual-guard path is default-OFF / inert by construction.
 *  - Inputs are PUBLIC only: the issue text + the repo's own passing test names.
 *    No hidden FAIL_TO_PASS / PASS_TO_PASS field is read (exactly Agentless's
 *    no-leak posture).
 *  - Pure + deterministic (no clock/random); the token counter is injected.
 */

/** Agentless context ceiling (`MAX_CONTEXT_LENGTH = 128000`). */
export const REGRESSION_SELECT_CONTEXT_LIMIT = 128_000

/** The select-tests prompt (verbatim shape of Agentless `select_tests_prompt_template`). */
export const buildRegressionSelectPrompt = (
  problem: string,
  passingTests: readonly string[],
): string =>
  `We are currently solving the following issue within our repository. Here is the issue text:
--- BEGIN ISSUE ---
${problem}
--- END ISSUE ---

Below are a list of existing tests in the repository.
\`\`\`
${passingTests.join("\n")}
\`\`\`

Please identify the tests that should not be run after applying the patch to fix the issue.
These tests should be excluded as the original functionality may change due to the patch.

### Example
\`\`\`
test1
test2
test5
\`\`\`
Return only the selected tests.`

/** Parse the model's plain-text return into excluded test names — one per line.
 *  INTENTIONAL robustness deviation from Agentless `_parse_model_return_lines`
 *  (which is `content.strip().split("\n")` only): we ALSO per-line trim + drop
 *  empty lines, so a model that emits `"  test_x  "` or stray blank lines still
 *  matches the exact passing-test name. Set-difference semantics are unchanged
 *  (an empty line never matches a real test either way). */
export const parseExcludedTests = (raw: string): string[] => {
  const trimmed = raw.trim()
  if (trimmed === "") return []
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/** Regression set = passing − excluded (EXACT-match set difference, order
 *  preserved). */
export const selectRegressionSubset = (
  passing: readonly string[],
  excluded: readonly string[],
): string[] => {
  const ex = new Set(excluded)
  return passing.filter((t) => !ex.has(t))
}

/** Conservative approximate token counter (~4 chars/token) — a context-fit GUARD
 *  default, NOT a correctness lever. Production injects the real model tokenizer
 *  (`countTokens`); the approximation only over-estimates so it never under-fits. */
export const approxTokens = (msg: string): number => Math.ceil(msg.length / 4)

/** Halve (head slice) the passing list until the rendered prompt fits the context
 *  limit — faithful to Agentless's `while message_too_long: passing = passing[:n//2]`.
 *  Deterministic: always keeps a HEAD slice, never reorders. */
export const fitPassingToContext = (
  problem: string,
  passing: readonly string[],
  countTokens: (msg: string) => number,
  limit: number,
): string[] => {
  let fitted = [...passing]
  while (fitted.length > 0 && countTokens(buildRegressionSelectPrompt(problem, fitted)) >= limit) {
    fitted = fitted.slice(0, Math.floor(fitted.length / 2))
  }
  return fitted
}

/** Greedy single-shot LLM port: prompt → raw text. Injected so the orchestrator is
 *  hermetic-by-injection in tests and provider-agnostic in production. */
export type RegressionSelectLlm = (prompt: string) => Promise<string>

export interface RegressionSelectDeps {
  readonly llm: RegressionSelectLlm
  /** Real tokenizer in production; defaults to {@link approxTokens}. */
  readonly countTokens?: (msg: string) => number
  /** Context ceiling; defaults to {@link REGRESSION_SELECT_CONTEXT_LIMIT}. */
  readonly contextLimit?: number
}

export interface RegressionSelection {
  /** The selected regression set (passing − model-excluded). */
  readonly regression: string[]
  /** The passing set actually prompted (post context-fit head slice). */
  readonly original: string[]
  /** Raw model output (for the receipt / RCA). */
  readonly raw: string
}

/**
 * Resolve the regression test set for one instance. Empty passing ⇒ empty set and
 * NO LLM call (fail-closed, byte-cheap). Otherwise: context-fit the passing list,
 * prompt the LLM for exclusions, and return `passing − excluded`.
 *
 * This is the ONLY non-pure export and the single seam a caller gates behind the
 * Phase-A opt-in — keeping the toggle clean (everything else is inert pure code).
 */
export const resolveRegressionTests = async (
  problem: string,
  passing: readonly string[],
  deps: RegressionSelectDeps,
): Promise<RegressionSelection> => {
  if (passing.length === 0) return { regression: [], original: [], raw: "" }
  const fitted = fitPassingToContext(
    problem,
    passing,
    deps.countTokens ?? approxTokens,
    deps.contextLimit ?? REGRESSION_SELECT_CONTEXT_LIMIT,
  )
  const raw = await deps.llm(buildRegressionSelectPrompt(problem, fitted))
  const excluded = parseExcludedTests(raw)
  return { regression: selectRegressionSubset(fitted, excluded), original: fitted, raw }
}
