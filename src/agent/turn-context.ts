/**
 * Session/Turn parameter bundles for the `runAgent` loop (R2-B P1).
 *
 * Background
 * ──────────
 * `runTurn`/`streamConsume`/`applyAction` historically grew to 17-20 positional
 * parameters as features (skill gate, classifier, working state, verify guard
 * chain, citations, redaction callbacks, TurnTiming sink, …) were threaded
 * through. Each new optional collaborator forced every call site + helper to
 * gain a new positional slot. This file groups those into two readonly bundles
 * so the loop helpers can be invoked with 3-6 args instead of 17-20.
 *
 * Two bundles
 * ───────────
 *   - `TurnSession` — session-lifetime resources (configured ONCE per
 *     `runAgent` invocation; passed through every turn untouched).
 *     `readonly` to enforce the "configured once" property at the type
 *     boundary: a turn helper cannot reassign the recorder or the skill gate.
 *
 *   - `TurnState` — turn-lifetime MUTABLE state (working memory, recovery
 *     counters, breaker strikes, the tool-history log, the ToolChoice TTL
 *     flags). Mutated in place by the loop helpers; readers can still observe
 *     the canonical pointer (e.g. `state.wm`) at any time.
 *
 * Default-OFF byte-identical (RFC §1.2)
 * ──────────────────────────────────────
 * Every optional field is `T | undefined` so an unconfigured session carries
 * exactly the same `undefined`s the prior positional-arg signature did. The
 * bundles are pure types — they erase at runtime, so this refactor is
 * structurally invisible to the recorder/recorder/dispatch contracts.
 *
 * Cycle safety
 * ────────────
 * Type-only imports from agent siblings (`./guards`, `./working-state`, …).
 * The agent-import-cycle test treats `import type { ... }` as erased; no new
 * value edge is introduced, the known SCC is untouched.
 *
 * Skill gate / override types
 * ───────────────────────────
 * `SkillGate` + `SkillTurnOverride` previously lived in `loop.ts`. They are
 * declared HERE and re-exported from `loop.ts` so existing consumers
 * (`features.ts` imports `SkillTurnOverride` from `./loop`) keep their import
 * paths byte-identical.
 */

import type { Message } from "@/llm"
import type { RateLimitSnapshotStore } from "@/llm/ratelimit-snapshot"
import type { WorkingMemory } from "@/memory"
import type { TurnTiming } from "@/observability"
import type { AutoModeClassifier } from "@/permission"
import type { RedactionHit, RedactionOrigin } from "@/security"
import type { CompactionBreaker } from "./compaction-breaker"
import type { ConversationSummaryArchive } from "./conversation-summary-archive"
import type { EffortLevel } from "./effort"
import type { TurnGuard } from "./guards"
import type { AgentRecorder } from "./metrics"
import type { RecoveryState } from "./recovery"
import type { ToolHistoryEntry } from "./session-resources"
import type { ToolChoiceTurnState } from "./tool-choice"
import type { AgentConfig, MemoryCitation } from "./types"
import type { TurnWorkMetricsCollector } from "./work-metrics-collector"
import type { WorkingStateSession } from "./working-state"

/** Author-declared per-skill model/effort override (ADR-0011 §6.2 → L4).
 *  `effort` mirrors `SkillEffort` (`low|medium|high|max|<number>`); a numeric
 *  value is a RAW token budget, a named tier maps via `effortToTokenBudget`.
 *  Carried structurally (no `@/skill` import) — `features.ts` builds the map
 *  from `skillModelOverride`/`skillEffortOverride`. Moved here (was in
 *  `loop.ts`) so the `TurnSession` bundle's `skillGate.activeOverride()` can
 *  reference the type without a loop.ts ↔ turn-context.ts value cycle.
 *  `loop.ts` re-exports it so existing imports stay byte-identical. */
export interface SkillTurnOverride {
  model?: string
  effort?: EffortLevel | number
}

/** Skill tool-scoping ENFORCEMENT (ADR-0011). Once a skill that declared a
 *  `tools:` allowlist is invoked, subsequent tool calls are restricted to
 *  that allowlist (+ the skill meta-tools) until another skill resets it.
 *  Built only when ≥1 discovered skill declared an allowlist OR an
 *  override; absent ⇒ no scoping (loop byte-identical). Moved here from
 *  loop.ts so it can be referenced by `TurnSession` without a cycle. */
export interface SkillGate {
  /** False ⇒ the call must be denied (not in the active skill's allowlist). */
  allow(name: string): boolean
  /** Observe a completed dispatch; a successful `Skill` invocation with a
   *  declared allowlist arms/replaces the active scope, and (independently)
   *  arms/replaces the active model/effort override. */
  observe(name: string, input: unknown, ok: boolean): void
  /** The active skill's model/effort override, or `undefined` when no skill
   *  is active or the active one declared none. Read once per turn at the
   *  stream open so the override is turn-scoped to the turns AFTER
   *  activation. */
  activeOverride(): SkillTurnOverride | undefined
}

/**
 * Session-lifetime resources for one `runAgent` invocation.
 *
 * Built once by `runAgentInner` (after `buildSessionFeatures()` +
 * `buildGuardChain()`) and threaded into every turn helper unchanged.
 * `readonly` at the type level so a helper cannot accidentally rebind the
 * recorder mid-session.
 *
 * Field-by-field
 * ──────────────
 *  - `config` — the effective `AgentConfig` (`buildEffectiveConfig` output);
 *    carries the ports the helpers reach for (`stream`, `registry`,
 *    `permission`, `budgetMeter`, …).
 *  - `specs` — the tool spec list snapshotted once at session start so
 *    every turn sees the same registry view (Codex anti-reread).
 *  - `recorder` — `undefined` when no metrics sink is wired (NullStream
 *    parity); helpers fan span/counter side-effects through it via optional
 *    chaining.
 *  - `classifier` — auto-mode LLM permission classifier; absent ⇒ deny path.
 *  - `skillGate` — present ONLY when ≥1 discovered skill declared an
 *    allowlist or an override (per `buildSkillGate`).
 *  - `activeSkills` — cached at session start for the per-turn reminder
 *    block; absent ⇒ no block emitted (skill-less sessions byte-identical).
 *  - `archive` — `ConversationSummaryArchive` built only when
 *    `config.compaction?.archive === true`.
 *  - `guards` — composed turn-exit guard chain (verify before closeout, per
 *    `./guards/build.ts`). Empty array ⇒ `runGuardChain` short-circuits in
 *    zero iterations (default-OFF byte-identical to the pre-chain loop).
 */
export interface TurnSession {
  readonly config: AgentConfig
  readonly specs: ReturnType<AgentConfig["registry"]["specs"]>
  readonly recorder?: AgentRecorder
  readonly classifier?: AutoModeClassifier
  readonly skillGate?: SkillGate
  readonly activeSkills?: { name: string; description: string }[]
  readonly archive?: ConversationSummaryArchive
  /** ADR-0473 — per-session speculative (background) compaction controller.
   *  Present only when `QUANTA_BG_COMPACTION=1`; the turn loop borrows a ready
   *  summary at turn-top and re-arms after compaction. Absent ⇒ byte-identical. */
  readonly bgCompaction?: import("./compaction/index").BackgroundSummarizationController<
    import("./compaction").BgSummaryPayload
  >
  readonly guards: readonly TurnGuard[]
  /** ADR-0133 — session-scoped pending list of hook-emitted promptHook
   *  responses. Pushed by the subagent runner (via
   *  `cfg.subagentPendingPrompt`) and by the per-turn `turn_start` hook
   *  emit (loop wires it). Drained by `prepareTurnContext` AFTER a
   *  successful build so a same-turn retry sees the same injects but the
   *  NEXT turn starts fresh. Mutable handle (push/splice), so the field is
   *  not `readonly` on the array itself even though the slot is. Absent ⇒
   *  no drain, byte-identical legacy. */
  readonly hookPromptPending?: import("./hooks").HookPromptInject[]
  /** ADR-0452 — once-fire Time-To-First-Message marker. Present ONLY when the
   *  `prewarm` config block is enabled; the stream dispatcher calls
   *  `markFirstDispatch()` at the LLM-request boundary and the marker records
   *  TTFM on the FIRST call (subsequent calls are no-ops). Absent ⇒ no TTFM,
   *  byte-identical legacy. */
  readonly ttfm?: { markFirstDispatch(): void }
  /** jun-6 account-ratelimit-snapshot (gate `QUANTA_RATELIMIT_PROACTIVE`).
   *  Per-run PROACTIVE rate-limit collaborators, constructed ONCE in
   *  `createRunAgentContext` ONLY when the knob is on. The `store` is the
   *  per-route snapshot container fed by the adapter's `onResponseHeaders`
   *  success-path hook; `now` is the injected clock; `sleep` the injected delay.
   *  Absent ⇒ the loop wires no header hook and applies no pre-request delay
   *  (byte-identical reactive 429-retry). */
  readonly rateLimitProactive?: {
    readonly store: RateLimitSnapshotStore
    readonly now: () => number
    readonly sleep: (ms: number) => Promise<void>
  }
}

/**
 * Turn-lifetime mutable state.
 *
 *  - `wm` — the canonical working-memory buffer. Mutated in place by
 *    `applyAction` (append assistant turn, append nudge meta, replace on
 *    compact).
 *  - `rec` — same-turn recovery counters (`freshRecovery()` per turn). The
 *    `decideOn*` functions mutate this in place.
 *  - `breaker` — compaction-thrash breaker; one instance per session is
 *    fed by both proactive (`maybeCompact`) and reactive (`applyAction`)
 *    paths. Optional: `cfg.compactionBreaker?.disabled === true` ⇒ undefined.
 *  - `toolHistory` — ordered dispatched-tool log. Created ONLY when
 *    `cfg.verifyGuard` is set; absent ⇒ undefined, the push site is never
 *    reached (byte-identical).
 *  - `workingState` — session-scoped `WorkingStateSession`; absent ⇒ no
 *    block in the per-turn reminder.
 *  - `collector` — per-turn work-metrics collector; absent ⇒ no sink.
 *  - `toolChoiceState` — ADR-0079 1-turn-TTL flags armed by the verify/
 *    closeout guards on the PRIOR stream's finish-intent. Always constructed
 *    (bare object); guard-OFF ⇒ flags never armed, `consumeTurnSignals`
 *    always yields `{}`, byte-identical wire payload.
 *  - `citations` — run-scoped memory_citation accumulator. Append-only.
 *  - `onRedaction` — single sink that folds tool_result + envelope_jsonl +
 *    memory_distill hits into the run-scoped rollup; absent ⇒ no-op.
 *  - `onTurnTiming` — sink for the LAST sampling-request's TurnTiming
 *    snapshot; absent ⇒ snapshot built locally and discarded.
 *
 * The bundle is `interface` (not `readonly`-property-list) because the
 * helpers WRITE into `wm`/`rec`/`breaker` etc. — fields that are themselves
 * mutable handles. The bundle reference itself is captured once per turn.
 */
export interface TurnState {
  wm: WorkingMemory<Message>
  rec: RecoveryState
  breaker: CompactionBreaker | undefined
  toolHistory: ToolHistoryEntry[] | undefined
  workingState: WorkingStateSession | undefined
  collector: TurnWorkMetricsCollector | undefined
  toolChoiceState: ToolChoiceTurnState
  citations: MemoryCitation[]
  onRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void
  onTurnTiming: ((timing: TurnTiming) => void) | undefined
  /**
   * jun-02 — SOFT task-budget cumulative spend box. Present ONLY when
   * `config.taskBudget` is set; the loop increments `tokens` by every observed
   * `usage` event (input + output) so `prepareTurnContext` can forward a
   * monotonically-growing `spent` into `buildTurnContext`. Independent of the
   * enforcement `BudgetMeter` (orthogonality contract). Absent ⇒ no
   * accumulation, no forward, byte-identical default-OFF. */
  taskSpend?: { tokens: number }
  /**
   * D5 (jun-7 naive-impl hardening) — authoritative token-baseline box. The
   * loop OVERWRITES `current` after every turn whose provider `usage` reported
   * an `exact` input count (authoritative ≥ chars/4 estimate), recording the
   * count + the `messages.length` at send time. `maybeCompact` reads it so the
   * NEXT turn's compaction trigger anchors on the provider's truth + a chars/4
   * estimate of ONLY the suffix appended since. Allocated ONCE per session
   * (spread into every turn's TurnState). `current` undefined ⇒ no baseline ⇒
   * the trigger uses the legacy chars/4 estimate (byte-identical). The box is
   * ALWAYS allocated (no knob): the field only takes effect once an exact usage
   * lands, and absent that the trigger is byte-identical. */
  tokenBaseline?: {
    current?: import("./compaction").TokenBaseline | undefined
    /** The `wm.snapshot().length` recorded by `prepareTurnContext` for the
     *  prompt about to be sent (after this turn's compaction settled). The
     *  usage capture pairs it with the provider's authoritative `inputTokens`
     *  to form `current`. Undefined until the first turn is prepared. */
    sendCount?: number
  }
}
