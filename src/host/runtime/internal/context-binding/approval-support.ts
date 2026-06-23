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

export const approvalPlaceholderOutcome = (messages: readonly Message[]): AgentOutcome => ({
  reason: "aborted",
  turns: 0,
  messages: [...messages],
})
