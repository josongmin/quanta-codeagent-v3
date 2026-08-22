/**
 * Admissibility-gate HITL pipeline — reviewer escalation + always-confirm tier
 * + the `runHitlGate` 4-tier resolver. Extracted from `admissibility-gate.ts`
 * (god-module split). Behavior-preserving; relative imports rebased one
 * directory deeper.
 */
import type { ToolUseBlock } from "@/llm"
import { attrs, QUANTA_ATTRS, recordAttrs, SPAN_NAMES } from "@/observability"
import { isAllowed, isDecisionLegalFor, reviewAction, type ToolActionKeyed } from "@/permission"
import { errMessage } from "@/shared"
import { createApprovalGate } from "../approval-gate-wire"
import {
  type ConfirmDecision,
  isAllowed as isConfirmAllowed,
  normalizeConfirm,
} from "../confirm-decision"
import { reviewerApprovalDenyReason, reviewerDenyReason } from "../deny-reason-wire"
import { deny, HANDOFF_SUFFIX } from "../dispatch-helpers"
import type { DispatchResult } from "../dispatch-types"
import type { AdmissibilityGateConfig } from "../types"
import {
  type AdmissibilityAction,
  type AdmissibilityWaveAOptions,
  buildHandoffDeny,
  cascadeOnApprove,
  denyFromConfirm,
  hardDenyHandoff,
  inferReviewKind,
  isSessionApprovalRequiredError,
  type ReviewContext,
  resolveHitlTier,
  reviewActionKeyOf,
  reviewerTag,
  runPreToolUseHook,
} from "./shared"

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
    reviewerDenyReason("reviewer returned illegal verb"),
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
      reviewerDenyReason(`reviewer outcome: ${decision.outcome}`),
    )
  }
  if (decision.outcome === "user_aborted") {
    return deny(
      call.id,
      `User aborted: ${decision.rationale}${originSuffix}${HANDOFF_SUFFIX}`,
      tag,
      // C6: categorical only — `decision.rationale` (reviewer-authored) never
      // enters the structured field.
      reviewerDenyReason("reviewer outcome: user_aborted"),
    )
  }
  if (decision.outcome === "guardian_denied") {
    return deny(
      call.id,
      `Guardian denied: ${decision.rationale}${originSuffix}`,
      tag,
      reviewerDenyReason("reviewer outcome: guardian_denied"),
    )
  }
  return deny(
    call.id,
    `User declined: ${decision.rationale}${originSuffix}`,
    tag,
    reviewerDenyReason("reviewer outcome: user_declined"),
  )
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

/**
 * Run the reviewer escalation for an action (rule `ask` OR always-confirm tier
 * with a wired port). Builds the `ToolActionKeyed` + `ReviewContext`, invokes
 * `reviewAction`, and maps the 8-state outcome to an admit (null via the hook)
 * or a terminal deny. Allowed outcomes route through `runPreToolUseHook`;
 * `user_aborted` carries the hand-off suffix; other denials phrase the verb by
 * reviewer. Throws from the port propagate (no silent catch).
 */
export const reviewAndDecide = async (
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
      reviewerDenyReason("reviewer escalation requested, no port wired"),
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

/** Run the always-confirm branch — calls `onConfirm`, normalizes the result
 *  (byte-identical for the legacy boolean form), wraps host throws, and returns
 *  the appropriate deny / null result. A structured `deny_and_steer` decision
 *  (ADR-0076 Gap-4) denies AND attaches the steer to the result. Factored out
 *  so the parent gate stays under the cognitive-complexity cap. */
export const runAlwaysConfirmBranch = async (
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
      reviewerApprovalDenyReason("always-confirm tier, no confirm handler wired"),
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
      reviewerApprovalDenyReason("always-confirm tier, confirmation handler failed"),
    )
  }
  if (!isConfirmAllowed(decision)) {
    return denyFromConfirm(
      call,
      decision,
      `User declined: ${call.name} requires explicit confirmation (always-confirm tier).`,
      "declined",
      config,
      reviewerApprovalDenyReason("always-confirm tier, user declined"),
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
export const runHitlGate = async (
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
