/**
 * Repro-test execution — runs each candidate as a pytest test on the ORIGINAL
 * (un-patched) repo and classifies the outcome from PYTEST EXIT SEMANTICS
 * (process exit code + parsed summary), NOT from a model-printed sentinel.
 *
 * P1 — EXECUTION-GROUNDED verdict (jun-23)
 * ========================================
 * The legacy oracle scanned stdout for a sentinel the LLM authored itself
 * ("Issue reproduced" / "Issue resolved"). The model wrote its own verdict, so
 * it was fakeable/paraphrasable and 6/10 generated repros self-judged into
 * "Other issues"/"unknown". We replace that with pytest's verdict: a canonical
 * repro is now a real `def test_*` with `assert`s on the EXPECTED (correct)
 * behaviour. On the BUGGY base tree the assertion FAILS; on a CORRECT fix it
 * PASSES. The verdict is the process exit code + pytest's summary line — code
 * the model cannot paraphrase its way around.
 *
 * The `python <path>` → pytest bridge
 * ===================================
 * The driver invokes a repro as `python <path>` (its `reproRunArgv`/`buildArgv`
 * contract, owned by out-of-fence code). A pytest test must run UNDER pytest. So
 * the GENERATED test file ends with a self-driving footer:
 *
 *     if __name__ == "__main__":
 *         import sys, pytest
 *         sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider"]))
 *
 * Run as `python <path>`, the module executes, hits the guard, and pytest runs
 * ITSELF — the process EXIT CODE then reflects pass/fail. The `__name__ ==
 * "__main__"` guard is LOAD-BEARING: without it, pytest re-imports the file
 * during its own collection and the footer fires recursively ("error during
 * collection"), destroying the verdict (exit 2 for both pass and fail). With the
 * guard, collection imports the module under its test-module name (not
 * "__main__"), the footer is inert during collection, and only the OUTER
 * `python <path>` invocation drives pytest. This keeps the driver's
 * `python <path>` contract intact while making the verdict exit-code-grounded.
 *
 * pytest exit-code / summary → ReproTestOutcome mapping
 * =====================================================
 * pytest's documented exit codes: 0=all passed, 1=tests failed, 2=interrupted,
 * 3=internal error, 4=usage error, 5=no tests collected. Exit code ALONE is
 * ambiguous (a top-level import crash and a real assertion failure can BOTH
 * surface as exit 1), so we combine the exit code with the parsed summary line
 * ("N failed", "N passed", "N error", "no tests ran"). Priority:
 *
 *   - summary has "failed"  → "reproduced"  (a real assertion FAILED on the base
 *                              tree = the bug is present / red. Wins even if some
 *                              incidental cases passed or errored — a failure is
 *                              still a failure.)
 *   - else summary has "error" (collection/setup/fixture error, no "failed")
 *                            → "exec_failed" (the test could not even RUN — infra,
 *                              NOT a verdict. e.g. fixture raised, collection error.)
 *   - else summary has "passed" (no failed / error)
 *                            → "resolved"    (green — the expected behaviour held.)
 *   - else "no tests ran" / exit 5 (no test items collected)
 *                            → "unknown"     (no def test_*; no signal.)
 *   - else exit ≠ 0 with NO parseable pytest summary (the script crashed BEFORE
 *     reaching the footer — e.g. `import projectlib` ModuleNotFoundError, syntax
 *     error, timeout-kill) → "exec_failed" (infra — project not importable, etc.)
 *   - else exit == 0 with no summary → "unknown" (ran, produced no test signal).
 *   - else exit 3/4 (pytest internal / usage error) with no failed/passed/error
 *                            → "other"       (pytest itself misbehaved — ran, but
 *                              produced an indeterminate result distinct from a
 *                              clean pass/fail. Meaningful, not a catch-all.)
 *
 * The `ReproTestOutcome` union is UNCHANGED — only HOW it is computed changed, so
 * every downstream consumer (driver, calibration, vote) is byte-stable.
 *
 * Slice posture
 * =============
 *   - I/O is INJECTED — the `exec` port is supplied by the caller (production
 *     wiring uses bench's `exec.ts`; tests inject a mock). We DO NOT import
 *     `node:fs` / `Bun.spawn` here.
 *   - file writing is also injected (`writeFile`) so the slice stays
 *     hermetically testable without ever touching the real filesystem.
 *   - cancellation: between samples, if `signal.aborted` is true we stop
 *     dispatching new execs. An in-flight exec is the caller's responsibility
 *     (the bench `exec.ts` honours its own timeout).
 *
 * Closed-port choice: the `exec` callable takes argv form rather than `bash -c`
 * so the temp filename is never word-split / glob-expanded.
 */

import type { ReproTestConfig, ReproTestOutcome, ReproTestSample } from "./types"

/** Default per-test execution timeout (ms). Paper doesn't fix one; 60s is the
 *  same shape used by `tests/smoke/swebench` for individual test commands. */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000

/** pytest documented process exit codes (see pytest `ExitCode`):
 *    0 OK · 1 TESTS_FAILED · 2 INTERRUPTED · 3 INTERNAL_ERROR ·
 *    4 USAGE_ERROR · 5 NO_TESTS_COLLECTED.
 *  Used as a fallback when the summary line is absent/unparseable. */
const PYTEST_EXIT_OK = 0
const PYTEST_EXIT_NO_TESTS = 5
const PYTEST_EXIT_INTERNAL = 3
const PYTEST_EXIT_USAGE = 4

/** Injected exec port shape — minimal surface so production / test wirings
 *  both fit. Production: `(argv, cwd, t) => execArgv(argv, cwd, t)` from
 *  `src/apps/bench/eval/exec.ts`. Tests: in-memory mock. */
export type ReproExecPort = (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>

/** Injected file-write port. Production wraps `Bun.write`. Tests use a Map. */
export type ReproWriteFilePort = (path: string, content: string) => Promise<void>

export interface ExecuteReproTestsArgs {
  /** K test sources (post fence-strip). Empty source ⇒ classified
   *  `"unknown"` (we still record a sample so indices align). */
  tests: readonly string[]
  /** Sandbox path — Python is invoked with this as cwd so the project's
   *  source code resolves on `sys.path` (the repo's own `setup.py` /
   *  `pyproject.toml` decides what's importable). */
  repoRoot: string
  /** Injected exec port. */
  exec: ReproExecPort
  /** Injected file-write port. Default-OFF substitutability — tests inject
   *  a Map-backed shim. */
  writeFile: ReproWriteFilePort
  /** Per-test timeout. Default 60_000. */
  config?: ReproTestConfig
  /** Cancellation signal — checked between samples. */
  signal?: AbortSignal
  /** Override the temp-path generator (used for deterministic tests).
   *  Production wiring uses a `crypto.randomUUID()`-based path under the
   *  repo root. The path returned MUST live INSIDE `repoRoot` so the
   *  script's relative imports resolve. */
  tempPath?: (i: number) => string
  /** Python interpreter to invoke. Default `python3` — modern Ubuntu boxes
   *  (22.04+) ship `python3` only, with NO `python` symlink, so a hardcoded
   *  `python` made `Bun.spawn` throw ENOENT and every sample silently became
   *  `exec_failed`. Override (e.g. a venv python) when the project env lives
   *  behind a specific interpreter. Ignored when {@link buildArgv} is set. */
  pythonBin?: string
  /** Build the FULL argv to execute a repro script. Default `[pythonBin, path]`.
   *  Production SWE-bench wiring overrides this to run the script under the SAME
   *  project env the test command uses (`uv run --with-editable . python <path>`) —
   *  a bare `python3` cannot `import` the project (it is not pip-installed on the
   *  box host; only the uvx ephemeral env has it), so every repro hit
   *  ModuleNotFoundError. The builder receives the script path and returns argv. */
  buildArgv?: (scriptPath: string) => readonly string[]
}

/** Compact a thrown value to a single-line string for the stderr diagnostic. */
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/** What the pytest summary line told us about test items. Computed by a single
 *  pass over the combined stdout/stderr; `null` for a dimension means "the
 *  summary did not mention it". Internal — feeds {@link classifyPytest}. */
interface PytestSummary {
  /** ≥1 test item FAILED an assertion (the summary said "N failed"). */
  hasFailed: boolean
  /** ≥1 test item ERRORED in collection / setup / fixture ("N error[s]"). */
  hasError: boolean
  /** ≥1 test item PASSED ("N passed"). */
  hasPassed: boolean
  /** pytest reported it collected nothing ("no tests ran"). */
  noTests: boolean
  /** ANY recognisable pytest summary token was present — i.e. the process got
   *  far enough to RUN pytest (the footer fired) rather than crashing before
   *  it. Distinguishes a real pytest verdict from an import crash. */
  sawSummary: boolean
}

/** pytest's terse (`-q`) summary tokens. We match on word boundaries so a test
 *  whose NAME contains "failed" can't spoof the summary. pytest prints e.g.
 *  `1 failed in 0.2s`, `2 passed in 0.1s`, `1 failed, 1 passed in 0.3s`,
 *  `1 error in 0.2s`, `no tests ran in 0.1s`. */
const RE_FAILED = /\b\d+\s+failed\b/
const RE_ERROR = /\b\d+\s+errors?\b/
const RE_PASSED = /\b\d+\s+passed\b/
const RE_NO_TESTS = /\bno tests ran\b/

/** Parse pytest's summary out of the combined output. Pure helper. */
const parsePytestSummary = (text: string): PytestSummary => {
  const hasFailed = RE_FAILED.test(text)
  const hasError = RE_ERROR.test(text)
  const hasPassed = RE_PASSED.test(text)
  const noTests = RE_NO_TESTS.test(text)
  return {
    hasFailed,
    hasError,
    hasPassed,
    noTests,
    sawSummary: hasFailed || hasError || hasPassed || noTests,
  }
}

/**
 * Classify a pytest run into a {@link ReproTestOutcome} from EXIT CODE + the
 * parsed summary line. This REPLACES the old stdout-sentinel scan — the verdict
 * now comes from pytest semantics the model cannot author, not from a string the
 * model printed.
 *
 * The summary takes priority over the bare exit code because exit 1 is
 * overloaded (a real assertion failure AND a top-level import crash both exit
 * 1); only the summary disambiguates them. See the module header for the full
 * mapping rationale.
 *
 * Pure — exported for direct unit testing. */
export const classifyPytest = (stdout: string, stderr: string, code: number): ReproTestOutcome => {
  // Defensive: non-strings (e.g. a Buffer slipped through) are treated as empty.
  const out = typeof stdout === "string" ? stdout : ""
  const err = typeof stderr === "string" ? stderr : ""
  const sum = parsePytestSummary(`${out}\n${err}`)

  // 1. A real assertion FAILED ⇒ bug present on the base tree ⇒ reproduced.
  //    Wins even alongside "passed"/"error": a failure is still a failure.
  if (sum.hasFailed) return "reproduced"
  // 2. Collection / setup / fixture ERROR (no failure) ⇒ the test could not be
  //    RUN ⇒ exec_failed (infra), NOT a verdict.
  if (sum.hasError) return "exec_failed"
  // 3. Only PASSED items ⇒ expected behaviour held ⇒ resolved (green).
  if (sum.hasPassed) return "resolved"
  // 4. pytest ran but collected nothing ⇒ no signal ⇒ unknown.
  if (sum.noTests || code === PYTEST_EXIT_NO_TESTS) return "unknown"

  // No parseable pytest summary — the footer either never ran or pytest itself
  // misbehaved. Fall back to the exit code.
  if (code === PYTEST_EXIT_OK) {
    // Ran to a clean exit but produced no test signal at all.
    return "unknown"
  }
  if (code === PYTEST_EXIT_INTERNAL || code === PYTEST_EXIT_USAGE) {
    // pytest's own machinery errored (ran, but the result is indeterminate and
    // distinct from a clean pass/fail) ⇒ "other" (meaningful, not a catch-all).
    return "other"
  }
  // Any other non-zero exit with no summary ⇒ the script crashed BEFORE the
  // footer drove pytest (import error, syntax error, timeout-kill) ⇒ infra.
  return "exec_failed"
}

/** Process-lifetime monotonic counter — guarantees that the crypto-less
 *  fallback id is distinct even for two calls in the SAME millisecond with the
 *  SAME sample index (the exact concurrent-collision the prior `${Date.now()}-${i}`
 *  fallback silently corrupted: two `runInstance` calls would write the SAME
 *  temp script path and cross-contaminate). */
let fallbackCounter = 0

/** Minimal shape of the global `crypto` we depend on (just `randomUUID`). */
type CryptoLike = { randomUUID: () => string }

/** Default temp-path generator. Path lives inside `repoRoot` so the
 *  script can `import` project modules. The filename embeds the sample
 *  index for human inspection during debugging, plus a unique fragment so
 *  parallel `runInstance` calls cannot collide.
 *
 *  `cryptoRef` is injectable ONLY so the no-crypto fallback can be exercised
 *  deterministically in tests; production omits it and the global `crypto`
 *  (present on Bun and Node 19+) is used. We don't import `node:crypto` (heavier
 *  dep). Pass `null` to FORCE the fallback path (test seam); `undefined`/omitted
 *  resolves to the global. (A defaulted `undefined` param can't force the
 *  fallback — JS default-params fire on `undefined` — hence the explicit `null`.)
 *
 *  Exported for direct unit testing of the fallback collision-resistance. */
export const defaultTempPath = (
  repoRoot: string,
  i: number,
  cryptoRef: CryptoLike | null | undefined = undefined,
): string => {
  const c: CryptoLike | null =
    cryptoRef === undefined ? (typeof crypto !== "undefined" ? crypto : null) : cryptoRef
  // Robust fallback: even with NO `crypto`, fold in process.pid + a monotonic
  // counter so two same-ms / same-index calls can NEVER produce the same path
  // (the old `${Date.now()}-${i}` form collided ⇒ cross-contaminated repros).
  const rnd = c !== null ? c.randomUUID() : `${Date.now()}-${process.pid}-${i}-${fallbackCounter++}`
  return `${repoRoot}/__repro_${i}_${rnd}.py`
}

/**
 * Execute every candidate. Returns one {@link ReproTestSample} per input;
 * exec / write exceptions are caught and surfaced as `"exec_failed"`
 * outcomes (so a single bad candidate cannot bring down the whole batch).
 *
 * Sequential: parallel exec would race on shared resources (importable
 * project state, on-disk caches, …) and is the kind of thing the paper
 * also runs in series.
 */
/** Run ONE candidate end-to-end. Extracted to keep `executeReproTests`
 *  under the biome complexity ceiling. Returns a typed sample for every
 *  branch: empty-source → unknown; write failure → exec_failed; exec
 *  exception → exec_failed; success → classifyPytest-derived outcome. */
const executeOne = async (
  source: string,
  i: number,
  args: ExecuteReproTestsArgs,
  timeoutMs: number,
): Promise<ReproTestSample> => {
  if (source === "") return { source, stdout: "", stderr: "", outcome: "unknown" }
  const path = args.tempPath !== undefined ? args.tempPath(i) : defaultTempPath(args.repoRoot, i)
  try {
    await args.writeFile(path, source)
  } catch (e) {
    return { source, stdout: "", stderr: `[writeFile threw] ${errText(e)}`, outcome: "exec_failed" }
  }
  try {
    const argv =
      args.buildArgv !== undefined ? args.buildArgv(path) : [args.pythonBin ?? "python3", path]
    const r = await args.exec(argv, args.repoRoot, timeoutMs)
    const stdout = typeof r.stdout === "string" ? r.stdout : ""
    const stderr = typeof r.stderr === "string" ? r.stderr : ""
    const code = typeof r.code === "number" ? r.code : -1
    return { source, stdout, stderr, outcome: classifyPytest(stdout, stderr, code) }
  } catch (e) {
    // The exec PORT threw (e.g. Bun.spawn ENOENT — the python binary is not on
    // PATH) BEFORE the process produced any output. Capture the throw reason so
    // an `exec_failed` is never silent again (the prior version dropped it,
    // making a missing-binary indistinguishable from a crashed script).
    return { source, stdout: "", stderr: `[exec threw] ${errText(e)}`, outcome: "exec_failed" }
  }
}

export const executeReproTests = async (
  args: ExecuteReproTestsArgs,
): Promise<readonly ReproTestSample[]> => {
  const timeoutMs = args.config?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const out: ReproTestSample[] = []
  for (let i = 0; i < args.tests.length; i++) {
    if (args.signal?.aborted === true) break
    const source = args.tests[i] ?? ""
    out.push(await executeOne(source, i, args, timeoutMs))
  }
  return out
}
