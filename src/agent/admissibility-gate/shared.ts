/**
 * Admissibility-gate shared primitives + public surface types.
 *
 * Extracted from `admissibility-gate.ts` (god-module split). These are the
 * cross-cutting helpers + the public interfaces consumed by the HITL pipeline
 * (`./hitl`), the gate stages (`./gates`), and the orchestrator
 * (`../admissibility-gate.ts`). No behavior change — the bodies are byte-
 * identical to the prior inline definitions, only relocated (relative imports
 * rebased one directory deeper).
 */
import type { ApprovalStateMachinePort } from "@/agent/approval-state-machine"
import type { ToolUseBlock } from "@/llm"
import { attrs, QUANTA_ATTRS, recordAttrs, SPAN_NAMES } from "@/observability"
import {
  type CircumventionTracker,
  classifyCommand,
  type DenialMemory,
  type DenyLayer,
  type DenyPillar,
  grantAndCascade,
  type HITLTier,
  hardDenyReason,
  hardDenySafeReason,
  inferReviewKind,
  inferToolTier,
  type LayeredRule,
  type LearningSource,
  type PendingPermission,
  type PermissionDenyDecision,
  type PermissionStore,
  type ReviewContext,
  type ReviewerPort,
  type ReviewerTier,
  type StructuredDenyReason,
  type StructuredDenyReasonInput,
} from "@/permission"
import type { RulesStore } from "@/rules"
import { errMessage, runtimeConfig, writeStderr } from "@/shared"
import { safeEmitDecision } from "@/stream"
import { buildDenySteerMessage, type ConfirmDecision } from "../confirm-decision"
import {
  denyReason,
  hardDenyStructuredReason,
  hookDenyReason,
  reviewerApprovalDenyReason,
} from "../deny-reason-wire"
import { deny, HANDOFF_SUFFIX } from "../dispatch-helpers"
import type { DispatchResult } from "../dispatch-types"
import type { HandoffRequiredEvent, HitlTier } from "../hitl-tier"
import { type HitlAnnotation, resolveHitlAnnotation } from "../hitl-tier-registry"
import type { AdmissibilityGateConfig } from "../types"

export type { ReviewContext }
export { inferReviewKind }

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
   * Gate-local cached HARD_DENY prose derived from the authoritative
   * `shellCommand` above. This lets gate helpers share one resolved deny fact
   * without each helper re-running the denylist matcher. The permission slice
   * may also reuse this cache when it matches the same authoritative command,
   * so one dispatch-time fact can flow through both layers.
   *
   * `null` / absent ⇒ no HARD_DENY hit.
   */
  hardDenyProse?: string | null
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
  approvalStateMachine?: ApprovalStateMachinePort
  /**
   * Capability B (multi-agent coordination — leader-mediated escalation). When a
   * WORKER subagent's tool hits a SOFT permission denial (the mode-policy
   * `evaluate()` deny arm), this injected broker escalates the request to the
   * worker's spawning LEADER's authority (its HITL/onConfirm). On approval the
   * gate ADMITS the call (routing through the pre_tool_use hook, parity with
   * every other allow path); on denial the worker stays blocked.
   *
   * SECURITY (load-bearing): this is consulted ONLY on the SOFT mode-policy deny
   * arm, and ONLY after re-verifying `resolvedHardDenyProse(action) === null` — a
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

// Re-exported for `./gates` (snapshotToLayeredRules consumes LayeredRule).
export type { LayeredRule }

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
export const emitGateDecision = (
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

/** Map a `ReviewerTier` to the short preview tag suffix the dispatch seam
 *  surfaces (`reviewer_user` / `reviewer_auto` / `reviewer_guardian`). */
export const reviewerTag = (reviewer: ReviewerTier): string =>
  reviewer === "auto_review"
    ? "reviewer_auto"
    : reviewer === "guardian_subagent"
      ? "reviewer_guardian"
      : "reviewer_user"

export const isSessionApprovalRequiredError = (error: unknown): boolean => {
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
export const withResolvedShellCommand = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
): AdmissibilityAction => {
  const shellCommand = config.registry.extractShellCommand(action.tool, action.input)
  if (shellCommand === null) {
    // Strip any caller-supplied shellCommand / hardDenyProse so fabricated or
    // stale facts can never out-vote the registry's authoritative null (a
    // non-shell tool stays ungated; HARD_DENY only fires on a registry-
    // confirmed command).
    if (action.shellCommand === undefined && action.hardDenyProse === undefined) return action
    const { shellCommand: _droppedShell, hardDenyProse: _droppedHardDeny, ...rest } = action
    return rest
  }
  const resolved = { ...action, shellCommand }
  return { ...resolved, hardDenyProse: hardDenyReason(resolved) }
}

export const resolvedHardDenyProse = (action: AdmissibilityAction): string | null =>
  action.hardDenyProse ?? hardDenyReason(action)

export const resolvedShellCommand = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
): string | null =>
  action.shellCommand ?? config.registry.extractShellCommand(action.tool, action.input)

/**
 * Canonical, key-order-independent JSON serialization of a tool input. Used to
 * derive a STABLE discriminator for the non-shell escalation key (see
 * {@link reviewActionKeyOf}). Object keys are sorted at every depth so two
 * structurally-identical inputs whose keys were emitted in a different order
 * collapse to the SAME string (they are the same action ⇒ coalesce), while any
 * value/target difference yields a DIFFERENT string (a distinct action ⇒
 * re-prompt). Arrays keep positional order (order is semantic there). Cycles /
 * non-serializable values fall back to a fail-closed sentinel so a pathological
 * input can never collapse two DIFFERENT actions onto one key — it just forces
 * a fresh prompt.
 */
const canonicalInputKey = (input: unknown): string => {
  const seen = new WeakSet<object>()
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v
    if (seen.has(v as object)) return "[cycle]"
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(norm)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = norm((v as Record<string, unknown>)[k])
    }
    return out
  }
  try {
    return JSON.stringify(norm(input)) ?? "undefined"
  } catch {
    // Non-serializable (e.g. BigInt) ⇒ fail closed: a sentinel derived from a
    // best-effort string tag. Never returns a constant that could merge two
    // distinct inputs — worst case is over-prompting, never under-prompting.
    return `[nonserializable:${String(input)}]`
  }
}

/**
 * The escalation/dedup key for a reviewer round.
 *
 *   - SHELL tools: `${tool}|${shellCommand}` — the command is the action
 *     identity (unchanged; do NOT weaken this path).
 *   - NON-SHELL mutating tools (edit/write/apply_patch — no extractable shell
 *     command): `${tool}|#${canonicalInputKey(input)}`. Pre-fix this collapsed
 *     to the BARE tool name, so after approving one `write {path:A}` the
 *     run-scoped `allowlistEscalated` Set held `write` and the NEXT
 *     `write {path:B}` (a DIFFERENT action) hit `has('write')` and SKIPPED the
 *     reviewer — a HITL over-approval bypass. Keying on the canonical input
 *     identity makes two different targets produce DIFFERENT keys (each
 *     re-prompts) while two identical actions still coalesce (one prompt).
 *
 * The `#` marker keeps the non-shell namespace disjoint from the shell one so a
 * canonical-input string can never alias a `${tool}|<command>` shell key.
 */
export const reviewActionKeyOf = (
  config: AdmissibilityGateConfig,
  action: AdmissibilityAction,
): string => {
  const shellCommand = resolvedShellCommand(config, action)
  return shellCommand !== null
    ? `${action.tool}|${shellCommand}`
    : `${action.tool}|#${canonicalInputKey(action.input)}`
}

/** Resolve the effective HITL tier for a known-registered tool. The unknown-
 *  tool case is guarded upstream by `dispatchTool`; we mirror the legacy
 *  defensive fallback so this helper still has a defined answer if invoked
 *  with a stale registry. ADR-0047: composes the per-tool classifier with
 *  the agent-side annotation registry (built-in + operator overrides). The
 *  registry can ESCALATE the tier (one-way ratchet) but never relax
 *  `hand-off-required`. */
export const resolveHitlTier = (
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

/** Emit pre_tool_use hook, returning a hook-denied result or null to proceed.
 *  When a handler rewrote the tool args (`updatedInput`, Cursor parity) and the
 *  call was NOT denied, the rewrite is surfaced to dispatch via
 *  `opts.onInputMutation` so the executed input is the mutated one. The gate
 *  itself stays control-flow-pure (it never mutates `call`/`config`); the sink
 *  is the only outbound channel and is a no-op when unwired. */
export const runPreToolUseHook = async (
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
      hookDenyReason("pre_tool_use hook denied"),
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
export const denyFromConfirm = (
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

/** Sanitize the `reason` tag for OTel emission. The agent-internal `reason`
 *  field on the `HandoffRequiredEvent` carries a categorical prefix plus a
 *  variable-shape suffix (e.g. `hard-deny:Blocked dangerous command: rm -rf /`
 *  — the suffix is the human-prose deny message which echoes the offending
 *  command). For the OTel attribute we strip that prose and keep ONLY the
 *  categorical kebab prefix, so a dashboard sees `hard-deny`, `registry:<tool>`,
 *  or `tier:hand-off-required` — never tool input, never user-facing
 *  copy. This is the canonical security invariant for `quanta.hitl.
 *  handoff_emitted`. */
export const slugifyHandoffReason = (reason: string): string => {
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
export const emitHandoffEvent = (
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
export const buildHandoffDeny = (
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
    reviewerApprovalDenyReason("tier: hand-off-required"),
  )
}

/** HARD_DENY-as-handoff terminal deny. Shared between the HITL branch and any
 *  other allow-capable path (tool-profile confirm) that could otherwise admit
 *  a denylisted command. Returns `null` when the action carries no HARD_DENY
 *  hit (the registry-derived `shellCommand` doesn't match the denylist), so
 *  callers `??`-chain it ahead of their approval. Mirrors policy.ts:203 —
 *  HARD_DENY ALWAYS wins, no confirm/approval can route around it. */
export const hardDenyHandoff = (
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
  const hardDenyProse = resolvedHardDenyProse(action)
  if (hardDenyProse === null) return null
  const handoffMessage = `Action requires human handoff: ${hardDenyProse}${HANDOFF_SUFFIX}`
  emitHandoffEvent(config, call, handoffMessage, `hard-deny:${hardDenyProse}`, now)
  return deny(
    call.id,
    handoffMessage,
    "handoff",
    // C6 no-leak: categorical `hardDenySafeReason()`, NOT `hardDenyProse`.
    hardDenyStructuredReason(),
  )
}

/**
 * C6 — build the {@link StructuredDenyReasonInput} for a policy-stack `deny`.
 * The typed decision is the SSOT:
 *   - `decision.hardDeny` decides the categorical `hard-deny` layer.
 *   - `decision.stackSource` decides the stack axis surfaced on the structured
 *     envelope.
 *   - the gate-local `brokerDenied` flag only upgrades the SOFT layer from
 *     `stack` to `broker` after a leader escalation refusal.
 *
 * SECURITY (no-leak): a hard deny switches to the categorical
 * `hardDenySafeReason()` + `layer:"hard-deny"` so the command never reaches the
 * structured field; only the soft deny reuses `decision.reason` (which
 * stitches `action.tool` at most — never tool input). The sandbox pillar is
 * inferred centrally for the per-thread / per-host stack sources so call sites
 * do not re-encode that mapping.
 */
export const policyDenyStructured = (
  decision: PermissionDenyDecision,
  opts: { brokerDenied?: boolean } = {},
): StructuredDenyReasonInput =>
  decision.hardDeny
    ? { layer: "hard-deny", safeReason: hardDenySafeReason() }
    : {
        layer: opts.brokerDenied ? "broker" : "stack",
        safeReason: decision.reason,
        stackSource: decision.stackSource,
        ...(decision.stackSource === "per-thread" || decision.stackSource === "per-host"
          ? ({ pillar: "sandbox" satisfies DenyPillar } as const)
          : {}),
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
export const cascadeOnApprove = (
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
  const shellCommand = resolvedShellCommand(config, action)
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
