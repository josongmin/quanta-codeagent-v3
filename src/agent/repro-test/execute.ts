/**
 * Repro-test execution — runs each candidate Python script on the ORIGINAL
 * (un-patched) repo and classifies the outcome from stdout.
 *
 * Paper §3.3.1 algorithm (this file's slice)
 * ==========================================
 *   1. Write each candidate to a unique temp file path inside the repo's
 *      working tree (so relative imports of the project's source code work).
 *   2. Run `python <file>` with a hard timeout, in the repo cwd.
 *   3. Inspect stdout for one of three sentinel substrings:
 *        - "Issue reproduced"  → outcome "reproduced"  (bug present)
 *        - "Issue resolved"    → outcome "resolved"    (already fixed)
 *        - "Other issues"      → outcome "other"       (script blew up)
 *      The LAST occurrence wins (paper §3.3.1 — a script that hits an
 *      `except` then continues might print multiple lines; the final line
 *      is the script's settled verdict).
 *   4. If exec exited non-zero AND no marker line appeared, classify
 *      `"exec_failed"` (timeout / crash before reaching a print).
 *   5. If exec exited zero but no marker line appeared, classify
 *      `"unknown"` (LLM emitted a no-op or paraphrased the sentinels).
 *
 * Slice posture
 * =============
 *   - I/O is INJECTED — the `exec` port is supplied by the caller
 *     (production wiring uses bench's `exec.ts` `bash -c`; tests inject a
 *     mock). We DO NOT import `node:fs` / `Bun.spawn` here.
 *   - file writing is also injected (`writeFile`) so the slice stays
 *     hermetically testable without ever touching the real filesystem.
 *   - cancellation: between samples, if `signal.aborted` is true we stop
 *     dispatching new execs. An in-flight exec is the caller's
 *     responsibility (the bench `exec.ts` honours its own timeout).
 *
 * Closed-port choice: the `exec` callable takes argv form rather than
 * `bash -c` so the temp filename is never word-split / glob-expanded. The
 * production wiring builds a wrapper that translates to `bash -c "python
 * '<file>'"` if it must; we recommend argv. Both shapes are equivalent here.
 */

import type { ReproTestConfig, ReproTestOutcome, ReproTestSample } from "./types"

/** Default per-test execution timeout (ms). Paper doesn't fix one; 60s is the
 *  same shape used by `tests/smoke/swebench` for individual test commands. */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000

/** Marker substrings — paper §3.3.1 verbatim. Order matters only for
 *  documentation; the classifier scans stdout once and picks the LAST
 *  occurrence (regardless of marker kind). */
const MARKER_REPRODUCED = "Issue reproduced"
const MARKER_RESOLVED = "Issue resolved"
const MARKER_OTHER = "Other issues"

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

/** Classify stdout into a {@link ReproTestOutcome}, applying the
 *  last-marker-wins rule. `code` decides between `"exec_failed"` and
 *  `"unknown"` when no marker is present.
 *
 *  Pure — exported for direct unit testing. */
export const classifyStdout = (stdout: string, code: number): ReproTestOutcome => {
  // Defensive: a non-string (e.g. Buffer slipped through) is treated as
  // empty output, NOT crashed at runtime.
  const s = typeof stdout === "string" ? stdout : ""
  // Find the LAST occurrence of any marker. We do this with a single pass
  // by tracking three indices and picking the maximum.
  const iReproduced = s.lastIndexOf(MARKER_REPRODUCED)
  const iResolved = s.lastIndexOf(MARKER_RESOLVED)
  const iOther = s.lastIndexOf(MARKER_OTHER)
  const max = Math.max(iReproduced, iResolved, iOther)
  if (max < 0) {
    // No marker present.
    return code !== 0 ? "exec_failed" : "unknown"
  }
  if (max === iResolved) return "resolved"
  if (max === iReproduced) return "reproduced"
  return "other"
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
 *  exception → exec_failed; success → classifyStdout-derived outcome. */
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
    return { source, stdout, stderr, outcome: classifyStdout(stdout, code) }
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
