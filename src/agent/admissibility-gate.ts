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
  inferToolTier,
  type PermissionContext,
  type PermissionStore,
  resolveHostId,
} from "@/permission"
import { deny, HANDOFF_SUFFIX } from "./dispatch-helpers"
import type { DispatchResult } from "./dispatch-types"
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

/** Resolve the effective HITL tier for a known-registered tool. The unknown-
 *  tool case is guarded upstream by `dispatchTool`; we mirror the legacy
 *  defensive fallback so this helper still has a defined answer if invoked
 *  with a stale registry. */
const resolveHitlTier = (
  config: AgentConfig,
  call: ToolUseBlock,
  action: AdmissibilityAction,
): HITLTier => {
  const tool = config.registry.get(call.name)
  if (tool) return inferToolTier(tool, call.input)
  return action.isReadOnly ? "none" : "pre-approval-ok"
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

  const tier = resolveHitlTier(config, call, action)
  if (tier === "hand-off-required") {
    return deny(
      call.id,
      `Action requires human handoff: ${call.name} is classified hand-off-required${HANDOFF_SUFFIX}`,
      "handoff",
    )
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
    // R-Phase5 P0-C: mirror the HITL branch — wrap host onConfirm in try-catch
    // so a throwing handler becomes a structured deny, never an uncaught
    // exception propagating into the dispatch pipeline.
    let approved = false
    if (config.onConfirm) {
      try {
        approved = await config.onConfirm(action)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return deny(call.id, `Confirmation handler failed: ${message}`, "error")
      }
    }
    if (!approved) return deny(call.id, `User declined: ${decision.reason}`, "declined")
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
