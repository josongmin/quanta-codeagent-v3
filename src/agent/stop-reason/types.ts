/**
 * Stop-reason typed surface (ADR-0241 — Cursor 8-stage refusal branching).
 *
 * Plane-clean leaf — depends ONLY on intra-slice types. Adding an arm to
 * {@link StopReasonKind} or {@link StopAction} forces a compile error at every
 * consumer switch (closed unions).
 *
 * Background. Cursor's loop branches on
 * `stop_reason ∈ {end_turn, tool_use, max_tokens, refusal, pause_turn,
 *                 content_filtered, guardrail_intervened, error}` (8 stages).
 * quanta historically only branched on three (`max_tokens` / `tool_use` /
 * `refusal`) — the remaining five reasons were buried as either a generic
 * `error` (Bedrock / OpenAI moderation) or fell through to the default
 * `proceed` arm. This slice introduces a typed surface for ALL EIGHT so a
 * future policy can give each a first-class treatment.
 */

/**
 * Closed eight-arm union — every stop_reason the upstream LLM SDKs can emit.
 *
 *   end_turn              — normal completion (Anthropic). OpenAI maps `stop`.
 *   tool_use              — model issued tool_use blocks; loop must dispatch.
 *   max_tokens            — output limit hit mid-message; resumable.
 *   refusal               — model declined (Anthropic refusal envelope or
 *                            OpenAI content-policy stop). Terminal-distinct
 *                            from error (see ADR-0120 / extractRefusalRationale).
 *   pause_turn            — Anthropic server-tool resume signal. quanta does
 *                            not ship server-side tools today, but the wire
 *                            surface still recognises the reason for hosts that
 *                            attach a custom server-tool runner.
 *   content_filtered      — Bedrock / OpenAI moderation removed content.
 *                            Terminal: the model never produced the assistant
 *                            text it was about to emit.
 *   guardrail_intervened  — Bedrock guardrail policy fired. Distinct from
 *                            `content_filtered` because a guardrail can
 *                            mid-stream INSERT a replacement message — HITL
 *                            escalation is the correct next step.
 *   error                 — provider surfaced a stream-level error (rate
 *                            limit, transient connectivity, server 5xx).
 *                            Recovered via backoff retry; loop may degrade
 *                            to `error` once the SAME-TURN budget is spent.
 */
export type StopReasonKind =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "content_filtered"
  | "guardrail_intervened"
  | "error"

/** Canonical literal tuple — runtime guard the union does not silently drift
 *  from consumer switches. Tested by HELL-SR-01..08 (exhaustive arm probe). */
export const ALL_STOP_REASON_KINDS = [
  "end_turn",
  "tool_use",
  "max_tokens",
  "refusal",
  "pause_turn",
  "content_filtered",
  "guardrail_intervened",
  "error",
] as const satisfies ReadonlyArray<StopReasonKind>

/**
 * Closed four-arm decision the loop receives back from the policy:
 *
 *   continue   — keep looping (the canonical paths: tool_use dispatch, normal
 *                end-of-turn completion, max_tokens nudge, etc.). The loop
 *                continues running existing `decideOnAssembled` logic.
 *   surface    — terminal-but-visible: the loop should finish with this
 *                reason exposed to the host (e.g. refusal + rationale,
 *                pause_turn while a server-tool callback resolves).
 *   abort      — terminal AND uncontinuable. The host must NOT auto-retry
 *                (content moderation removed the response — re-asking yields
 *                the same removal).
 *   hitl       — escalate to a human reviewer (guardrail_intervened: a
 *                policy boundary fired; only a human can decide whether to
 *                rewrite the request and re-run).
 */
export type StopAction = "continue" | "surface" | "abort" | "hitl"

/** Canonical literal tuple for {@link StopAction}. */
export const ALL_STOP_ACTIONS = [
  "continue",
  "surface",
  "abort",
  "hitl",
] as const satisfies ReadonlyArray<StopAction>

/**
 * Per-call context the policy receives. Optional fields use exactOptional
 * OMIT semantics: callers OMIT the field rather than passing `undefined`.
 *
 *   metrics — optional counter sink. The default policy increments
 *             `quanta.refusal.reason` (and sibling keys per arm) so a host
 *             that wires a {@link import("@/observability").Metrics} instance
 *             sees per-arm hit counts without having to read decision logs.
 *   rationale — visible-text rationale already extracted by the caller
 *               (typically via `extractRefusalRationale`). Forwarded as-is.
 */
export interface StopReasonContext {
  readonly metrics?: {
    counter(name: string): { inc(delta?: number): void }
  }
  readonly rationale?: string
}
