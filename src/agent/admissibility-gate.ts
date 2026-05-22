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
import {
  type AutoModeClassifier,
  autoPassByPatterns,
  computeActionSignature,
  type DenialMemory,
  evaluate,
  evaluateAuto,
  evaluateStack,
  type HITLTier,
  hardDenyReason,
  inferToolTier,
  isAllowed,
  type PermissionContext,
  type PermissionStore,
  type ReviewContext,
  type ReviewerPort,
  type ReviewerTier,
  resolveHostId,
  reviewAction,
  type ToolActionKeyed,
} from "@/permission"
import type { RulesStore } from "@/rules"
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
import { isMutatingToolBlockedInMode, modeBlockReason, resolveAgentMode } from "./mode"
import type { AdmissibilityGateConfig } from "./types"

export interface AdmissibilityAction {
  tool: string
  input: unknown
  isReadOnly: boolean
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
   * TODO(absorb #2): expose `rememberPatterns` / `isMaybeDangerous` in the
   * model-facing tool/schema surface so a future ADR can promote them onto
   * the model contract. For now, the dispatch seam plumbs whatever the action
   * carries; there is no model surface populating these yet.
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
 */
export interface AdmissibilityWaveAOptions {
  permissionStore?: PermissionStore
  rulesStore?: RulesStore
  noMatchPolicy?: "deny" | "fallthrough"
  reviewerPort?: ReviewerPort
  defaultReviewer?: ReviewerTier
  priorDenials?: ReadonlyArray<DenialMemory>
  decidedAt?: () => number
}

/** Map a `ReviewerTier` to the short preview tag suffix the dispatch seam
 *  surfaces (`reviewer_user` / `reviewer_auto` / `reviewer_guardian`). */
const reviewerTag = (reviewer: ReviewerTier): string =>
  reviewer === "auto_review"
    ? "reviewer_auto"
    : reviewer === "guardian_subagent"
      ? "reviewer_guardian"
      : "reviewer_user"

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
    )
  }
  // actionKey is `${tool}|${shellCommand}` when the tool exposes a command,
  // else the bare tool name — the same key a sticky-precedence DenialMemory is
  // recorded under, so a prior guardian_denied / user_aborted short-circuits
  // re-review of the identical action.
  const shellCommand = config.registry.extractShellCommand(action.tool, action.input)
  const actionKey = shellCommand !== null ? `${action.tool}|${shellCommand}` : action.tool
  const keyed: ToolActionKeyed = {
    tool: action.tool,
    input: action.input,
    isReadOnly: action.isReadOnly,
    actionKey,
  }
  const ctx: ReviewContext = {
    sessionId: config.sessionId ?? "default",
    turnId: String(config.run?.turn ?? 0),
    priorDenials: opts.priorDenials ?? [],
    configReviewer: opts.defaultReviewer ?? "user",
    decidedAt: opts.decidedAt ? opts.decidedAt() : Date.now(),
  }
  const dec = await reviewAction(keyed, ctx, opts.reviewerPort)
  const tag = reviewerTag(dec.reviewer)
  if (isAllowed(dec.outcome)) return runPreToolUseHook(call, config)
  // Rule-ask escalations carry an `origin=rule` marker so the surface can tell
  // a denylist-rule escalation apart from an always-confirm-tier escalation.
  const originSuffix = origin === "rule" ? " (origin=rule)" : ""
  if (dec.outcome === "user_aborted") {
    return deny(call.id, `User aborted: ${dec.rationale}${originSuffix}${HANDOFF_SUFFIX}`, tag)
  }
  if (dec.outcome === "guardian_denied") {
    return deny(call.id, `Guardian denied: ${dec.rationale}${originSuffix}`, tag)
  }
  return deny(call.id, `User declined: ${dec.rationale}${originSuffix}`, tag)
}

/** Emit pre_tool_use hook, returning a hook-denied result or null to proceed. */
const runPreToolUseHook = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
): Promise<DispatchResult | null> => {
  if (!config.hooks) return null
  const hookDeny = await config.hooks.emit({
    type: "pre_tool_use",
    name: call.name,
    input: call.input,
  })
  if (hookDeny) return deny(call.id, `Hook denied: ${hookDeny.deny}`, "hook-denied")
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

/** Emit a structured handoff event to the host (RFC §UI integration seam).
 *  Absent callback ⇒ silent no-op (byte-identical legacy behaviour). The
 *  callback is wrapped in a try/catch so a host-side bug never propagates
 *  into dispatch — emission MUST NOT change the deny result. */
const emitHandoffEvent = (
  config: AdmissibilityGateConfig,
  call: ToolUseBlock,
  handoffMessage: string,
  reason: string,
): void => {
  if (!config.onHandoff) return
  const event: HandoffRequiredEvent = {
    kind: "hitl-handoff",
    tool: call.name,
    args: call.input,
    handoffMessage,
    reason,
    timestamp: Date.now(),
  }
  try {
    config.onHandoff(event)
  } catch (e) {
    // The deny path must remain stable even when a host listener throws.
    // We swallow + warn via stderr — observability lives on the gate's
    // canonical return path, not on this notification seam.
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`[quanta] hitl: onHandoff threw: ${msg}\n`)
  }
}

/** Build + emit the hand-off deny when the resolved tier is
 *  `hand-off-required`. Factored out of `runHitlGate` so the cyclomatic
 *  complexity stays under the project cap. */
const buildHandoffDeny = (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  matched: HitlAnnotation | undefined,
): DispatchResult => {
  const suffix = matched?.reason !== undefined ? ` (${matched.reason})` : ""
  const handoffMessage = `Action requires human handoff: ${call.name} is classified hand-off-required${suffix}${HANDOFF_SUFFIX}`
  emitHandoffEvent(
    config,
    call,
    handoffMessage,
    matched !== undefined ? `registry:${matched.tool}` : "tier:hand-off-required",
  )
  return deny(call.id, handoffMessage, "handoff")
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
): DispatchResult => {
  // ADR-0077: consult the registry the gate already owns (no parallel lookup
  // path). The tool's DECLARED `isReadOnly()` decides whether to append the
  // readonly note to the steer; absent tool / mutating tool ⇒ verbatim steer
  // (byte-identical for legacy callers).
  const tool = config.registry.get(call.name)
  const isReadonly = tool ? tool.isReadOnly() : false
  const steer = buildDenySteerMessage(decision, isReadonly)
  if (steer === null) {
    return deny(call.id, baseContent, basePreview)
  }
  // deny_and_steer: deny AND carry the corrective instruction atomically.
  const result = deny(call.id, `${baseContent} Steer: ${steer}`, "deny_steer")
  // ADR-0077: surface the declared readonly flag on the DispatchResult's
  // typed failure envelope so trajectory/permission consumers can branch on
  // it without re-deriving from the tool registry. The shape is the existing
  // {@link ToolFailure.permission_denied} variant — unchanged when the tool
  // is mutating (omitted, byte-identical).
  return {
    ...result,
    steerInjection: steer,
    failure: { mode: "permission_denied", isReadonly },
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
): Promise<DispatchResult | null> => {
  if (!config.onConfirm) {
    return deny(
      call.id,
      `Permission denied: ${call.name} requires explicit confirmation (always-confirm tier) but no confirm handler is wired.`,
      "denied",
    )
  }
  let decision: ConfirmDecision
  try {
    decision = normalizeConfirm(await config.onConfirm(action))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return deny(
      call.id,
      `Confirmation handler failed for ${call.name} (always-confirm tier): ${message}`,
      "error",
    )
  }
  if (!isConfirmAllowed(decision)) {
    return denyFromConfirm(
      call,
      decision,
      `User declined: ${call.name} requires explicit confirmation (always-confirm tier).`,
      "declined",
      config,
    )
  }
  return null
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
): Promise<DispatchResult | null | "fallthrough"> => {
  // HARD_DENY hits ARE the hand-off-required tier (security boundary crossing
  // — no mode authorizes them). Phrase as a handoff demand.
  const denyReason = hardDenyReason(action)
  if (denyReason !== null) {
    const handoffMessage = `Action requires human handoff: ${denyReason}${HANDOFF_SUFFIX}`
    emitHandoffEvent(config, call, handoffMessage, `hard-deny:${denyReason}`)
    return deny(call.id, handoffMessage, "handoff")
  }

  const { tier, matched } = resolveHitlTier(config, call, action)
  if (tier === "hand-off-required") return buildHandoffDeny(call, config, matched)
  if (tier === "always-confirm") return runAlwaysConfirmBranch(call, config, action)
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
    },
    permission,
    { threadId, hostId, actionSignature, workdir: config.cwd },
    opts.store !== undefined ? { store: opts.store } : {},
  )
  if (decision.kind === "allow") return "allow"
  if (decision.kind === "deny") {
    return deny(call.id, `Permission denied: ${decision.reason}`, "denied")
  }
  // `ask` ⇒ no opinion from the stack; fall through to the legacy mode policy
  // (which is the canonical place for the `ask → onConfirm` handshake).
  return null
}

/** Phase C — trust-scope short-circuit for the ask-branch (ADR-0050). DEFAULT
 *  OFF: returns false unless `config.trustScope` is set AND the registry
 *  confirms a positive grant for `(projectKey, action.tool)`. The registry
 *  owns once_only consumption; the gate never branches on scope literals. */
const trustScopeGrants = (config: AdmissibilityGateConfig, action: AdmissibilityAction): boolean => {
  if (!config.trustScope) return false
  return config.trustScope.registry.hasGrant(config.trustScope.projectKey, { tool: action.tool })
}

/** Resolve the `ask` branch: short-circuit on a trust-scope grant, otherwise
 *  call host `onConfirm` (wrapped in try-catch so a throwing handler becomes
 *  a structured deny, R-Phase5 P0-C). Returns a deny short-circuit or null. */
const resolveAskBranch = async (
  call: ToolUseBlock,
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
  reason: string,
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
      const message = e instanceof Error ? e.message : String(e)
      return deny(call.id, `Confirmation handler failed: ${message}`, "error")
    }
  }
  // ADR-0076 Gap-4: a `deny_and_steer` decision from the mode-policy ask-branch
  // also surfaces its steer (the verb is decision-shaped, not branch-shaped).
  if (!isConfirmAllowed(decision)) {
    return denyFromConfirm(call, decision, `User declined: ${reason}`, "declined", config)
  }
  return null
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
): Promise<DispatchResult | null> => {
  const decision =
    permission.mode === "auto" && autoClassifier
      ? await evaluateAuto(action, permission, autoClassifier)
      : evaluate(action, permission)
  if (decision.kind === "deny") {
    // When the HITL gate is enabled the HARD_DENY branch is already handled
    // upstream; any remaining policy denial keeps the legacy "Permission
    // denied" wording (e.g. classifier "deny" verdict in auto mode).
    return deny(call.id, `Permission denied: ${decision.reason}`, "denied")
  }
  if (decision.kind === "ask") {
    return resolveAskBranch(call, config, action, decision.reason)
  }
  return null
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
  action: AdmissibilityAction,
  autoClassifier?: AutoModeClassifier,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null> => {
  // 1. Mode-posture block (plan/review/audit) — fires BEFORE any HITL or
  //    permission work so a blocked mutating tool never reaches the classifier
  //    or the confirm prompt. Read-only tools always pass through.
  const effectiveMode = resolveAgentMode(config.mode, config.planMode)
  if (isMutatingToolBlockedInMode(effectiveMode, action)) {
    return deny(call.id, modeBlockReason(effectiveMode, call.name), `${effectiveMode}-blocked`)
  }

  // 2. HARD_DENY security boundary — pulled AHEAD of the rule DSL + HITL/
  //    reviewer ONLY when Wave A options are active (rulesStore/reviewerPort),
  //    so a rule `allow` cannot bypass the denylist and the reviewer port is
  //    never consulted for a denylisted command. Mode-block (above) still wins.
  //    Without Wave A options this is skipped and the legacy policy-internal
  //    HARD_DENY (step 5 `evaluate`) stays byte-identical.
  if (opts.rulesStore !== undefined || opts.reviewerPort !== undefined) {
    const hardDenyCommand = config.registry.extractShellCommand(action.tool, action.input)
    const hardDeny = hardDenyReason({
      tool: action.tool,
      input: action.input,
      isReadOnly: action.isReadOnly,
      shellCommand: hardDenyCommand,
    })
    if (hardDeny !== null) {
      return deny(call.id, `Action requires human handoff: ${hardDeny}${HANDOFF_SUFFIX}`, "handoff")
    }
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
  if (config.permissionPatternStore !== undefined) {
    const autoPassOpts: { allowDangerous?: boolean; decidedAt?: () => number } = {}
    if (config.permissionAllowDangerous === true) autoPassOpts.allowDangerous = true
    if (opts.decidedAt !== undefined) autoPassOpts.decidedAt = opts.decidedAt
    const res = autoPassByPatterns(
      config.permissionPatternStore,
      { rememberPatterns: action.rememberPatterns, isMaybeDangerous: action.isMaybeDangerous },
      autoPassOpts,
    )
    if (res.kind === "auto_pass") {
      // Synthetic `auto_review/config_allowed` decision; we don't surface the
      // ApprovalDecision via this seam (the gate's contract is DispatchResult),
      // but the predicate constructed + validated one. Route through the hook
      // so a `pre_tool_use` veto still applies.
      return runPreToolUseHook(call, config)
    }
  }

  // 3. Prefix-rule DSL gate (ADR-0031) — after mode + HARD_DENY. `allow` ⇒ admit,
  //    `deny` ⇒ terminal, `ask` ⇒ reviewer (or rule_ask deny if no port),
  //    `no_match` ⇒ noMatchPolicy ("deny" terminal, else fallthrough). Match key
  //    = the tool's shell command when present, else the tool name (so
  //    `allow read_file` matches a non-shell tool). Absent rulesStore ⇒ skipped.
  if (opts.rulesStore) {
    const ruleKey = config.registry.extractShellCommand(action.tool, action.input) ?? action.tool
    const m = opts.rulesStore.match(ruleKey)
    if (m.kind === "matched") {
      if (m.rule.action === "allow") return runPreToolUseHook(call, config)
      if (m.rule.action === "deny") {
        return deny(
          call.id,
          `Permission denied by rule '${m.rule.prefix}' (${m.rule.layer}): ${ruleKey}`,
          "rule_deny",
        )
      }
      // m.rule.action === "ask" — escalate (rule_ask deny if no port wired).
      if (opts.reviewerPort === undefined) {
        return deny(
          call.id,
          `Rule 'ask ${m.rule.prefix}' matched '${ruleKey}' but no ReviewerPort is wired.`,
          "rule_ask",
        )
      }
      return reviewAndDecide(call, config, action, opts, "rule")
    }
    // m.kind === "no_match"
    if (opts.noMatchPolicy === "deny") {
      return deny(
        call.id,
        `no rule matched '${ruleKey}' (noMatchPolicy='deny').`,
        "rule_no_match_deny",
      )
    }
    // "fallthrough" (or absent) ⇒ fall through to the legacy gates below.
  }

  // 4. HITL 4-tier gate (when enabled). HARD_DENY lives INSIDE this branch as
  //    well as inside `evaluate()` below — keeping both is intentional: the
  //    HITL branch phrases the deny as a hand-off-required terminator, while
  //    the policy branch keeps the legacy "Permission denied" wording for
  //    classifier denials in auto mode.
  if (config.hitl?.enabled === true) {
    // Wave A (ADR-0029): a wired reviewerPort intercepts the always-confirm
    // tier and escalates to reviewAction instead of the legacy onConfirm. Every
    // other tier keeps its runHitlGate semantics (hand-off-required deny / none
    // allow / pre-approval fallthrough), so unset reviewerPort ⇒ byte-identical.
    if (opts.reviewerPort !== undefined) {
      const { tier } = resolveHitlTier(config, call, action)
      if (tier === "always-confirm") {
        return reviewAndDecide(call, config, action, opts, "hitl")
      }
    }
    const hitlResult = await runHitlGate(call, config, action)
    if (hitlResult !== "fallthrough") {
      // null ⇒ HITL approved, skip mode policy and emit hook + proceed.
      // non-null ⇒ short-circuit deny.
      return hitlResult ?? runPreToolUseHook(call, config)
    }
  }

  // 3. Permission stack consultation (ADR-0046, opt-in via
  //    config.permissionStack.enabled). Highest-priority axis after HARD_DENY:
  //    post-denial override → per-thread → per-host → fall through.
  const stackResult = runPermissionStack(
    call,
    config,
    permission,
    action,
    opts.permissionStore !== undefined ? { store: opts.permissionStore } : {},
  )
  if (stackResult !== null && stackResult !== "allow") return stackResult
  // `"allow"` from the stack ⇒ skip mode policy (the stack's allow is
  //    authoritative) and emit the pre_tool_use hook last.
  if (stackResult === "allow") return runPreToolUseHook(call, config)

  // 4. Permission policy (HARD_DENY + mode-driven decision; "auto" routes
  //    through the injected classifier).
  const policyResult = await runModePolicy(call, config, permission, action, autoClassifier)
  if (policyResult) return policyResult

  // 5. pre_tool_use hook — repo-local code (or test spy) may deny last.
  return runPreToolUseHook(call, config)
}
