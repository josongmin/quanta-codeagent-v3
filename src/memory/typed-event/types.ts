/**
 * ADR-0319 — Typed history event variants.
 *
 * Codex `codex-rs/core/src/session/turn.rs` (`record_conversation_items`,
 * `ResponseItem`) records reasoning / context-update / function-call /
 * function-call-output / skill-event side-channel envelopes alongside the
 * plain message stream so the next prompt assembly can reason about
 * structured turn-deltas (mode flips, cwd flips, skill activation, ...)
 * without re-deriving them from the flat message body.
 *
 * `quanta` wm (`src/memory/working.ts`) stores only the flat Anthropic
 * content-block union. This module introduces a PARALLEL typed event
 * stream — wm is not mutated, and no production code path is auto-wired
 * (Wave-B / ADR-0301 wires producers later).
 *
 * **Closed set of 5 variants.** Extending this union requires a new ADR
 * (closed-port pattern, RFC §3.1 layering).
 */

/** Fields whose value swap is captured by a {@link ContextUpdateEvent}. */
export type ContextUpdateField = "cwd" | "mode" | "repo_rules" | "active_skills" | "model"

/** Trigger source for a {@link SkillActivationEvent}. */
export type SkillActivationTrigger = "user" | "auto" | "system"

/**
 * Side-channel record of a single context field flipping. `prev`/`next`
 * stay `unknown` — the consumer is responsible for narrowing per `field`
 * (cwd ⇒ `string`, mode ⇒ `string`, active_skills ⇒ `readonly string[]`,
 * etc.). Storing as `unknown` keeps the union small (5 variants) without
 * forcing a tagged sub-union per field.
 */
export interface ContextUpdateEvent {
  readonly kind: "context_update"
  readonly field: ContextUpdateField
  readonly prev: unknown
  readonly next: unknown
  /** Epoch milliseconds at which the swap was observed. */
  readonly at: number
  /** Optional turn correlation id. Absent until a producer wires turnIds. */
  readonly turnId?: string
}

/** A skill became active. Distinct from `context_update`-`active_skills`
 *  because the trigger source carries information the field-diff loses. */
export interface SkillActivationEvent {
  readonly kind: "skill_activation"
  readonly skillId: string
  readonly trigger: SkillActivationTrigger
  readonly at: number
  readonly turnId?: string
}

/** Repo-rules tree gained / lost path entries (additive + subtractive). */
export interface RepoRulesChangeEvent {
  readonly kind: "repo_rules_change"
  readonly addedPaths: readonly string[]
  readonly removedPaths: readonly string[]
  readonly at: number
  readonly turnId?: string
}

/** Mode swap (e.g. `architect` → `editor`). `prev`/`next` are free-form
 *  strings — this slice does NOT depend on `@/agent/mode` (slice fence). */
export interface ModeChangeEvent {
  readonly kind: "mode_change"
  readonly prev: string
  readonly next: string
  readonly reason?: string
  readonly at: number
  readonly turnId?: string
}

/**
 * Provider-emitted reasoning signature (e.g. Anthropic `thinking` block
 * signature; OpenAI Responses `reasoning.encrypted_content`). Stored
 * REDACTED by default — `signature` is opaque, `redacted` records
 * whether the producer stripped the body before append.
 */
export interface ReasoningEchoEvent {
  readonly kind: "reasoning_echo"
  readonly signature: string
  readonly redacted: boolean
  readonly tokenCount?: number
  readonly at: number
  readonly turnId?: string
}

/**
 * Closed discriminated union of typed side-channel history events.
 * Extending requires a new ADR (closed-port pattern).
 */
export type TypedHistoryEvent =
  | ContextUpdateEvent
  | SkillActivationEvent
  | RepoRulesChangeEvent
  | ModeChangeEvent
  | ReasoningEchoEvent

/** Variant tags. Useful for exhaustiveness checks at callsites. */
export type TypedHistoryEventKind = TypedHistoryEvent["kind"]
