/** Epic-2 — normalized test-run result shared by every language parser. */

export interface TestFailure {
  /** Test identifier (e.g. `TestFail`, `tests::fail_test`, `test_fail (m.T)`). */
  readonly name: string
  /** Source file the failure points at, when the runner reports it. */
  readonly file?: string
  /** 1-based line, when reported. */
  readonly line?: number
  /** First useful failure/assertion message, when reported. */
  readonly message?: string
}

export interface TestRunResult {
  /** Which parser produced this (`go` / `cargo` / `python-unittest` / …). */
  readonly runner: string
  /** Count of passing tests (best-effort; some runners don't report it). */
  readonly passed: number
  readonly failed: readonly TestFailure[]
  /** True iff the suite had ZERO failures. */
  readonly ok: boolean
}

/** Detected project toolchain + how to test it. */
export interface Toolchain {
  readonly kind: "go" | "rust" | "python" | "node"
  /** argv to run the suite. */
  readonly command: readonly string[]
  /** Which parser to apply to the output. */
  readonly parser: "go" | "cargo" | "python-unittest" | "generic"
}
