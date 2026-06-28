/**
 * Repro-test execution — runs each candidate as a pytest test on the ORIGINAL
 * (un-patched) repo and classifies the outcome from the controlled pytest
 * sidecar report, NOT from stdout, process-code-only semantics, or a
 * model-printed sentinel.
 *
 * P1 — EXECUTION-GROUNDED verdict (jun-23)
 * ========================================
 * The legacy oracle scanned stdout for sentinel verdicts the LLM authored
 * itself. The model wrote its own verdict, so it was fakeable/paraphrasable and
 * 6/10 generated repros self-judged into non-proof states. We replace that with a deterministic pytest hook
 * report: a canonical repro is a real `def test_*` with `assert`s on the
 * EXPECTED behavior. On the BUGGY base tree an assertion/pytest.fail call
 * failure is red; on a CORRECT fix the call passes. Raw exceptions, collection
 * failures, missing sidecars, and malformed reports are infra/invalid-test
 * failures and cannot be admitted as proof.
 *
 * The `python <path>` → pytest bridge
 * ===================================
 * The driver invokes a repro as `python <path>` (its `reproRunArgv`/`buildArgv`
 * contract, owned by out-of-fence code). A pytest test must run UNDER pytest. So
 * the GENERATED test file ends with a self-driving footer:
 *
 *     if __name__ == "__main__":
 *         ... install _QuantaPytestReport hook ...
 *         sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider"], plugins=[...]))
 *
 * Run as `python <path>`, the module executes, hits the guard, and pytest runs
 * ITSELF — the process EXIT CODE then reflects pass/fail. The `__name__ ==
 * "__main__"` guard is LOAD-BEARING: without it, pytest re-imports the file
 * during its own collection and the footer fires recursively ("error during
 * collection"), destroying the verdict (exit 2 for both pass and fail). With the
 * guard, collection imports the module under its test-module name (not
 * "__main__"), the footer is inert during collection, and only the OUTER
 * `python <path>` invocation drives pytest. This keeps the driver's
 * `python <path>` contract intact while making the verdict report-grounded.
 *
 * Sidecar → ReproTestOutcome mapping
 * ==================================
 *   - call-phase AssertionError / pytest.fail failure → "reproduced"
 *   - call-phase RAW exception from code under test
 *     (TypeError/AttributeError/KeyError/…)            → "reproduced"
 *   - all collected call reports passed                 → "resolved"
 *   - no collected tests                                → "unknown"
 *   - collection/setup/teardown failure, pytest ERROR,
 *     import/syntax exception (even at call phase),
 *     missing/malformed sidecar                         → "exec_failed"
 *   - pytest internal/usage exitstatus in sidecar       → "other"
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

import { errMessage } from "@/shared"
import {
  classifyPytestReportText,
  parsePytestExecutionReport,
  pytestReportPathFor,
} from "./pytest-report"
import type {
  ReproControlOutcome,
  ReproExecFailureKind,
  ReproTestConfig,
  ReproTestOutcome,
  ReproTestSample,
} from "./types"

/** Default per-test execution timeout (ms). Paper doesn't fix one; 60s is the
 *  same shape used by `tests/smoke/swebench` for individual test commands. */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000

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

/** Injected sidecar-read port. Production wraps `Bun.file(path).text()`. */
export type ReproReadFilePort = (path: string) => Promise<string>

export interface ExecuteReproTestsArgs {
  /** K test sources (post fence-strip). Empty source ⇒ classified
   *  `"unknown"` (we still record a sample so indices align). */
  tests: readonly string[]
  /** G2 paired-control: OPTIONAL per-symptom-test control sources (parallel to
   *  {@link tests}). Each entry is itself a list of control-test sources (happy
   *  / edge cases produced by the SAME repro-gen, NEVER the gold). When present
   *  for sample `i`, each control is executed on the BASE tree and the resulting
   *  {@link ReproControlOutcome} is folded into `sample.baseControl`:
   *    - every control PASSES (outcome `"resolved"`) ⇒ `"green"`
   *    - any control fails / errors / doesn't run     ⇒ `"red"`
   *  Omitted / empty for sample `i` ⇒ `baseControl` stays undefined (the
   *  admission gate treats undefined as `"absent"` ⇒ fail-closed). This is the
   *  REAL field-population seam; only the control-SOURCE generation (the LLM
   *  prompt) is a separate follow-up. */
  controlTests?: readonly (readonly string[])[]
  /** Sandbox path — Python is invoked with this as cwd so the project's
   *  source code resolves on `sys.path` (the repo's own `setup.py` /
   *  `pyproject.toml` decides what's importable). */
  repoRoot: string
  /** Injected exec port. */
  exec: ReproExecPort
  /** Injected file-write port. Default-OFF substitutability — tests inject
   *  a Map-backed shim. */
  writeFile: ReproWriteFilePort
  /** Read the deterministic pytest report sidecar written by the controlled
   * footer. Missing read port/report is fail-closed as exec_failed; stdout is
   * never an authority fallback. */
  readFile?: ReproReadFilePort
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
const errText = (e: unknown): string => errMessage(e)

/**
 * Back-compat pure classifier surface. The arguments are intentionally ignored:
 * stdout/stderr/process code are not oracle authority. Callers that need a real
 * verdict must pass the controlled sidecar JSON text as stdout.
 */
export const classifyPytest = (stdout: string, _stderr: string, _code: number): ReproTestOutcome =>
  classifyPytestReportText(typeof stdout === "string" ? stdout : "")

export { classifyPytestReportText, parsePytestExecutionReport, pytestReportPathFor }

/**
 * F3D — classify the CAUSE of an `exec_failed` outcome (PURE).
 *
 * The single discriminator is "did pytest actually RUN and emit a parseable
 * sidecar report?":
 *
 *   - exec port threw (ENOENT / python-missing / spawn failure) ⇒ the process
 *     never produced output ⇒ `infra_unavailable`.
 *   - no report text at all (read port absent, sidecar never written because the
 *     process was killed at launch / timeout-kill / exit 127) ⇒ `infra_unavailable`.
 *   - report text present but UNPARSEABLE (not the schema-1 JSON the controlled
 *     footer writes) ⇒ the footer never completed a real pytest run ⇒
 *     `infra_unavailable`.
 *   - a PARSEABLE schema-1 report exists ⇒ pytest RAN. Whatever failure it
 *     describes (collection/setup/import error) is a `test_errored` — the
 *     harness worked, the TEST is the problem.
 *
 * Never inspects exit code as authority (the project's heuristic-free posture):
 * the presence of a real pytest report is the ground truth that it ran.
 */
export const classifyExecFailureKind = (args: {
  /** The raw sidecar report text read back, or `undefined` if none was read. */
  readonly reportText: string | undefined
  /** True iff the exec/write port THREW before any report could exist. */
  readonly execThrew?: boolean
}): ReproExecFailureKind => {
  if (args.execThrew === true) return "infra_unavailable"
  if (args.reportText === undefined) return "infra_unavailable"
  return parsePytestExecutionReport(args.reportText) === null ? "infra_unavailable" : "test_errored"
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
    // F3D: the file could not even be written ⇒ the harness never ran ⇒ infra.
    return {
      source,
      stdout: "",
      stderr: `[writeFile threw] ${errText(e)}`,
      outcome: "exec_failed",
      execFailure: "infra_unavailable",
    }
  }
  try {
    const argv =
      args.buildArgv !== undefined ? args.buildArgv(path) : [args.pythonBin ?? "python3", path]
    const r = await args.exec(argv, args.repoRoot, timeoutMs)
    const stdout = typeof r.stdout === "string" ? r.stdout : ""
    const stderr = typeof r.stderr === "string" ? r.stderr : ""
    const reportPath = pytestReportPathFor(path)
    if (args.readFile === undefined) {
      // F3D: no read port ⇒ no sidecar can be inspected ⇒ infra (cannot prove
      // pytest ran), never a test signal.
      return {
        source,
        stdout,
        stderr: `${stderr}\n[pytest report missing read port] ${reportPath}`.trim(),
        outcome: "exec_failed",
        execFailure: "infra_unavailable",
      }
    }
    try {
      const reportText = await args.readFile(reportPath)
      const outcome = classifyPytestReportText(reportText)
      // F3D: attach the cause ONLY when the outcome is exec_failed. A parseable
      // schema-1 report ⇒ pytest RAN ⇒ test_errored; otherwise ⇒ infra.
      // A1: surface the RAW report bytes (sidecarReport) for per-candidate artifact
      // persistence — RCA reconstructs the node-level verdict, not just `outcome`.
      return outcome === "exec_failed"
        ? {
            source,
            stdout,
            stderr,
            outcome,
            sidecarReport: reportText,
            execFailure: classifyExecFailureKind({ reportText }),
          }
        : { source, stdout, stderr, outcome, sidecarReport: reportText }
    } catch (e) {
      // F3D: the sidecar could not be READ (process produced no report — killed
      // at launch / timeout-kill / exit 127) ⇒ infra, not a test verdict.
      return {
        source,
        stdout,
        stderr: `${stderr}\n[pytest report read failed] ${reportPath}: ${errText(e)}`.trim(),
        outcome: "exec_failed",
        execFailure: "infra_unavailable",
      }
    }
  } catch (e) {
    // The exec PORT threw (e.g. Bun.spawn ENOENT — the python binary is not on
    // PATH) BEFORE the process produced any output. Capture the throw reason so
    // an `exec_failed` is never silent again (the prior version dropped it,
    // making a missing-binary indistinguishable from a crashed script).
    // F3D: a port throw is unambiguous infrastructure (could not run).
    return {
      source,
      stdout: "",
      stderr: `[exec threw] ${errText(e)}`,
      outcome: "exec_failed",
      execFailure: "infra_unavailable",
    }
  }
}

/** G2 paired-control: run one control test on the base tree, reusing the SAME
 *  pytest bridge as the symptom test. A control is "passing" iff its outcome is
 *  `"resolved"` (all collected call reports passed in a healthy env). Anything
 *  else (`exec_failed` import/env break, `reproduced`, `other`, `unknown`)
 *  signals the env cannot be trusted to certify the symptom's base-red. */
const runOneControl = async (
  source: string,
  i: number,
  args: ExecuteReproTestsArgs,
  timeoutMs: number,
): Promise<boolean> => {
  if (source === "") return false
  const sample = await executeOne(source, i, args, timeoutMs)
  return sample.outcome === "resolved"
}

/** Execute every paired control for sample `i` on the base tree and fold the
 *  results into a single {@link ReproControlOutcome}. Empty ⇒ undefined (the
 *  gate treats it as `"absent"`). All controls pass ⇒ `"green"`; any control
 *  not-green ⇒ `"red"`. The control script indices are offset past the symptom
 *  index space so temp paths never collide with the symptom tests. */
const evaluateControls = async (
  controls: readonly string[] | undefined,
  symptomIndex: number,
  args: ExecuteReproTestsArgs,
  timeoutMs: number,
): Promise<ReproControlOutcome | undefined> => {
  if (controls === undefined || controls.length === 0) return undefined
  for (let j = 0; j < controls.length; j++) {
    if (args.signal?.aborted === true) return "red"
    // Offset the index so the control's temp file path is distinct from the
    // symptom test's (defaultTempPath embeds the index).
    const controlIndex = (symptomIndex + 1) * 1000 + j
    const passed = await runOneControl(controls[j] ?? "", controlIndex, args, timeoutMs)
    if (!passed) return "red"
  }
  return "green"
}

export const executeReproTests = async (
  args: ExecuteReproTestsArgs,
): Promise<readonly ReproTestSample[]> => {
  const timeoutMs = args.config?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const out: ReproTestSample[] = []
  for (let i = 0; i < args.tests.length; i++) {
    if (args.signal?.aborted === true) break
    const source = args.tests[i] ?? ""
    const sample = await executeOne(source, i, args, timeoutMs)
    // G2 paired-control: when controls are supplied for this sample, run them on
    // the base tree and attach the verdict. This is what populates the field the
    // admission gate reads — without it the gate would fail-closed on every
    // sample (undefined ⇒ "absent"). Symptom-test indices stay 0..K-1; control
    // temp paths are offset so they never collide.
    const baseControl = await evaluateControls(args.controlTests?.[i], i, args, timeoutMs)
    out.push(baseControl !== undefined ? { ...sample, baseControl } : sample)
  }
  return out
}
