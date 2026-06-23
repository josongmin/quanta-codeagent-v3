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
 * `dispatch.ts#runGates` exactly.
 *
 * God-module split (fix-on-sight): the gate's internal helpers now live in
 * `./admissibility-gate/{shared,hitl,gates}.ts`. This file keeps ONLY the
 * orchestrator `runAdmissibilityGate` and re-exports the COMPLETE original
 * public surface (`AdmissibilityAction`, `AdmissibilityWaveAOptions`,
 * `GateEscalationBroker`) so every importer of `@/agent/admissibility-gate`
 * stays byte-compatible.
 */
import type { ToolUseBlock } from "@/llm"
import type { AutoModeClassifier, PermissionContext } from "@/permission"
import {
  denyIfModeBlocked,
  earlyHardDeny,
  runHandoffFloorGate,
  runHitlReviewGate,
  runModePolicy,
  runPatternAutoPassGate,
  runPermissionRequestHook,
  runPermissionStackGate,
  runRulesDsl,
  runToolProfileGate,
} from "./admissibility-gate/gates"
import {
  type AdmissibilityAction,
  type AdmissibilityWaveAOptions,
  type GateEscalationBroker,
  runPreToolUseHook,
  withResolvedShellCommand,
} from "./admissibility-gate/shared"
import type { DispatchResult } from "./dispatch-types"
import type { AdmissibilityGateConfig } from "./types"

// Re-export the COMPLETE original public surface so every importer of
// `@/agent/admissibility-gate` stays byte-compatible.
export type { AdmissibilityAction, AdmissibilityWaveAOptions, GateEscalationBroker }

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
