/**
 * Admissibility-gate SSOT (Codex `may-20-codex-agent-loop.md §5` absorption
 * — ADR-0018). Single canonical function that runs ALL pre-execute
 * gates in ONE place, in ONE documented order, with ONE testable seam.
 *
 * Before this extraction, gate ordering was distributed across `dispatch.ts#
 * runGates`, `permission/policy.ts#evaluate` (HARD_DENY inside), and
 * `dispatch.ts#runHitlGate` (HARD_DENY also inside). The order was correct but
 * not asserted by any single test and not visualizable in one file.
 *
 * Canonical order (matches the Codex agent-loop §5 mermaid):
 *   1. visible           — registry has the tool (checked upstream in dispatch)
 *   2. plan/review/audit mode block — mutating tools refused in non-default modes
 *   3. HITL tier         — when `config.hitl?.enabled === true`:
 *                          hand-off-required ⇒ deny (no mode can authorize),
 *                          always-confirm    ⇒ ask via onConfirm (cannot be
 *                                              skipped by acceptEdits/bypass),
 *                          none              ⇒ allow (skip mode policy),
 *                          pre-approval-ok   ⇒ fall through to mode policy.
 *   4. permission policy — HARD_DENY (security boundary) inside, then mode-
 *                          driven decision (default/acceptEdits/bypass/auto).
 *                          "auto" routes through the injected classifier.
 *   5. repo-local hook   — `pre_tool_use` hook may deny (RFC §13).
 *
 * Behavior-preserving extraction: every return path matches the prior
 * `dispatch.ts#runGates` exactly. Wave B4 fills in the body via TDD; the
 * dispatch seam then delegates to it.
 */
import type { ToolUseBlock } from "@/llm"
import { attrs, QUANTA_ATTRS, recordAttrs, SPAN_NAMES } from "@/observability"
import {
  type AutoModeClassifier,
  autoPassByPatterns,
  buildAutoModeOverlay,
  type CircumventionTracker,
  CLASSIFIER_SYSTEM_PROMPT,
  classifyCommand,
  computeActionSignature,
  type DenialMemory,
  type DenyLayer,
  type DenyPillar,
  decideFloor,
  type EffectSignature,
  type EvaluateAutoOptions,
  evaluate,
  evaluateAuto,
  evaluateStack,
  extractWriteEffects,
  getDefaultPermissionStore,
  grantAndCascade,
  type HITLTier,
  hardDenyReason,
  hardDenySafeReason,
  inferReviewKind,
  inferToolTier,
  isAllowed,
  isDecisionLegalFor,
  // #20 (durable prefix safety) — single-simple-command guard for the
  // trust-scope ask-skip (a chained command must never ride a token-prefix grant).
  isSimpleCommand,
  type LayeredRule,
  type LearningSource,
  type PendingPermission,
  type PermissionContext,
  type PermissionDecision,
  type PermissionStore,
  type ReviewContext,
  type ReviewerPort,
  type ReviewerTier,
  resolveHostId,
  reviewAction,
  type StructuredDenyReason,
  type StructuredDenyReasonInput,
  structuredDenyReason,
  type ToolActionKeyed,
  withExfilScoutingTaxonomy,
  withUserRuleOverlay,
} from "@/permission"
import type { RulesStore } from "@/rules"
import { errMessage, runtimeConfig, writeStderr } from "@/shared"
import { safeEmitDecision } from "@/stream"
import { createApprovalGate } from "./approval-gate-wire"
import {
  buildDenySteerMessage,
  type ConfirmDecision,
  isAllowed as isConfirmAllowed,
  normalizeConfirm,
} from "./confirm-decision"
import { deny, HANDOFF_SUFFIX } from "./dispatch-helpers"
import type { DispatchResult } from "./dispatch-types"
import type { HandoffRequiredEvent, HitlTier } from "./hitl-tier"
import { type HitlAnnotation, resolveHitlAnnotation } from "./hitl-tier-registry"
import { type HookPermissionDecision, routePermissionHookVerdict } from "./hooks"
import { isMutatingToolBlockedInMode, modeBlockReason, resolveAgentMode } from "./mode"
import type { AdmissibilityGateConfig } from "./types"

export interface AdmissibilityAction {
  tool: string
  input: unknown
  isReadOnly: boolean
  /**
   * S16 (audit A1 #3) — shell-equivalent command string when the tool's input
   * represents one, derived from `ToolRegistry.extractShellCommand(tool,input)`.
   * The dispatch seam may populate it, but the gate NEVER trusts the caller to
   * have done so: {@link withResolvedShellCommand} re-derives it from the
   * registry at the top of {@link runAdmissibilityGate} so EVERY downstream
   * HARD_DENY check (`hardDenyReason` in the HITL branch, `evaluate` /
   * `evaluateAuto` in mode-policy, `evaluateStack` in the per-thread stack)
   * applies the denylist uniformly to ANY shell-equivalent tool — not just one
   * named "bash". A non-bash shell/exec/MCP-run tool can therefore never
   * sidestep HARD_DENY by reaching mode-policy / the permission stack with the
   * command stripped off the action.
   *
   * `null` / absent ⇒ the tool does not represent a shell command (no gate).
   */
  shellCommand?: string | null
  /**
   * ADR-0061 (absorb #2) — patterns the action declares it would be satisfied
   * by, e.g. `["bash:git status", "read:src/**"]`. When `config.
   * permissionPatternStore` is wired AND every pattern is already granted in
   * that store AND `isMaybeDangerous` is not set (or `permissionAllowDangerous`
   * is true), the gate short-circuits with a synthetic
   * `auto_review/config_allowed` decision BEFORE invoking the reviewer.
   *
   * Absent ⇒ never auto-passed (legacy path, byte-identical).
   *
   * Deliberate hold (absorb #2): the model-facing tool/schema surface does
   * not yet expose `rememberPatterns` / `isMaybeDangerous` — promotion path
   * is documented under catalog `61-permission-remember-patterns`'s
   * `deliberate_hold`. The dispatch seam plumbs whatever the action carries;
   * no in-source model surface populates these today, so the auto-pass path
   * only fires when an out-of-band caller (host, test, or future ADR-0060
   * out-schema extension) sets them.
   */
  rememberPatterns?: readonly string[] | undefined
  /**
   * ADR-0061 — model self-flag. When `true` the gate refuses to auto-pass on
   * pattern coverage alone, even if every pattern is granted, UNLESS
   * `config.permissionAllowDangerous === true`. Hardening over v0.dev's
   * unconditional cascade.
   */
  isMaybeDangerous?: boolean | undefined
}

/**
 * Wave A opt-in surface (ADR-0029 reviewer 3-tier + ADR-0031 prefix-rule DSL).
 * Every field is optional; an all-undefined object (or the legacy 4-arg call)
 * is byte-identical to the prior gate. `permissionStore` is carried here so the
 * single `opts` parameter stays one object (the prior `{ permissionStore? }`
 * shape is a structural subset — existing call sites compile unchanged).
 *
 *   - `rulesStore`     consulted FIRST (before mode/HITL/policy): allow ⇒ admit,
 *                      deny ⇒ terminal, ask ⇒ reviewer, no_match ⇒ noMatchPolicy.
 *   - `noMatchPolicy`  "deny" ⇒ terminal default-deny on no_match; "fallthrough"
 *                      (or absent) ⇒ continue to the legacy gates.
 *   - `reviewerPort`   when wired, the always-confirm HITL tier (and rule `ask`)
 *                      escalate to `reviewAction` instead of the legacy onConfirm.
 *   - `defaultReviewer` policy-default reviewer for the ReviewContext (default
 *                      `"user"`).
 *   - `priorDenials`   sticky-precedence inputs threaded into the ReviewContext.
 *   - `decidedAt`      injectable clock for deterministic decision timestamps.
 *   - `onInputMutation` outbound sink for a `pre_tool_use` hook's `updatedInput`
 *                      rewrite (Cursor parity). Invoked at most once per gate
 *                      run, on the admit path only, with the composed rewrite.
 *                      Absent ⇒ rewrites are silently dropped (the gate stays
 *                      byte-identical for callers that don't opt in).
 */
export interface AdmissibilityWaveAOptions {
  permissionStore?: PermissionStore
  rulesStore?: RulesStore
  noMatchPolicy?: "deny" | "fallthrough"
  reviewerPort?: ReviewerPort
  defaultReviewer?: ReviewerTier
  priorDenials?: ReadonlyArray<DenialMemory>
  decidedAt?: () => number
  onInputMutation?: (next: unknown) => void
  /**
   * ADR-0061 (L3→L4) — pending-permission queue the cascade folds when a
   * user approves a call carrying `rememberPatterns`. Each pending request
   * whose patterns become covered by the just-granted set has its
   * `toolCallId` reported via {@link onPatternCascade}. Absent ⇒ no cascade
   * is computed (byte-identical to pre-L4 callers).
   */
  pendingPermissions?: ReadonlyArray<PendingPermission>
  /**
   * ADR-0061 (L3→L4) — invoked when at least one pending request was newly
   * resolvable by the just-granted patterns. The `cascadedToolCallIds` are
   * the ids the caller can now auto-pass. `learningSource` tags WHY the
   * grant landed (`user_accept` for explicit confirm, `classifier` for the
   * pattern auto-pass path). Pure notification — the gate never auto-runs
   * cascaded calls itself (that's the loop's job, deferred). Absent ⇒
   * the cascade computation is skipped entirely.
   */
  onPatternCascade?: (info: {
    grantedPatterns: readonly string[]
    cascadedToolCallIds: readonly string[]
    learningSource: LearningSource
    suggestedAllowlistEntry: string | null
  }) => void
  /**
   * ADR-0070 review-kind matrix (L3→L4) — Cursor `allowlist_escalated` re-run
   * pattern. A mutable Set the gate consults BEFORE invoking the reviewer:
   * when the action's `actionKey` is already in the set, the reviewer is
   * SKIPPED and the gate emits a synthetic auto-pass through the pre-hook.
   * On a reviewer approval, the gate ADDS the actionKey so a subsequent
   * structurally-equivalent call within the same run does not re-prompt.
   *
   * Caller-owned (typically one Set per `runAgent` invocation, scoped to the
   * run). Absent ⇒ the escalation cache is bypassed entirely (every reviewer
   * round runs as before — byte-identical legacy).
   */
  allowlistEscalated?: Set<string>
  /**
   * ADR-0070 review-kind matrix (L3→L4) — when set, the gate FORCES this
   * {@link ReviewKind} on the `ReviewContext` instead of deriving it via
   * {@link inferReviewKind}. Used by tests and surfaces that already know the
   * kind (e.g. an MCP-only host). Absent ⇒ inferred from the tool + readonly
   * shape.
   */
  reviewKindOverride?: import("@/permission").ReviewKind
  /**
   * ADR-0407 — approval-state-machine wire. When supplied, every reviewer
   * escalation is opened as an approval (attributing the pause to Objective
   * + Run Ledger via `ApprovalStateMachinePort.request`) and settled on the
   * way out. Absent ⇒ byte-identical legacy resolver path (no SM calls).
   * NO-THROW: SM failure cannot perturb the reviewer's decision.
   */
  approvalStateMachine?: import("@/agent/approval-state-machine").ApprovalStateMachinePort
  /**
   * Capability B (multi-agent coordination — leader-mediated escalation). When a
   * WORKER subagent's tool hits a SOFT permission denial (the mode-policy
   * `evaluate()` deny arm), this injected broker escalates the request to the
   * worker's spawning LEADER's authority (its HITL/onConfirm). On approval the
   * gate ADMITS the call (routing through the pre_tool_use hook, parity with
   * every other allow path); on denial the worker stays blocked.
   *
   * SECURITY (load-bearing): this is consulted ONLY on the SOFT mode-policy deny
   * arm, and ONLY after re-verifying `hardDenyReason(action) === null` — a
   * HARD_DENY / denylisted command is structurally never escalatable (it returns
   * at step 2 `earlyHardDeny` / inside the HITL branch BEFORE mode-policy, and
   * the re-check catches the policy-internal HARD_DENY that surfaces here when no
   * allow-capable bypass was active). The grant authority is the injected
   * leader port — a worker can NEVER self-grant (the decision is one it does not
   * author; the wire pins `leaderId` through `applyDecisionResponse`). A throw is
   * fail-closed (treated as denied).
   *
   * Default-OFF: absent ⇒ byte-identical legacy deny (the composition root only
   * injects this for a subagent when `QUANTA_TEAM_BROKER` is on AND a leader
   * authority + mailbox are present). The gate itself reads no knob — "present ⇒
   * armed".
   */
  coordinationBroker?: GateEscalationBroker
  /**
   * jun-7-misc 04 (b) — session-scoped denied-effect tracker for tool-switch
   * circumvention detection. Caller-owned (one tracker per `runAgent` run).
   *
   * SECURITY / DEFAULT-OFF: the gate ALSO re-checks `runtimeConfig().
   * circumventDetect` (strict `=== "1"`) before consulting the tracker, so even
   * a wired tracker is inert unless the knob is ON. Absent ⇒ no circumvention
   * detection at all (byte-identical auto-mode gate). It is ADVISORY by default
   * (threads a context line to the classifier) and only forces a HITL `ask`
   * under the stricter `escalate` posture — NEVER auto-allow / auto-hard-block.
   */
  circumventionTracker?: CircumventionTracker
}

/**
 * Duck-typed escalation port (Capability B). Kept LOCAL to the gate so the
 * security SSOT does not import `@/subagent/coordination` — the composition root
 * (`coordination-broker-wire.ts`) adapts the real broker (mailbox round-trip +
 * `applyDecisionResponse` with a pinned `leaderId`) behind this one async
 * method. NO-THROW expected; the gate fail-closes on a throw regardless.
 */
export interface GateEscalationBroker {
  escalate(req: {
    readonly tool: string
    readonly scope: string
    readonly reason: string
  }): Promise<{ readonly approved: boolean; readonly reason?: string }>
}

/* ------------------------------------------------------------------------- *
 * ADR-0267 (Phase 2 of ADR-0239) — gate-decision emit helper.
 *
 * Called from the 3 emit sites (rule / hook / permission) so the
 * `DecisionEvent` shape is constructed in ONE place. Sanitisation contract
 * lives here:
 *   - `reason` is a short human-readable one-liner; callers MUST NOT include
 *     tool input, file contents, or env values.
 *   - `metadata` carries kind-specific extras and ONLY safe enums/categorical
 *     tags. Callers pass `{ tool: action.tool }` at most — never `action.input`.
 *   - `toolCallId` is the upstream `call.id` so a debug-tracer can pair the
 *     decision row with the eventual `tool_call.id` row.
 *
 * Default-OFF: `config.decisionEmitter === undefined` (the byte-identical
 * production path) ⇒ `safeEmitDecision` returns a no-op with zero allocation.
 * ------------------------------------------------------------------------- */
const emitGateDecision = (
  config: AdmissibilityGateConfig,
  args: {
    kind: "permission" | "rule" | "hook"
    outcome: "allow" | "deny" | "ask"
    reason: string
    toolCallId?: string
    ruleId?: string
    hookName?: string
    tool?: string
  },
): void => {
  if (config.decisionEmitter === undefined) return
  const event: import("@/stream").DecisionEvent = {
    type: "decision",
    turn: config.run?.turn ?? 0,
    kind: args.kind,
    outcome: args.outcome,
    reason: args.reason,
    ...(args.toolCallId !== undefined ? { toolCallId: args.toolCallId } : {}),
    ...(args.ruleId !== undefined ? { ruleId: args.ruleId } : {}),
    ...(args.hookName !== undefined ? { hookName: args.hookName } : {}),
    ...(args.tool !== undefined ? { metadata: { tool: args.tool } } : {}),
  }
  safeEmitDecision(config.decisionEmitter, event)
}

/**
 * C6 (RFC jun-6-deny-reason-surfacing) — build the {@link StructuredDenyReason}
 * for a deny SITE, gated on `surfaceDenyReason` (`QUANTA_DENY_REASON`).
 *
 * Returns `undefined` (zero allocation) when the knob is OFF, so `deny(...,
 * denyReason(...))` is byte-identical to the legacy `deny(...)` on the default
 * path. The dispatch-helper `deny()` ALSO re-checks the knob (defence in depth),
 * so even a `denyReason` that leaked through here cannot surface OFF.
 *
 * SECURITY (no-leak, load-bearing): `input.safeReason` MUST be the SAME pre-
 * sanitized one-liner the call site already hands to `emitGateDecision({reason})`
 * / the recorder — NEVER a fresh string composed from `action.input`, a command,
 * or a regex source. For the HARD_DENY layer the caller passes the CATEGORICAL
 * `hardDenySafeReason()`, NOT the command-echoing model-facing prose. This helper
 * cannot widen the surface — it only forwards the caller's already-safe `layer`/
 * `pillar`/`stackSource`/`safeReason` into the value record.
 */
const denyReason = (input: StructuredDenyReasonInput): StructuredDenyReason | undefined =>
  runtimeConfig().surfaceDenyReason ? structuredDenyReason(input) : undefined

/** Map a `ReviewerTier` to the short preview tag suffix the dispatch seam
 *  surfaces (`reviewer_user` / `reviewer_auto` / `reviewer_guardian`). */
const reviewerTag = (reviewer: ReviewerTier): string =>
  reviewer === "auto_review"
    ? "reviewer_auto"
    : reviewer === "guardian_subagent"
      ? "reviewer_guardian"
      : "reviewer_user"

const isSessionApprovalRequiredError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("approval" in error)) return false
  const approval = (error as { approval?: unknown }).approval
  return (
    typeof approval === "object" &&
    approval !== null &&
    "approvalId" in approval &&
    "reason" in approval &&
    "requestedAt" in approval
  )
}

/**
 * S16 (audit A1 #3) — canonical, registry-driven shell-command enrichment.
 *
 * Re-derives `action.shellCommand` from `ToolRegistry.extractShellCommand`
 * regardless of what the caller passed, so every downstream HARD_DENY consumer
 * (`hardDenyReason`, `evaluate`/`evaluateAuto`, `evaluateStack`) sees the SAME
 * command string. This is the SSOT that closes the bypass where a shell-
 * equivalent (non-bash) tool reached mode-policy / the permission stack with
 * the command stripped off the action, so `hardDeny()` inside `evaluate*` /
 * `evaluateStack` fell back to the bash-only legacy probe and never fired.
 *
 * Returns the action unchanged (same reference) when the registry reports no
 * shell command — `shellCommand` stays absent so genuine non-shell tools keep
 * their byte-identical fall-through (no HARD_DENY gate applied).
 */
const withResolvedShellCommand = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
): AdmissibilityAction => {
  const shellCommand = config.registry.extractShellCommand(action.tool, action.input)
  if (shellCommand === null) {
    // Strip any caller-supplied shellCommand so a fabricated value can never
    // out-vote the registry's authoritative null (a non-shell tool stays
    // ungated; HARD_DENY only fires on a registry-confirmed command).
    if (action.shellCommand === undefined) return action
    const { shellCommand: _dropped, ...rest } = action
    return rest
  }
  return { ...action, shellCommand }
}

const reviewActionKeyOf = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
): string => {
  const shellCommand = config.registry.extractShellCommand(action.tool, action.input)
  return shellCommand !== null ? `${action.tool}|${shellCommand}` : action.tool
}

/**
 * ROUND-4 concurrency fix — coalesce concurrent reviewer escalations per
 * `actionKey` so the reviewer is prompted AT MOST ONCE per key under a single
 * run.
 *
 * The bug: `reviewAndDecide` does a check-then-act on `opts.allowlistEscalated`
 * across the `await gate.open(...)` (reviewer prompt) boundary —
 *   miss `has(actionKey)`  →  await reviewer  →  `add(actionKey)`
 * Two structurally-equivalent calls with the SAME `actionKey` dispatched
 * concurrently (a concurrency-safe tool that escalates via a rule-ask /
 * always-confirm tier early-dispatches in-flight, see `streaming-dispatch.ts`)
 * BOTH pass the `has` miss before either reaches `add`, so BOTH pop a reviewer
 * prompt — defeating the dedup the Set is meant to provide.
 *
 * Fix (Approach A — pending-promise map): the FIRST caller for an `actionKey`
 * creates+stores the `reviewAction` promise BEFORE awaiting; concurrent callers
 * for the same key await the SAME promise (no second prompt). The entry is
 * cleared when it settles, so a LATER (post-settle) call behaves exactly as
 * today. The shared promise rejects if the reviewer throws — propagating the
 * throw (incl. abort/`SessionApprovalRequiredError`) to ALL waiters identically.
 *
 * Run scoping for free: the map is keyed in a `WeakMap` on the caller-owned
 * per-run `allowlistEscalated` Set — the same run-scoped handle whose dedup is
 * being defeated. When `allowlistEscalated` is ABSENT the gate has no dedup
 * intent (every reviewer round is meant to run as legacy), so coalescing is
 * skipped and the path is byte-identical. The map auto-GCs with the Set.
 */
type ReviewDecision = Awaited<ReturnType<typeof reviewAction>>
const pendingReviewsByRun = new WeakMap<Set<string>, Map<string, Promise<ReviewDecision>>>()

const pendingReviewMapFor = (
  allowlistEscalated: Set<string>,
): Map<string, Promise<ReviewDecision>> => {
  let m = pendingReviewsByRun.get(allowlistEscalated)
  if (m === undefined) {
    m = new Map()
    pendingReviewsByRun.set(allowlistEscalated, m)
  }
  return m
}

const buildReviewContext = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): ReviewContext & { reviewKind: NonNullable<ReviewContext["reviewKind"]> } => ({
  sessionId: config.sessionId ?? "default",
  turnId: String(config.run?.turn ?? 0),
  priorDenials: opts.priorDenials ?? [],
  configReviewer: opts.defaultReviewer ?? "user",
  decidedAt: (opts.decidedAt ?? Date.now)(),
  reviewKind: opts.reviewKindOverride ?? inferReviewKind(action.tool, action.isReadOnly),
})

const denyIllegalReviewerVerb = (
  call: ToolUseBlock,
  decision: Awaited<ReturnType<typeof reviewAction>>,
  reviewKind: NonNullable<ReviewContext["reviewKind"]>,
): DispatchResult | null => {
  if (decision.verb === undefined || isDecisionLegalFor(reviewKind, decision.verb)) return null
  return deny(
    call.id,
    `Reviewer returned illegal verb '${decision.verb.verb}' for reviewKind='${reviewKind}'.`,
    "reviewer_verb_illegal",
    // C6: categorical safeReason — the reviewer-authored verb/kind never enters
    // the structured field (the prose `content` above already surfaces them).
    denyReason({ layer: "reviewer", safeReason: "reviewer returned illegal verb" }),
  )
}

const denyReviewedAction = (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  decision: Awaited<ReturnType<typeof reviewAction>>,
  origin: "rule" | "hitl",
): DispatchResult => {
  const tag = reviewerTag(decision.reviewer)
  const originSuffix = origin === "rule" ? " (origin=rule)" : ""
  if (decision.verb?.verb === "reject_and_tell") {
    const baseContent =
      decision.outcome === "user_aborted"
        ? `User aborted: ${decision.rationale}${originSuffix}${HANDOFF_SUFFIX}`
        : decision.outcome === "guardian_denied"
          ? `Guardian denied: ${decision.rationale}${originSuffix}`
          : `User declined: ${decision.rationale}${originSuffix}`
    return denyFromConfirm(
      call,
      { decision: "deny_and_steer", steer: decision.verb.message },
      baseContent,
      tag,
      config,
      denyReason({ layer: "reviewer", safeReason: `reviewer outcome: ${decision.outcome}` }),
    )
  }
  if (decision.outcome === "user_aborted") {
    return deny(
      call.id,
      `User aborted: ${decision.rationale}${originSuffix}${HANDOFF_SUFFIX}`,
      tag,
      // C6: categorical only — `decision.rationale` (reviewer-authored) never
      // enters the structured field.
      denyReason({ layer: "reviewer", safeReason: "reviewer outcome: user_aborted" }),
    )
  }
  if (decision.outcome === "guardian_denied") {
    return deny(
      call.id,
      `Guardian denied: ${decision.rationale}${originSuffix}`,
      tag,
      denyReason({ layer: "reviewer", safeReason: "reviewer outcome: guardian_denied" }),
    )
  }
  return deny(
    call.id,
    `User declined: ${decision.rationale}${originSuffix}`,
    tag,
    denyReason({ layer: "reviewer", safeReason: "reviewer outcome: user_declined" }),
  )
}

/**
 * Run the reviewer escalation for an action (rule `ask` OR always-confirm tier
 * with a wired port). Builds the `ToolActionKeyed` + `ReviewContext`, invokes
 * `reviewAction`, and maps the 8-state outcome to an admit (null via the hook)
 * or a terminal deny. Allowed outcomes route through `runPreToolUseHook`;
 * `user_aborted` carries the hand-off suffix; other denials phrase the verb by
 * reviewer. Throws from the port propagate (no silent catch).
 */
const reviewAndDecide = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
  origin: "rule" | "hitl",
): Promise<DispatchResult | null> => {
  // Guarded by the call sites, but keep the invariant explicit: a reviewer
  // escalation with no port is a wiring error, never a silent allow.
  if (opts.reviewerPort === undefined) {
    return deny(
      call.id,
      `Reviewer escalation requested for ${action.tool} but no ReviewerPort is wired.`,
      "rule_ask",
      denyReason({ layer: "reviewer", safeReason: "reviewer escalation requested, no port wired" }),
    )
  }
  // actionKey is `${tool}|${shellCommand}` when the tool exposes a command,
  // else the bare tool name — the same key a sticky-precedence DenialMemory is
  // recorded under, so a prior guardian_denied / user_aborted short-circuits
  // re-review of the identical action.
  const actionKey = reviewActionKeyOf(config, action)

  // ADR-0070 allowlist_escalated re-run pattern — Cursor parity. When a prior
  // approval recorded this actionKey, skip the reviewer entirely and proceed
  // through the pre-hook. The cache is run-scoped (caller-owned Set).
  if (opts.allowlistEscalated?.has(actionKey)) {
    return runPreToolUseHook(call, config, opts)
  }

  const keyed: ToolActionKeyed = {
    tool: action.tool,
    input: action.input,
    isReadOnly: action.isReadOnly,
    actionKey,
  }
  // ADR-0070 — attach the WHAT-IS-BEING-REVIEWED axis. Overridable via
  // `opts.reviewKindOverride`; otherwise inferred from the tool name + readonly
  // shape. The port may consume `ctx.reviewKind` to render a kind-typed UI; if
  // it doesn't, the field is ignored (byte-identical legacy port behavior).
  // T03 — carry the dispatch tool-call id so the auto-approval-review notice can
  // key its `tool_progress` annotation to this exact call (surface-only; the
  // decision is unaffected).
  const ctx = { ...buildReviewContext(config, action, opts), toolCallId: call.id }
  // ADR-0407 — attribute reviewer escalations to Objective+RunLedger via the
  // approval-SM when wired. Default-OFF ⇒ byte-identical legacy passthrough.
  const gate = createApprovalGate(
    opts.approvalStateMachine !== undefined ? { approvalSM: opts.approvalStateMachine } : {},
  )
  const reviewerPort = opts.reviewerPort
  // The reviewer prompt itself (`gate.open` → `reviewAction`). Captured as a
  // promise so concurrent callers for the SAME actionKey can share it without
  // re-prompting. `dec` is closed over and assigned inside, so every awaiter
  // (the originator and any coalesced sibling) reads the SAME decision.
  let dec!: ReviewDecision
  const runReview = async (): Promise<ReviewDecision> => {
    await gate.open(
      {
        threadId: config.sessionId ?? "",
        kind: origin === "rule" ? "permission" : "escalation",
        reason: `${origin}-escalation:${action.tool}`,
        proposedAction: actionKey,
        resumeStep: `dispatch:${call.id}`,
      },
      async () => {
        dec = await reviewAction(keyed, ctx, reviewerPort)
        return isAllowed(dec.outcome) ? "approve" : "deny"
      },
    )
    return dec
  }

  // ROUND-4 coalesce: when a per-run `allowlistEscalated` Set is wired (dedup
  // intended), prompt the reviewer AT MOST ONCE per actionKey across concurrent
  // in-flight callers. The first caller stores the promise BEFORE awaiting;
  // siblings await the SAME promise. The entry clears on settle (success OR
  // throw), so a later post-settle call re-prompts exactly as before. Absent
  // `allowlistEscalated` ⇒ byte-identical legacy path (no coalescing).
  if (opts.allowlistEscalated !== undefined) {
    const pending = pendingReviewMapFor(opts.allowlistEscalated)
    const inFlight = pending.get(actionKey)
    if (inFlight !== undefined) {
      dec = await inFlight
    } else {
      const p = runReview()
      pending.set(actionKey, p)
      try {
        dec = await p
      } finally {
        // Only the originator clears its own entry, and only if it is still the
        // current one (a later distinct acquisition cannot be clobbered).
        if (pending.get(actionKey) === p) pending.delete(actionKey)
      }
    }
  } else {
    dec = await runReview()
  }

  // ADR-0070 — validate the OPTIONAL richer verb against the reviewKind.
  // A port that returns a verb illegal for the kind (e.g. `allowlist_commands`
  // on an `edit` kind) MUST be rejected — this is a wiring/contract bug, not
  // a user-facing decision. Surfaced as a typed deny so a host learns about
  // the malformed verb without trusting it as an allow.
  const illegalVerb = denyIllegalReviewerVerb(call, dec, ctx.reviewKind)
  if (illegalVerb !== null) return illegalVerb

  if (isAllowed(dec.outcome)) {
    // ADR-0070 — record the actionKey in the allowlist_escalated cache so a
    // subsequent structurally-equivalent call within the same run skips review.
    opts.allowlistEscalated?.add(actionKey)
    return runPreToolUseHook(call, config, opts)
  }

  // Rule-ask escalations carry an `origin=rule` marker so the surface can tell
  // a denylist-rule escalation apart from an always-confirm-tier escalation.
  return denyReviewedAction(call, config, dec, origin)
}

/** Emit pre_tool_use hook, returning a hook-denied result or null to proceed.
 *  When a handler rewrote the tool args (`updatedInput`, Cursor parity) and the
 *  call was NOT denied, the rewrite is surfaced to dispatch via
 *  `opts.onInputMutation` so the executed input is the mutated one. The gate
 *  itself stays control-flow-pure (it never mutates `call`/`config`); the sink
 *  is the only outbound channel and is a no-op when unwired. */
const runPreToolUseHook = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null> => {
  if (!config.hooks) return null
  const result = await config.hooks.emit({
    type: "pre_tool_use",
    name: call.name,
    input: call.input,
  })
  if (result.deny) {
    // ADR-0267 Phase 2 — surface the hook-deny on the debug-tracer side
    // channel. The `result.deny.deny` field is the operator-authored deny
    // reason from the local hook (trust-level == permission config); we pass
    // it through verbatim per the gate's existing wording invariant. Default-
    // OFF when `decisionEmitter` is absent (zero allocation).
    emitGateDecision(config, {
      kind: "hook",
      outcome: "deny",
      reason: `pre_tool_use: ${result.deny.deny}`,
      toolCallId: call.id,
      hookName: "pre_tool_use",
      tool: call.name,
    })
    return deny(
      call.id,
      `Hook denied: ${result.deny.deny}`,
      "hook-denied",
      // C6: categorical layer. safeReason stays categorical (the operator hook's
      // free-form `result.deny.deny` is surfaced on `content` only, never on the
      // structured field — keeps the typed envelope leak-free by construction).
      denyReason({ layer: "hook", safeReason: "pre_tool_use hook denied" }),
    )
  }
  // A rewrite only matters when the call is admitted. `emit` includes the
  // `updatedInput` KEY only when a handler set it (presence is the signal, not
  // truthiness), so a rewrite to a falsy value is still propagated.
  if ("updatedInput" in result) opts.onInputMutation?.(result.updatedInput)
  // ADR-0267 Phase 2 — hook admitted (no deny). Emit on the admit path too so
  // a tracer line confirms which call passed which hook (paired with the
  // upstream `tool_call.id` row).
  emitGateDecision(config, {
    kind: "hook",
    outcome: "allow",
    reason: "pre_tool_use: admitted",
    toolCallId: call.id,
    hookName: "pre_tool_use",
    tool: call.name,
  })
  return null
}

/** Resolve the effective HITL tier for a known-registered tool. The unknown-
 *  tool case is guarded upstream by `dispatchTool`; we mirror the legacy
 *  defensive fallback so this helper still has a defined answer if invoked
 *  with a stale registry. ADR-0047: composes the per-tool classifier with
 *  the agent-side annotation registry (built-in + operator overrides). The
 *  registry can ESCALATE the tier (one-way ratchet) but never relax
 *  `hand-off-required`. */
const resolveHitlTier = (
  config: AdmissibilityGateConfig,
  call: ToolUseBlock,
  action: AdmissibilityAction,
): { tier: HitlTier; matched: HitlAnnotation | undefined } => {
  const tool = config.registry.get(call.name)
  const baseline: HITLTier = tool
    ? inferToolTier(tool, call.input)
    : action.isReadOnly
      ? "none"
      : "pre-approval-ok"
  return resolveHitlAnnotation(call.name, call.input, baseline)
}

/** Sanitize the `reason` tag for OTel emission. The agent-internal `reason`
 *  field on the `HandoffRequiredEvent` carries a categorical prefix plus a
 *  variable-shape suffix (e.g. `hard-deny:Blocked dangerous command: rm -rf /`
 *  — the suffix is the human-prose deny message which echoes the offending
 *  command). For the OTel attribute we strip that prose and keep ONLY the
 *  categorical kebab prefix, so a dashboard sees `hard-deny`, `registry:<tool>`,
 *  or `tier:hand-off-required` — never tool input, never user-facing
 *  copy. This is the canonical security invariant for `quanta.hitl.
 *  handoff_emitted`. */
const slugifyHandoffReason = (reason: string): string => {
  // `registry:<tool>` and `tier:<tier-literal>` are already short categorical
  // tags from controlled vocabularies — pass through verbatim.
  if (reason.startsWith("registry:")) return reason
  if (reason.startsWith("tier:")) return reason
  // `hard-deny:<prose>` — strip the prose suffix and keep ONLY the category.
  // Future categories can be added here as `startsWith` arms.
  if (reason.startsWith("hard-deny:")) return "hard-deny"
  // Defensive fallback: strip anything past the first `:` so an unknown
  // category never leaks a prose body. Empty category ⇒ literal "handoff".
  const colon = reason.indexOf(":")
  if (colon > 0) return reason.slice(0, colon)
  return reason.length > 0 ? reason : "handoff"
}

/** Emit a structured handoff event to the host (RFC §UI integration seam).
 *  Absent callback ⇒ silent no-op (byte-identical legacy behaviour). The
 *  callback is wrapped in a try/catch so a host-side bug never propagates
 *  into dispatch — emission MUST NOT change the deny result. */
const emitHandoffEvent = (
  config: AdmissibilityGateConfig,
  call: ToolUseBlock,
  handoffMessage: string,
  reason: string,
  now: () => number = Date.now,
): void => {
  // ADR-0047 vocabulary activation: record the kebab-case handoff tag on the
  // span sink. The OTel attribute carries the SANITIZED categorical slug
  // (`hard-deny`, `registry:<tool>`, `tier:hand-off-required`) — NEVER the
  // prompt text from `handoffMessage` and NEVER the prose suffix from the
  // deny reason (which can include the offending shell command). Default-OFF
  // when no sink is registered.
  recordAttrs(
    SPAN_NAMES.handleToolCall,
    attrs({ [QUANTA_ATTRS.hitl.handoffEmitted]: slugifyHandoffReason(reason) }),
  )
  if (!config.onHandoff) return
  const event: HandoffRequiredEvent = {
    kind: "hitl-handoff",
    tool: call.name,
    args: call.input,
    handoffMessage,
    reason,
    timestamp: now(),
  }
  try {
    config.onHandoff(event)
  } catch (e) {
    // The deny path must remain stable even when a host listener throws.
    // We swallow + warn via stderr — observability lives on the gate's
    // canonical return path, not on this notification seam.
    const msg = errMessage(e)
    writeStderr(`[quanta] hitl: onHandoff threw: ${msg}\n`)
  }
}

/** Build + emit the hand-off deny when the resolved tier is
 *  `hand-off-required`. Factored out of `runHitlGate` so the cyclomatic
 *  complexity stays under the project cap. */
const buildHandoffDeny = (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  matched: HitlAnnotation | undefined,
  now: () => number = Date.now,
): DispatchResult => {
  const suffix = matched?.reason !== undefined ? ` (${matched.reason})` : ""
  const handoffMessage = `Action requires human handoff: ${call.name} is classified hand-off-required${suffix}${HANDOFF_SUFFIX}`
  emitHandoffEvent(
    config,
    call,
    handoffMessage,
    matched !== undefined ? `registry:${matched.tool}` : "tier:hand-off-required",
    now,
  )
  return deny(
    call.id,
    handoffMessage,
    "handoff",
    // C6: the HITL `hand-off-required` tier — no mode can authorize, a human
    // reviewer must take over. Categorical safeReason (no annotation prose).
    denyReason({ layer: "reviewer", pillar: "approval", safeReason: "tier: hand-off-required" }),
  )
}

/**
 * Map a normalized `deny`/`deny_and_steer` {@link ConfirmDecision} to a deny
 * {@link DispatchResult}, attaching the corrective steer on the
 * `deny_and_steer` arm (ADR-0076 Gap-4 — Cursor REJECT_AND_TELL). The base
 * deny phrasing/preview is supplied by the caller so each branch keeps its
 * legacy wording for the plain-`deny` case (byte-identical). On
 * `deny_and_steer` the preview is bumped to `deny_steer` and the steer text is
 * surfaced on `DispatchResult.steerInjection` for the loop to inject next turn.
 *
 * MUST be called only with a refusal (`deny` / `deny_and_steer`). All current
 * callers gate on `isConfirmAllowed` before reaching here, so an `allow` is
 * unreachable in practice; if one ever leaks through, `buildDenySteerMessage`
 * returns `null` (only `deny_and_steer` produces a steer body) and the
 * function falls back to the plain `deny(...)` shape — defensive, not a
 * silent allow.
 */
const denyFromConfirm = (
  call: ToolUseBlock,
  decision: ConfirmDecision,
  baseContent: string,
  basePreview: string,
  config: AdmissibilityGateConfig,
  // C6 — the deny SITE's structured reason (already knob-gated by the caller via
  // `denyReason(...)`: `undefined` when OFF). On the plain-deny arm it threads
  // straight to `deny()`; on the `deny_and_steer` arm it is MERGED into the
  // existing `permission_denied` envelope alongside `isReadonly` (and the
  // categorical `[layer/pillar]` prefix is prepended to the steered content too).
  reason?: StructuredDenyReason | undefined,
): DispatchResult => {
  // ADR-0077: consult the registry the gate already owns (no parallel lookup
  // path). The tool's DECLARED `isReadOnly()` decides whether to append the
  // readonly note to the steer; absent tool / mutating tool ⇒ verbatim steer
  // (byte-identical for legacy callers).
  const tool = config.registry.get(call.name)
  const isReadonly = tool ? tool.isReadOnly() : false
  const steer = buildDenySteerMessage(decision, isReadonly)
  if (steer === null) {
    return deny(call.id, baseContent, basePreview, reason)
  }
  // deny_and_steer: deny AND carry the corrective instruction atomically. Pass
  // `reason` so the categorical prefix is prepended to the steered content (when
  // the knob is on); the resulting failure envelope is overwritten below to also
  // surface `isReadonly`, re-merging `denyReason` from the same knob-gated value.
  const result = deny(call.id, `${baseContent} Steer: ${steer}`, "deny_steer", reason)
  // ADR-0077: surface the declared readonly flag on the DispatchResult's
  // typed failure envelope so trajectory/permission consumers can branch on
  // it without re-deriving from the tool registry. The shape is the existing
  // {@link ToolFailure.permission_denied} variant — unchanged when the tool
  // is mutating (omitted, byte-identical). C6: when the knob is on AND a
  // `reason` was supplied, ALSO carry `denyReason` here (OMITTED otherwise so
  // the envelope stays byte-identical to the pre-C6 `{mode, isReadonly}` shape).
  return {
    ...result,
    steerInjection: steer,
    failure: {
      mode: "permission_denied",
      isReadonly,
      ...(reason !== undefined && runtimeConfig().surfaceDenyReason ? { denyReason: reason } : {}),
    },
  }
}

/** Run the always-confirm branch — calls `onConfirm`, normalizes the result
 *  (byte-identical for the legacy boolean form), wraps host throws, and returns
 *  the appropriate deny / null result. A structured `deny_and_steer` decision
 *  (ADR-0076 Gap-4) denies AND attaches the steer to the result. Factored out
 *  so the parent gate stays under the cognitive-complexity cap. */
const runAlwaysConfirmBranch = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null> => {
  if (!config.onConfirm) {
    return deny(
      call.id,
      `Permission denied: ${call.name} requires explicit confirmation (always-confirm tier) but no confirm handler is wired.`,
      "denied",
      denyReason({
        layer: "reviewer",
        pillar: "approval",
        safeReason: "always-confirm tier, no confirm handler wired",
      }),
    )
  }
  let decision: ConfirmDecision
  try {
    decision = normalizeConfirm(await config.onConfirm(action))
  } catch (e) {
    if (isSessionApprovalRequiredError(e)) throw e
    const message = errMessage(e)
    return deny(
      call.id,
      `Confirmation handler failed for ${call.name} (always-confirm tier): ${message}`,
      "error",
      // C6: categorical only — the host error `message` never enters the
      // structured field (the prose `content` above already surfaces it).
      denyReason({
        layer: "reviewer",
        pillar: "approval",
        safeReason: "always-confirm tier, confirmation handler failed",
      }),
    )
  }
  if (!isConfirmAllowed(decision)) {
    return denyFromConfirm(
      call,
      decision,
      `User declined: ${call.name} requires explicit confirmation (always-confirm tier).`,
      "declined",
      config,
      denyReason({
        layer: "reviewer",
        pillar: "approval",
        safeReason: "always-confirm tier, user declined",
      }),
    )
  }
  // ADR-0061 L4 cascade — user approved, fold rememberPatterns into the store
  // and notify the caller of any newly-resolvable pending requests. Default-OFF
  // (no-op when permissionPatternStore / onPatternCascade absent).
  cascadeOnApprove(config, action, opts, "user_accept")
  return null
}

/** HARD_DENY-as-handoff terminal deny. Shared between the HITL branch and any
 *  other allow-capable path (tool-profile confirm) that could otherwise admit
 *  a denylisted command. Returns `null` when the action carries no HARD_DENY
 *  hit (the registry-derived `shellCommand` doesn't match the denylist), so
 *  callers `??`-chain it ahead of their approval. Mirrors policy.ts:203 —
 *  HARD_DENY ALWAYS wins, no confirm/approval can route around it. */
const hardDenyHandoff = (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  now: () => number = Date.now,
): DispatchResult | null => {
  // `hardDenyProse` is the model-facing message which MAY echo the agent's own
  // command (acceptable on `content` — the agent authored it). The STRUCTURED
  // safeReason below uses `hardDenySafeReason()` (categorical) so the command is
  // NEVER persisted on the typed envelope. (Renamed from `denyReason` to avoid
  // shadowing the C6 `denyReason(...)` builder.)
  const hardDenyProse = hardDenyReason(action)
  if (hardDenyProse === null) return null
  const handoffMessage = `Action requires human handoff: ${hardDenyProse}${HANDOFF_SUFFIX}`
  emitHandoffEvent(config, call, handoffMessage, `hard-deny:${hardDenyProse}`, now)
  return deny(
    call.id,
    handoffMessage,
    "handoff",
    // C6 no-leak: categorical `hardDenySafeReason()`, NOT `hardDenyProse`.
    denyReason({ layer: "hard-deny", safeReason: hardDenySafeReason() }),
  )
}

/** Tool-profile gate (ADR-0213 closeout). The active profile is re-read per
 *  call via `config.toolProfile.activeName()` when present, otherwise the
 *  static `defaultName` remains authoritative. The profile may only tighten
 *  admissibility:
 *    - `allow`   ⇒ fall through to the existing gates
 *    - `confirm` ⇒ HARD_DENY-checked, then explicit confirmation, then the
 *                  pre_tool_use hook (parity with every other allow path)
 *    - `deny`    ⇒ terminal deny
 *
 * Absent slot / absent active name ⇒ byte-identical fallthrough. */
const runToolProfileGate = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null | "fallthrough"> => {
  const slot = config.toolProfile
  if (slot === undefined) return "fallthrough"
  const activeName = slot.activeName?.() ?? slot.defaultName
  if (activeName === undefined) return "fallthrough"
  let policy: ReturnType<typeof slot.resolver.resolve>
  try {
    policy = slot.resolver.resolve({
      profileName: activeName,
      toolName: action.tool,
      isReadOnly: action.isReadOnly,
    })
  } catch (e) {
    return deny(
      call.id,
      `Permission denied: tool profile "${activeName}" could not resolve ${action.tool} (${errMessage(e)})`,
      "tool-profile-error",
      // C6: categorical — the resolver error `errMessage(e)` stays on `content`.
      denyReason({ layer: "tool-profile", safeReason: "tool profile failed to resolve" }),
    )
  }
  if (policy.kind === "allow") return "fallthrough"
  if (policy.kind === "deny") {
    return deny(
      call.id,
      `Permission denied: ${policy.reason}`,
      "tool-profile-denied",
      // `policy.reason` is the profile resolver's own categorical message (no
      // model input); reused verbatim as the structured safeReason.
      denyReason({ layer: "tool-profile", safeReason: policy.reason }),
    )
  }
  // policy.kind === "confirm".
  // AUDIT A1 #5 — HARD_DENY beats a tool-profile confirm-approval. A profile
  // `confirm` is an allow-CAPABLE outcome (the user can approve); it MUST NOT
  // be able to route a denylisted command around the security boundary. This
  // mirrors policy.ts:203 ("HARD_DENY ALWAYS wins") and the B3 invariant, and
  // matters here because `earlyHardDeny` only fires when an allow-capable
  // bypass (rulesStore/reviewerPort/permissionPatternStore) is wired — a
  // profile-only deployment skips it, so the check has to live on this path.
  const hardDeny = hardDenyHandoff(call, config, action, opts.decidedAt ?? Date.now)
  if (hardDeny !== null) return hardDeny
  const confirmResult = await runAlwaysConfirmBranch(call, config, action, opts)
  // AUDIT A1 #9 — a profile confirm-APPROVAL (null) must still pass through the
  // pre_tool_use hook so a repo-local hook can veto last, exactly like the HITL
  // always-confirm path (which routes its approval through the hook via the
  // caller) and every other allow path in this gate. Without this the profile
  // confirm path was asymmetric — the only allow that skipped the hook.
  if (confirmResult !== null) return confirmResult
  return runPreToolUseHook(call, config, opts)
}

const denyIfModeBlocked = (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
): DispatchResult | null => {
  const effectiveMode = resolveAgentMode(config.mode, config.planMode)
  if (!isMutatingToolBlockedInMode(effectiveMode, action)) return null
  const reason = modeBlockReason(effectiveMode, call.name)
  return deny(
    call.id,
    reason,
    `${effectiveMode}-blocked`,
    // C6: `modeBlockReason` is categorical (mode literal + tool NAME only — never
    // tool input), so it is reused verbatim as the structured safeReason.
    denyReason({ layer: "mode", pillar: "approval", safeReason: reason }),
  )
}

const runPatternAutoPassGate = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): Promise<DispatchResult | null | "fallthrough"> => {
  if (config.permissionPatternStore === undefined) return "fallthrough"
  const autoPassOpts: { allowDangerous?: boolean; decidedAt?: () => number } = {}
  if (config.permissionAllowDangerous === true) autoPassOpts.allowDangerous = true
  if (opts.decidedAt !== undefined) autoPassOpts.decidedAt = opts.decidedAt
  const result = autoPassByPatterns(
    config.permissionPatternStore,
    { rememberPatterns: action.rememberPatterns, isMaybeDangerous: action.isMaybeDangerous },
    autoPassOpts,
  )
  return result.kind === "auto_pass"
    ? ((await runPreToolUseHook(call, config, opts)) ?? null)
    : "fallthrough"
}

/** P2-T2 (A3) — the `hand-off-required` tier floor, pulled to HARD_DENY-level
 *  precedence (BEFORE pattern-grant + rules DSL) so no operator grant/rule can
 *  unlock it. Routed through {@link runHitlGate} so the deny is byte-identical
 *  AND the tier telemetry still emits. Non-hand-off tiers ⇒ "fallthrough" (they
 *  are handled later, after the grant/rule gates, by {@link runHitlReviewGate}). */
const runHandoffFloorGate = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): Promise<DispatchResult | null | "fallthrough"> => {
  const { tier } = resolveHitlTier(config, call, action)
  if (tier !== "hand-off-required") return "fallthrough"
  const hitlResult = await runHitlGate(call, config, action, opts)
  if (hitlResult === "fallthrough") return "fallthrough"
  return hitlResult ?? runPreToolUseHook(call, config, opts)
}

const runHitlReviewGate = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): Promise<DispatchResult | null | "fallthrough"> => {
  // SECURITY FLOOR (jun-10, audit §F1 + P2-T3 PDP) — the floor is UNIVERSAL
  // (secure-by-default): enforced even when the opt-in `hitl.enabled` flag is off,
  // so no surface (CLI / agent / bench / web) can blanket-allow it under `bypass`
  // by never opting in. Routed THROUGH `runHitlGate` so the tier telemetry emits.
  //
  // WHICH tiers are universal is decided by the PDP capability decider
  // (`decideFloor`), NOT the raw tier — that is what splits the two reasons a
  // tool is `always-confirm`: `confirm: "sensitive"` (git push) joins the floor;
  // `needs-sandbox` (bash without a profile) DEFERS to mode / sandbox, so every
  // shell call is not gated. hand-off-required is its own (harder) universal
  // floor — caught upstream by `runHandoffFloorGate`; kept here belt-and-suspenders.
  const { tier } = resolveHitlTier(config, call, action)
  const capability = config.registry.get(call.name)?.capability?.(call.input)
  const universalFloor =
    tier === "hand-off-required" || decideFloor({ tier, capability }) === "universal-floor"
  // AUTONOMOUS opt-out — an explicit `autoApprove` surface auto-runs floor
  // always-confirm tools unattended (hand-off-required is NEVER opted out).
  if (tier === "always-confirm" && universalFloor && config.hitl?.autoApprove === true) {
    return "fallthrough"
  }
  if (config.hitl?.enabled !== true && !universalFloor) return "fallthrough"
  if (opts.reviewerPort !== undefined && tier === "always-confirm") {
    return await reviewAndDecide(call, config, action, opts, "hitl")
  }
  const hitlResult = await runHitlGate(call, config, action, opts)
  if (hitlResult === "fallthrough") return "fallthrough"
  return hitlResult ?? runPreToolUseHook(call, config, opts)
}

const runPermissionStackGate = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  permission: PermissionContext,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): Promise<DispatchResult | null | "fallthrough"> => {
  const stackResult = runPermissionStack(
    call,
    config,
    permission,
    action,
    opts.permissionStore !== undefined ? { store: opts.permissionStore } : {},
  )
  if (stackResult === "allow") return await runPreToolUseHook(call, config, opts)
  if (stackResult !== null) return stackResult
  return "fallthrough"
}

/**
 * HITL 4-tier gate (Codex hitl-audit.md). Returns:
 *   - a short-circuit {@link DispatchResult} for handoff / declined /
 *     always-confirm denials,
 *   - `null` when HITL approved the call (caller emits hook + proceeds),
 *   - `"fallthrough"` when the tier is "pre-approval-ok" (defer to mode policy).
 */
const runHitlGate = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null | "fallthrough"> => {
  const now = opts.decidedAt ?? Date.now
  // HARD_DENY hits ARE the hand-off-required tier (security boundary crossing
  // — no mode authorizes them). Phrase as a handoff demand.
  const hardDeny = hardDenyHandoff(call, config, action, now)
  if (hardDeny !== null) return hardDeny

  const { tier, matched } = resolveHitlTier(config, call, action)
  // ADR-0047 vocabulary activation: emit the resolved tier + the registry-
  // escalation bit at the canonical decision point. Outcome categories only —
  // NO prompt text, NO user-facing message body, NO tool input. Default-OFF
  // when no span sink is wired (zero-allocation no-op).
  recordAttrs(
    SPAN_NAMES.handleToolCall,
    attrs({
      [QUANTA_ATTRS.hitl.tierResolved]: tier,
      [QUANTA_ATTRS.hitl.registryEscalated]: matched !== undefined,
    }),
  )
  if (tier === "hand-off-required") return buildHandoffDeny(call, config, matched, now)
  if (tier === "always-confirm") return runAlwaysConfirmBranch(call, config, action, opts)
  if (tier === "none") return null
  return "fallthrough"
}

/**
 * Permission-stack consultation (ADR-0046). When `config.permissionStack?.
 * enabled` is true, consult per-thread / per-host / post-denial axes BEFORE
 * the legacy mode policy. Returns:
 *   - a short-circuit {@link DispatchResult} when the stack denies the call,
 *   - `"allow"` when the stack explicitly allows (skip mode policy),
 *   - `null` when the stack has nothing to say (fall through to mode policy).
 *
 * Pure dispatch — the store and host-id are injected via opts so tests can
 * isolate. Production callers leave both undefined and the singleton +
 * `resolveHostId()` are used.
 */
const runPermissionStack = (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  permission: PermissionContext,
  action: AdmissibilityAction,
  opts: { store?: PermissionStore } = {},
): DispatchResult | "allow" | null => {
  if (config.permissionStack?.enabled !== true) return null
  // Need a thread id — sessionId is the only stable handle the loop carries.
  // Absent ⇒ skip the stack rather than synthesize a fake id (a synthesized
  // id would silently fail to match any UI-set thread record).
  const threadId = config.sessionId
  if (typeof threadId !== "string" || threadId.length === 0) return null

  const hostId = config.permissionStack.hostId ?? resolveHostId()
  const actionSignature = computeActionSignature({
    tool: action.tool,
    workdir: config.cwd,
    args: action.input,
  })
  const decision = evaluateStack(
    {
      tool: action.tool,
      input: action.input,
      isReadOnly: action.isReadOnly,
      // S16 (audit A1 #3) — carry the registry-derived shell command so the
      // stack's own HARD_DENY (precedence level 1) fires for ANY shell-
      // equivalent tool, not just bash. Without this the stack dropped it and
      // `hardDeny()` fell back to the bash-only legacy probe → a non-bash
      // shell tool with a denylisted command was admitted by the stack/mode.
      ...(action.shellCommand !== undefined ? { shellCommand: action.shellCommand } : {}),
    },
    permission,
    { threadId, hostId, actionSignature, workdir: config.cwd },
    // W4 follow-up: evaluateStack now REQUIRES store. This file is the
    // composition-adjacent layer (called by dispatch), so `getDefaultPermissionStore()`
    // as a fallback is allowed by the new scanner rule. Surfaces may now
    // inject `AgentConfig.admissibility.permissionStore`; the singleton
    // fallback remains only for legacy callers that omit that bundle.
    { store: opts.store ?? getDefaultPermissionStore() },
  )
  // ADR-0267 Phase 2 — emit the per-thread/per-host/post-denial stack verdict
  // BEFORE acting on it. `decision.reason` (deny path only) is the policy's
  // own message (mentions the per-thread sandbox type + workdir, never tool
  // input).
  //
  // H12 emit-once fix (gate seam): the `ask` arm is a FALL-THROUGH — the stack
  // has no opinion and the canonical decision is emitted downstream by
  // `runModePolicy` (which, when the host is unpinned, surfaces the SAME
  // global-default verdict). Emitting here on the `ask` arm too would double-
  // count that one logical global-default decision on the `decisionEmitter`
  // channel. So we emit ONLY on the terminal arms (`allow` / `deny`) where the
  // stack itself is the decision authority; the fall-through arm stays silent
  // and lets the single canonical mode-policy emit fire. This mirrors, at the
  // gate-decision-event seam, the policy.ts emit-once contract proven by
  // `permission-otel-global-default-emit-once-hellgate.test.ts`.
  if (decision.kind === "allow") {
    emitGateDecision(config, {
      kind: "permission",
      outcome: "allow",
      reason: "stack allow",
      toolCallId: call.id,
      tool: action.tool,
    })
    return "allow"
  }
  if (decision.kind === "deny") {
    emitGateDecision(config, {
      kind: "permission",
      outcome: "deny",
      reason: decision.reason,
      toolCallId: call.id,
      tool: action.tool,
    })
    // C6: for a SOFT per-thread/per-host stack deny `decision.reason` is the
    // SAME pre-sanitized one-liner handed to `emitGateDecision` above (sandbox
    // type + workdir — never tool input), reused verbatim with `layer:"stack"`
    // / `pillar:"sandbox"`. `stackSource` is OMITTED: the returned
    // `PermissionDecision` does not carry the firing axis. SECURITY (no-leak):
    // `evaluateStack`'s HARD_DENY arm (precedence level 1) ALSO surfaces here as
    // a `deny` whose `decision.reason` echoes the command — `policyDenyStructured`
    // switches it to the categorical `hard-deny` form so the command never
    // reaches the structured field (the prose `content` may still echo it).
    return deny(
      call.id,
      `Permission denied: ${decision.reason}`,
      "denied",
      denyReason(policyDenyStructured(action, "stack", decision.reason, "sandbox")),
    )
  }
  // `ask` ⇒ no opinion from the stack; fall through to the legacy mode policy
  // (which is the canonical place for the `ask → onConfirm` handshake AND the
  // single canonical emit site for the resulting global-default verdict). No
  // emit here — emitting would double-count the one downstream decision.
  return null
}

/**
 * L4 wiring (ADR-0061 absorb #2) — cascade-on-approval. When the host's
 * `onConfirm` returns allow for a call carrying `rememberPatterns`, this
 * helper:
 *   1. Folds those patterns into `config.permissionPatternStore` (so future
 *      structurally-equivalent actions can auto-pass via `autoPassByPatterns`).
 *   2. Computes which `opts.pendingPermissions` are now fully covered.
 *   3. Notifies the caller via `opts.onPatternCascade` so the loop can choose
 *      to short-circuit those queued requests (deferred wiring — the gate
 *      itself does NOT auto-execute them; cascade is pure information).
 *
 * Skipped when the store, the patterns, or the notifier is absent (i.e. the
 * default-OFF path stays byte-identical for callers that don't opt in).
 *
 * The classifier-emitted `suggestedAllowlistEntry` is included in the
 * notification so a surface can display "grant 'npm,install'" instead of the
 * literal command. The classifier is deterministic + pure (no ML);
 * `learningSource` distinguishes a user-driven cascade from a future
 * classifier-driven auto-pass.
 */
const cascadeOnApprove = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
  learningSource: LearningSource,
): void => {
  const store = config.permissionPatternStore
  if (store === undefined) return
  const patterns = action.rememberPatterns
  if (patterns === undefined || patterns.length === 0) return
  // ADR-0061 hardening: dangerous actions only cascade on operator override.
  if (action.isMaybeDangerous === true && config.permissionAllowDangerous !== true) return
  const pending = opts.pendingPermissions ?? []
  const cascaded = grantAndCascade(store, patterns, {
    pending,
    allowDangerous: config.permissionAllowDangerous === true,
  })
  if (opts.onPatternCascade === undefined) return
  // Compute the classifier surface from the same actionKey the trust-scope
  // wire-up uses, so the suggested pattern matches the persisted-grant shape.
  const shellCommand = config.registry.extractShellCommand(action.tool, action.input)
  const actionKey = shellCommand !== null ? `${action.tool}|${shellCommand}` : null
  const classified = classifyCommand({
    toolName: action.tool,
    ...(actionKey !== null ? { actionKey } : {}),
  })
  opts.onPatternCascade({
    grantedPatterns: patterns,
    cascadedToolCallIds: cascaded,
    learningSource,
    suggestedAllowlistEntry: classified.suggestedAllowlistEntry,
  })
}

/** Phase C — trust-scope short-circuit for the ask-branch (ADR-0050). DEFAULT
 *  OFF: returns false unless `config.trustScope` is set AND the registry
 *  confirms a positive grant for `(projectKey, action.tool[, actionKey])`. The
 *  registry owns once_only consumption; the gate never branches on scope
 *  literals.
 *
 *  L4 promotion (persistent registry — `trust-scope-store.ts`): the registry's
 *  `hasGrant` cascade now keys on (tool, actionKey, command-pattern). The gate
 *  derives the action's `actionKey` from the same `extractShellCommand` source
 *  the reviewer dispatch uses, so a persisted `bash|git status` grant is hit
 *  for the same call shape the reviewer would see. Absent shell command ⇒
 *  tool-only lookup (legacy behavior — pure widening, byte-identical to
 *  pre-L4 callers that pass an in-memory registry). */
const trustScopeGrants = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
): boolean => {
  if (!config.trustScope) return false
  const shellCommand = config.registry.extractShellCommand(action.tool, action.input)
  // #20 (durable prefix safety) — a token-prefix trust-scope grant (`commandPattern`)
  // matches by FIRST TOKEN, so a chained command (`echo x && cat /etc/passwd`)
  // whose first token rides the grant would smuggle the rest past the prompt.
  // The persistent store's `patternMatchesAction` has no metachar guard, so we
  // apply the SAME single-simple-command guard the session prefix grant uses
  // here: a shell-command action with any chaining/redirection/substitution
  // metachar NEVER ask-skips (it re-prompts, fail-closed). A non-shell action
  // (shellCommand === null) is unaffected. HARD_DENY already precedes this gate.
  if (shellCommand !== null && !isSimpleCommand(shellCommand)) return false
  const lookup: { tool: string; actionKey?: string } = { tool: action.tool }
  if (shellCommand !== null) lookup.actionKey = `${action.tool}|${shellCommand}`
  return config.trustScope.registry.hasGrant(config.trustScope.projectKey, lookup)
}

/** Resolve the `ask` branch: short-circuit on a trust-scope grant, otherwise
 *  call host `onConfirm` (wrapped in try-catch so a throwing handler becomes
 *  a structured deny, R-Phase5 P0-C). Returns a deny short-circuit or null. */
const resolveAskBranch = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  reason: string,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null> => {
  // Phase C — trust-scope registry wire-up (ADR-0050). DEFAULT OFF.
  if (trustScopeGrants(config, action)) return null
  // Default-deny when no handler is wired (byte-identical legacy: a missing
  // onConfirm has always been treated as a refusal).
  let decision: ConfirmDecision = { decision: "deny" }
  if (config.onConfirm) {
    try {
      decision = normalizeConfirm(await config.onConfirm(action))
    } catch (e) {
      if (isSessionApprovalRequiredError(e)) throw e
      const message = errMessage(e)
      return deny(
        call.id,
        `Confirmation handler failed: ${message}`,
        "error",
        // C6: categorical — the host error `message` stays on `content`.
        denyReason({
          layer: "stack",
          pillar: "approval",
          safeReason: "confirmation handler failed",
        }),
      )
    }
  }
  // ADR-0076 Gap-4: a `deny_and_steer` decision from the mode-policy ask-branch
  // also surfaces its steer (the verb is decision-shaped, not branch-shaped).
  if (!isConfirmAllowed(decision)) {
    return denyFromConfirm(
      call,
      decision,
      `User declined: ${reason}`,
      "declined",
      config,
      // C6: `reason` is the policy's own categorical ask message (action.tool at
      // most — never tool input), reused verbatim.
      denyReason({ layer: "stack", pillar: "approval", safeReason: reason }),
    )
  }
  // ADR-0061 L4 cascade — user approved via the mode-policy ask path.
  cascadeOnApprove(config, action, opts, "user_accept")
  return null
}

/**
 * Capability B — consult the injected leader broker for a SOFT-denied action.
 * Fail-closed: any throw from the port is treated as "denied" (a worker can
 * never widen its own permission by crashing the decider). The HARD_DENY
 * exclusion + knob-gating are the CALLER's responsibility (see the deny arm of
 * {@link runModePolicy}); this helper only adapts the port call + fail-close.
 */
const runBrokerEscalation = async (
  broker: GateEscalationBroker,
  action: AdmissibilityAction,
  reason: string,
): Promise<"approved" | "denied"> => {
  try {
    const verdict = await broker.escalate({
      tool: action.tool,
      scope: action.shellCommand ?? action.tool,
      reason,
    })
    return verdict.approved ? "approved" : "denied"
  } catch (e) {
    writeStderr(`[quanta] team-broker: escalate threw (fail-closed deny): ${errMessage(e)}\n`)
    return "denied"
  }
}

/**
 * C6 — build the {@link StructuredDenyReasonInput} for a mode-policy / stack
 * `deny` whose `decision.reason` MAY echo the command (the HARD_DENY arm sets
 * `"Blocked dangerous command: <cmd>"`).
 *
 * SECURITY (no-leak): a HARD_DENY hit switches to the CATEGORICAL
 * `hardDenySafeReason()` + `layer:"hard-deny"` so the command never reaches the
 * structured field; only the SOFT deny reuses `decision.reason` (which stitches
 * `action.tool` at most — never tool input) under the supplied SOFT `layer`.
 */
const policyDenyStructured = (
  action: AdmissibilityAction,
  softLayer: DenyLayer,
  softReason: string,
  softPillar?: DenyPillar,
): StructuredDenyReasonInput =>
  hardDenyReason(action) !== null
    ? { layer: "hard-deny", safeReason: hardDenySafeReason() }
    : {
        layer: softLayer,
        safeReason: softReason,
        ...(softPillar !== undefined ? { pillar: softPillar } : {}),
      }

/* ------------------------------------------------------------------------- *
 * jun-7-misc 04 — auto-mode overlay + circumvention wiring (BOTH default-OFF).
 *
 * `buildEvaluateAutoOptions` assembles the optional {@link EvaluateAutoOptions}
 * for `evaluateAuto` from gate config/opts, STRICTLY knob-gated:
 *
 *   - `runtimeConfig().autoModeRules` (`=== "1"`) ⇒ compose the operator
 *     rule overlay onto the classifier prompt. OFF ⇒ no overlay slot, the
 *     canonical `CLASSIFIER_SYSTEM_PROMPT` flows through `evaluateAuto`
 *     unchanged (byte-identical classification).
 *   - `runtimeConfig().circumventDetect` (`=== "1"`) AND a wired
 *     `opts.circumventionTracker` ⇒ extract THIS action's write-effect and pass
 *     the tracker + effect + turn. OFF (or no tracker) ⇒ no effect memory.
 *
 * When BOTH knobs are OFF this returns `undefined`, so `runModePolicy` calls the
 * 3-arg `evaluateAuto(...)` exactly as before (the OFF ratchet).
 *
 * Untrusted-source fence: the overlay is built from the rules store snapshot via
 * {@link buildAutoModeOverlay}, which DROPS a `project`-layer (repo-controllable)
 * `allow`/`hard_deny` — a repo cannot loosen the AFK boundary.
 * ------------------------------------------------------------------------- */

/** Project a `RulesStore` snapshot to the layered-rule view the overlay adapter
 *  consumes. The current `@/rules` DSL has a single `deny` action with NO hard
 *  tag, so every `deny` maps to `soft_deny` (the conservative default — Open
 *  Question §6.2: a hard-deny tag is a deferred DSL extension). */
const snapshotToLayeredRules = (store: RulesStore): readonly LayeredRule[] => {
  const snap = store.snapshot()
  const out: LayeredRule[] = []
  for (const layerRules of [snap.system, snap.user, snap.project]) {
    for (const r of layerRules) {
      out.push({ action: r.action, prefix: r.prefix, layer: r.layer })
    }
  }
  return out
}

const buildEvaluateAutoOptions = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): EvaluateAutoOptions | undefined => {
  const rulesOn = runtimeConfig().autoModeRules
  const circumventOn = runtimeConfig().circumventDetect && opts.circumventionTracker !== undefined
  if (!rulesOn && !circumventOn) return undefined

  const result: {
    overlaidSystemPrompt?: string
    tracker?: CircumventionTracker
    effect?: EffectSignature
    effects?: readonly EffectSignature[]
    turn?: number
  } = {}

  if (rulesOn && opts.rulesStore !== undefined) {
    const overlay = buildAutoModeOverlay(snapshotToLayeredRules(opts.rulesStore))
    if (overlay !== undefined) {
      // Compose the overlay ONTO the scout-overlaid base so the existing
      // exfil-scouting seam (its own knob) still applies underneath.
      const scoutBase = withExfilScoutingTaxonomy(
        CLASSIFIER_SYSTEM_PROMPT,
        runtimeConfig().exfilScouting,
      )
      result.overlaidSystemPrompt = withUserRuleOverlay(scoutBase, overlay)
    }
  }

  if (circumventOn && opts.circumventionTracker !== undefined) {
    // Round-4: extract ALL write effects (a shell command can write multiple
    // paths; a decoy-prefixed redirect must not hide the soft-denied target).
    const effects = extractWriteEffects(
      action.tool,
      action.input,
      action.shellCommand,
      config.cwd,
      action.isReadOnly,
    )
    const first = effects[0]
    if (first !== undefined) {
      result.tracker = opts.circumventionTracker
      result.effects = effects
      // Keep the single `effect` populated for any consumer/test that reads it.
      result.effect = first
      result.turn = config.run?.turn ?? 0
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

/** Resolve the mode-policy decision: "auto" + a wired classifier routes through
 *  the async classifier (with the optional, knob-gated overlay/circumvention
 *  wiring); every other mode uses the synchronous policy verbatim. Extracted so
 *  {@link runModePolicy} stays under the complexity bar. */
const resolveModeDecision = async (
  config: AdmissibilityGateConfig,
  permission: PermissionContext,
  action: AdmissibilityAction,
  autoClassifier: AutoModeClassifier | undefined,
  opts: AdmissibilityWaveAOptions,
): Promise<PermissionDecision> => {
  if (permission.mode === "auto" && autoClassifier) {
    const autoOpts = buildEvaluateAutoOptions(config, action, opts)
    return evaluateAuto(action, permission, autoClassifier, autoOpts)
  }
  return evaluate(action, permission)
}

/** Mode-based permission decision (legacy path). Tier 1 capability (ADR-0011):
 *  "auto" mode routes to the session-scoped LLM classifier; all other modes
 *  use the synchronous policy verbatim. */
const runModePolicy = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  permission: PermissionContext,
  action: AdmissibilityAction,
  autoClassifier?: AutoModeClassifier,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null> => {
  // jun-7-misc 04 — in "auto" mode, assemble the optional overlay +
  // circumvention wiring (BOTH knobs OFF ⇒ `undefined`, byte-identical call).
  const decision = await resolveModeDecision(config, permission, action, autoClassifier, opts)
  // ADR-0267 Phase 2 — emit the mode-policy decision BEFORE acting on it so a
  // tracer sees the categorical outcome (allow/deny/ask) even on paths that
  // later short-circuit via the ask handler. `decision.reason` is the
  // policy's own message; it MAY include the tool name but never tool input
  // — the underlying `evaluate*` constructors only ever stitch action.tool
  // into the prose. Defence-in-depth: this site does NOT spread metadata
  // from the decision itself.
  const outcome: "allow" | "deny" | "ask" = decision.kind
  emitGateDecision(config, {
    kind: "permission",
    outcome,
    reason:
      decision.kind === "allow"
        ? `mode='${permission.mode}' allow`
        : decision.kind === "deny"
          ? decision.reason
          : decision.reason,
    toolCallId: call.id,
    tool: action.tool,
  })
  if (decision.kind === "deny") {
    // Capability B — leader-mediated escalation of a SOFT policy denial. SECURITY:
    // re-verify the action is NOT a HARD_DENY before escalating (the policy-
    // internal HARD_DENY surfaces here as a `deny` when no allow-capable bypass
    // ran step-2 `earlyHardDeny`). A denylisted command is NEVER escalatable.
    let brokerDenied = false
    if (opts.coordinationBroker !== undefined && hardDenyReason(action) === null) {
      const verdict = await runBrokerEscalation(opts.coordinationBroker, action, decision.reason)
      brokerDenied = verdict === "denied"
      if (verdict === "approved") {
        // Corrective emit: the policy denied but the leader overrode → ADMIT.
        // Two events (deny then broker-allow) tell the true story to a tracer.
        emitGateDecision(config, {
          kind: "permission",
          outcome: "allow",
          reason: "broker-escalated (leader-approved)",
          toolCallId: call.id,
          tool: action.tool,
        })
        // null ⇒ runAdmissibilityGate proceeds to the pre_tool_use hook (so a
        // repo-local hook can still veto last — parity with every allow path).
        return null
      }
    }
    // When the HITL gate is enabled the HARD_DENY branch is already handled
    // upstream; any remaining policy denial keeps the legacy "Permission
    // denied" wording (e.g. classifier "deny" verdict in auto mode). C6: the
    // structured reason is `hard-deny` on a HARD_DENY hit (no command leak), or
    // the SOFT `broker`/`stack` layer otherwise — see {@link policyDenyStructured}.
    return deny(
      call.id,
      `Permission denied: ${decision.reason}`,
      "denied",
      denyReason(policyDenyStructured(action, brokerDenied ? "broker" : "stack", decision.reason)),
    )
  }
  if (decision.kind === "ask") {
    return resolveAskBranch(call, config, action, decision.reason, opts)
  }
  return null
}

/**
 * Gate step 2 — HARD_DENY security boundary, pulled AHEAD of the rule DSL +
 * HITL/reviewer + pattern auto-pass when ANY allow-capable bypass is active
 * (rulesStore / reviewerPort / permissionPatternStore), so a rule `allow`, a
 * reviewer approval, OR a pattern-grant auto-pass cannot route around the
 * denylist. Mode-block (caller, step 1) still wins. Without any of those this
 * returns `null` and the legacy policy-internal HARD_DENY (step 5 `evaluate`)
 * stays byte-identical.
 *
 * AUDIT-FIX (gate fail-open): `permissionPatternStore` was previously NOT in
 * this trigger. With only `permissionPatternStore` wired, step 2.5
 * (`autoPassByPatterns`) could `auto_pass` a covered-pattern action straight
 * to the hook, skipping BOTH the HITL HARD_DENY branch AND the policy
 * `evaluate` HARD_DENY — a security-boundary bypass. Including it here closes
 * that hole; existing rulesStore/reviewerPort/legacy paths are unchanged.
 *
 * Extracted from `runAdmissibilityGate` so the trigger predicate + inner
 * deny live in one place and the parent function's cognitive complexity does
 * not grow with the added condition.
 */
const earlyHardDeny = (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): DispatchResult | null => {
  const bypassActive =
    opts.rulesStore !== undefined ||
    opts.reviewerPort !== undefined ||
    config.permissionPatternStore !== undefined ||
    // jun-6 — the `permission_request` hook is allow-CAPABLE (step 3b). When the
    // kill-switch is on AND a HookBus is wired, pull HARD_DENY ahead so a hook
    // `allow` can never route around the denylist (the §4.4 floor, layer (a)).
    (runtimeConfig().permissionHook && config.hooks !== undefined)
  if (!bypassActive) return null
  const hardDenyCommand = config.registry.extractShellCommand(action.tool, action.input)
  const hardDeny = hardDenyReason({
    tool: action.tool,
    input: action.input,
    isReadOnly: action.isReadOnly,
    shellCommand: hardDenyCommand,
  })
  if (hardDeny === null) return null
  return deny(
    call.id,
    `Action requires human handoff: ${hardDeny}${HANDOFF_SUFFIX}`,
    "handoff",
    // C6 no-leak: categorical `hardDenySafeReason()`, NOT `hardDeny` (which
    // echoes the matched command on the model-facing `content`).
    denyReason({ layer: "hard-deny", safeReason: hardDenySafeReason() }),
  )
}

/**
 * jun-6 (RFC jun-6-permission-request-hook) — dispatch "step 3b": consult the
 * `permission_request` hook BEFORE the policy stack. PURE control flow over
 * three injected ports (the bus, the registry-derived HARD_DENY fact, the
 * `routePermissionHookVerdict` helper). Returns:
 *   - a terminal {@link DispatchResult} when the hook decided deny/ask/admit,
 *   - `"fallthrough"` when there is no hook, the kill-switch is off, the hook
 *     supplied no decision, OR the decision was a HARD_DENY `allow` that the
 *     helper downgraded (the gate then proceeds to the existing stack, which —
 *     because `earlyHardDeny` was pulled ahead — has already terminated a
 *     HARD_DENY call, so this fall-through is byte-identical fail-closed).
 *
 * SECURITY (the §4.4 floor): the HARD_DENY precedence is enforced on BOTH
 * layers — (a) `earlyHardDeny`'s `bypassActive` trigger now includes
 * `config.hooks !== undefined`, so a HARD_DENY call is terminated BEFORE this
 * step runs; (b) `routePermissionHookVerdict` independently downgrades an
 * `allow`-on-HARD_DENY to a `deny` arm, so even a wiring mistake cannot let a
 * hook `allow` route around the denylist.
 *
 * Default-OFF: `runtimeConfig().permissionHook !== true` OR no `HookBus` ⇒
 * `"fallthrough"` with NO emit, NO allocation (byte-identical to today).
 */
const runPermissionRequestHook = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): Promise<DispatchResult | null | "fallthrough"> => {
  if (!runtimeConfig().permissionHook) return "fallthrough"
  if (config.hooks === undefined) return "fallthrough"
  const { tier } = resolveHitlTier(config, call, action)
  const result = await config.hooks.emit({
    type: "permission_request",
    name: call.name,
    input: call.input,
    tier,
    cwd: config.cwd,
  })
  const decision: HookPermissionDecision | undefined = result.permissionDecision
  // The HARD_DENY fact for the §4.4 floor — re-derive from the registry so the
  // helper can refuse an `allow`-on-HARD_DENY even if (impossibly) earlyHardDeny
  // did not pull it ahead.
  const hardDeny = hardDenyReason(action)
  const routing = routePermissionHookVerdict(decision, hardDeny !== null, hardDeny ?? undefined)
  switch (routing.arm) {
    case "fallthrough":
      return "fallthrough"
    case "admit":
      // Short-circuit admit — but still pass through the pre_tool_use hook so a
      // repo-local hook can veto last (parity with every other allow path).
      return runPreToolUseHook(call, config, opts)
    case "deny":
      emitGateDecision(config, {
        kind: "hook",
        outcome: "deny",
        reason: `permission_request: ${routing.reason}`,
        toolCallId: call.id,
        hookName: "permission_request",
        tool: call.name,
      })
      return deny(
        call.id,
        `Permission denied: ${routing.reason}`,
        "hook-denied",
        // C6: categorical — the router `routing.reason` stays on `content`.
        denyReason({ layer: "hook", safeReason: "permission_request hook denied" }),
      )
    case "ask":
      return resolveAskBranch(call, config, action, `permission_request hook (${call.name})`, opts)
  }
}

/**
 * Prefix-rule DSL gate body (ADR-0031). Returns the gate result, or the
 * sentinel `"fallthrough"` when the parent should continue to the legacy
 * gates (no rules store, or `no_match` with the default `"fallthrough"`
 * policy). Extracted from `runAdmissibilityGate` so the parent's cognitive
 * complexity stays under the biome cap with the ADR-0267 emit calls layered
 * in — the gate semantics are byte-identical to the previous inline block.
 *
 * ADR-0267 Phase 2 — emits `kind:"rule"` decisions on the 3 outcome branches
 * (allow / deny / ask). The `rule_no_match_deny` branch also emits so a
 * tracer can show why a default-deny policy fired. The `m.rule.action === "ask"`
 * arm with no reviewer port wired emits an `ask` (the policy intent), then
 * the gate returns the legacy `rule_ask` deny — the emit reflects the rule's
 * DECLARED outcome, not the wiring-failure deny that follows.
 */
const runRulesDsl = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  opts: AdmissibilityWaveAOptions,
): Promise<DispatchResult | null | "fallthrough"> => {
  if (!opts.rulesStore) return "fallthrough"
  const ruleKey = config.registry.extractShellCommand(action.tool, action.input) ?? action.tool
  const m = opts.rulesStore.match(ruleKey)
  if (m.kind === "matched") {
    // Build the ruleId from prefix + layer + source line — categorical,
    // matches the on-disk identity, NEVER carries the matched command.
    const ruleId = `${m.rule.layer}:${m.rule.sourceFile}:${m.rule.sourceLine}`
    if (m.rule.action === "allow") {
      emitGateDecision(config, {
        kind: "rule",
        outcome: "allow",
        reason: `matched rule '${m.rule.prefix}' (${m.rule.layer})`,
        toolCallId: call.id,
        ruleId,
        tool: action.tool,
      })
      return runPreToolUseHook(call, config, opts)
    }
    if (m.rule.action === "deny") {
      emitGateDecision(config, {
        kind: "rule",
        outcome: "deny",
        reason: `matched deny rule '${m.rule.prefix}' (${m.rule.layer})`,
        toolCallId: call.id,
        ruleId,
        tool: action.tool,
      })
      return deny(
        call.id,
        `Permission denied by rule '${m.rule.prefix}' (${m.rule.layer}): ${ruleKey}`,
        "rule_deny",
        // C6 no-leak: the categorical rule-prefix+layer form (the SAME shape
        // emitted to the recorder above) — NOT `ruleKey`, which for a shell tool
        // is the command itself. The prose `content` keeps `ruleKey`.
        denyReason({
          layer: "stack",
          safeReason: `matched deny rule '${m.rule.prefix}' (${m.rule.layer})`,
        }),
      )
    }
    // m.rule.action === "ask" — escalate (rule_ask deny if no port wired).
    emitGateDecision(config, {
      kind: "rule",
      outcome: "ask",
      reason: `matched ask rule '${m.rule.prefix}' (${m.rule.layer})`,
      toolCallId: call.id,
      ruleId,
      tool: action.tool,
    })
    if (opts.reviewerPort === undefined) {
      return deny(
        call.id,
        `Rule 'ask ${m.rule.prefix}' matched '${ruleKey}' but no ReviewerPort is wired.`,
        "rule_ask",
        // C6 no-leak: categorical rule prefix+layer only — NOT `ruleKey`.
        denyReason({
          layer: "stack",
          safeReason: `matched ask rule '${m.rule.prefix}' (${m.rule.layer}), no port wired`,
        }),
      )
    }
    return reviewAndDecide(call, config, action, opts, "rule")
  }
  // m.kind === "no_match"
  if (opts.noMatchPolicy === "deny") {
    emitGateDecision(config, {
      kind: "rule",
      outcome: "deny",
      reason: "no rule matched (noMatchPolicy='deny')",
      toolCallId: call.id,
      tool: action.tool,
    })
    return deny(
      call.id,
      `no rule matched '${ruleKey}' (noMatchPolicy='deny').`,
      "rule_no_match_deny",
      // C6 no-leak: categorical (the SAME recorder reason above) — NOT `ruleKey`.
      denyReason({ layer: "stack", safeReason: "no rule matched (noMatchPolicy='deny')" }),
    )
  }
  // "fallthrough" (or absent) ⇒ continue to the legacy gates below. No emit
  // here — the legacy gates own the next decision and will emit their own
  // kind:"permission" or kind:"hook" line.
  return "fallthrough"
}

/**
 * Run all pre-execute gates in canonical order. Returns a {@link
 * DispatchResult} to short-circuit the call, or `null` when the call is
 * admissible and execute should proceed.
 *
 * Pure with respect to control flow — it never mutates `config` or `permission`
 * — but it does invoke async ports (`onConfirm`, classifier, hooks). All
 * gates are skipped when unconfigured, so the default path (no hitl, no
 * planMode, no classifier, no hooks) is byte-for-byte identical to the prior
 * inline `runGates`.
 */
export const runAdmissibilityGate = async (
  call: ToolUseBlock,
  // Audit #9 — narrowed from full `AgentConfig` to `AdmissibilityGateConfig`
  // (the 14 fields this function and its internal helpers actually read).
  // `AgentConfig` is assignable to it via TS structural subtyping, so
  // existing callers (`dispatch.ts`) pass `config` unchanged. The narrower
  // type prevents accidental field creep and documents the surface in one
  // place — every internal helper in this file takes the same narrow type.
  config: AdmissibilityGateConfig,
  permission: PermissionContext,
  rawAction: AdmissibilityAction,
  autoClassifier?: AutoModeClassifier,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null> => {
  // S16 (audit A1 #3) — enrich the action with the registry-derived
  // `shellCommand` ONCE, up front, and use the enriched value for every
  // downstream gate. This is the SSOT that makes HARD_DENY fire uniformly for
  // ANY shell-equivalent tool inside `evaluate`/`evaluateAuto`/`evaluateStack`
  // and `runHitlGate`'s `hardDenyReason` — closing the bypass where a non-bash
  // shell tool reached mode-policy / the permission stack with the command
  // stripped off (so `hardDeny()` fell back to the bash-only legacy probe).
  const action = withResolvedShellCommand(config, rawAction)

  // 1. Mode-posture block (plan/review/audit) — fires BEFORE any HITL or
  //    permission work so a blocked mutating tool never reaches the classifier
  //    or the confirm prompt. Read-only tools always pass through.
  const modeBlocked = denyIfModeBlocked(call, config, action)
  if (modeBlocked !== null) return modeBlocked

  // 2. HARD_DENY security boundary — pulled AHEAD of the rule DSL + HITL/
  //    reviewer + pattern auto-pass when ANY allow-capable bypass is active
  //    (rulesStore/reviewerPort/permissionPatternStore). See
  //    {@link earlyHardDeny} for the full rationale (including the AUDIT-FIX
  //    that added permissionPatternStore to the trigger to close a fail-open).
  const earlyDeny = earlyHardDeny(call, config, action, opts)
  if (earlyDeny) return earlyDeny

  // 2.1. hand-off-required tier floor (jun-10 P2-T2/A3) — the tier whose contract
  //      is "NO mode can authorize" is pulled AHEAD of the permission hook /
  //      tool-profile / pattern auto-pass / rules DSL, so an operator pattern
  //      grant or `allow` rule CANNOT unlock it (parity with HARD_DENY above).
  //      `always-confirm` is intentionally NOT here — it is relaxable by an
  //      operator rule by design; it stays in the later HITL review gate.
  const handoffFloor = await runHandoffFloorGate(call, config, action, opts)
  if (handoffFloor !== "fallthrough") return handoffFloor

  // 3b. permission_request hook (jun-6). Consults an operator-authored handler
  //     that may PROGRAMMATICALLY supply the allow/deny/ask decision BEFORE the
  //     policy stack. Gated on `runtimeConfig().permissionHook` + a wired
  //     HookBus. HARD_DENY precedence is enforced on both layers (earlyHardDeny
  //     pull-ahead above + the helper's allow-downgrade). Default-OFF ⇒
  //     "fallthrough", byte-identical.
  const permissionHookResult = await runPermissionRequestHook(call, config, action, opts)
  if (permissionHookResult !== "fallthrough") return permissionHookResult

  // 2.25. Tool-profile strictness overlay. `/profile` mutates the active
  //       profile in-place through the shared session state, and the gate
  //       re-reads that live value here on every call. `allow` is neutral;
  //       only stricter outcomes short-circuit.
  const toolProfileResult = await runToolProfileGate(call, config, action, opts)
  if (toolProfileResult !== "fallthrough") {
    return toolProfileResult
  }

  // 2.5. Pattern-grant auto-pass (ADR-0061 absorb #2). DEFAULT OFF — fires only
  //      when `config.permissionPatternStore` is wired AND the action carries
  //      a non-empty `rememberPatterns` AND every pattern is already granted in
  //      the store. Hardening: an `isMaybeDangerous: true` action is NEVER auto-
  //      passed unless `config.permissionAllowDangerous === true`. The check is
  //      a pure predicate (`@/permission/gate-pattern-wire.ts`); a fall-through
  //      result simply continues to the rules DSL below. On auto-pass we still
  //      route through `runPreToolUseHook` so a hook can veto last (parity with
  //      every other allow path in this gate).
  //
  //      Placed BEFORE the rules DSL so a user-granted pattern combo behaves
  //      like an explicit pre-approval — equivalent in spirit to a rules
  //      `allow` written by the operator. HARD_DENY (above) still wins.
  const patternResult = await runPatternAutoPassGate(call, config, action, opts)
  if (patternResult !== "fallthrough") return patternResult

  // 3. Prefix-rule DSL gate (ADR-0031) — after mode + HARD_DENY. `allow` ⇒ admit,
  //    `deny` ⇒ terminal, `ask` ⇒ reviewer (or rule_ask deny if no port),
  //    `no_match` ⇒ noMatchPolicy ("deny" terminal, else fallthrough). Match key
  //    = the tool's shell command when present, else the tool name (so
  //    `allow read_file` matches a non-shell tool). Absent rulesStore ⇒ skipped.
  const ruleResult = await runRulesDsl(call, config, action, opts)
  if (ruleResult !== "fallthrough") return ruleResult

  // 4. HITL 4-tier gate (when enabled). HARD_DENY lives INSIDE this branch as
  //    well as inside `evaluate()` below — keeping both is intentional: the
  //    HITL branch phrases the deny as a hand-off-required terminator, while
  //    the policy branch keeps the legacy "Permission denied" wording for
  //    classifier denials in auto mode.
  const hitlResult = await runHitlReviewGate(call, config, action, opts)
  if (hitlResult !== "fallthrough") return hitlResult

  // 3. Permission stack consultation (ADR-0046, opt-in via
  //    config.permissionStack.enabled). Highest-priority axis after HARD_DENY:
  //    post-denial override → per-thread → per-host → fall through.
  const stackResult = await runPermissionStackGate(call, config, permission, action, opts)
  if (stackResult !== "fallthrough") return stackResult

  // 4. Permission policy (HARD_DENY + mode-driven decision; "auto" routes
  //    through the injected classifier).
  const policyResult = await runModePolicy(call, config, permission, action, autoClassifier, opts)
  if (policyResult) return policyResult

  // 5. pre_tool_use hook — repo-local code (or test spy) may deny last.
  return runPreToolUseHook(call, config, opts)
}
