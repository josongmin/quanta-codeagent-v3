/**
 * ADR-0177 — Streaming cancellation + cleanup orchestration.
 *
 * Universal SOTA gap closure: every modern agent (Cursor, Claude Code, Codex,
 * Cline, OpenHands) supports cancelling in-flight LLM streams with clean
 * teardown of partial state. Our pre-feature path already threads a plain
 * `AbortSignal` through `StreamInput.signal` at the provider port (see
 * `src/llm/types.ts`), but the loss of (a) typed cancel cause, (b) cleanup
 * orchestration, and (c) partial-result salvage policy means callers can't
 * tell "user pressed Esc" from "budget breached" from "verify-guard
 * tripped" — and any resource teardown happens ad-hoc.
 *
 * This module is the TYPE LAYER. It introduces a closed-port discriminated
 * cause + a controller surface; the implementation lives in `./default.ts`
 * and the LLM-stream salvage wrap lives in `./llm-stream-cancel.ts`.
 *
 * Plane-clean: this file imports NO siblings — types only. Default-OFF: no
 * existing caller wires the controller in, so byte-identical until opt-in.
 */

/** The "why" of a cancellation. Closed union — adding an arm is an ADR.
 *
 * Each arm is the caller's explicit declaration of intent at the moment of
 * `cancel()`. The signal carries this verbatim through to cleanup handlers and
 * the resulting {@link CancellationOutcome}; downstream consumers (metrics,
 * jsonl recorder, surface UIs) can branch on it without sniffing strings.
 *
 * Names mirror common SOTA semantics:
 *  - `user-abort`        — Claude Code Esc, Cursor Cmd-K, Codex Ctrl+C.
 *  - `budget-breach`     — BudgetLedger hard limit (ADR-0138).
 *  - `timeout`           — per-turn wall-clock cap (deadline elapsed).
 *  - `verify-guard`      — verify-guard hard gate (ADR-0123).
 *  - `permission-deny`   — HITL deny issued mid-stream.
 *  - `side-conversation` — `/side` spawn pauses the parent.
 *  - `compaction-needed` — pre-token-limit hit; parent must compact + resume.
 *  - `host-shutdown`     — process is going down (SIGTERM / surface unload).
 *  - `external`          — generic adapter from a plain `AbortSignal` whose
 *                          origin we cannot type more precisely. Reserved for
 *                          the `fromAbortSignal()` adapter so callers can
 *                          still hand us third-party signals losslessly. */
export type CancellationCause =
  | "user-abort"
  | "budget-breach"
  | "timeout"
  | "verify-guard"
  | "permission-deny"
  | "side-conversation"
  | "compaction-needed"
  | "host-shutdown"
  | "external"

/** A typed, observable cancellation signal.
 *
 * Mirrors the shape of WHATWG `AbortSignal` (so adapters can round-trip) but
 * adds `cause` + `abortedAt` for ledger / metrics consumers. Listeners fire
 * SYNCHRONOUSLY on cancel — same contract as `AbortSignal` — so a tight
 * stream-consumer loop sees the abort on its NEXT iteration without needing
 * to await a microtask. */
export interface CancellationSignal {
  /** `true` once cancelled. Latching: never resets to `false`. */
  readonly aborted: boolean
  /** The declared cause; `null` until cancelled. First-cause-wins policy
   *  (see {@link CancellationController.cancel}). */
  readonly cause: CancellationCause | null
  /** Best-effort `Date.now()` (or injected `now()`) at the first cancel.
   *  `null` until cancelled; never reassigned. */
  readonly abortedAt: number | null
  /** Subscribe to the one-shot `abort` event. Fires synchronously, exactly
   *  once, on the first cancel. Adding a listener AFTER abort still fires
   *  synchronously (mirrors `AbortSignal.addEventListener` semantics so
   *  callers can wire up unconditionally without a pre-check race). */
  addEventListener(type: "abort", listener: () => void): void
  removeEventListener(type: "abort", listener: () => void): void
}

/** Whatever the upstream stream produced before the cancel arrived.
 *
 * Salvaged on a best-effort basis by the {@link cancellableStream} wrap. A
 * caller MAY decide to execute any complete `toolUses[]` even after cancel
 * (the tool calls themselves are self-contained side-effects), or it MAY
 * discard the lot. The flag `hasUsableToolUses` is the explicit policy
 * carrier so consumers don't reimplement the "is anything actionable here"
 * predicate. */
export interface PartialResult {
  /** All `text_delta` payloads joined in stream order. May be `""` if the
   *  cancel landed before the first text delta. */
  readonly partialText: string
  /** Tool uses that fully completed (saw a matching `tool_use_end`) before
   *  the cancel. A `tool_use_start` without a closing end is INTENTIONALLY
   *  absent — partial JSON input is not actionable and silently dropping it
   *  is safer than handing the loop half-parsed input. */
  readonly toolUses: ReadonlyArray<{ id: string; name: string; input: unknown }>
  /** Cumulative usage from the LAST `usage` event seen pre-cancel. Zeros
   *  when no usage event arrived. `cacheReadTokens` / `cacheWriteTokens`
   *  are optional because not every provider emits them. */
  readonly usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  /** `true` iff `toolUses.length > 0`. Convenience carrier for the caller's
   *  "should I execute these or roll back?" decision; semantically redundant
   *  with `toolUses.length > 0` but pinning it as a separate field forces
   *  callers to read it from one named place. */
  readonly hasUsableToolUses: boolean
}

/** Cleanup handler executed during {@link CancellationController.finalize}.
 *
 * Handlers receive the cause + (possibly null) partial result so they can
 * decide between full rollback and partial commit. Throws are captured into
 * {@link CancellationOutcome.cleanupErrors} — they NEVER propagate out of
 * `finalize()`. This matches the OpenHands `ActionExecutionStatus.cancelled`
 * convention: cleanup is best-effort by contract, and the outcome is a
 * structured report rather than an exception. */
export interface CleanupHandler {
  /** Stable name for audit trails / metrics. */
  readonly name: string
  cleanup(cause: CancellationCause, partial: PartialResult | null): Promise<void>
}

/** The structured report returned from {@link CancellationController.finalize}.
 *
 * Designed to be JSON-serialisable so a jsonl recorder can persist it as a
 * single envelope. `cleanupErrors` is `Error.message` strings (not Error
 * objects) for the same reason. */
export interface CancellationOutcome {
  readonly cause: CancellationCause
  readonly cancelledAt: number
  /** `null` when the stream had not yet produced any event when cancel
   *  fired (so there is literally nothing to salvage). */
  readonly partial: PartialResult | null
  /** `true` iff `cleanupErrors.length === 0`. Convenience field — explicit
   *  so callers don't reimplement the predicate. */
  readonly cleanupSucceeded: boolean
  /** One entry per handler that threw. Order matches handler-registration
   *  order; the entry is the thrown `Error.message` (or `String(err)` for
   *  non-Error throws). Empty when every handler succeeded. */
  readonly cleanupErrors: ReadonlyArray<string>
}

/** The controller-side handle paired with a {@link CancellationSignal}.
 *
 * One controller per logical cancellation scope (a turn, a side-conversation
 * sub-turn, a subagent invocation). The signal is what consumers OBSERVE;
 * the controller is what PRODUCERS hold to fire the cancel and orchestrate
 * cleanup. Same separation as WHATWG `AbortController` / `AbortSignal`. */
export interface CancellationController {
  /** The signal half — pass this DOWN to consumers (LLM adapters, tool
   *  executors, sub-loops). Identity is stable for the controller's
   *  lifetime; consumers may cache it. */
  readonly signal: CancellationSignal
  /** Fire the cancel.
   *
   *  - **First call wins**: the first `cancel(c)` latches `cause = c`.
   *    Subsequent calls (same or different cause) are no-ops; the original
   *    cause survives. Rationale: the EARLIEST observed reason is the
   *    causally-correct one — a budget breach that arrived first is the
   *    real cause; a user-abort one tick later is a redundant signal.
   *  - **Synchronous**: listeners fire in registration order before
   *    `cancel()` returns. */
  cancel(cause: CancellationCause): void
  /** Register a cleanup handler. Handlers fire during {@link finalize}.
   *
   *  Returns a deregister function so callers can remove a handler if the
   *  protected resource was released cleanly before cancel landed (avoids
   *  double-free). Idempotent: deregistering twice is a no-op. */
  registerCleanup(handler: CleanupHandler): () => void
  /** Run all registered cleanup handlers and return the structured report.
   *
   *  - **Idempotent**: calling `finalize` twice returns the same outcome
   *    on the second call; handlers run exactly once.
   *  - **Never throws**: handler errors are captured into `cleanupErrors`.
   *  - **Bounded parallelism**: handlers run in parallel up to a cap
   *    (default 4, configurable on the controller). The cap is the
   *    deliberate trade-off vs strict-serial — see the ADR for the
   *    file-handle-exhaustion + dependency-ordering reasoning.
   *  - **Calling without prior `cancel()`**: marked as a contract
   *    violation; the implementation cancels with cause `"external"` and
   *    proceeds, so an accidental call still produces a valid outcome
   *    rather than hanging. The ADR documents this as a safety net, not
   *    a supported API. */
  finalize(partial: PartialResult | null): Promise<CancellationOutcome>
}

/** Thrown by callers that opt into exception-style propagation.
 *
 * The library itself never throws this — async iterators exit cleanly on
 * cancel (mirrors `client.messages.stream(...)` SDK semantics where the
 * iterator simply returns rather than throwing on abort). Provided as a
 * convenience for adapters that need exception flow (e.g. wrapping a
 * promise-returning call where iterator semantics don't apply). */
export class CancellationError extends Error {
  public override readonly cause: CancellationCause
  constructor(cause: CancellationCause, message: string) {
    super(message)
    this.cause = cause
    // Mutating `name` AFTER super() is the conventional sub-Error pattern;
    // avoids `override` keyword friction across mixed lib versions.
    this.name = "CancellationError"
  }
}
