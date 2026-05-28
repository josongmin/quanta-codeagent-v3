/**
 * ADR-0396 — Shadow Verify port contract (Wave 1: port + runner only).
 *
 * Multi-file edits change UX more by PRE-APPLY VERIFICATION than by the
 * proposal itself. This slice defines a closed port that applies a patch to
 * a SCRATCH overlay (never the real workspace), runs lint/typecheck/targeted
 * tests there, and returns failing diagnostics — so the agent can show
 * "fixed it AND here's where it breaks" before touching real files.
 *
 * Slice fence (ADR-0396): this slice NEVER imports `@/agent` core, `@/apps`,
 * `@/lsp`, `@/tool`, `@/patch`, or `@/runtime`. The scratch/applier/checker
 * are INJECTED ports satisfied by fakes in tests. Wave 2 wires the real
 * worktree provider + V4A applier + LSP-diagnostics adapters and registers
 * the verifier into the loop / as an LLM tool.
 */

/** The three check kinds a shadow verify can run in the scratch overlay. */
export type ShadowCheck = "lint" | "typecheck" | "test"

export interface ShadowVerifyRequest {
  /** V4A or unified diff — opaque to this slice (passed straight to the applier dep). */
  readonly patch: string
  readonly checks: readonly ShadowCheck[]
  /** Targeted test path/pattern forwarded to the "test" check only. */
  readonly testTarget?: string
}

export interface ShadowDiagnostic {
  readonly file: string
  readonly line: number
  readonly col?: number
  readonly severity: "error" | "warning" | "info"
  readonly message: string
  readonly source: ShadowCheck
}

export interface ShadowVerifyResult {
  /** true iff applied && no "error"-severity diagnostics. */
  readonly ok: boolean
  /** did the patch apply cleanly to the scratch overlay. */
  readonly applied: boolean
  readonly diagnostics: readonly ShadowDiagnostic[]
}

/**
 * Injected dependencies (slice fence — this slice NEVER imports the real
 * impls). Each is NO-THROW from the runner's POV: the runner wraps calls in
 * try/catch and converts thrown errors into error-severity diagnostics.
 */
export interface ShadowScratchPort {
  /** Create an isolated scratch overlay, return an opaque handle; dispose() cleans it. */
  open(signal?: AbortSignal): Promise<{ handle: string; dispose: () => Promise<void> }>
}

export interface ShadowApplyPort {
  apply(
    handle: string,
    patch: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }>
}

export interface ShadowCheckPort {
  /** Run one check kind against the scratch overlay; return diagnostics (possibly empty). */
  run(
    handle: string,
    check: ShadowCheck,
    testTarget: string | undefined,
    signal?: AbortSignal,
  ): Promise<readonly ShadowDiagnostic[]>
}

export interface ShadowVerifyPort {
  verify(req: ShadowVerifyRequest, signal?: AbortSignal): Promise<ShadowVerifyResult>
}

export interface ShadowVerifyDeps {
  readonly scratch: ShadowScratchPort
  readonly applier: ShadowApplyPort
  readonly checker: ShadowCheckPort
}
