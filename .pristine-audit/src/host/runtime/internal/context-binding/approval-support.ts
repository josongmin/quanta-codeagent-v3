import type { AgentOutcome } from "@/agent"
import type { ConfirmDecision } from "@/agent/confirm-decision"
import type { Message } from "@/llm"
import { inferReviewKind, reasonCodeFor, type ToolAction } from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"
import type { ActionDiff } from "@/runner/action-diff"
import type { ToolRegistry } from "@/tool"

export class RuntimeApprovalRequiredError extends Error {
  readonly approval: PendingApprovalView

  constructor(approval: PendingApprovalView) {
    super(`runtime approval required: ${approval.reason}`)
    this.name = "RuntimeApprovalRequiredError"
    this.approval = approval
  }
}

export const isRuntimeApprovalRequiredError = (
  error: unknown,
): error is RuntimeApprovalRequiredError => error instanceof RuntimeApprovalRequiredError

export interface PendingRuntimeApprovalRecord {
  readonly approval: PendingApprovalView
  readonly actionKey: string
  /** False when shell extraction threw at mint time (the stored `actionKey` is
   *  a diagnostics-only sentinel string). A non-grantable record still mints
   *  the single-use lease (which can never match — fail closed, re-prompts)
   *  but must NEVER mint a standing session grant. */
  readonly grantable: boolean
  /** T02 — the proposed action captured at mint time, so an APPROVE (which may
   *  arrive RELAYED from a follower client over the session transport) is
   *  re-checked against HARD_DENY at resolve time. The dispatch gate already
   *  denies HARD_DENY commands BEFORE they reach this prompt (earlyHardDeny), so
   *  this is defense-in-depth: it guarantees NO approve path — local or relayed —
   *  can ever mint a grant for a dangerous command. */
  readonly action: ToolAction
  /** T05 (web/SDK per-hunk apply) — the `(path, before, after)` captured at MINT
   *  time (gate `QUANTA_HUNK_APPROVAL` ON + previewable action with ≥2 hunks).
   *  `before` is the REQUEST-time file baseline, so an out-of-band approve that
   *  arrives after the file drifted is detected as stale by `applyHunkSelection`
   *  (recomputing at resolve would silently lose that drift signal). Absent ⇒
   *  the approve takes the whole-call grant path, byte-identical to pre-T05. */
  readonly actionDiff?: ActionDiff
}

/** T03 (audit L5 H-1/M-3) — an approval grant is an opaque, single-use LEASE
 *  scoped to ONE turn/action instance, not a broad action-kind key held for the
 *  session lifetime. The lease carries the `actionKey` it satisfies so a re-run
 *  of the approved action matches, but it is keyed by the opaque `approvalId`
 *  so two concurrent same-`actionKey` actions can NOT share one grant. */
export interface RuntimeApprovalLease {
  readonly approvalId: string
  readonly actionKey: string
  /** ADR-0512 P3 — the operator's RICH decision, set ONLY when the resolved
   *  approval was a skill-scope escalation (`scopeContext` present). When set,
   *  `claimLease` returns it verbatim so the loop's `decideScopeEscalation`
   *  honours `allow_once` (scope:"once" ⇒ no widen) / `deny_and_steer` (steer).
   *  Absent on a NORMAL approval ⇒ `claimLease` returns bare `true`
   *  (byte-identical to the pre-ADR-0512 grant). */
  readonly decision?: ConfirmDecision
}

/** Sentinel returned by {@link actionKeyOf} when shell extraction throws. A
 *  thrown extraction must FAIL CLOSED (force a prompt) rather than collapse to a
 *  broad tool-name-only key that a stale lease could match (audit L5 H-1). */
export const SHELL_EXTRACT_FAILED = Symbol("shell-extract-failed")

export const actionKeyOf = (
  registry: ToolRegistry,
  action: ToolAction,
): string | typeof SHELL_EXTRACT_FAILED => {
  let shellCommand: string | null
  try {
    shellCommand = registry.extractShellCommand(action.tool, action.input)
  } catch {
    return SHELL_EXTRACT_FAILED
  }
  return shellCommand !== null ? `${action.tool}|${shellCommand}` : action.tool
}

/**
 * Enrich a `ToolAction` with the registry-derived `shellCommand` when the caller
 * did not already supply it — mirroring `admissibility-gate.ts`'s
 * `withResolvedShellCommand` gate-entry step, but at the INLINE-approval seam
 * (`runOnConfirm` → the operator surface). The interactive surface confirm reads
 * `action.shellCommand` to offer the `[p]`/`[P]` program-token PREFIX-grant verbs
 * (runtime-context-compose.ts `buildCliOnConfirm`). The inline-approval-resolver
 * path (ADR-0540) builds the action from the raw tool call and does NOT pass
 * through `runAdmissibilityGate`'s enrichment, so without this the field stayed
 * `undefined` and the prefix verbs silently vanished from the bash confirm.
 *
 * Uses the SAME `registry.extractShellCommand` source `actionKeyOf` keys on, so
 * the offered prefix verb and the minted grant key can never disagree. A caller-
 * supplied `shellCommand` (already resolved upstream) wins/skips. A non-shell
 * tool, an empty/null extraction, or a thrown extraction ⇒ the action is returned
 * UNCHANGED (same reference) — byte-identical for every non-prefix confirm.
 */
export const withResolvedShellCommandForConfirm = (
  registry: ToolRegistry,
  action: ToolAction,
): ToolAction => {
  if (action.shellCommand !== undefined) return action
  let shellCommand: string | null
  try {
    shellCommand = registry.extractShellCommand(action.tool, action.input)
  } catch {
    return action
  }
  if (shellCommand === null || shellCommand.length === 0) return action
  return { ...action, shellCommand }
}

export const reasonOf = (action: ToolAction): PendingApprovalView["reason"] =>
  reasonCodeFor(inferReviewKind(action.tool, action.isReadOnly))

/** ADR-0512 P3 — when a confirm is a skill-scope ESCALATION (`action.scopeContext`
 *  present, set by `decideScopeEscalation`), project it onto the approval's
 *  `scopeContext` so the web/IDE surface renders the rich "outside skill scope"
 *  card (the CLI gets the same data via the `permission_escalation_requested`
 *  stream event). `risk` is derived from the SAME `isReadOnly` predicate the
 *  card and dispatch share (read-only ⇒ "read-only", else "mutating"), so the
 *  card's risk and the dispatch decision can never disagree. A normal confirm
 *  has no `scopeContext` ⇒ this returns `{}` ⇒ the field is omitted ⇒ the minted
 *  approval is byte-identical to every pre-ADR-0512 approval. The model's
 *  `justification` is forwarded only when the escalation carried one. */
export const escalationScopeFields = (
  action: ToolAction,
): Pick<PendingApprovalView, "scopeContext"> => {
  const scope = action.scopeContext
  if (scope === undefined) return {}
  // `justification` is OPTIONAL on the escalation's `scopeContext` (Codex
  // `on-request` rationale, seeded from the model's pre-tool prose). The action
  // carries it only when the escalation set it; forward it through when present
  // so the web/IDE card can render the row.
  const justification = scope.justification
  return {
    scopeContext: {
      tool: action.tool,
      activeSkill: scope.activeSkill,
      reason: scope.reason,
      risk: action.isReadOnly ? "read-only" : "mutating",
      ...(justification !== undefined ? { justification } : {}),
    },
  }
}

/** RFC12-4 — when a confirm is a TEAM-BROKER escalation (`action.teamEscalation`
 *  set by `buildLeaderDecide`), project the asking worker's identity onto the
 *  approval's `actor` so the web/IDE card names WHO is asking (parity with the
 *  CLI card, which reads the SAME `teamEscalation` off the action). A normal
 *  confirm (main agent) has no `teamEscalation` ⇒ this returns `{}` ⇒ the field
 *  is omitted ⇒ the minted approval is byte-identical to every main-agent
 *  approval. `scope` is forwarded only when the escalation carried one. */
export const escalationActorFields = (
  action: ToolAction,
): Pick<PendingApprovalView, "actor"> => {
  const team = action.teamEscalation
  if (team === undefined) return {}
  const scope = team.scope
  return {
    actor: {
      workerId: team.workerId,
      ...(scope !== undefined && scope.length > 0 ? { scope } : {}),
    },
  }
}

export const approvalPlaceholderOutcome = (messages: readonly Message[]): AgentOutcome => ({
  // ALBB-18 — the turn is PAUSED awaiting a HITL approval decision (returned
  // WITH an `approvalRequest`, matching scheduler status `"awaiting_approval"`),
  // NOT terminally user-cancelled. `"awaiting_approval"` lets a consumer reading
  // `outcome.reason` distinguish "paused, resume pending" from `"aborted"`.
  reason: "awaiting_approval",
  turns: 0,
  messages: [...messages],
})
