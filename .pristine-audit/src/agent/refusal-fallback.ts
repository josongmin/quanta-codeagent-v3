/**
 * T08 — model-refusal recovery (fork/neutralize + re-prompt) config seam.
 *
 * When a turn ends with a refusal-class stop reason (Anthropic `refusal` /
 * OpenAI `content_filtered`, unified by `@/llm#isRefusalStopReason`) and this
 * feature is enabled, the loop "forks" the refused turn off the transcript
 * (neutralizes it so the retry does not re-anchor on the prior "no") and
 * re-prompts the model EXACTLY ONCE with {@link RefusalFallbackConfig.prompt}.
 * A second refusal is terminal — the one-shot cap is a HARD rule (never a knob:
 * `n>1` is forbidden without measurement, [[no-heuristics-only-validated]]).
 *
 * Default-OFF: absent / `enabled !== true` ⇒ the loop is byte-identical (a
 * refusal terminates exactly as before). Knob `QUANTA_REFUSAL_FALLBACK` wires
 * this at the composition root (`@/agent/optional-ports`); the optional string
 * knob `QUANTA_REFUSAL_FALLBACK_PROMPT` overrides the built-in template.
 *
 * Plane-clean leaf — no imports. Pure data + one constant.
 */

export interface RefusalFallbackConfig {
  /** Master gate. Absent / false ⇒ OFF (byte-identical). */
  readonly enabled?: boolean
  /** Re-prompt template injected as the single retry nudge. Absent ⇒ the
   *  built-in {@link DEFAULT_REFUSAL_FALLBACK_PROMPT}. */
  readonly prompt?: string
}

/**
 * Built-in re-prompt template. Provider-agnostic and deliberately conservative:
 * it asks the model to reconsider a *legitimate* request and to keep refusing
 * (with a concrete reason + safe alternative) when the refusal is genuinely
 * warranted — so the fallback recovers false refusals WITHOUT pressuring the
 * model past a real safety boundary.
 */
export const DEFAULT_REFUSAL_FALLBACK_PROMPT =
  "Your previous response declined the request. If this request is legitimate " +
  "and within your guidelines, please reconsider and complete it directly. If " +
  "it genuinely violates a policy, state specifically which policy and why, and " +
  "offer a safe alternative — do not refuse without explanation."
