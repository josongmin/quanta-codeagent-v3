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
  evaluate,
  evaluateAuto,
  evaluateStack,
  type HITLTier,
  hardDenyReason,
  type PermissionContext,
  type PermissionStore,
  resolveHostId,
} from "@/permission"
import { deny, HANDOFF_SUFFIX } from "./dispatch-helpers"
import type { DispatchResult } from "./dispatch-types"
import type { ToolHitlAnnotation } from "./hitl-tier"
import { getToolHitlTier } from "./hitl-tier-registry"
import { isMutatingToolBlockedInMode, modeBlockReason, resolveAgentMode } from "./mode"
import type { AgentConfig } from "./types"

export interface AdmissibilityAction {
  tool: string
  input: unknown
  isReadOnly: boolean
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

/** Strictness ordering for HITL tiers — composes the tool's own declaration
 *  with the name-based registry annotation by taking the more restrictive of
 *  the two. The "more restrictive" axis is well-defined: `hand-off-required`
 *  is strictest (blocks even with explicit confirm), then `always-confirm`
 *  (forces a prompt regardless of mode), then `pre-approval-ok` (defers to
 *  mode), then `none` (allows). Composing this way means a host that adds a
 *  `hitl-overrides.json` entry can only TIGHTEN the gate, never loosen the
 *  tool's own declaration — a one-way safety ratchet. */
const TIER_STRICTNESS: Readonly<Record<HITLTier, number>> = {
  "hand-off-required": 3,
  "always-confirm": 2,
  "pre-approval-ok": 1,
  none: 0,
}

const stricter = (a: HITLTier, b: HITLTier): HITLTier =>
  TIER_STRICTNESS[a] >= TIER_STRICTNESS[b] ? a : b

/** Read the tool's EXPLICIT `hitlTier(input)` declaration, if any. Returns
 *  `null` when the tool did not declare one (so the caller knows to defer to
 *  the registry's annotation instead of the fail-closed `inferToolTier`
 *  default). This is the only way to distinguish "tool said pre-approval-ok"
 *  from "tool said nothing and the policy inferred always-confirm". */
const explicitToolTier = (
  tool: ReturnType<AgentConfig["registry"]["get"]>,
  input: unknown,
): HITLTier | null => {
  if (!tool) return null
  const duck = tool as { hitlTier?: (i: unknown) => HITLTier }
  if (typeof duck.hitlTier !== "function") return null
  return duck.hitlTier(input)
}

/** Resolve the effective HITL annotation for a known-registered tool by
 *  composing the registry's name-based annotation with the tool's own
 *  `hitlTier(input)` declaration (ADR-0047).
 *
 *  Composition rules (the registry never silently loosens an EXPLICIT tool
 *  declaration; absent declarations defer to the registry):
 *    1. If the tool DECLARED a tier explicitly (`tool.hitlTier(input)` exists),
 *       compose with the registry by taking the STRICTER of the two — a
 *       one-way ratchet so a host's `~/.quanta/hitl-overrides.json` can only
 *       tighten an authored tool.
 *    2. If the tool did NOT declare a tier, use the registry's annotation
 *       verbatim. The registry's table is the system's authoritative source
 *       for tools that didn't self-classify — fixing the secure-by-default
 *       fallback's tendency to over-escalate well-known orchestration tools
 *       (`spawn_agent`, `wait_agent`, …) that are intrinsically harmless.
 *
 *  The returned annotation carries the registry's `reason` and
 *  `handoffMessage` whenever the registry's tier wins the composition — so
 *  a handoff deny block surfaces the human-readable guidance from the
 *  override / pattern table. */
const resolveHitlAnnotation = (
  config: AgentConfig,
  call: ToolUseBlock,
  _action: AdmissibilityAction,
): { tier: HITLTier; annotation: ToolHitlAnnotation } => {
  const tool = config.registry.get(call.name)
  const declared = explicitToolTier(tool, call.input)
  const registry = getToolHitlTier(call.name, call.input)

  if (declared === null) {
    // No explicit tool declaration — the registry's annotation is
    // authoritative. For tools the registry does not know either (unknown
    // mutating tool, no override), `getToolHitlTier` returns
    // `pre-approval-ok` (backwards-compat default).
    return { tier: registry.tier, annotation: registry }
  }

  // Tool declared a tier — take the stricter of the two (one-way ratchet).
  const composed = stricter(declared, registry.tier)
  const annotation: ToolHitlAnnotation = registry.tier === composed ? registry : { tier: composed }
  return { tier: composed, annotation }
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
    return deny(call.id, `Action requires human handoff: ${denyReason}${HANDOFF_SUFFIX}`, "handoff")
  }

  const { tier, annotation } = resolveHitlAnnotation(config, call, action)
  if (tier === "hand-off-required") {
    // Prefer the registry-provided handoffMessage when present (ADR-0047) —
    // it carries operator-facing guidance that's more useful than the generic
    // wording. Falls back to the legacy phrasing for tools whose tier comes
    // from `Tool.hitlTier()` alone (no registry annotation).
    const body =
      annotation.handoffMessage !== undefined
        ? `Action requires human handoff: ${annotation.handoffMessage}${HANDOFF_SUFFIX}`
        : `Action requires human handoff: ${call.name} is classified hand-off-required${HANDOFF_SUFFIX}`
    return deny(call.id, body, "handoff")
  }
  if (tier === "always-confirm") {
    if (!config.onConfirm) {
      return deny(
        call.id,
        `Permission denied: ${call.name} requires explicit confirmation (always-confirm tier) but no confirm handler is wired.`,
        "denied",
      )
    }
    // R-Phase5 P0-C: a host-provided onConfirm callback is user code and may
    // throw (REPL closed, network UI race, custom handler bug). The dispatch
    // contract is "no throw out of execute", so a throwing onConfirm MUST NOT
    // propagate — convert it into a structured deny so the loop sees a
    // recoverable error result.
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

/** Phase C — trust-scope short-circuit for the ask-branch (ADR-0045). DEFAULT
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
  // Phase C — trust-scope registry wire-up (ADR-0045). DEFAULT OFF.
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
  opts: { permissionStore?: PermissionStore } = {},
): Promise<DispatchResult | null> => {
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
