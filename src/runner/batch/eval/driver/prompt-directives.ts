/**
 * Bench prompt directives + steer text (pure string constants) and the
 * {@link composeBaseText} composer.
 *
 * Extracted verbatim from `driver.ts` (pure code motion, byte-identical). This
 * module owns the SWE-bench solve-directive family (verbose / lean / no-exec /
 * repro-only variants) plus the bolt-on steer strings and the pure composer
 * that assembles the bench user-message base text. No env reads, no external
 * driver dependencies — directly unit-testable.
 */

/** Solve directive for real SWE-bench tasks, grounded in observed 0/5 failure
 *  modes: full-file rewrites → 180KB diffs that break PASS_TO_PASS; agents
 *  editing tests/ (discarded by the source-only grader); plausible-but-wrong
 *  fixes with no verification loop. Appended to the task message only when
 *  `instance.swebench` is set (custom-corpus runs unaffected). */
/** Anti-semantic-over-engineering steer absorbed from OpenHands'
 *  `system_prompt_tech_philosophy.j2` (Linus "good taste" mode) + mini-swe's
 *  minimal posture — the methodology delta that lets those scaffolds solve the
 *  #13417 class on the SAME model where quanta over-engineers. Targets SEMANTIC
 *  over-engineering (a small diff that still reaches for runtime/compiler APIs
 *  or invents a helper), which the existing diff-SIZE rules do not catch. */
export const SIMPLICITY_STEER =
  "Prefer the SIMPLEST mechanism that already exists. If a plain attribute or " +
  "field on the object already holds the answer, read it DIRECTLY — do NOT build " +
  "or call a runtime/execution/compiler object (or re-run the operation) and do " +
  "NOT add a new helper method, function, or class when editing the existing " +
  "expression in place would do. Eliminating a special case beats adding a branch " +
  "or a new abstraction; ask 'is there a one-line change to the existing code?' " +
  "before writing new code. Remove any reproduction script or downloaded file you " +
  "created so only the real source fix remains."

// REMOVED (jun-22): benchmark-overfit issue-keyword directive steers
// (MESSAGE_FORMAT / ADAPTER_FAMILY / EXECUTION_ENV_BOUNDARY + their RCA variants).
// They hard-coded specific SWE-bench instances' gold-patch recipes (astropy
// TimeSeries required-columns, django TIME_ZONE backend, django PostgreSQL dbshell)
// into prompt steers triggered by keyword-matching the issue text — answer-key /
// leaderboard-gaming, banned by the no-heuristic-authority rule. The structural
// steers (LSP grounding / find-refs / spec-fidelity / simplicity / sibling-
// completion) remain: they are general method guidance, not instance-tuned.

/** Lever A — SIBLING-COMPLETION / co-change consequence check (2026-06-19,
 *  ceiling RCA). Measured failure mode on the multi-file ceiling subset: quanta
 *  localizes the OWNER file correctly (often gold-identical) but STOPS there and
 *  misses the COUPLED sibling file the fix also requires (matplotlib cm.py edit
 *  needs colors.py `__eq__`; django related.py needs forms/models.py). The
 *  adversarial audit showed the sibling usually IS reachable by symbol (cm.py
 *  uses colors.LinearSegmentedColormap; related.py references forms.Model-
 *  ChoiceField) — the agent simply never follows the link or asks "what does my
 *  change break elsewhere". This steer forces the LSP traversal + ripple check.
 *  Complements the WS2 grep feeder (tool-found siblings) with model-driven LSP
 *  discovery. Knob-gated `QUANTA_BENCH_SIBLING` (default-OFF for clean A/B). */
export const SIBLING_COMPLETION_STEER =
  "Many fixes span MORE THAN ONE file. KEEP your primary fix exactly where it is " +
  "— never move it to another file. Then, ADDITIVELY, run a co-change check: for " +
  "every symbol your edit touches or whose behavior it changes (a renamed/added " +
  "attribute, a changed return or raise, an altered comparison, a new kwarg you " +
  "pass), grep the symbol name (and/or use lsp_references) to find every OTHER " +
  "file that DEFINES or CONSUMES it. For each, ask: does my change break or " +
  "contradict what it assumes — its equality/hash, how it renders or consumes the " +
  "value, or its parallel layer (a form field paired with a model field, a " +
  "registry paired with the object it stores)? If yes, ADD an edit to that file " +
  "TOO — on top of, not instead of, your primary edit. Your FINAL diff must " +
  "contain BOTH the primary file AND every coupled file; dropping either one " +
  "fails the hidden tests. Verify both before you stop."

const BASH_VERIFY_MODE_STEER =
  '- Tool mode: when calling bash for any test, reproducer, or verification command, set mode:"write". Reserve bash mode:"read" for passive inspection only (ls/rg/cat/git diff); read mode rejects verification runtimes instead of running them under a read-only sandbox.'

const SWEBENCH_DIRECTIVE = [
  "",
  "",
  "You are fixing a real defect in this repository; an automated grader runs",
  "hidden tests against ONLY your source changes. Hard rules:",
  "- Change library/source code ONLY. NEVER create, edit, or delete any test",
  "  file or anything under a tests/ or test/ dir — the grader supplies its own",
  "  tests; your test edits are discarded and only waste turns.",
  "- Make the SMALLEST correct change. Use `edit` for targeted hunks. Do NOT",
  "  rewrite or reformat whole files; do NOT `write` over an existing file.",
  "- NEVER run `git checkout`/`reset`/`clean`/`stash`/`restore`, re-clone, or",
  "  any command that discards your own edits. Your final git diff IS the",
  "  submission — do not let bash commands wipe it.",
  "- Reproduce first: from the issue, construct the concrete failing scenario",
  "  (the exact input/call the issue describes) and confirm it currently",
  "  misbehaves before you edit.",
  "- Infer the EXACT required behavior (signatures, error messages, return",
  "  values, edge cases) from the issue and match it precisely — a fix that is",
  "  close but not exact still fails the hidden test.",
  "- MANDATORY before you stop: after your final edit, run the repository's",
  "  existing test(s) most specific to the changed code AND your reproduction",
  "  of the issue. If anything fails, iterate. Do NOT stop right after an edit",
  "  without running tests — an unverified edit is the #1 cause of failure.",
  BASH_VERIFY_MODE_STEER,
  "- Keep the final diff minimal and isolated to the fix.",
  "- When using apply_patch, produce V4A format: start with '*** Begin Patch',",
  "  then per file '*** Update File: path/to/file.py', then lines prefixed '+' (add),",
  "  '-' (remove), ' ' (context, one space then the line), then '*** End Patch'.",
  "- If tests fail with ModuleNotFoundError, set PYTHONPATH=. before pytest to",
  "  ensure the repo root is on sys.path (e.g. PYTHONPATH=. python -m pytest ...).",
].join("\n")

/**
 * LEAN, low-prescription variant of {@link SWEBENCH_DIRECTIVE} — selected by the
 * `QUANTA_BENCH_LEAN_PROMPT` knob (Sonar absorption, P2, default-OFF).
 *
 * WHY: Sonar measured that LESS-prescriptive prompts score HIGHER for capable
 * models (two-stage 58% → free-workflow 70% → less-prescriptive + extended
 * thinking 75%). Our verbose directive plus the lspSteer / specSteer /
 * simplicitySteer / siblingSteer bolt-ons micromanage the workflow and may CAP
 * gpt-5.4. This arm encodes Sonar's 3 principles ONLY, high-level, and FOLDS the
 * bolt-on steers' intent in (smallest-change / in-place edit / source-only), so
 * when the knob is ON those steers are omitted — see `composeBaseText`. It is a
 * PARALLEL alternative; the verbose path is untouched and OFF is byte-identical.
 */
const SWEBENCH_DIRECTIVE_LEAN_HEAD = [
  "",
  "",
  "You are fixing a real defect in this repository. An automated grader runs",
  "hidden tests against ONLY your source changes.",
  "- Never modify, add, or delete any test file.",
  "- Solve it the way the problem warrants — reproduction, code inspection, or",
  "  test analysis — and make the SMALLEST change that fixes the root cause. Edit",
  "  the existing code in place; do not add helper methods or reach for runtime",
  "  APIs when an in-place edit works.",
  "- Change source code ONLY; never rewrite or reformat whole files. Your final",
  "  unified diff is the submission.",
]

const SWEBENCH_DIRECTIVE_LEAN_FULL = [
  ...SWEBENCH_DIRECTIVE_LEAN_HEAD,
  "- Test-driven: reproduce the issue with a small script, fix it, then verify",
  "  with your reproducer AND by finding and running the repository's own",
  "  relevant regression tests.",
  BASH_VERIFY_MODE_STEER,
].join("\n")

const SWEBENCH_DIRECTIVE_LEAN_REPRO_ONLY = [
  ...SWEBENCH_DIRECTIVE_LEAN_HEAD,
  "- If useful, reproduce the issue with a small script and verify with that",
  "  focused reproducer. Do NOT run the repository test suite, pytest, tox, or",
  "  broad regression sweeps yourself; the grader owns full verification.",
  BASH_VERIFY_MODE_STEER,
].join("\n")

const SWEBENCH_DIRECTIVE_LEAN_NOEXEC = [
  ...SWEBENCH_DIRECTIVE_LEAN_HEAD,
  "- Do NOT run the repository test suite, pytest, tox, or ad-hoc validation",
  "  commands yourself. Make the smallest correct source change and stop; the",
  "  grader decides in the correct environment.",
].join("\n")

/**
 * Edit-and-submit variant of {@link SWEBENCH_DIRECTIVE} — used when the
 * `bench-in-loop-exec` mode resolves to `"off"`.
 *
 * Keeps every source-discipline rule (source-only, smallest change, no test
 * edits, no git-checkout, V4A format) but DELETES the "Reproduce first" and the
 * "MANDATORY ... run the repository's existing test(s) ... iterate" clauses. On
 * instances whose host test-env is incompatible with the pinned deps, that
 * mandate is unsatisfiable (`python -m pytest` → collection error), so the model
 * flails until budget exhaustion and aborts with an empty patch. The grader runs
 * the tests in the correct per-instance docker env at grading time, so in-loop
 * execution is not required to produce a correct patch.
 */
const SWEBENCH_DIRECTIVE_NOEXEC = [
  "",
  "",
  "You are fixing a real defect in this repository; an automated grader runs",
  "hidden tests against ONLY your source changes. Hard rules:",
  "- Change library/source code ONLY. NEVER create, edit, or delete any test",
  "  file or anything under a tests/ or test/ dir — the grader supplies its own",
  "  tests; your test edits are discarded and only waste turns.",
  "- Make the SMALLEST correct change. Use `edit` for targeted hunks. Do NOT",
  "  rewrite or reformat whole files; do NOT `write` over an existing file.",
  "- NEVER run `git checkout`/`reset`/`clean`/`stash`/`restore`, re-clone, or",
  "  any command that discards your own edits. Your final git diff IS the",
  "  submission — do not let bash commands wipe it.",
  "- Infer the EXACT required behavior (signatures, error messages, return",
  "  values, edge cases) from the issue and match it precisely — a fix that is",
  "  close but not exact still fails the hidden test.",
  "- The automated grader runs the repository's tests for you in a correct",
  "  environment. Do NOT run the test suite, pytest, or tox yourself — this repo",
  "  is checked out without its test dependencies, so test commands will fail",
  "  spuriously and only waste turns. Make the smallest correct source change",
  "  and stop; an unverified edit is fine — the grader decides.",
  "- Keep the final diff minimal and isolated to the fix.",
  "- When using apply_patch, produce V4A format: start with '*** Begin Patch',",
  "  then per file '*** Update File: path/to/file.py', then lines prefixed '+' (add),",
  "  '-' (remove), ' ' (context, one space then the line), then '*** End Patch'.",
].join("\n")

/**
 * Focused execution variant between FULL and NOEXEC. It keeps the mini-swe
 * source-discipline rules, still forbids broad repo-test execution, but allows
 * a tiny direct reproducer when the issue can be demonstrated narrowly.
 */
const SWEBENCH_DIRECTIVE_REPRO_ONLY = [
  "",
  "",
  "You are fixing a real defect in this repository; an automated grader runs",
  "hidden tests against ONLY your source changes. Hard rules:",
  "- Change library/source code ONLY. NEVER create, edit, or delete any test",
  "  file or anything under a tests/ or test/ dir — the grader supplies its own",
  "  tests; your test edits are discarded and only waste turns.",
  "- Make the SMALLEST correct change. Use `edit` for targeted hunks. Do NOT",
  "  rewrite or reformat whole files; do NOT `write` over an existing file.",
  "- NEVER run `git checkout`/`reset`/`clean`/`stash`/`restore`, re-clone, or",
  "  any command that discards your own edits. Your final git diff IS the",
  "  submission — do not let bash commands wipe it.",
  "- Infer the EXACT required behavior (signatures, error messages, return",
  "  values, edge cases) from the issue and match it precisely — a fix that is",
  "  close but not exact still fails the hidden test.",
  "- If useful, you MAY run a tiny issue reproducer or a focused script that",
  "  demonstrates the bug directly. Do NOT run the repository test suite,",
  "  pytest, tox, or broad regression sweeps yourself; the grader owns full",
  "  verification in the correct environment.",
  BASH_VERIFY_MODE_STEER,
  "- Keep the final diff minimal and isolated to the fix.",
  "- When using apply_patch, produce V4A format: start with '*** Begin Patch',",
  "  then per file '*** Update File: path/to/file.py', then lines prefixed '+' (add),",
  "  '-' (remove), ' ' (context, one space then the line), then '*** End Patch'.",
].join("\n")

/** Pre-composed steer lines (already include their leading `\n-` separator, or
 *  are `""` when their gate is off). Factored into a record so {@link composeBaseText}
 *  can append them verbatim in the OFF path and drop them all in the LEAN path. */
export interface SteerLines {
  readonly lsp: string
  readonly findRefs: string
  readonly spec: string
  readonly simplicity: string
  readonly sibling: string
}

/**
 * Compose the bench user-message base text. Pure (no env reads) so it is
 * unit-testable directly. Two parallel arms, selected by `leanPrompt`:
 *
 *  - OFF (default, byte-identical to the pre-knob composition): the in-loop /
 *    no-exec verbose directive followed by every gated steer line.
 *  - LEAN ON (`QUANTA_BENCH_LEAN_PROMPT`): the SHORT lean-directive family
 *    INSTEAD of the verbose directive, but STILL preserving the caller's
 *    execution authority mode (`full` / `repro-only` / `off`). The bolt-on
 *    steers (lsp / spec / simplicity / sibling) are OMITTED — LEAN folds their
 *    intent in. The tool-availability `findRefs` steer is retained (it only
 *    names an actually-wired tool and is default-OFF itself).
 *
 * Non-swebench instances always return `base` unchanged on both arms.
 */
export const composeBaseText = (
  base: string,
  isSwebench: boolean,
  inLoopExecMode: "full" | "repro-only" | "off",
  steers: SteerLines,
  leanPrompt: boolean,
): string => {
  if (!isSwebench) return base
  if (leanPrompt) {
    const leanDirective =
      inLoopExecMode === "full"
        ? SWEBENCH_DIRECTIVE_LEAN_FULL
        : inLoopExecMode === "repro-only"
          ? SWEBENCH_DIRECTIVE_LEAN_REPRO_ONLY
          : SWEBENCH_DIRECTIVE_LEAN_NOEXEC
    return `${base}${leanDirective}${steers.findRefs}`
  }
  const directive =
    inLoopExecMode === "full"
      ? SWEBENCH_DIRECTIVE
      : inLoopExecMode === "repro-only"
        ? SWEBENCH_DIRECTIVE_REPRO_ONLY
        : SWEBENCH_DIRECTIVE_NOEXEC
  return `${base}${directive}${steers.lsp}${steers.findRefs}${steers.spec}${steers.simplicity}${steers.sibling}`
}
