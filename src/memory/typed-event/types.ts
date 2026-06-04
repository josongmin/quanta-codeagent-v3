/**
 * ADR-0320 — Typed history event variants.
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
 * (Wave-B / ADR-0321 wires producers later).
 *
 * **Closed set of 8 variants.** Extending this union requires a new ADR
 * (closed-port pattern, RFC §3.1 layering).
 *  - Variants 1-5 (`context_update`, `skill_activation`,
 *    `repo_rules_change`, `mode_change`, `reasoning_echo`) come from the
 *    original ADR-0320 seal.
 *  - The 6th variant (`compaction_event`) was added by ADR-0324 to mirror
 *    Codex `ResponseItem::Compaction / ContextCompaction /
 *    CompactionTrigger` so the model can see "compaction occurred" as a
 *    typed narrative event (orthogonal to the wm mutation channel).
 *  - The 7th + 8th variants (`plugin_activation`, `app_activation`) were
 *    added by ADR-0335 to absorb the Codex r2 plugin/app activation
 *    surface: `plugin_activation` mirrors Codex's `.codex-plugin/plugin.json`
 *    discovery + enable flow, and `app_activation` mirrors the Codex
 *    `@@app-name` mention bound to a quanta surface (CLI / Web-Tauri /
 *    CLI-embedded browser).
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
 *
 * H15 — for the OpenAI-Responses carry-over path the `signature` holds the
 * opaque `encrypted_content` ciphertext (ZDR — never decoded), and the
 * OPTIONAL `carryover` field holds the full re-emittable Responses input
 * reasoning item so the next turn can re-feed it verbatim. `carryover` stays
 * `undefined` for the Anthropic thinking-signature producer (which re-submits
 * via its own channel) and whenever carry-over is off — keeping this variant
 * byte-identical for every existing producer. The item shape is intentionally
 * opaque (`Record<string, unknown>`) so this slice does NOT depend on
 * `@/llm` (slice fence).
 */
export interface ReasoningEchoEvent {
  readonly kind: "reasoning_echo"
  readonly signature: string
  readonly redacted: boolean
  readonly tokenCount?: number
  /**
   * H15 — opaque, re-emittable Responses input reasoning item
   * (`{ type: "reasoning", id?, encrypted_content, summary? }`). Present ONLY
   * for the OpenAI-Responses carry-over producer; absent otherwise. The
   * consumer re-feeds it verbatim onto the next turn's Responses input.
   */
  readonly carryover?: Readonly<Record<string, unknown>>
  readonly at: number
  readonly turnId?: string
}

/** Trigger source for a {@link CompactionEventVariant} — when the
 *  compaction pass ran relative to the turn lifecycle. */
export type CompactionEventTrigger = "pre_sampling" | "mid_turn" | "user_requested"

/** Reason that drove a {@link CompactionEventVariant} — why the
 *  compaction was needed. */
export type CompactionEventReason = "context_limit" | "token_budget" | "manual"

/**
 * A compaction pass executed on the working memory. Emitted alongside
 * (NOT replacing) the wm mutation so the model can see "compaction
 * occurred" as a typed narrative event.
 *
 * Mirrors Codex `ResponseItem::Compaction / ContextCompaction /
 * CompactionTrigger` (codex-rs `turn.rs:284-310` —
 * `run_auto_compact(..., InitialContextInjection::BeforeLastUserMessage,
 * MidTurn)`): Codex bakes the compaction fact into the history stream
 * so the next iteration's `clone_history().for_prompt()` sees a
 * compact-aware narrative.
 *
 * `tokensAfter <= tokensBefore` is the producer's responsibility — the
 * store does NOT enforce it (no validation in `append`, see
 * `port.ts:append` contract). `messagesRemoved` is the count of
 * messages dropped; `0` means a compaction pass was attempted but was
 * trivial (no messages removed) — still emit so the model sees the
 * attempt.
 */
export interface CompactionEventVariant {
  readonly kind: "compaction_event"
  /** When the compaction ran relative to the turn lifecycle. */
  readonly trigger: CompactionEventTrigger
  /** Why the compaction was needed. */
  readonly reason: CompactionEventReason
  /** Token estimate BEFORE the compaction pass. */
  readonly tokensBefore: number
  /** Token estimate AFTER the compaction pass. */
  readonly tokensAfter: number
  /**
   * Number of messages removed by the compaction pass (non-negative).
   * `0` means a trivial pass (attempted but no removal) — still
   * recorded so the model sees the attempt occurred.
   */
  readonly messagesRemoved: number
  readonly at: number
  readonly turnId?: string
}

/** Trigger source for a {@link PluginActivationEvent} — who/what enabled
 *  the plugin this turn. Matches the {@link SkillActivationTrigger}
 *  closed set so producers can share enum vocab across variants. */
export type PluginActivationTrigger = "user" | "auto" | "system"

/** Capability surface a plugin manifest declared, in the Codex
 *  `.codex-plugin/plugin.json` 3-way closed enum
 *  (`memory/codex-plugin-manifest-pattern`). The capability set is
 *  ADDITIVE — a plugin may declare zero, one, two, or all three. */
export type PluginCapability = "Interactive" | "Read" | "Write"

/**
 * A plugin (Codex `.codex-plugin/plugin.json`-style manifest) was
 * enabled this turn. Distinct from {@link SkillActivationEvent}
 * because plugins carry **tool manifests + scoped capabilities** (not
 * just description + body): the `capabilities` field records the
 * declared surface so a downstream consumer can reason about what
 * effects the plugin may produce without re-parsing the manifest.
 *
 * `capabilities` is a `readonly` array (zero or more entries) — empty
 * is legal (a manifest with no declared capability set still emits the
 * event so the model sees the discovery occurred). Producers are
 * responsible for de-duping the array; the store does not validate.
 */
export interface PluginActivationEvent {
  readonly kind: "plugin_activation"
  readonly pluginId: string
  readonly trigger: PluginActivationTrigger
  readonly capabilities: readonly PluginCapability[]
  readonly at: number
  readonly turnId?: string
}

/** Surface a quanta app maps to. Mirrors the `memory/surface-model`
 *  3-surface closed enum: CLI process, Tauri shell + Web UI, and the
 *  CLI-embedded browser (subagent / embedded WebView). */
export type AppActivationSurface = "cli" | "web-tauri" | "cli-browser"

/** Trigger source for an {@link AppActivationEvent}. Shared with
 *  {@link SkillActivationTrigger} / {@link PluginActivationTrigger} for
 *  cross-variant enum vocab parity. */
export type AppActivationTrigger = "user" | "auto" | "system"

/**
 * An "app" mention resolved this turn. In quanta's surface model an app
 * maps to a surface (CLI / Web-Tauri / CLI-embedded browser); the
 * `surface` field carries that label so the model can reason about
 * which environment is active. Mirrors Codex `@@app-name` resolution
 * (memory `codex-r2-wire`).
 *
 * Distinct from {@link PluginActivationEvent} because an app
 * activation is **environment-scoped** (which surface is now
 * conversational) whereas a plugin activation is
 * **manifest-scoped** (a tool/capability bundle was enabled).
 */
export interface AppActivationEvent {
  readonly kind: "app_activation"
  readonly appId: string
  readonly surface: AppActivationSurface
  readonly trigger: AppActivationTrigger
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
  | CompactionEventVariant
  | PluginActivationEvent
  | AppActivationEvent

/** Variant tags. Useful for exhaustiveness checks at callsites. */
export type TypedHistoryEventKind = TypedHistoryEvent["kind"]
