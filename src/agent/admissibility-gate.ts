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
  classifyCommand,
  computeActionSignature,
  type DenialMemory,
  evaluate,
  evaluateAuto,
  evaluateStack,
  getDefaultPermissionStore,
  grantAndCascade,
  type HITLTier,
  hardDenyReason,
  inferReviewKind,
  inferToolTier,
  isAllowed,
  isDecisionLegalFor,
  type LearningSource,
  type PendingPermission,
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
import { errMessage } from "@/shared"
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
  const reviewKind = opts.reviewKindOverride ?? inferReviewKind(action.tool, action.isReadOnly)
  const ctx: ReviewContext = {
    sessionId: config.sessionId ?? "default",
    turnId: String(config.run?.turn ?? 0),
    priorDenials: opts.priorDenials ?? [],
    configReviewer: opts.defaultReviewer ?? "user",
    decidedAt: opts.decidedAt ? opts.decidedAt() : Date.now(),
    reviewKind,
  }
  const dec = await reviewAction(keyed, ctx, opts.reviewerPort)
  const tag = reviewerTag(dec.reviewer)

  // ADR-0070 — validate the OPTIONAL richer verb against the reviewKind.
  // A port that returns a verb illegal for the kind (e.g. `allowlist_commands`
  // on an `edit` kind) MUST be rejected — this is a wiring/contract bug, not
  // a user-facing decision. Surfaced as a typed deny so a host learns about
  // the malformed verb without trusting it as an allow.
  if (dec.verb !== undefined && !isDecisionLegalFor(reviewKind, dec.verb)) {
    return deny(
      call.id,
      `Reviewer returned illegal verb '${dec.verb.verb}' for reviewKind='${reviewKind}'.`,
      "reviewer_verb_illegal",
    )
  }

  if (isAllowed(dec.outcome)) {
    // ADR-0070 — record the actionKey in the allowlist_escalated cache so a
    // subsequent structurally-equivalent call within the same run skips review.
    opts.allowlistEscalated?.add(actionKey)
    return runPreToolUseHook(call, config, opts)
  }

  // Rule-ask escalations carry an `origin=rule` marker so the surface can tell
  // a denylist-rule escalation apart from an always-confirm-tier escalation.
  const originSuffix = origin === "rule" ? " (origin=rule)" : ""

  // ADR-0070 — `reject_and_tell` carries a steering message for the model.
  // We synthesize a `deny_and_steer` ConfirmDecision and route it through the
  // EXISTING {@link denyFromConfirm} seam so the gate has exactly ONE
  // `steerInjection:` assignment site (regression-guarded by
  // admissibility-deny-steer-hell.test.ts §G-1d).
  if (dec.verb !== undefined && dec.verb.verb === "reject_and_tell") {
    const baseContent =
      dec.outcome === "user_aborted"
        ? `User aborted: ${dec.rationale}${originSuffix}${HANDOFF_SUFFIX}`
        : dec.outcome === "guardian_denied"
          ? `Guardian denied: ${dec.rationale}${originSuffix}`
          : `User declined: ${dec.rationale}${originSuffix}`
    return denyFromConfirm(
      call,
      { decision: "deny_and_steer", steer: dec.verb.message },
      baseContent,
      tag,
      config,
    )
  }

  if (dec.outcome === "user_aborted") {
    return deny(call.id, `User aborted: ${dec.rationale}${originSuffix}${HANDOFF_SUFFIX}`, tag)
  }
  if (dec.outcome === "guardian_denied") {
    return deny(call.id, `Guardian denied: ${dec.rationale}${originSuffix}`, tag)
  }
  return deny(call.id, `User declined: ${dec.rationale}${originSuffix}`, tag)
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
  if (result.deny) return deny(call.id, `Hook denied: ${result.deny.deny}`, "hook-denied")
  // A rewrite only matters when the call is admitted. `emit` includes the
  // `updatedInput` KEY only when a handler set it (presence is the signal, not
  // truthiness), so a rewrite to a falsy value is still propagated.
  if ("updatedInput" in result) opts.onInputMutation?.(result.updatedInput)
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
    timestamp: Date.now(),
  }
  try {
    config.onHandoff(event)
  } catch (e) {
    // The deny path must remain stable even when a host listener throws.
    // We swallow + warn via stderr — observability lives on the gate's
    // canonical return path, not on this notification seam.
    const msg = errMessage(e)
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
  opts: AdmissibilityWaveAOptions = {},
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
    const message = errMessage(e)
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
  // ADR-0061 L4 cascade — user approved, fold rememberPatterns into the store
  // and notify the caller of any newly-resolvable pending requests. Default-OFF
  // (no-op when permissionPatternStore / onPatternCascade absent).
  cascadeOnApprove(config, action, opts, "user_accept")
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
  opts: AdmissibilityWaveAOptions = {},
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
  if (tier === "hand-off-required") return buildHandoffDeny(call, config, matched)
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
    },
    permission,
    { threadId, hostId, actionSignature, workdir: config.cwd },
    // W4 follow-up: evaluateStack now REQUIRES store. This file is the
    // composition-adjacent layer (called by dispatch), so `getDefaultPermissionStore()`
    // as a fallback is allowed by the new scanner rule. Long-term: thread
    // `permissionStore` through `AgentConfig` and remove this fallback.
    { store: opts.store ?? getDefaultPermissionStore() },
  )
  if (decision.kind === "allow") return "allow"
  if (decision.kind === "deny") {
    return deny(call.id, `Permission denied: ${decision.reason}`, "denied")
  }
  // `ask` ⇒ no opinion from the stack; fall through to the legacy mode policy
  // (which is the canonical place for the `ask → onConfirm` handshake).
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
      const message = errMessage(e)
      return deny(call.id, `Confirmation handler failed: ${message}`, "error")
    }
  }
  // ADR-0076 Gap-4: a `deny_and_steer` decision from the mode-policy ask-branch
  // also surfaces its steer (the verb is decision-shaped, not branch-shaped).
  if (!isConfirmAllowed(decision)) {
    return denyFromConfirm(call, decision, `User declined: ${reason}`, "declined", config)
  }
  // ADR-0061 L4 cascade — user approved via the mode-policy ask path.
  cascadeOnApprove(config, action, opts, "user_accept")
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
  opts: AdmissibilityWaveAOptions = {},
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
    config.permissionPatternStore !== undefined
  if (!bypassActive) return null
  const hardDenyCommand = config.registry.extractShellCommand(action.tool, action.input)
  const hardDeny = hardDenyReason({
    tool: action.tool,
    input: action.input,
    isReadOnly: action.isReadOnly,
    shellCommand: hardDenyCommand,
  })
  if (hardDeny === null) return null
  return deny(call.id, `Action requires human handoff: ${hardDeny}${HANDOFF_SUFFIX}`, "handoff")
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
  //    reviewer + pattern auto-pass when ANY allow-capable bypass is active
  //    (rulesStore/reviewerPort/permissionPatternStore). See
  //    {@link earlyHardDeny} for the full rationale (including the AUDIT-FIX
  //    that added permissionPatternStore to the trigger to close a fail-open).
  const earlyDeny = earlyHardDeny(call, config, action, opts)
  if (earlyDeny) return earlyDeny

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
      return runPreToolUseHook(call, config, opts)
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
      if (m.rule.action === "allow") return runPreToolUseHook(call, config, opts)
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
    const hitlResult = await runHitlGate(call, config, action, opts)
    if (hitlResult !== "fallthrough") {
      // null ⇒ HITL approved, skip mode policy and emit hook + proceed.
      // non-null ⇒ short-circuit deny.
      return hitlResult ?? runPreToolUseHook(call, config, opts)
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
  if (stackResult === "allow") return runPreToolUseHook(call, config, opts)

  // 4. Permission policy (HARD_DENY + mode-driven decision; "auto" routes
  //    through the injected classifier).
  const policyResult = await runModePolicy(call, config, permission, action, autoClassifier, opts)
  if (policyResult) return policyResult

  // 5. pre_tool_use hook — repo-local code (or test spy) may deny last.
  return runPreToolUseHook(call, config, opts)
}
