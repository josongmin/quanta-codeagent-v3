/**
 * `@/codemode` — types for the QuickJS-WASM code-cell sandbox (RFC
 * jun-6-code-mode §10). This slice is the DUMB SANDBOX: it knows it has a
 * {@link CodeCellDispatchPort} to call, NOTHING about `dispatchTool`,
 * permission, or the agent loop. The security-critical binding that routes the
 * port to the REAL dispatcher lives in `@/agent/codemode-wire.ts` (the only
 * implementation of the port). Inversion-of-control IS the security boundary.
 *
 * Slice fence (RFC §5.1): `@/codemode` imports ONLY `node:*` / the WASM dep
 * (`quickjs-emscripten`) / `@/shared` (runtime-config, errMessage) / `@/security`
 * (redaction of the cell's model-facing output). It imports NO `@/agent`,
 * `@/permission`, `@/tool` — the port is the ONLY channel to the host.
 */

/**
 * The TERMINAL outcome of ONE in-cell `tools.X(args)` dispatch, marshalled back
 * across the WASM boundary. The sandbox resolves the cell's `await` with
 * `content` on `ok`, or THROWS a typed JS error (`{name, tool, reason}`) into
 * the cell on a non-ok outcome (the model MAY `try/catch` it, but a caught deny
 * does NOT make the underlying action happen — RFC §4.5).
 *
 * The shape is intentionally MINIMAL: the host port has already run the full
 * `dispatchTool` pipeline (admissibility gate / HARD_DENY / plan-mode /
 * redaction) and collapsed the result to model-facing content + an ok flag. The
 * sandbox never sees a permission context, a raw tool, or the registry.
 */
export interface DispatchOutcome {
  /** Whether the underlying `dispatchTool` produced an `ok` tool_result. */
  readonly ok: boolean
  /** The model-facing tool_result content (already redacted by the host). On a
   *  non-ok outcome this is the deny/error message surfaced into the cell's
   *  thrown error `reason`. */
  readonly content: string
}

/**
 * The CLOSED port the sandbox calls for every in-cell tool invocation. The ONLY
 * way `@/codemode` can affect the host. `(name, input) => Promise<DispatchOutcome>`.
 *
 * SECURITY INVARIANT (RFC §6.1): the only implementation
 * (`@/agent/codemode-wire.ts#buildCodeCellDispatchPort`) routes EVERY call
 * through the SAME `dispatchTool` the loop uses with the SAME live
 * `config`/`permission`/`autoClassifier`. A code cell is, to the permission
 * system, N ordinary gated tool calls.
 */
export type CodeCellDispatchPort = (name: string, input: unknown) => Promise<DispatchOutcome>

/** Hard resource caps for one cell run (RFC §4.4). Every field has a
 *  runtime-config-derived default in the tool layer; the runtime treats these
 *  as already-resolved numbers. */
export interface CodeCellLimits {
  /** WASM heap cap in bytes (`runtime.setMemoryLimit`). */
  readonly memoryBytes: number
  /** Wall-clock deadline in ms (interrupt handler). */
  readonly timeoutMs: number
  /** Max in-cell tool dispatches before the binding throws a typed `ToolCap`
   *  into the cell (prevents a runaway fan-out from issuing 10^6 dispatches). */
  readonly maxCalls: number
  /** Max bytes of the JSON-stringified return value + captured console retained
   *  on the result (`[truncated]` marker past the cap). */
  readonly outputCap: number
}

/** The closed status of a finished cell run. */
export type CodeCellStatus =
  | "ok" // the program returned (or completed) without an uncaught throw
  | "error" // an uncaught throw / parse error inside the cell
  | "timeout" // the deadline interrupt fired
  | "memory" // the WASM heap cap was hit
  | "cap" // the per-cell tool-call cap was hit
  | "aborted" // the host AbortSignal fired

/** One in-cell tool dispatch recorded for the per-cell ledger (RFC §4.3). The
 *  ledger carries CATEGORICAL data only — tool name + terminal outcome enum,
 *  NEVER the tool input or result bytes (no-leak discipline, RFC §6.3). */
export interface CellToolCallRecord {
  readonly seq: number
  readonly tool: string
  readonly outcome: "ok" | "denied" | "error"
}

/** The typed result of running one cell. NEVER thrown — every failure (parse,
 *  uncaught throw, timeout, memory, cap, abort) is a typed value (RFC §4.5).
 *  `output` is the redacted, capped model-facing text. */
export interface CodeCellResult {
  readonly status: CodeCellStatus
  /** Redacted + capped model-facing text: the JSON-stringified return value on
   *  success, or the redacted error message on a non-ok status. */
  readonly output: string
  /** Per-call ledger — what the cell dispatched across its whole run. */
  readonly toolCalls: readonly CellToolCallRecord[]
  /** Number of dispatches the cell issued (=== `toolCalls.length`; surfaced
   *  separately so the security proof can assert call-count == iteration-count). */
  readonly callCount: number
  /** True when the output was truncated past {@link CodeCellLimits.outputCap}. */
  readonly truncated: boolean
}

/** Options for one {@link runCodeCell} invocation. */
export interface RunCodeCellOptions {
  /** The model-authored JS program (the "code cell"). */
  readonly code: string
  /** The host dispatch port — the ONLY channel to the real tool layer. */
  readonly dispatch: CodeCellDispatchPort
  /** The tool names to bind on the cell's `tools.*` object (RFC §4.2 / Phase 2
   *  full surface). When ABSENT, the runtime falls back to the Phase-1 3-tool
   *  surface (`read`/`grep`/`write`) so every existing caller is byte-identical.
   *  When provided (the host passes `registry.toolNames()`), the cell binds the
   *  agent's FULL registered set — each STILL routed through the same injected
   *  {@link CodeCellDispatchPort} (security unchanged; just more tools exposed).
   *  A tool name NOT in this list is simply ABSENT from `tools` — the cell can
   *  never widen its own surface past what the loop exposes. */
  readonly surfaceTools?: readonly string[]
  /** Resolved hard caps. */
  readonly limits: CodeCellLimits
  /** The loop's AbortSignal — interrupts the cell + disposes the runtime. */
  readonly signal: AbortSignal
  /** Monotonic clock (injected — NO `Date.now()` in-slice). Returns ms. */
  readonly now: () => number
}
