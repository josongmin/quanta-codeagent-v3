/**
 * TB — regression oracle (engine port + pure run/parse).
 *
 * Runs an IMPACTED-TEST set in the patched sandbox and reports whether the
 * candidate broke any of them. This is the `HardGate.regressionGreen` source
 * for the VerificationBundle: a candidate that regresses an existing test is
 * inadmissible.
 *
 * ── No-leak invariant (STRUCTURAL) ───────────────────────────────────────────
 * This engine module is AGNOSTIC to where the test set comes from. It knows
 * only a `tests: string[]` argument. It MUST NOT import or name any official
 * SWE-bench hidden field — there is no `PASS_TO_PASS` / `FAIL_TO_PASS` /
 * `test_patch` string anywhere in this file. The bench adapter
 * (`src/runner/batch/eval/regression-oracle-adapter.ts`) supplies the concrete
 * test ids (PASS_TO_PASS) from the eval-only oracle side, exactly the same
 * boundary `closure-diagnostics` uses for gold files. A `regression-oracle.ts`
 * that imported PASS_TO_PASS would leak the bench label into the engine SSOT —
 * a slice-fence test asserts this file stays clean.
 *
 * ── Fail-open ────────────────────────────────────────────────────────────────
 * `toRegressionGreen` maps a run to the `boolean | null` signal: an empty /
 * absent test set ⇒ `null` (FAIL-OPEN — a missing regression run NEVER rejects
 * a candidate). Only a real run with a non-zero exit reports `false`.
 *
 * The pass DECISION is the runner's exit code (0 ⇒ all passed) — robust and
 * heuristic-free. The parsed `failed` node-ids are ADVISORY (for the repair
 * seed / diagnostics), not part of the pass decision.
 */

/** Injected exec port (argv form) — same shape as the repro-test exec port so
 *  the bench wiring and test fixtures both fit. */
export type RegressionExecPort = (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>

export interface RegressionRunArgs {
  /** The impacted-test set to run (e.g. pytest node-ids). The port is agnostic
   *  to provenance — the bench adapter supplies these from the eval-only side. */
  tests: readonly string[]
  /** Patched sandbox path (cwd for the test runner). */
  sandbox: string
  /** Injected exec port. */
  exec: RegressionExecPort
  /** Per-run timeout (ms). */
  timeoutMs: number
  /** argv builder: (tests) => runner argv. The bench adapter builds the
   *  project-env pytest command; fixtures inject a deterministic fake. */
  buildArgv: (tests: readonly string[]) => readonly string[]
  /** Exit codes that represent a REAL pass/fail verdict (vs "couldn't run").
   *  Default = pytest's `{0: all-passed, 1: tests-failed}` (a documented
   *  contract, not a tuned threshold). Any OTHER code (2 interrupted, 3
   *  internal, 4 usage, 5 no-tests-collected) ⇒ `ran:false` ⇒ FAIL-OPEN.
   *  Override for a non-pytest runner whose exit semantics differ. */
  verdictCodes?: readonly number[]
}

/** pytest `ExitCode`: 0 OK, 1 TESTS_FAILED are the only codes carrying a real
 *  verdict; 2/3/4/5 mean it never got there. */
const PYTEST_VERDICT_CODES: readonly number[] = [0, 1]

export interface RegressionResult {
  /** True ⇒ the runner exited 0 (no test broke). Only MEANINGFUL when `ran`. */
  pass: boolean
  /** True ⇒ the runner produced a real pass/fail VERDICT (pytest exit 0 or 1).
   *  False ⇒ it could not (no tests collected / usage error / interrupted —
   *  pytest exit 2/3/4/5, or an empty input set). Drives the FAIL-OPEN mapping:
   *  a run that never reached a verdict must NEVER reject a candidate. */
  ran: boolean
  /** Best-effort parsed failing test ids (advisory; empty when `pass`/`!ran`). */
  failed: readonly string[]
}

export interface RunImpactedTestsPort {
  run(args: RegressionRunArgs): Promise<RegressionResult>
}

/** pytest emits `FAILED <nodeid>` / `ERROR <nodeid>` lines in its short summary
 *  (and `<nodeid> FAILED` in `-v`). Parse both, deduped, order-preserving.
 *  Advisory only — never feeds the pass decision.
 *
 *  Robustness: strip an xdist worker tag (`[gw0] FAILED …`) and progress
 *  columns first, and accept a captured token only if it has node-id SHAPE
 *  (contains `::` or ends `.py`) — so `[gw0]` / `at` (from "ERROR at setup of
 *  …") are not mis-captured as test ids. Lines whose id we cannot shape-verify
 *  are simply dropped (advisory tolerance), never guessed. */
const looksLikeNodeId = (s: string): boolean => s.includes("::") || s.endsWith(".py")

export const parseFailedTests = (output: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of output.split("\n")) {
    // Drop a leading xdist worker tag so the verbose-form regex can't grab it.
    const line = raw.trim().replace(/^\[gw\d+\]\s*/, "")
    // `FAILED path::test` / `ERROR path::test` (incl. "ERROR at setup of <id>").
    let id: string | null = null
    let m = /^(?:FAILED|ERROR)(?:\s+at\s+(?:setup|teardown)\s+of)?\s+(\S+)/.exec(line)
    if (m !== null) id = m[1] as string
    // `path::test FAILED` / `path::test ERROR` (verbose form).
    else {
      m = /^(\S+)\s+(?:FAILED|ERROR)\b/.exec(line)
      if (m !== null) id = m[1] as string
    }
    if (id !== null && looksLikeNodeId(id) && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** Default engine impl: run `buildArgv(tests)` once in the sandbox. `pass` ⇔
 *  exit 0; `ran` ⇔ the exit code is a real verdict (default pytest `{0,1}`) —
 *  a "no tests collected / usage error" exit is `ran:false` (FAIL-OPEN), NOT a
 *  regression. No fs / spawn here — all I/O is the injected `exec`. */
export const makeRegressionOracle = (): RunImpactedTestsPort => ({
  run: async ({ tests, sandbox, exec, timeoutMs, buildArgv, verdictCodes }) => {
    if (tests.length === 0) return { pass: true, ran: false, failed: [] }
    const { code, stdout, stderr } = await exec(buildArgv(tests), sandbox, timeoutMs)
    const ran = (verdictCodes ?? PYTEST_VERDICT_CODES).includes(code)
    const pass = code === 0
    // Advisory ids ONLY for a real failing verdict; a non-verdict exit (e.g.
    // collection error) has no failing tests to report.
    const failed = ran && !pass ? parseFailedTests(`${stdout}\n${stderr}`) : []
    return { pass, ran, failed }
  },
})

/**
 * Map a regression run to the `HardGate.regressionGreen` signal. FAIL-OPEN ⇒
 * `null` (no objection) when:
 *   - the test set was empty,
 *   - the run is absent (`result === null`, e.g. exec threw and the caller
 *     swallowed it), OR
 *   - the runner never reached a verdict (`!result.ran` — no tests collected /
 *     usage error / interrupted). A non-verdict exit must NEVER reject a
 *     candidate (the exit-5 false-RED that defeats the whole invariant).
 * Only a real verdict maps to its `pass` boolean.
 */
export const toRegressionGreen = (
  tests: readonly string[],
  result: RegressionResult | null,
): boolean | null => {
  if (tests.length === 0 || result === null || !result.ran) return null
  return result.pass
}
