import type { LLMPort, Message } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type {
  PatternGrantStore,
  PermissionContext,
  ToolAction,
  TrustScopeRegistry,
} from "@/permission"
import type { PromptSurfaceProfileSnapshot, RunContext } from "@/shared"
import type { DecisionEmitter, StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"
import type { CloseoutCriticConfig } from "./closeout-critic"
import type { ConfirmDecision } from "./confirm-decision"
import type { DedupGate, DedupGateCaps } from "./dispatch-dedup"
import type { GlobRule } from "./glob-rules"
import type { HandoffRequiredEvent } from "./hitl-tier"
import type { HookBus } from "./hooks"
import type { LocalizePhaseConfig, LocalizePhaseState } from "./localize-phase-guard"
import type { NamedAgentResolver } from "./named-agent-registry"
import type { AgentMode } from "./prompt"
import type { RadarProducerBlock } from "./radar-producer-hook"
import type { RefusalFallbackConfig } from "./refusal-fallback"
import type { RepoRules } from "./repo-rules"
import type { ReproDoubtConfig, ReproDoubtState } from "./repro-doubt-guard"
import type { ActiveTurnState } from "./steering"
import type { SkillsBlock, SubagentBlock, WorkingStateBlock } from "./types/agent-capabilities"
import type {
  CompactionBreakerOptions,
  CompactionConfigBlock,
  OnPreCompactCallback,
  PreCompactRequestQuery,
} from "./types/compaction-config"
import type { MemoryConfigBlock, MemoryConsolidatorBlock } from "./types/memory-config"
import type { RulesConfigBlock } from "./types/rules-config"
import type { WireSlotsComposeConfig } from "./types/wire-slots-compose"
import type { WireSlotsCoreConfig } from "./types/wire-slots-core"
import type { WireSlotsRuntimeConfig } from "./types/wire-slots-runtime"
import type { WireSlotsSessionConfig } from "./types/wire-slots-session"

// Re-export the extracted Tier-1 capability option blocks (subagent / skills /
// workingState — branchSearch already lives in `./branch-search`). The
// `from "./types"` import contract for every consumer stays byte-identical
// after this split (T3, T2 follow-up).
export type {
  SkillsBlock,
  SubagentBlock,
  WorkingStateBlock,
} from "./types/agent-capabilities"
// Outcome surface re-exported from ./types/agent-outcome (cohesion split,
// byte-identical). Keeps the `from "./types"` import contract unchanged for
// the 132 consumer files that depend on these names being on this module.
export type {
  AgentOutcome,
  MemoryCitation,
  RedactionRollup,
  StopReason,
} from "./types/agent-outcome"
// Re-export the extracted memory + compaction config types so that every
// existing consumer reading them via `from "./types"` (or the `@/agent`
// barrel) keeps working byte-for-byte after this split.
export type {
  CompactionBreakerOptions,
  CompactionConfigBlock,
  OnPreCompactCallback,
  PreCompactDecision,
  PreCompactRequestQuery,
} from "./types/compaction-config"
export type { MemoryConfigBlock, MemoryConsolidatorBlock } from "./types/memory-config"
// ADR-0233 (Wire 2) — Vendor-detector composition knobs for `AgentConfig.rules`.
export type { RulesConfigBlock } from "./types/rules-config"
// God-module split (fix-on-sight per AGENTS.md SE-metrics): the bulk of the
// optional `AgentConfig` wire-slot fields were extracted into four cohesion
// interfaces under `./types/wire-slots-*`. `AgentConfig` `extends` all four so
// every field stays on the public surface BYTE-IDENTICALLY via declaration-
// merging — the `from "./types"` import contract for every consumer is
// unchanged. The interface names are re-exported too for discoverability.
export type { WireSlotsComposeConfig } from "./types/wire-slots-compose"
export type { WireSlotsCoreConfig } from "./types/wire-slots-core"
export type { WireSlotsRuntimeConfig } from "./types/wire-slots-runtime"
export type { WireSlotsSessionConfig } from "./types/wire-slots-session"

// AgentConfig `extends` the three cohesion groups defined at the BOTTOM of
// this file (SafetyConfig / PermissionExtrasConfig / SteeringConfig) plus the
// four extracted wire-slot groups (WireSlotsCore/Runtime/Session/Compose).
// Declaration-merging keeps every field shape byte-identical to consumers;
// the inheritance documents the grouping and lets each subsystem take a
// narrow slice as its parameter type (audit #1).
/**
 * Subsystem consumers SHOULD take a narrow `Pick<AgentConfig, ...>` rather than
 * the full bag — see `RecoveryConfig`, `MemoryConfig`, `FeaturesConfig`,
 * `TurnContextConfig`, `BudgetConfig`, `AdmissibilityGateConfig` below.
 * Adding a new field here without an associated narrow Pick is an SRP
 * regression.
 */
export interface AgentConfig
  extends SafetyConfig,
    PermissionExtrasConfig,
    SteeringConfig,
    WireSlotsCoreConfig,
    WireSlotsRuntimeConfig,
    WireSlotsSessionConfig,
    WireSlotsComposeConfig {
  llm: LLMPort
  registry: ToolRegistry
  /** Session tool-name ALLOWLIST (jul-7 audit F1). When set, feature tools that
   *  `buildSessionFeatures` materializes (spawn_agent / team_* / working-state / …)
   *  are intersected with this list in `buildEffectiveConfig` — so a restricted
   *  subagent (`tool_filter` / `task_kind:"read"`) cannot acquire spawn/team tools
   *  that its inherited-registry filter already denied. Absent ⇒ NO feature-tool
   *  filtering (byte-identical: a root/interactive session keeps every feature). */
  toolAllowlist?: readonly string[]
  stream: StreamPort
  /**
   * ADR-0267 (Phase 2 of ADR-0239) — narrow side-channel for gate-decision
   * events. SEPARATE from `stream` on purpose: the `decision` AgentEvent
   * variant is rendered by the stdout adapter + persisted by the JSONL
   * recorder the moment it lands on `stream`, so routing decisions through
   * `stream` by default would break the default-OFF byte-identical surface
   * invariant. The admissibility gate calls `decisionEmitter?.emit(...)` at
   * its 3 hot sites (rule / hook / permission). Absent ⇒ no emit, no
   * allocation, no visible bytes — byte-identical to the pre-Phase-2 path.
   * Composition roots wire this against the debug-tracer (NOT the main
   * stream) only when developer-mode is on.
   */
  decisionEmitter?: DecisionEmitter
  /**
   * Trajectory fork-experiment seam (troubleshooting). A pure rewriter applied
   * to the fully-assembled per-turn {@link TurnContextInput} (in
   * `prepareTurnContext`) JUST BEFORE `buildTurnContext` renders it — so an
   * experiment can vary EXACTLY the information the LLM sees at a chosen
   * `turn` (inject corrected localization, swap evidence, drop a misleading
   * note) while everything up to that turn replays deterministically from a
   * cassette. `turn` is the 1-based loop turn index (turn-loop.ts iterates
   * `for (turn = 1; turn <= maxTurns; turn++)` — the first turn is 1, NOT 0);
   * return the input unchanged for turns you don't want to touch.
   *
   * Contract (the seam does not enforce these — honour them):
   *  - MAY fire MORE THAN ONCE for the same `turn` value: refusal-fallback /
   *    nudge re-prompts re-enter `prepareTurnContext` within one logical turn
   *    (same-turn-engine.ts `for (;;)`). If you need fire-once semantics, key
   *    off your own counter, not `turn` alone.
   *  - PURE: return a NEW object; do NOT mutate `input` or its nested members
   *    in place. `baseMessages` is a shallow copy of working memory — mutating
   *    a shared `message.content[*]` object corrupts the session transcript.
   *    Use `{ ...input, baseMessages: [...input.baseMessages, extra] }`.
   *  - Vary MESSAGE CONTENT only. Do NOT change `system` / `cwd` — they pin the
   *    cached system-prompt prefix; rewriting them breaks per-turn cache reuse.
   *
   * DEFAULT-OFF: absent ⇒ the input reaches `buildTurnContext` untouched ⇒
   * byte-identical prompt. No I/O; replay-stable. This is the ONE seam the
   * fork/replay/branch tooling needs — cassette truncation (replay 0..N-1, live
   * from N) and the K-branch runner reuse existing primitives (ADR-0192 replay,
   * `sampleBestOfN`). Note: each branch MUST build its own replay port — a
   * shared port's `used` set is consumed by branch 1 (see RFC §4.1).
   */
  turnContextMutator?: (
    turn: number,
    input: import("./prompt").TurnContextInput,
  ) => import("./prompt").TurnContextInput
  permission: PermissionContext
  /** Conversation seed (typically one user message). */
  messages: Message[]
  system: string
  /** Declared prompt axes for this session/surface. Observation-only:
   *  forwarded into turn snapshots; absent ⇒ no surface-profile snapshot. */
  promptSurfaceProfile?: PromptSurfaceProfileSnapshot
  cwd: string
  maxTurns: number
  signal: AbortSignal
  /**
   * Asked when the permission policy returns `ask` (or the always-confirm HITL
   * tier fires). Absent ⇒ treated as deny.
   *
   * Returns either a legacy `boolean` (`true` allow / `false` deny —
   * BYTE-IDENTICAL: every existing caller uses this form and is unchanged) or a
   * structured {@link ConfirmDecision} (ADR-0076 Gap-4). A `ConfirmDecision`
   * adds the `deny_and_steer` verb (Cursor REJECT_AND_TELL): deny the action
   * AND carry a non-empty corrective `steer` the loop injects as the next-turn
   * user message. The gate normalizes the return via `normalizeConfirm` and,
   * on `deny_and_steer`, surfaces the steer on `DispatchResult.steerInjection`.
   */
  onConfirm?: (action: ToolAction) => Promise<boolean | ConfirmDecision>
  /**
   * Long-term memory store. Absent ⇒ recall/persist are skipped entirely and
   * the loop is byte-for-byte unchanged (RFC §6.3, behavior-preserving).
   */
  store?: PersistentStorePort
  /** Stable id for the current session, used to tag persisted memory. */
  sessionId?: string
  /**
   * F3 — OPTIONAL bench trajectory identity, stamped onto the top-level
   * `session_loop` OTEL span (see `sessionSpanAttrs`) so an OTLP span is
   * JOINABLE to its trajectory line. The bench driver sets `instanceId` (the
   * SWE-instance id) — together with the `quanta.run.id` resource attr the OTEL
   * exporter already carries, `{runId, instanceId}` is the join key that links
   * a span to `<runId>/<instanceId>.<attempt>.jsonl`. `attempt` is the
   * Best-of-N/retry index when the driver knows it. Absent (every non-bench
   * entry point) ⇒ span attrs untouched ⇒ byte-identical, and zero-overhead
   * when the OTEL sink is OFF (the span itself is a no-op sentinel).
   */
  spanIdentity?: { readonly instanceId?: string; readonly attempt?: number }
  /**
   * Embedding provider for semantic recall + dedup (long-term memory, RFC §6.3).
   * Absent ⇒ recall/consolidation degrade to lexical+tag+freshness only; the
   * loop is otherwise unchanged. Wired by the app layer (OpenAI adapter).
   */
  embedder?: EmbedderPort
  /**
   * Long-term memory tuning (RFC §6.3). Absent ⇒ all defaults;
   * with no `store` the whole block is inert. Behavior-preserving when unset.
   * See {@link MemoryConfigBlock} for the field-level docs.
   */
  memory?: MemoryConfigBlock
  /**
   * ADR-0068 2-phase memory consolidator session-end hook (L4 wire).
   * Absent ⇒ no consolidator runs at session-end (byte-identical for every
   * legacy caller — RFC §1.2 default-OFF). See {@link MemoryConsolidatorBlock}
   * for the field-level docs (enabled / forceSummarization / port / store /
   * threadId semantics).
   */
  memoryConsolidator?: MemoryConsolidatorBlock
  /**
   * ADR-0231 (wire phase) — radar proposal-queue producer hook. Absent ⇒ NO
   * radar sampling runs at any turn boundary (byte-identical for every legacy
   * caller — RFC §1.2 default-OFF; the same "turn-end pure hook, absent ⇒
   * byte-identical" precedent as {@link memoryConsolidator}). When present
   * (the composition root mints it behind `QUANTA_RADAR`), the loop calls
   * `maybeProposeRadarCard(block, ...)` in the turn finally, which deposits a
   * heuristic-derived card on `block.store` ONLY when the turn COMPLETED and
   * the pure idle/long-task heuristic fires. A radar fault is logged +
   * swallowed — it can never derail the turn. See {@link RadarProducerBlock}.
   */
  radar?: RadarProducerBlock
  /**
   * Compaction tuning. Absent ⇒ compaction is skipped entirely (existing
   * suites with no compaction config are unaffected). See
   * {@link CompactionConfigBlock} for the field-level docs
   * (thresholdTokens / keepRecentTurns / summarizerLlm / archive).
   */
  compaction?: CompactionConfigBlock
  /**
   * Cursor-style pre-compact HITL hook (ADR-0075). When the proactive
   * compaction path is ABOUT to fire (token threshold crossed AND a
   * summarizable boundary exists), the loop builds a
   * {@link PreCompactRequestQuery} and awaits this callback. See
   * {@link OnPreCompactCallback} for the full semantics (approve /
   * defer_one_turn / force_now / error → defer). Absent ⇒ auto-approve,
   * byte-identical.
   */
  onPreCompact?: OnPreCompactCallback
  /**
   * In-process hook bus (RFC §13 Q1). Absent ⇒ no events emitted, zero
   * overhead, loop byte-for-byte unchanged.
   */
  hooks?: HookBus
  /**
   * Plan mode (RFC §13 Q3). When true: system prompt is augmented and any
   * non-read-only tool is blocked before permission/execute. Absent/false ⇒
   * unchanged. Superseded by `mode` (see below) — both are accepted; `mode`
   * wins when set.
   */
  planMode?: boolean
  /**
   * Agent interaction mode (Codex `mode-and-plan-process-audit.md` absorption).
   * Extends `planMode` into a typed enum: `default | plan | review | audit`.
   * `plan` matches the legacy boolean. `review` / `audit` add task-posture
   * mode notices in the per-turn reminder; tool gating for these is wired in
   * Phase 3. Absent ⇒ derived from `planMode` (byte-identical).
   */
  mode?: AgentMode
  /**
   * Plan-vs-Default collaboration mode (ADR-0036). 2-mode enum tied to the
   * DISPATCH SEAM (orthogonal to {@link mode}, which drives the per-turn
   * PROMPT posture). In `"plan"` posture every mutating tool is blocked at
   * the dispatch seam BEFORE any tool implementation runs — the block is
   * driven by an explicit per-tool table in `./mode.ts#MUTATING_TOOL_TABLE`
   * so a future tool added without classifying its mutating-kind is a hard
   * fail rather than a silent allow.
   *
   * Default-OFF: absent ⇒ derived as `"default"` (no block, byte-identical
   * for every legacy caller). The two-mode collaboration enum is INTENT-
   * DISTINCT from the 4-mode {@link mode}: a host may legitimately run a
   * `mode: "review"` posture (a read-only-by-prompt mode) without setting
   * `collaborationMode: "plan"` — the prompt posture controls what the
   * model is told; the dispatch posture controls what the registry will
   * RUN. Setting both keeps the safe direction: the dispatch seam blocks
   * mutating calls regardless of what the prompt says.
   */
  collaborationMode?: import("./mode").CollaborationMode
  /**
   * Repo-local rules to inject ahead of memory hints as repo authority (Codex
   * `repo-local-rule-ingestion-audit.md` absorption). Loaded by the caller
   * (e.g. via `loadRepoRules(cwd)`) — the loop does not auto-read so contexts
   * that should NOT adopt workspace rules (bench sandboxes, agent forks) stay
   * byte-identical. Absent ⇒ no repo-rules block.
   */
  repoRules?: RepoRules
  /**
   * Static session context block prepended into the cached system sections.
   * Caller-owned: cross-session memory, tool snapshots, or other durable
   * host context may live here. Absent ⇒ prompt stays byte-identical.
   */
  sessionCtx?: string
  /**
   * Distilled `memory_summary.md` body loaded once per session start. It shares
   * the cached `session_ctx` section with `sessionCtx`, but stays a distinct
   * field so the prompt owner preserves the wrapper/cap/ordering semantics.
   */
  memorySummaryMd?: string
  /**
   * File-scoped rules (Cursor `.cursor/rules/*.mdc` parity — glob-matched +
   * always-applied kinds). Loaded by the caller (e.g. `loadGlobRules(cwd)`),
   * same opt-in posture as `repoRules`. `rules` is the FULL discovered set;
   * `changedPaths` is the per-turn file list that drives glob selection (a host
   * may pass the same list it gives `skills.changedPaths`). Each turn the loop
   * injects `alwaysApply` rules ∪ rules whose globs match a changed path.
   * Absent ⇒ no block, byte-identical (RFC §1.2 default-OFF).
   */
  globRules?: { rules: GlobRule[]; changedPaths?: string[] }
  /**
   * ADR-0233 (Wire 2) — Multi-source rules vendor-detector composition.
   *
   * When set with `vendorDetectorEnabled: true`, the caller-side
   * `loadGlobRulesWithVendors(cwd, config.rules)` helper composes the
   * legacy `loadGlobRules(cwd)` output with `DetectedRule[]` from the
   * vendor detector slice (ADR-0205). Hosts that have already wired the
   * helper into their session-start flow pass the resulting GlobRule[]
   * through {@link globRules}.rules as before — this slot is the policy
   * knob set, not a runtime store.
   *
   * Absent / `vendorDetectorEnabled !== true` ⇒ no composition, byte-
   * identical to legacy (RFC §1.2 default-OFF). See {@link RulesConfigBlock}
   * for the field-level docs (vendorDetectorEnabled / vendors / priority /
   * detector override semantics).
   */
  rules?: RulesConfigBlock
  /**
   * Metrics registry (RFC §8 Phase 3). Absent ⇒ no metrics recorded; loop
   * behavior identical.
   */
  metrics?: Metrics
  /**
   * ADR-0452 — session-startup prewarm + Time-To-First-Message (Codex
   * `session_startup_prewarm` absorption). Absent ⇒ NO prewarm call and NO
   * TTFM metric (the loop is byte-identical to the pre-slice path). Present
   * (set by the `QUANTA_PREWARM` knob at the composition root) ⇒ the loop, at
   * session start (before the first turn), best-effort warms the LLM
   * connection via {@link import("@/llm").prewarmLlm} (a no-op unless the
   * adapter implements the optional `prewarm` capability) and records TTFM on
   * the first turn's LLM-stream dispatch.
   *
   * The capability half of startup prewarm (tools / skills / classifier) is
   * ALREADY eager in `buildSessionFeatures`; this block only adds the
   * LLM-connection warm + the observability, both gated together.
   */
  prewarm?: {
    /** Master gate. Only `true` arms the prewarm call + TTFM recording. */
    readonly enabled: boolean
    /** Injected wall-clock for TTFM (epoch ms). Inject a fake clock in tests
     *  for determinism; defaults to `Date.now` when omitted. NO real timer is
     *  read in the loop body — this is the single source. */
    readonly now?: () => number
    /** Optional abort signal for a slow connection warm so it can never delay
     *  the first turn. Independent of the loop's lifetime `signal`. */
    readonly warmSignal?: AbortSignal
  }
  /**
   * RFC jun-17 (code-intelligence warm backend) — session-start LSP workspace
   * prewarm. ORTHOGONAL to {@link prewarm} (which warms the LLM/TTFM path); this
   * warms the language-server workspace. Absent ⇒ NO background LSP prewarm and
   * the loop is byte-identical. Present + `enabled` ⇒ session bootstrap
   * FIRE-AND-FORGETS a background warm of the Python workspace's anchor file so
   * the first LSP nav call joins a warm pool instead of paying the 2–6s cold
   * pyright boot. Session start is NEVER delayed or aborted by it.
   *
   * Gated at the composition root by `QUANTA_LSP_PREWARM` AND the nav tools
   * being enabled (`QUANTA_LSP_TOOLS=full` / `QUANTA_BENCH_LSP=1`) — warming a
   * server whose tools are not even exposed would be wasted work.
   */
  lspPrewarm?: {
    /** Master gate. Only `true` arms the background warm. */
    readonly enabled: boolean
    /** Abort signal (the session signal) so session end cancels an in-flight
     *  background warm instead of riding out the readiness budget. */
    readonly warmSignal?: AbortSignal
  }
  /**
   * RFC jun-17 — evict pooled LSP workspaces at session end. Interactive relies
   * on the pool's idle-TTL for cross-turn / cross-session reuse; BENCH sets this
   * so a per-instance sandbox cwd does not leak a language-server child for the
   * whole idle-TTL window. Absent/false ⇒ idle-TTL only (byte-identical).
   */
  evictLspPoolOnEnd?: boolean
  /**
   * jun-6 account-ratelimit-snapshot (gate `QUANTA_RATELIMIT_PROACTIVE`).
   * Optional injected collaborators for the PROACTIVE rate-limit path so the
   * loop reads no real clock and sleeps no real timer in tests.
   *   - `now` — injected wall-clock (epoch ms) fed to `parseRateLimitSnapshot`
   *     and used to time the proactive delay. Defaults to `Date.now`.
   *   - `sleep` — injected delay primitive `(ms) => Promise<void>`. Defaults to
   *     the loop's abort-aware `setTimeout` sleep. A fake lets a test assert the
   *     delay magnitude WITHOUT wall-clock waiting.
   * The block is consulted ONLY when `runtimeConfig().proactiveRateLimit` is on;
   * absent ⇒ the proactive store is never constructed, the header hook is never
   * wired, no delay is applied, no notice emitted — byte-identical to today's
   * reactive 429-retry path. */
  proactiveRateLimit?: {
    readonly now?: () => number
    readonly sleep?: (ms: number) => Promise<void>
  }
  /**
   * Subagent recursion depth of THIS agent (0 = root user session). Set by
   * the subagent runner for forked children; propagated onto `ToolContext`
   * by the dispatch seam so the `Agent` tool can enforce `maxDepth`. Absent ⇒
   * 0 (root). Subagent absorption (ADR-0011).
   */
  depth?: number
  /**
   * Enable the subagent system (Tier 1 capability, ADR-0011). Absent ⇒ the
   * `Agent`/`Task`/`TaskOutput`/`TaskStop` tools are NOT registered and the
   * loop is byte-identical. When present the loop builds a `SubagentRunner`
   * (forked `runAgent`, depth+1, filtered registry) and registers the tools.
   *
   * See {@link SubagentBlock} for the field-level docs.
   */
  subagent?: SubagentBlock
  /**
   * Enable the skill system (Tier 1 capability, ADR-0011). Absent ⇒ no skill
   * discovery and the `Skill`/`ToolSearch` tools are NOT registered (loop
   * byte-identical). When present, skills are discovered + the `Skill` /
   * `ToolSearch` tools are registered.
   *
   * `dir` (OPTIONAL — ADR-0045 follow-up): the user skills directory. When
   * OMITTED, only the BUNDLED system skills (`localize-fault`, `progress-audit`
   * — version-pinned, shipped with the framework) are discovered. This lets a
   * host enable the discipline skills WITHOUT remembering to point at a user
   * dir (the whole rationale of bundled skills). `skills: {}` ⇒ system skills
   * only; `skills: { dir }` ⇒ user dir + system skills (system wins on a name
   * collision so a user skill cannot weaken a bundled one). `skills` ABSENT ⇒
   * no Skill tool, byte-identical default-OFF (RFC §1.2).
   *
   * `changedPaths` (optional, conservative L1→L2 wiring): when set, the
   * per-turn active-skills inventory is pre-filtered via
   * `skillsActivatedFor(allSkills, changedPaths)` — a skill with `paths:` in
   * its frontmatter only appears in the inventory when one of those globs
   * matches a changed path. A skill WITHOUT `paths:` is always included
   * (unconditional). `changedPaths` UNSET ⇒ no filter, exact prior behavior
   * (byte-identical). Hosts compute this list however they want (git diff,
   * file watcher, manual hint).
   *
   * See {@link SkillsBlock} for the field-level docs.
   */
  skills?: SkillsBlock
  /**
   * Compaction circuit-breaker control (Tier 0 safety hardening, ADR-0011). The
   * breaker is ON by default with `DEFAULT_COMPACTION_BREAKER_CAPS` — it only
   * trips on pathological compaction thrash (≥N consecutive no-progress
   * compactions), so normal flows are unaffected. See
   * {@link CompactionBreakerOptions} (`disabled` opts out; `caps` overrides
   * individual thresholds).
   */
  compactionBreaker?: CompactionBreakerOptions
  /**
   * Verify-guard control (Tier 0 safety hardening). Absent ⇒ guard fully OFF and
   * the loop is byte-identical. When present, a finish attempt right after a
   * mutating tool with no test/reproduction since is blocked, forcing one more
   * turn (up to `maxTrips`, default 1 — capped to avoid infinite forcing;
   * lowered from 2 in ADR-0013 변경 이력 per the negative empirical from
   * ADR-0014 — bench callers may still explicitly override).
   *
   * `mustPass:true` (default `false`) extends the guard with the SOTA outcome-
   * gate: when set, a finish attempt is ALSO blocked when the most-recent
   * verify call after the latest edit FAILED (dispatch `ok:false` OR the
   * captured output contains an explicit per-ecosystem failure marker). Closes
   * the "ran pytest → ok:false → declared done" loophole observed in
   * skills/subagent-ON sanity runs. Aider / Agentless / SWE-agent all run an
   * outcome-gate of this shape; quanta's bench driver enables it for real
   * SWE-bench instances with `maxTrips:2`.
   */
  verifyGuard?: {
    maxTrips?: number
    mustPass?: boolean
    exactCommands?: readonly string[]
    stickyRed?: boolean
  }
  /**
   * Localize-phase guard (Agentless "localize-first" absorption — Tier 0
   * safety hardening). When set with a positive integer `phase1Turns`, the
   * dispatch seam BLOCKS mutating tools (`edit`/`write`/`scripted_replace`)
   * during the first N turns of the run — the model is forced to use
   * `read`/`grep`/`glob`/`localize` to pin down file + function FIRST. After
   * `phase1Turns` turns elapse, the gate becomes a no-op (Phase 2 — repair).
   *
   * Absent / `phase1Turns` invalid (undefined, 0, NaN, Infinity, non-integer)
   * ⇒ guard fully OFF and the loop is byte-identical. Default-OFF (RFC §1.2);
   * the bench driver opts in via `QUANTA_BENCH_LOCALIZE_PHASE=N`. See
   * `./localize-phase-guard.ts` for the pure policy + the closed mutating set.
   */
  localizePhase?: LocalizePhaseConfig
  /** Localize-phase state slot — built by `buildLocalizePhase` ONLY when
   *  `localizePhase.phase1Turns` is a positive integer. The loop bumps
   *  `state.turn` at the TOP of each turn (0-indexed). Dispatch reads this
   *  through `consultLocalizePhaseGuard`. Absent ⇒ guard never fires (the
   *  decision returns `{block:false}`, byte-identical).
   *
   *  Carried as an internal slot (not a public knob) so callers cannot
   *  hand-craft a turn counter that disagrees with the loop's. The field is
   *  PUBLIC because the dispatch seam is in a sibling module — there is no
   *  module-private channel between `loop.ts` and `dispatch.ts`. */
  localizePhaseState?: LocalizePhaseState
  /** repro-doubt guard config (jun-20). `{stuckRuns:N}` ⇒ after N test re-runs
   *  with no edit, dispatch appends the one-shot doubt steer. Absent ⇒ OFF
   *  (byte-identical). Set by the `repro-doubt` knob (QUANTA_BENCH_REPRO_DOUBT). */
  reproDoubt?: ReproDoubtConfig
  /** repro-doubt mutable state slot — built by `buildReproDoubt` ONLY when
   *  `reproDoubt.stuckRuns` is active. Dispatch advances it per tool call and
   *  appends {@link REPRO_DOUBT_STEER} once per stuck streak. Absent ⇒ never fires. */
  reproDoubtState?: ReproDoubtState
  /** Bench test-scope guard (RCA 2026-06-19, django-13417). When `true`, the
   *  dispatch pre-flight `consultTestScope` DENIES any mutating tool
   *  (edit/write/scripted_replace/apply_patch[_structured]) whose target is a
   *  test path (`@/shared#isTestFilePath` — same SSOT the bench patch sanitizer
   *  uses) and steers the model back to source-only edits. Removes the observed
   *  regression where the model wrote the correct minimal fix, then edited tests
   *  and chased them into a wrong over-built fix. Absent/false ⇒ guard OFF and
   *  dispatch is byte-identical. Bench-only (driver opts in for swebench
   *  in-loop runs); the grader supplies its own tests, so a denied test edit
   *  loses nothing. */
  protectTestPaths?: boolean
  /** Closeout guard (Codex CloseoutLens §4 mirror). Optional, absent ⇒ guard
   *  fully OFF and the loop is byte-identical. When `enabled` true, a single
   *  pre-finish nudge injects the closeout reminder (keep only defended claims,
   *  state if verification not run, separate fact from inference, match
   *  requested reporting shape) once per run. Single-shot by design — no
   *  maxTrips knob (multiple closeout nudges just thrash).
   *
   *  `fourRule:true` (Codex `response-assembly-and-closeout.md §5.2` verbatim
   *  absorption) replaces the single-line reminder with the full 4-rule
   *  defended-claim checklist + VerificationCloseout scaffold cue. Use when
   *  the workload demands the stricter discipline (review/audit/SWE-bench).
   *  Absent / false ⇒ legacy one-liner. */
  closeoutGuard?: { enabled?: boolean; fourRule?: boolean }
  /**
   * Working state opt-in (Codex memory L3 absorption). Absent ⇒ no working-
   * state block is rendered, the `update_working_state` tool is NOT registered,
   * and the loop is byte-identical. When set, the loop builds a session-scoped
   * `WorkingState`, plumbs it through `ToolContext.workingState`, registers the
   * `update_working_state` meta-tool, and renders the L3 block in the per-turn
   * reminder (BELOW repo-rules, ABOVE memory hints).
   *
   * See {@link WorkingStateBlock} for the field-level docs.
   */
  workingState?: WorkingStateBlock
  // §19.1 NOTE (SSOT): there is deliberately NO `mcpToolAnnotations` field here.
  // The SOLE LIVE channel for the `QUANTA_MCP_TOOL_ANNOTATIONS` knob is the
  // env var, read at the composition root via `runtimeConfig().mcpToolAnnotations`
  // and folded into the `loadMcpTools` opts (`annotationsHonored`); the bridge
  // never reads an `AgentConfig` field, so a config field here would be dead
  // (and an observability footgun). The knob's `apply` is an identity no-op.
  /** §20.2 (jun-7 gap-other-agent) — host-wired named-agent resolver. The
   *  subagent runner consults this when a spawn carries a matching `agentType`
   *  and folds the resolved definition's `{system, tools, model, mode}` into the
   *  child (narrow-only tools, explicit-request-wins). Absent ⇒ no named-agent
   *  resolution and the spawn path is byte-identical. Host builds it via
   *  `loadNamedAgents(cwd)`. */
  namedAgentResolver?: NamedAgentResolver
  /** P12 (jun-7 gap-other-agent) — closeout critic gate. Absent ⇒ OFF and the
   *  loop's completion seal is byte-identical. When `enabled` AND `critic`
   *  injected, the loop consults the critic right before sealing a completed
   *  turn; the verdict surfaces as an advisory `recovery`/`closeout` event and
   *  NEVER blocks completion. Port absent / critic throws ⇒ FAIL-OPEN. Knob:
   *  `QUANTA_CLOSEOUT_CRITIC`. */
  closeoutCritic?: CloseoutCriticConfig
  /** T08 — model-refusal recovery (fork/neutralize + re-prompt). Absent ⇒ OFF
   *  and a refusal-class stop (`refusal` / `content_filtered`) terminates the
   *  turn byte-identically. When `enabled`, the loop neutralizes the refused
   *  turn and re-prompts ONCE with the (configurable) fallback prompt; a second
   *  refusal — or a fork that would exceed `taskBudget` — is terminal. Knob:
   *  `QUANTA_REFUSAL_FALLBACK` (+ optional `QUANTA_REFUSAL_FALLBACK_PROMPT`). */
  refusalFallback?: RefusalFallbackConfig
  /** HITL 4-tier gate (Codex hitl-audit.md absorption). Absent ⇒ legacy
   *  single-tier behavior (byte-identical). When enabled, every dispatch
   *  computes the effective tier and routes through tier-specific gates:
   *  hand-off-required terminates, always-confirm calls onConfirm (not
   *  skippable by acceptEdits; under BYPASS the `needs-sandbox`-REASON tier —
   *  bash w/o a sandbox profile, unclassified mutating tools — falls through
   *  to mode policy instead, jul-10 D-1 follow-through; sensitive/declared/
   *  registry reasons still confirm), pre-approval-ok defers to the existing
   *  mode policy, and none allows.
   *
   *  `enabled` turns on the richer reviewer escalation. INDEPENDENTLY, the
   *  `hand-off-required` tier is a UNIVERSAL security floor — it denies on every
   *  surface regardless of `enabled` (jun-10 keystone).
   *
   *  `autoApprove` (P2-T3 always-confirm secure-by-default, LIVE — see
   *  always-confirm-secure-by-default-e2e): the autonomous opt-out that lets a
   *  headless / bench / CI surface auto-run universal-floor always-confirm
   *  tools unattended. */
  hitl?: { enabled?: boolean; autoApprove?: boolean }
  /**
   * ADR-0047 UI integration seam. When the admissibility-gate emits a
   * hand-off-required deny (HARD_DENY hit OR an explicit/registry-
   * promoted `hand-off-required` tier), it ALSO fires this callback with
   * a structured {@link HandoffRequiredEvent}. Absent ⇒ no event emitted
   * (byte-identical legacy). The callback is wrapped in try/catch so a
   * host-side bug never propagates into dispatch — emission is best-
   * effort, the deny result is the authoritative signal.
   */
  onHandoff?: (event: HandoffRequiredEvent) => void
  /** ADR-0050 trust-scope wire-up (Phase C). DEFAULT OFF — absent ⇒ the
   *  admissibility-gate ask-branch never short-circuits on scope. When set,
   *  the gate consults `registry.hasGrant(projectKey, { tool })` before
   *  calling host `onConfirm`. */
  trustScope?: { registry: TrustScopeRegistry; projectKey: string }
  /** ADR-0030 mid-turn steering: mutable ref the loop overwrites on every
   *  turn boundary with the active {@link ActiveTurnState} (fresh
   *  `currentTurn` header per turn; `currentTurn=null` + `isInterrupted`
   *  reflecting the stop reason after finish). Absent ⇒ no state exposed
   *  (byte-identical legacy). */
  activeTurnRef?: { current: ActiveTurnState }
  /** §11.5 — interrupted-turn restore buffer. When a turn is aborted by a
   *  conversation-action `cancel` (interrupt mode / `/cancel`), the loop captures
   *  the partial turn into THIS session-scoped buffer; a later `resume` action
   *  re-injects it (the agent picks the interrupted task back up). Absent ⇒ no
   *  capture, `resume` is a no-op (byte-identical legacy). The buffer's presence
   *  is the session-level "interrupted" signal (vs the per-turn
   *  {@link ActiveTurnState.isInterrupted} which resets each boundary). */
  interruptedTurnBuffer?: import("./interrupted-turn").InterruptedTurnBuffer
  /** §20.4 (ticket-12) — subagent FS owned/forbidden ENFORCEMENT policy. Built
   *  from the spawn request's `ownedSurfaces`/`forbiddenSurfaces` (canonicalized)
   *  when `QUANTA_FS_OWNERSHIP_ENFORCE` is on; the dispatch gate HARD-blocks a
   *  write outside owned / inside forbidden. Absent / `enforced:false` ⇒ the
   *  advisory-only legacy (seed-prompt guidance), byte-identical. */
  ownershipPolicy?: import("./ownership-policy").OwnershipPolicy
  /** ADR-0030: awaited ONCE at the top of each turn (before the next LLM
   *  call) so a surface can fence a mid-turn injection into the conversation
   *  buffer before the loop snapshots it. Absent ⇒ never awaited
   *  (byte-identical legacy). */
  steerBarrier?: () => Promise<void>
  /**
   * Correlation context (RFC-0002 §5.1). Absent ⇒ the loop behaves
   * byte-identically (project-standard optional-context pattern, like
   * `metrics?`/`hooks?`). When present the loop maintains a per-turn working
   * copy (the caller's object is never mutated) used purely for trajectory
   * correlation — it never changes control flow, StopReason, emit ordering,
   * or messages.
   */
  run?: RunContext
}

// ─────────────────────────────────────────────────────────────────────────
// AgentConfig cohesion groups (Round-3 audit #1 — additive seam).
// AgentConfig `extends` these so the flat field set on the public type is
// byte-identical (consumers reading `config.verifyGuard` etc. are unchanged),
// but each subsystem can now take the narrow slice it actually needs as its
// parameter type — turning the 53-field god-config into a documented
// composition of cohesive sub-configs without a breaking restructure.
//
// Field types here MUST stay byte-identical to the AgentConfig body
// declarations above; declaration-merging requires identical signatures.
// ─────────────────────────────────────────────────────────────────────────

/** Safety / guard knobs. Each member is default-OFF when absent. */
export interface SafetyConfig {
  compactionBreaker?: CompactionBreakerOptions
  verifyGuard?: {
    maxTrips?: number
    mustPass?: boolean
    exactCommands?: readonly string[]
    stickyRed?: boolean
  }
  localizePhase?: LocalizePhaseConfig
  localizePhaseState?: LocalizePhaseState
  /** repro-doubt guard — see AgentConfig.reproDoubt / reproDoubtState. */
  reproDoubt?: ReproDoubtConfig
  reproDoubtState?: ReproDoubtState
  /** Bench test-scope guard — see AgentConfig.protectTestPaths. */
  protectTestPaths?: boolean
  closeoutGuard?: { enabled?: boolean; fourRule?: boolean }
  /** P12 — closeout critic gate (mirrors `closeoutGuard` placement on both
   *  AgentConfig and SafetyConfig). See AgentConfig.closeoutCritic. */
  closeoutCritic?: CloseoutCriticConfig
  dedupGate?: DedupGate
  dedupGateConfig?: { disabled?: boolean; caps?: Partial<DedupGateCaps> }
}

/** Permission-stack add-ons orthogonal to the core {@link AgentConfig.permission}
 *  context. Each is default-OFF. */
export interface PermissionExtrasConfig {
  hitl?: { enabled?: boolean; autoApprove?: boolean }
  trustScope?: { registry: TrustScopeRegistry; projectKey: string }
  permissionStack?: { enabled?: boolean; hostId?: string }
  permissionPatternStore?: PatternGrantStore
  permissionAllowDangerous?: boolean
}

/** Mid-turn steering wiring (ADR-0030). Default-OFF when absent. */
export interface SteeringConfig {
  activeTurnRef?: { current: ActiveTurnState }
  steerBarrier?: () => Promise<void>
}

/** Narrow contract for {@link runAdmissibilityGate} — Round-3 audit #9
 *  ("feature envy on AgentConfig"). The gate reads exactly these fields;
 *  taking the narrow type instead of the whole `AgentConfig` documents the
 *  surface and prevents accidental growth. `AgentConfig` is assignable to
 *  it, so existing callers (`dispatch.ts`) need no change. */
export type AdmissibilityGateConfig = Pick<
  AgentConfig,
  | "cwd"
  | "decisionEmitter"
  | "hitl"
  | "hooks"
  | "mode"
  | "onConfirm"
  | "onHandoff"
  | "permissionAllowDangerous"
  | "permissionPatternStore"
  | "permissionStack"
  | "planMode"
  | "registry"
  | "run"
  | "sessionId"
  | "toolProfile"
  | "trustScope"
>

/** Narrow contract for the loop's recovery seam (recovery.ts decisions +
 *  reactive compaction surface). Recovery itself uses internal SAME-TURN
 *  budget constants; the loop wires the decision into the actual transcript /
 *  compaction path via `llm`, `stream`, `signal`, and the `compaction` block
 *  (summarizer + thresholds). `compactionBreaker` short-circuits pathological
 *  compaction thrash. ISP slice for the recovery / compaction co-operators. */
export type RecoveryConfig = Pick<
  AgentConfig,
  "llm" | "stream" | "signal" | "compaction" | "compactionBreaker" | "onPreCompact"
>

/** Narrow contract for the plan-mode lifecycle wires (`loop/plan-enter-wire.ts`,
 *  `loop/plan-exit-wire.ts`). They read/mutate the collaboration posture
 *  (`mode`/`planMode`/`collaborationMode` via `applyCollaborationModeTransition`),
 *  emit `mode_changed` on `stream`, and clear the mutable `planStore` on approved
 *  exit — nothing else on the 71-field `AgentConfig`. A full `AgentConfig` is
 *  assignable here, so callers pass it verbatim; the wire signatures just declare
 *  the slice they depend on (ISP, mirrors {@link RecoveryConfig}). */
export type PlanLifecycleConfig = Pick<
  AgentConfig,
  "mode" | "planMode" | "collaborationMode" | "stream" | "planStore"
>

/** Narrow contract for the long-term memory subsystem (RFC §6.3; memory.ts /
 *  memory-distill.ts / memory-consolidate.ts seams). Recall + persist + distill
 *  read `store` / `embedder` / `memory` knobs; `sessionId` tags persisted
 *  records; `llm` powers distill + consolidate. Absent fields ⇒ the subsystem
 *  degrades exactly as it does on the full `AgentConfig`. */
export type MemoryConfig = Pick<AgentConfig, "store" | "embedder" | "memory" | "sessionId" | "llm">

/** Narrow contract for `buildSessionFeatures` (features.ts). Turns the
 *  optional Tier-1 toggles into wired services (skills inventory, subagent
 *  runner, working-state, branch-search tool, plan-exit). Reads `registry` +
 *  `llm` + `permission` for the per-feature wiring, plus the feature
 *  toggles themselves. */
export type FeaturesConfig = Pick<
  AgentConfig,
  | "registry"
  | "llm"
  | "permission"
  | "skills"
  | "subagent"
  | "workingState"
  | "branchSearch"
  | "shadowCheckpoint"
  | "shadowOdb"
  | "shadowVerify"
  | "subagentBackground"
  | "subagentMailbox"
  | "delegation"
  | "fork"
  | "onProgress"
  | "planExitPort"
  | "modelCandidates"
  | "planQueue"
  | "webSearch"
  | "advisor"
  // ─── P0/P1 wire-audit closeout (new slots reachable from features.ts) ───
  // `budgetLedger` is consumed TODAY (builds `budget_status` tool).
  // The remaining 6 are helper-only slots: their presence on the FeaturesConfig
  // Pick documents that future caller-wire-time consumers in features.ts will
  // read them, and keeps the Pick union from drifting away from AgentConfig.
  | "budgetLedger"
  | "objective"
  | "runLedger"
  | "approvalStateMachine"
  | "conversationCheckpoint"
  | "responsesContinuation"
  | "llmProvider"
  | "lspPorts"
  | "metrics"
  | "osSandbox"
  // ─── ADR-0417 (ports-only, consumer wire deferred) ───
  | "effortClassifier"
  | "fastApplyFallback"
  | "fastApplyMerge"
  // ─── ticket-11 (P8 git-worktree agent tools) ───
  // Present ⇒ features.ts registers the enter/exit/worktree_status tools over the
  // session-scoped slot. Absent ⇒ the tools are not registered (default-OFF).
  | "activeWorktreeSlot"
>

/** Narrow contract for per-turn prompt / context assembly (the loop's
 *  reminder-builder + IDE-context snapshot + redaction-config consult). These
 *  are the fields read at the TOP of each turn to compose what the model
 *  sees, distinct from the recovery / dispatch fields read inside the turn. */
export type TurnContextConfig = Pick<
  AgentConfig,
  | "cwd"
  | "system"
  | "mode"
  | "planMode"
  | "repoRules"
  | "globRules"
  | "ideContextProvider"
  | "redaction"
  | "run"
  | "sessionId"
>

/** Narrow contract for the budget / mode-policy slot (RFC may-22 Phase 0/1).
 *  The loop's tick sites emit through `budgetMeter`; `modePolicy` clamps the
 *  meter caps and parametrizes the dispatch posture; `maxTurns` is the hard
 *  upper bound the loop enforces independently of any meter. */
export type BudgetConfig = Pick<AgentConfig, "budgetMeter" | "modePolicy" | "maxTurns">
