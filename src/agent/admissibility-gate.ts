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
  reviewAction,
  resolveHostId,
  type ToolActionKeyed,
} from "@/permission"
import type { RulesStore } from "@/rules"
import { deny, HANDOFF_SUFFIX } from "./dispatch-helpers"
import type { DispatchResult } from "./dispatch-types"
import type { HandoffRequiredEvent, HitlTier } from "./hitl-tier"
import { type HitlAnnotation, resolveHitlAnnotation } from "./hitl-tier-registry"
import { isMutatingToolBlockedInMode, modeBlockReason, resolveAgentMode } from "./mode"
import type { AgentConfig } from "./types"

export interface AdmissibilityAction {
  tool: string
  input: unknown
  isReadOnly: boolean
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
  config: AgentConfig,
  action: AdmissibilityAction,
  actionKey: string,
  opts: AdmissibilityWaveAOptions,
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
    decidedAt: opts.decidedAt ?? (() => Date.now()),
  }
  const dec = await reviewAction(keyed, ctx, opts.reviewerPort)
  const tag = reviewerTag(dec.reviewer)
  if (isAllowed(dec.outcome)) return runPreToolUseHook(call, config)
  if (dec.outcome === "user_aborted") {
    return deny(call.id, `User aborted: ${dec.rationale}${HANDOFF_SUFFIX}`, tag)
  }
  if (dec.outcome === "guardian_denied") {
    return deny(call.id, `Guardian denied: ${dec.rationale}`, tag)
  }
  return deny(call.id, `User declined: ${dec.rationale}`, tag)
}

/** Emit pre_tool_use hook, returning a hook-denied result or null to proceed. */
const runPreToolUseHook = async (
  call: ToolUseBlock,
  config: AgentConfig,
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
  config: AgentConfig,
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
  config: AgentConfig,
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
  config: AgentConfig,
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

/** Run the always-confirm branch — calls `onConfirm`, wraps host throws,
 *  returns the appropriate deny / null result. Factored out so the parent
 *  gate stays under the cognitive-complexity cap. */
const runAlwaysConfirmBranch = async (
  call: ToolUseBlock,
  config: AgentConfig,
  action: AdmissibilityAction,
): Promise<DispatchResult | null> => {
  if (!config.onConfirm) {
    return deny(
      call.id,
      `Permission denied: ${call.name} requires explicit confirmation (always-confirm tier) but no confirm handler is wired.`,
      "denied",
    )
  }
  let approved = false
  try {
    approved = await config.onConfirm(action)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return deny(
      call.id,
      `Confirmation handler failed for ${call.name} (always-confirm tier): ${message}`,
      "error",
    )
  }
  if (!approved) {
    return deny(
      call.id,
      `User declined: ${call.name} requires explicit confirmation (always-confirm tier).`,
      "declined",
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
  config: AgentConfig,
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
  config: AgentConfig,
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
const trustScopeGrants = (config: AgentConfig, action: AdmissibilityAction): boolean => {
  if (!config.trustScope) return false
  return config.trustScope.registry.hasGrant(config.trustScope.projectKey, { tool: action.tool })
}

/** Resolve the `ask` branch: short-circuit on a trust-scope grant, otherwise
 *  call host `onConfirm` (wrapped in try-catch so a throwing handler becomes
 *  a structured deny, R-Phase5 P0-C). Returns a deny short-circuit or null. */
const resolveAskBranch = async (
  call: ToolUseBlock,
  config: AgentConfig,
  action: AdmissibilityAction,
  reason: string,
): Promise<DispatchResult | null> => {
  // Phase C — trust-scope registry wire-up (ADR-0050). DEFAULT OFF.
  if (trustScopeGrants(config, action)) return null
  let approved = false
  if (config.onConfirm) {
    try {
      approved = await config.onConfirm(action)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return deny(call.id, `Confirmation handler failed: ${message}`, "error")
    }
  }
  if (!approved) return deny(call.id, `User declined: ${reason}`, "declined")
  return null
}

/** Mode-based permission decision (legacy path). Tier 1 capability (ADR-0011):
 *  "auto" mode routes to the session-scoped LLM classifier; all other modes
 *  use the synchronous policy verbatim. */
const runModePolicy = async (
  call: ToolUseBlock,
  config: AgentConfig,
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
  config: AgentConfig,
  permission: PermissionContext,
  action: AdmissibilityAction,
  autoClassifier?: AutoModeClassifier,
  opts: AdmissibilityWaveAOptions = {},
): Promise<DispatchResult | null> => {
  // 0. Prefix-rule DSL gate (ADR-0031) — consulted BEFORE mode/HITL/policy so
  //    an explicit `allow` short-circuits every downstream gate, a `deny` is
  //    terminal, an `ask` escalates to the reviewer, and `no_match` honors
  //    `noMatchPolicy` (default "fallthrough" ⇒ legacy gates). The match key is
  //    the tool's shell command when it exposes one, else the tool name (so a
  //    `allow read_file` rule still matches a non-shell tool). Absent
  //    `rulesStore` ⇒ skipped (byte-identical).
  if (opts.rulesStore) {
    const ruleKey = config.registry.extractShellCommand(action.tool, action.input) ?? action.tool
    const m = opts.rulesStore.match(ruleKey)
    if (m.kind === "matched") {
      if (m.rule.action === "allow") return runPreToolUseHook(call, config)
      if (m.rule.action === "deny") {
        return deny(call.id, `Denied by ${m.rule.layer} rule '${m.rule.prefix}': ${ruleKey}`, "rule_deny")
      }
      // m.rule.action === "ask" — escalate (deny with rule_ask tag if unwired).
      if (opts.reviewerPort === undefined) {
        return deny(
          call.id,
          `Rule 'ask ${m.rule.prefix}' matched '${ruleKey}' but no ReviewerPort is wired.`,
          "rule_ask",
        )
      }
      return reviewAndDecide(call, config, action, ruleKey, opts)
    }
    // m.kind === "no_match"
    if (opts.noMatchPolicy === "deny") {
      return deny(call.id, `No rule matched '${ruleKey}' and noMatchPolicy='deny'.`, "rule_no_match_deny")
    }
    // "fallthrough" (or absent) ⇒ fall through to the legacy gates below.
  }

  // 1. Mode-posture block (plan/review/audit) — fires BEFORE any HITL or
  //    permission work so a blocked mutating tool never reaches the classifier
  //    or the confirm prompt. Read-only tools always pass through.
  const effectiveMode = resolveAgentMode(config.mode, config.planMode)
  if (isMutatingToolBlockedInMode(effectiveMode, action)) {
    return deny(call.id, modeBlockReason(effectiveMode, call.name), `${effectiveMode}-blocked`)
  }

  // 2. HITL 4-tier gate (when enabled). HARD_DENY lives INSIDE this branch as
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
        return reviewAndDecide(call, config, action, action.tool, opts)
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
