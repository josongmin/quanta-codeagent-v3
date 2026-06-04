/**
 * LLM connection prewarm seam (ADR-0452 — Codex `session_startup_prewarm`
 * absorption, LLM-connection half).
 *
 * --- WHAT THIS IS ---
 *
 * `buildSessionFeatures` (src/agent/features.ts) is already EAGER — tools,
 * skills and the auto-mode classifier are all materialized once at session
 * start, so the *capability* half of Codex's startup prewarm is DONE. The
 * genuine gap is the LLM CONNECTION: by the time the first user turn opens the
 * model stream, the DNS resolution + TLS handshake + (for HTTP/2 providers)
 * connection establishment all happen on the critical path of the user's first
 * message, inflating Time-To-First-Message.
 *
 * --- THE ABSTRACTION BOUNDARY (honest) ---
 *
 * `LLMPort` (src/llm/ports.ts) exposes exactly ONE behavioral method:
 * `stream(input)`. The concrete adapters (`adapters/openai.ts`,
 * `adapters/anthropic.ts`, ...) wrap the official vendor SDKs (`new OpenAI()`,
 * `new Anthropic()`). Those SDK clients own a private, fetch-based HTTP agent
 * with its own connection pool — there is NO public method on the SDK client,
 * and therefore none reachable through `LLMPort`, that opens a pooled
 * connection without also issuing a model request. Issuing a throwaway model
 * request purely to warm a socket would be wasteful and bill the user, which
 * the slice brief forbids.
 *
 * So this module ships an OPTIONAL, OPT-IN capability rather than a fake
 * request: a port MAY structurally implement {@link LlmPrewarmPort.prewarm} to
 * pre-open its connection (e.g. a TLS handshake via a HEAD probe, a connection-
 * pool warm, or a provider-native ping). An adapter that genuinely benefits can
 * implement it; the stock SDK-wrapping adapters do NOT (no clean SDK hook), so
 * they are detected as `prewarm`-absent and the helper is a no-op. This keeps
 * the default path byte-identical while leaving a typed seam for a future
 * adapter (or a custom transport) that can truly pre-open.
 *
 * --- CONTRACT ---
 *
 *   - Best-effort: a prewarm that rejects or throws is swallowed (logged via
 *     the injected `onError`). Warming MUST NEVER block or fail the first turn.
 *   - Idempotent at the call site: the loop calls it exactly once at session
 *     start (before the first turn), gated on `config.prewarm`.
 *   - Absent capability ⇒ {@link prewarmLlm} returns `"skipped"` without
 *     touching the port (true no-op).
 */

import { errMessage } from "@/shared"
import type { LLMPort } from "./ports"

/**
 * Optional connection-prewarm capability an `LLMPort` adapter MAY implement.
 *
 * Structural (duck-typed) extension of {@link LLMPort}: the loop detects it via
 * {@link hasPrewarm} rather than requiring every adapter to implement it, so
 * adding this never breaks an existing port. `prewarm` should pre-open the
 * provider connection (handshake / pool warm) WITHOUT issuing a billable model
 * request, and resolve once the connection is ready (or reject — the caller
 * treats a rejection as best-effort and proceeds).
 */
export interface LlmPrewarmPort {
  /** Pre-open the provider connection. Best-effort; may reject. The injected
   *  `signal` lets the caller abort a slow warm (it must never delay the turn).
   */
  prewarm(signal?: AbortSignal): Promise<void>
}

/** Runtime guard: does `port` structurally implement {@link LlmPrewarmPort}? */
export const hasPrewarm = (port: LLMPort): port is LLMPort & LlmPrewarmPort =>
  typeof (port as Partial<LlmPrewarmPort>).prewarm === "function"

/** Outcome of a prewarm attempt — surfaced to the metric layer. */
export type PrewarmOutcome =
  /** The port had no `prewarm` capability — true no-op, nothing touched. */
  | "skipped"
  /** `prewarm()` resolved cleanly. */
  | "warmed"
  /** `prewarm()` rejected / threw — swallowed best-effort. */
  | "failed"

/**
 * Best-effort connection prewarm. Returns the {@link PrewarmOutcome} so the
 * caller can record a metric; NEVER throws.
 *
 * @param port  the session's `LLMPort` (possibly wrapped — the guard sees the
 *              outermost wrapper, which forwards `prewarm` only if it chooses).
 * @param opts.signal   abort signal to cancel a slow warm.
 * @param opts.onError  best-effort error sink (e.g. the loop's logger).
 */
export const prewarmLlm = async (
  port: LLMPort,
  opts: { readonly signal?: AbortSignal; readonly onError?: (message: string) => void } = {},
): Promise<PrewarmOutcome> => {
  if (!hasPrewarm(port)) return "skipped"
  try {
    await port.prewarm(opts.signal)
    return "warmed"
  } catch (e) {
    opts.onError?.(`llm.prewarm failed (best-effort, ignored): ${errText(e)}`)
    return "failed"
  }
}

const errText = (e: unknown): string => errMessage(e)
