/**
 * Background (speculative) compaction — port + config + outcome types
 * (ADR-0473).
 *
 * WHAT: type surface for {@link BackgroundSummarizationController}. The
 * controller speculatively starts a summarize() while the turn keeps running
 * (we are APPROACHING, not at, the token limit) and, at the turn boundary,
 * either installs the completed summary or discards it under a closed reason
 * set — so a failed/aborted summarize can NEVER corrupt live history (2-phase
 * install: old context stays until a successful summary lands).
 *
 * ADR: 0473.
 *
 * Slices imported: `@/shared` ONLY (Result/ok/err). This is a leaf in @/agent.
 * The summarize primitive arrives as the INJECTED {@link SpeculativeSummarizeFn}
 * port (port inversion, mirrors @/permission ClassifierPort + @/agent
 * away-summary SummarizeFn) so the slice stays @/llm-free and unit-testable
 * with a spy double. The clock arrives as an INJECTED {@link Clock}.
 *
 * NO-THROW contract: every public method returns a value (Result / outcome),
 * never throws. The summarizer's rejection and an aborted token are encoded as
 * typed discard reasons.
 *
 * DEFAULT-OFF (RFC §1.2): the controller is only constructed when the gate
 * (QUANTA_BG_COMPACTION === "1") is on. When off the host never references it
 * and the existing synchronous reactive/proactive paths are byte-identical.
 */

import type { Result } from "@/shared"

/** The env var that opts a deployment into background compaction. Value MUST be
 *  exactly `"1"` (mirrors the strict-`"1"` convention of every other quanta
 *  gate — an accidental `"0"`/`"true"`/`"on"` keeps it OFF). */
export const BG_COMPACTION_ENV = "QUANTA_BG_COMPACTION"

/** Injected monotonic-ish wall clock (ms since epoch). Mirrors the @/agent
 *  clock-injection precedent (ADR may-23 structural round) — never `Date.now()`
 *  inline, so tests drive time deterministically. */
export type Clock = () => number

/** Cancellation token handed to the summarizer when a background pass starts.
 *  The controller flips `aborted` (and calls `abort`) when the turn ends before
 *  the summary completes — so a speculative summarize that is no longer useful
 *  stops spending. A standard `AbortSignal`-shaped surface is intentionally NOT
 *  used: the slice must stay environment-free; the injected summarizer adapter
 *  bridges this to a real `AbortController` at the composition root. */
export interface CancelToken {
  /** `true` once the controller has decided this background pass is moot. */
  readonly aborted: boolean
  /** Request cancellation. Idempotent. The injected summarizer is expected to
   *  observe `aborted` / this signal and stop ASAP. NO-THROW. */
  abort(): void
}

/**
 * Token-usage snapshot the host feeds in (chars/4-or-provider estimate of the
 * live transcript). `limitTokens` is the hard context-window ceiling we must
 * NOT cross; `usedTokens` is the current footprint. "Approaching" is a function
 * of the configured {@link BgCompactionConfig.startAtUnusedPercent} /
 * `startAtUnusedTokens` — NOT a magic constant baked here.
 */
export interface UsageSnapshot {
  /** Estimated tokens currently in the live transcript. */
  usedTokens: number
  /** Hard context-window ceiling (tokens). MUST be > 0 for a meaningful gap. */
  limitTokens: number
}

/**
 * REQUIRED persist-threshold config — no magic numbers. A completed background
 * summary is only INSTALLED at the turn boundary when BOTH headroom conditions
 * say it is worth swapping live history for the summary:
 *
 *   - `persistUnusedTokens`  — install only if the summary frees at least this
 *     many tokens vs. the live transcript (absolute floor).
 *   - `persistUnusedPercent` — AND only if it frees at least this fraction of
 *     the context window (0..1, relative floor).
 *
 * Both must hold (AND). This mirrors the reactive path's `REACTIVE_MIN_DROP_*`
 * intent but is caller-supplied (named config), so the controller bakes no
 * heuristic. The "start" knobs say WHEN to speculatively begin; these say
 * WHETHER the produced summary is worth keeping.
 */
export interface BgCompactionConfig {
  /** Begin a speculative summarize once free headroom drops to/below this many
   *  tokens (absolute). Approaching-limit trigger. */
  startAtUnusedTokens: number
  /** OR once free headroom drops to/below this fraction of the window (0..1).
   *  Either start condition firing begins the background pass (OR) — we want to
   *  start EARLY/eagerly; the persist gate (AND) is the conservative side. */
  startAtUnusedPercent: number
  /** Minimum tokens the summary must free to be installed (absolute floor). */
  persistUnusedTokens: number
  /** Minimum fraction of the window the summary must free to be installed
   *  (0..1, relative floor). */
  persistUnusedPercent: number
}

/**
 * Closed reason set for discarding a speculative summary at the turn boundary.
 * Exhaustive by construction (a new reason fails tsc at every `switch`):
 *
 *   - "not-completed"           — the background pass had not finished when the
 *                                 turn boundary arrived (still in flight); we
 *                                 do NOT block the turn waiting on it.
 *   - "below-persist-threshold" — it finished but freed too little (failed the
 *                                 AND of persistUnusedTokens/Percent).
 *   - "input-limit-failure"     — the summarize itself failed because its OWN
 *                                 input exceeded the model limit mid-turn
 *                                 (a prompt-too-long while summarizing). Never
 *                                 install; live history is left intact.
 *   - "cancelled"               — the turn ended early and we aborted the pass
 *                                 (no wasted spend); nothing to install.
 *   - "summarizer-error"        — any other summarizer rejection (network, rate
 *                                 limit). Discard, never corrupt history.
 *   - "no-pass-started"         — reconcile called when maybeStart never fired
 *                                 (idempotent no-op).
 */
export type DiscardReason =
  | "not-completed"
  | "below-persist-threshold"
  | "input-limit-failure"
  | "cancelled"
  | "summarizer-error"
  | "no-pass-started"

/**
 * What the injected summarizer returns. Result-shaped so the port is NO-THROW:
 * the adapter MUST encode a prompt-too-long as `{ok:false, error:{kind:
 * "input-limit"}}` (so the controller can map it to the dedicated
 * `input-limit-failure` discard) and any other failure as `kind:"other"`.
 */
export type SummarizeError =
  | { kind: "input-limit"; detail: string }
  | { kind: "other"; detail: string }

/**
 * The INJECTED speculative summarize port. Generic over the payload type so the
 * slice never names @/llm `Message`. The host wires an adapter over the existing
 * `summarize`/`compactIfNeeded` primitive that:
 *   - honors the {@link CancelToken} (stops on abort),
 *   - returns the produced summary payload PLUS its estimated token footprint,
 *   - returns a typed {@link SummarizeError} (never throws).
 *
 * `S` is the installed-summary payload (e.g. the new Message[] the host will
 * `wm.replace(...)`). `freedTokensEstimate` is the summarizer's estimate of the
 * post-install transcript size — the controller compares it against the live
 * `usedTokens` to apply the persist threshold WITHOUT importing the token
 * estimator (keeps the slice @/llm-free).
 */
export type SpeculativeSummarizeFn<S> = (req: {
  cancel: CancelToken
}) => Promise<Result<{ summary: S; resultingTokens: number }, SummarizeError>>

/** Reconcile outcome: install the produced summary, or discard with a reason. */
export type ReconcileOutcome<S> =
  | { kind: "install"; summary: S; freedTokens: number }
  | { kind: "discard"; reason: DiscardReason }
