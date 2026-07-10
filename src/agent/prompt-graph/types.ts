/**
 * ADR-0538 Phase 1 — instruction-graph FOUNDATION types.
 *
 * The system prompt is modelled as a graph of CONDITIONED, DECLARATIVE
 * instruction atoms compiled into the existing channelized wire artifact. This
 * file is the pure primitive layer (no IO, no clock, no env reads): the atom
 * shape, the closed facet matcher, the reachable-context axes, and the compiled
 * artifact contract.
 *
 * WHY declarative (not `(ctx) => boolean`): purity + auditability + EXHAUSTIVE
 * build-time verification require a closed, inspectable facet set. A closed set
 * lets `verifyRuleGraph` enumerate the full reachable context surface and prove
 * conflict-freedom / supersede-soundness / coverage statically — an arbitrary
 * predicate cannot be reasoned about that way.
 *
 * Slice boundary: this file imports only the axis types from sibling prompt
 * slices (`EnvironmentPosture`, `PromptPackMode`/`AgentMode`, `VerifyStrategy`).
 * No `@/llm`, no `@/tool` — atoms are pure text data + declarative conditions.
 */

import type { EnvironmentPosture } from "../prompt"
import type { AgentMode as PromptPackMode, VerifyStrategy } from "../prompt-rules"

/** The task-posture mode axis — the full 6-mode set (`default|plan|review|
 *  audit|architect|editor`, mirroring `@/shared`'s `AgentPromptMode`, which is
 *  what `buildTurnContext` resolves). Distinct from `PromptPackMode` (the
 *  runtime surface). Kept as a string union here so the matcher does not couple
 *  the prompt-graph slice to the mode slice's internals. ADR-0538 Phase 2 needs
 *  `architect`/`editor` as first-class facets (the read-only completion-bar
 *  split + the architect/editor mode notices). */
export type AgentMode = "default" | "plan" | "review" | "audit" | "architect" | "editor"

/** Authority layer (ADR-0538 §Primitive). Higher layer = higher precedence when
 *  two atoms speak to the same concern; recorded on every atom for placement +
 *  ordering audits. Phase 1 uses only L1_system (the frozen tool-use rails) and
 *  L3_app_env (env-posture-owned overrides); the full ladder is declared so the
 *  Phase 2 body migration does not have to widen the union. */
export type AuthorityLayer =
  | "L1_system"
  | "L2_runtime"
  | "L3_app_env"
  | "L4_permission"
  | "L5_mode"
  | "L6_repo"
  | "L7_skill"
  | "L8_user"
  | "L9_working_state"

/** The 8 real channels — ADR-0326 cached system.* sections + the dynamic
 *  message.* channels. Phase 1 migrates only `system.base` atoms (the tool-use
 *  rules ride in the static cached prefix). */
export type PromptChannel =
  | "system.base"
  | "system.project_md"
  | "system.session_ctx"
  | "system.user_append"
  | "message.hook_context"
  | "message.context_update"
  | "message.mention_injection"
  | "message.system_reminder"

/**
 * A facet predicate over an axis value. Either a positive membership list
 * (`["owned","default"]` = axis ∈ set) OR a negation (`{not:["grader-only"]}` =
 * axis ∉ set). This is the ADR's `T[]` widened with the `{not}` form the
 * migration requires (grader-only suppression is expressed as
 * `verifyStrategy:{not:["grader-only"]}`, not as a hand-maintained
 * suppression list).
 */
export type FacetPredicate<T extends string> = readonly T[] | { readonly not: readonly T[] }

/**
 * DECLARATIVE matcher — a closed struct of optional facets, NOT a
 * `(ctx) => boolean`. Semantics:
 *   - an ABSENT facet = "don't care" (does not constrain applicability);
 *   - a PRESENT facet must be satisfied; all present facets AND together.
 * `undefined` matcher (the whole `when`) ⇒ the atom ALWAYS applies.
 */
export interface AtomMatcher {
  envPosture?: FacetPredicate<EnvironmentPosture>
  promptPack?: FacetPredicate<PromptPackMode>
  verifyStrategy?: FacetPredicate<VerifyStrategy>
  mode?: FacetPredicate<AgentMode>
  // presence facets over the real TurnContextInput surface (ADR §Primitive P1):
  hasRepoRules?: boolean
  hasGlobRules?: boolean
  hasSessionCtx?: boolean
  hasMemorySummary?: boolean
  hasWorkingState?: boolean
  hasActiveSkills?: boolean
  hasContextEvents?: boolean
  hasMentionInjection?: boolean
  hasHookInjects?: boolean
  hasImages?: boolean
  brief?: boolean
  untrustedEnvelope?: boolean
  // ADR-0538 Phase 3 — presence facets for the DYNAMIC reminder atoms.
  hasLanguageHint?: boolean
  hasEnvBlock?: boolean
  /** Repo rules present AND NOT hoisted to the cached `project_md` section (so
   *  they ride the DYNAMIC reminder). Distinct from `hasRepoRules` (which is
   *  presence-anywhere) — the dynamic repo-rules atom fires only on this. */
  hasRepoRulesDynamic?: boolean
  hasTaskBudget?: boolean
  /** ≥1 §5 prompt-directive is active (resolved from runtimeConfig knobs). The
   *  dynamic directives atom fires only when the selection is non-empty, so the
   *  manifest never reports it for a default-OFF (zero-byte) turn. */
  hasDirectives?: boolean
}

/**
 * A conditioned instruction atom — the graph node. `atomId` is the SEMANTIC id
 * (one per rule, stable); `variantId` is the RENDERED-instance id — a semantic
 * atom may have posture/verify variants with DIFFERENT text (e.g. the frozen
 * `R-ENV` vs the owned `R-ENV-OWNED` variant of the env-guardrail atom).
 * supersede / conflict / coverage account against `variantId`.
 */
export interface InstructionAtom {
  /** SEMANTIC id (stable, one per rule concern). */
  readonly atomId: string
  /** RENDERED-instance id — unique per variant text. */
  readonly variantId: string
  readonly authority: AuthorityLayer
  readonly channel: PromptChannel
  /** Group + intra-channel order label (audit-friendly). */
  readonly section: string
  readonly order: number
  /** Rendered content — NO ADR/Codex citations (those live in `provenance`).
   *  For a STATIC atom this is the literal wire text. For a DYNAMIC-content atom
   *  (one that carries a `contentKey`) `lines` is EMPTY — its wire text is
   *  per-turn DATA produced by the leaf renderer, NOT carried on the atom. */
  readonly lines: readonly string[]
  /**
   * ADR-0538 Phase 3 — DYNAMIC-content marker. When present, the atom carries NO
   * wire text (`lines` stays empty): it is the declarative APPLICABILITY (`when`)
   * + a STABLE key for one per-turn reminder block. The compiler's `contentByKey`
   * resolver (`prompt.ts`) maps the key to the block's per-turn wire text via the
   * leaf renderers; `resolveReminderBlocks` folds over the selected atoms to
   * assemble the reminder AND its manifest from the SAME selection (so they cannot
   * drift). The purity contract holds: `when` is the declarative matcher,
   * `contentKey` is a stable string (no clock/IO/closure capture on the atom).
   * Only atoms on the `message.system_reminder` channel may carry one (the verifier
   * enforces this). Absent ⇒ STATIC (`lines` authoritative).
   */
  readonly contentKey?: string
  /** Absent ⇒ always applies. */
  readonly when?: AtomMatcher
  /** variantIds this one overrides (owned R-* over frozen R-*). */
  readonly supersedes?: readonly string[]
  /** variantIds that must NEVER co-render in the same channel. */
  readonly conflictsWith?: readonly string[]
  /** variantIds that must co-render whenever this one does. */
  readonly requires?: readonly string[]
  /** ADR/Codex/RFC refs — metadata only, NEVER sent to the model. */
  readonly provenance?: readonly string[]
}

/**
 * The FULL compile/verify context — the axes PLUS the presence facets. A
 * `PromptContext` is one reachable point in the surface `verifyRuleGraph`
 * enumerates. Every field is required so a ctx is a total assignment (the
 * verifier reasons over concrete points, not partial ones).
 */
export interface PromptContext {
  readonly envPosture: EnvironmentPosture
  readonly promptPack: PromptPackMode
  /** Absent verify strategy is modelled as `undefined` (a real reachable state). */
  readonly verifyStrategy: VerifyStrategy | undefined
  readonly mode: AgentMode
  readonly hasRepoRules: boolean
  readonly hasGlobRules: boolean
  readonly hasSessionCtx: boolean
  readonly hasMemorySummary: boolean
  readonly hasWorkingState: boolean
  readonly hasActiveSkills: boolean
  readonly hasContextEvents: boolean
  readonly hasMentionInjection: boolean
  readonly hasHookInjects: boolean
  readonly hasImages: boolean
  readonly brief: boolean
  readonly untrustedEnvelope: boolean
  // ADR-0538 Phase 3 — per-turn DYNAMIC reminder facets.
  readonly hasLanguageHint: boolean
  readonly hasEnvBlock: boolean
  readonly hasRepoRulesDynamic: boolean
  readonly hasTaskBudget: boolean
  readonly hasDirectives: boolean
}

/** A rendered, cache-labelled system section (structurally the `PromptSection`
 *  shape from `@/agent/prompt-sections`, declared here so the pure slice stays
 *  decoupled). `buildSectionedSystemBlocks` consumes these directly to recover
 *  the `SystemBlock[]` prefix — the artifact re-assembles byte-identically. */
export interface CompiledPromptSection {
  readonly name: string
  readonly text: string
  readonly cache: boolean
}

/**
 * The compiled artifact contract (ADR §Compiler) — the FULL Phase-3 shape.
 *
 *   - `systemSections` — the ≤4 cached `system.*` sections (ADR-0326). Feed
 *     `buildSectionedSystemBlocks` to recover the `SystemBlock[]` prefix.
 *   - `injectedMessages` — the chronological message list: `baseMessages` +
 *     `message.hook_context` + `message.context_update` +
 *     `message.mention_injection`, in the EXACT current order (ADR-0321/0325).
 *   - `trailingReminder` — the RAW `message.system_reminder` block text BEFORE
 *     `embedUntrusted` (so the caller wraps it exactly once; absent ⇒ no
 *     reminder message, byte-identical to the pre-reminder path).
 *   - `manifest` — the fired-atom manifest across all 8 channels + the policy
 *     snapshot the compiler produced (snapshot parity).
 */
export interface CompiledPromptArtifact {
  readonly systemSections: readonly CompiledPromptSection[]
  readonly injectedMessages: readonly import("@/llm").Message[]
  readonly trailingReminder?: string
  readonly manifest: {
    readonly firedAtomIds: readonly string[]
    readonly firedVariantIds: readonly string[]
    /** supersede audit trail: `loser` variantId suppressed by `winner`. */
    readonly suppressed: ReadonlyArray<{ readonly loser: string; readonly winner: string }>
    /** ALL 8 channels present (empty array ⇒ no atom fired on that channel). */
    readonly byChannel: Readonly<Record<PromptChannel, readonly string[]>>
    /** ADR-0538 Phase 3 — the `PromptPolicySnapshot` the compiler assembled, so
     *  the manifest can RECONSTRUCT the observability snapshot (snapshot parity).
     *  Typed structurally to avoid a `@/shared` value import into the pure slice. */
    readonly policy: import("@/shared").PromptPolicySnapshot
  }
}

/** A single structured verifier violation. */
export interface GraphViolation {
  readonly kind:
    | "conflict"
    | "supersede-unsound"
    | "coverage"
    | "hidden-assumption"
    // ADR-0538 Phase 2 checks (ADR §Build-time verifier 4,5,6,8):
    | "cached-section-budget"
    | "static-dynamic-separation"
    | "authority-placement"
    | "manifest-completeness"
    // ADR-0538 Phase 3 checks (ADR §Build-time verifier 8 extended, 9):
    | "dynamic-content-placement"
    | "snapshot-parity"
  readonly message: string
  /** The offending variantId(s). */
  readonly variantIds: readonly string[]
  /** A reachable ctx witnessing the violation (omitted for coverage — the
   *  witness is the ABSENCE of any firing ctx). */
  readonly ctx?: PromptContext
}
