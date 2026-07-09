/**
 * Admissibility-gate stage helpers — mode-block, early HARD_DENY, handoff
 * floor, permission-request hook, tool-profile, pattern auto-pass, rules DSL,
 * permission stack, HITL review gate, mode policy + broker escalation. Extracted
 * from `admissibility-gate.ts` (god-module split). Behavior-preserving;
 * relative imports rebased one directory deeper.
 */
import type { ToolUseBlock } from "@/llm"
import {
  type AutoModeClassifier,
  autoPassByPatterns,
  buildAutoModeOverlay,
  type CircumventionTracker,
  CLASSIFIER_SYSTEM_PROMPT,
  computeActionSignature,
  decideFloor,
  type EffectSignature,
  type EvaluateAutoOptions,
  evaluate,
  evaluateAuto,
  evaluateStack,
  extractWriteEffects,
  getDefaultPermissionStore,
  isSimpleCommand,
  type PermissionContext,
  type PermissionDecision,
  type PermissionStore,
  resolveHostId,
  withExfilScoutingTaxonomy,
  withUserRuleOverlay,
} from "@/permission"
import type { RulesStore } from "@/rules"
import { errMessage, runtimeConfig, writeStderr } from "@/shared"
import {
  type ConfirmDecision,
  isAllowed as isConfirmAllowed,
  normalizeConfirm,
} from "../confirm-decision"
import {
  denyReason,
  hardDenyStructuredReason,
  hookDenyReason,
  modeApprovalDenyReason,
  stackApprovalDenyReason,
  stackDenyReason,
  toolProfileDenyReason,
} from "../deny-reason-wire"
import { deny, HANDOFF_SUFFIX } from "../dispatch-helpers"
import type { DispatchResult } from "../dispatch-types"
import { type HookPermissionDecision, routePermissionHookVerdict } from "../hooks"
import { isMutatingToolBlockedInMode, modeBlockReason, resolveAgentMode } from "../mode"
import type { AdmissibilityGateConfig } from "../types"
import { reviewAndDecide, runAlwaysConfirmBranch, runHitlGate } from "./hitl"
import {
  type AdmissibilityAction,
  type AdmissibilityWaveAOptions,
  cascadeOnApprove,
  denyFromConfirm,
  emitGateDecision,
  type GateEscalationBroker,
  hardDenyHandoff,
  isSessionApprovalRequiredError,
  type LayeredRule,
  policyDenyStructured,
  resolvedHardDenyProse,
  resolvedShellCommand,
  resolveHitlTier,
  runPreToolUseHook,
} from "./shared"

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
      toolProfileDenyReason("tool profile failed to resolve"),
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
      toolProfileDenyReason(policy.reason),
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
    modeApprovalDenyReason(reason),
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
    // C6: the typed deny carries the stack source, and `policyDenyStructured`
    // centralizes the `per-thread|per-host -> pillar:"sandbox"` mapping. A hard
    // deny is also explicit on `decision.hardDeny`, so this site no longer
    // re-encodes either mapping.
    return deny(
      call.id,
      `Permission denied: ${decision.reason}`,
      "denied",
      denyReason(policyDenyStructured(decision)),
    )
  }
  // `ask` ⇒ no opinion from the stack; fall through to the legacy mode policy
  // (which is the canonical place for the `ask → onConfirm` handshake AND the
  // single canonical emit site for the resulting global-default verdict). No
  // emit here — emitting would double-count the one downstream decision.
  return null
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
  const shellCommand = resolvedShellCommand(config, action)
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
        stackApprovalDenyReason("confirmation handler failed"),
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
      stackApprovalDenyReason(reason),
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
): Promise<
  { readonly verdict: "approved" } | { readonly verdict: "denied"; readonly steer?: string }
> => {
  try {
    const decision = await broker.escalate({
      tool: action.tool,
      scope: action.shellCommand ?? action.tool,
      reason,
    })
    if (decision.approved) return { verdict: "approved" }
    // WS-A (jul-10, UUX-1-07) — thread the leader's corrective steer (when a
    // non-empty string) so the deny arm can surface it via `denyFromConfirm`.
    const steer =
      typeof decision.steer === "string" && decision.steer.trim().length > 0
        ? decision.steer
        : undefined
    return steer === undefined ? { verdict: "denied" } : { verdict: "denied", steer }
  } catch (e) {
    writeStderr(`[quanta] team-broker: escalate threw (fail-closed deny): ${errMessage(e)}\n`)
    return { verdict: "denied" }
  }
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
    // a typed hard deny is NEVER escalatable. The permission slice sets
    // `decision.hardDeny=true` on its own HARD_DENY boundary, so this gate no
    // longer re-derives the fact from `action`.
    let brokerDenied = false
    let brokerSteer: string | undefined
    if (opts.coordinationBroker !== undefined && !decision.hardDeny) {
      const escalation = await runBrokerEscalation(opts.coordinationBroker, action, decision.reason)
      brokerDenied = escalation.verdict === "denied"
      if (escalation.verdict === "approved") {
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
      brokerSteer = escalation.steer
    }
    // WS-A (jul-10, UUX-1-07) — a leader deny that carries a corrective steer
    // routes through the EXISTING deny_and_steer mechanism (`denyFromConfirm` ⇒
    // `DispatchResult.steerInjection`), so the worker model learns what to do
    // instead. A plain broker deny stays byte-identical below.
    if (brokerSteer !== undefined) {
      return denyFromConfirm(
        call,
        { decision: "deny_and_steer", steer: brokerSteer },
        `Permission denied: ${decision.reason}`,
        "denied",
        config,
        denyReason(policyDenyStructured(decision, { brokerDenied })),
      )
    }
    // When the HITL gate is enabled the HARD_DENY branch is already handled
    // upstream; any remaining policy denial keeps the legacy "Permission
    // denied" wording (e.g. classifier "deny" verdict in auto mode). C6: the
    // structured reason is `hard-deny` on a hard deny (no command leak), or the
    // soft `broker`/`stack` layer otherwise — see {@link policyDenyStructured}.
    return deny(
      call.id,
      `Permission denied: ${decision.reason}`,
      "denied",
      denyReason(policyDenyStructured(decision, { brokerDenied })),
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
  // Reuse the gate-entry action fact (`withResolvedShellCommand`) instead of
  // re-deriving shellCommand from the registry a second time here.
  const hardDeny = resolvedHardDenyProse(action)
  if (hardDeny === null) return null
  return deny(
    call.id,
    `Action requires human handoff: ${hardDeny}${HANDOFF_SUFFIX}`,
    "handoff",
    // C6 no-leak: categorical `hardDenySafeReason()`, NOT `hardDeny` (which
    // echoes the matched command on the model-facing `content`).
    hardDenyStructuredReason(),
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
  const hardDeny = resolvedHardDenyProse(action)
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
        hookDenyReason("permission_request hook denied"),
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
  const ruleKey = resolvedShellCommand(config, action) ?? action.tool
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
        stackDenyReason(`matched deny rule '${m.rule.prefix}' (${m.rule.layer})`),
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
        stackDenyReason(`matched ask rule '${m.rule.prefix}' (${m.rule.layer}), no port wired`),
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
      stackDenyReason("no rule matched (noMatchPolicy='deny')"),
    )
  }
  // "fallthrough" (or absent) ⇒ continue to the legacy gates below. No emit
  // here — the legacy gates own the next decision and will emit their own
  // kind:"permission" or kind:"hook" line.
  return "fallthrough"
}

export {
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
}
