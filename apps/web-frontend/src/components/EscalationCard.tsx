/**
 * ADR-0512 P3 — web/IDE skill-scope ESCALATION approval card.
 *
 * The headline UX of ADR-0512: when the model calls a tool OUTSIDE the active
 * skill's allowlist, that is NOT a red error — it is an interactive approval.
 * The CLI renders this as a yellow card from the `permission_escalation_
 * requested` STREAM event; the browser does NOT consume that stream, so the
 * daemon enriches the SESSION `approval.requested` event's `PendingApprovalView`
 * with `scopeContext` (tool / risk / reason / model justification). This card
 * renders that scopeContext — matching the CLI card's content + Korean labels
 * (도구 / 위험 / 이유 / 근거) — with the 4 ConfirmDecision verbs.
 *
 * A PLAIN approval (no `scopeContext`) keeps the existing approve/deny
 * affordance: the surface is byte-identical to every pre-ADR-0512 approval.
 */

import { memo } from "react"
import type { ApprovalScopeContext } from "../types/protocol"

/** The minimal approval shape the card consumes — a subset of
 *  `PendingApprovalView` (the `requestedAt` field is irrelevant to rendering). */
export interface EscalationApproval {
  readonly approvalId: string
  readonly reason: string
  /** Present ⇒ the rich escalation card; absent ⇒ the plain approve/deny row. */
  readonly scopeContext?: ApprovalScopeContext
}

/** The session protocol decision verb sent back via `approval.respond`. The 4
 *  escalation OPTIONS collapse onto this 2-verb wire (ADR-0076 `ConfirmDecision`
 *  carries no once-vs-session bit — both approve buttons widen scope; both deny
 *  buttons decline). The `option` is retained so a future protocol extension can
 *  distinguish once-vs-session / steer without re-plumbing the surface. */
export interface EscalationDecision {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
  readonly option: EscalationOption
}

export type EscalationOption = "allow_once" | "allow_session" | "deny" | "deny_and_steer"

interface EscalationButton {
  readonly option: EscalationOption
  readonly label: string
  /** `approve` ⇒ accent button; `deny` ⇒ neutral / subtle button. */
  readonly tone: "approve" | "deny"
}

/** Stable order + labels — 1:1 with `ESCALATION_OPTIONS` in
 *  `src/agent/skill-scope-escalation.ts`. */
const ESCALATION_BUTTONS: readonly EscalationButton[] = [
  { option: "allow_once", label: "Allow once", tone: "approve" },
  { option: "allow_session", label: "Allow session", tone: "approve" },
  { option: "deny", label: "Deny", tone: "deny" },
  { option: "deny_and_steer", label: "Deny + steer", tone: "deny" },
]

/** Pure verb→decision map: the two approve buttons widen scope (`approve`); the
 *  two deny buttons decline (`deny`). Exposed for the unit contract. */
const escalationDecisionFor = (
  option: EscalationOption,
): { decision: "approve" | "deny"; option: EscalationOption } => ({
  decision: option === "allow_once" || option === "allow_session" ? "approve" : "deny",
  option,
})

/** Pure click-builder so the verb→`approval.respond` wiring is testable in a
 *  node env without a DOM. */
const buildDecisionHandler =
  (approvalId: string, onDecision: (d: EscalationDecision) => void) =>
  (option: EscalationOption): void => {
    const { decision } = escalationDecisionFor(option)
    onDecision({ approvalId, decision, option })
  }

export interface EscalationCardProps {
  readonly approval: EscalationApproval
  readonly onDecision: (decision: EscalationDecision) => void
}

const RiskBadge = ({ risk }: { risk: ApprovalScopeContext["risk"] }): JSX.Element => {
  const tone = risk === "mutating" ? "bg-warn/15 text-warn" : "bg-black/[0.05] text-ink-secondary"
  const glyph = risk === "mutating" ? "✎" : "○"
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${tone}`}>
      {glyph} {risk}
    </span>
  )
}

/** The plain approve/deny affordance for a NON-escalation approval. No
 *  skill-scope chrome — keeps the surface byte-identical to pre-ADR-0512. */
const PlainApproval = memo(
  ({ approval, onDecision }: EscalationCardProps): JSX.Element => (
    <section
      className="rounded-xl border border-line bg-surface-raised p-3"
      data-testid="approval-plain"
    >
      <div className="text-xs font-medium text-ink">{approval.reason}</div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() =>
            onDecision({
              approvalId: approval.approvalId,
              decision: "approve",
              option: "allow_once",
            })
          }
          className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg hover:bg-accent-muted"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() =>
            onDecision({ approvalId: approval.approvalId, decision: "deny", option: "deny" })
          }
          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-secondary hover:bg-black/[0.05] hover:text-ink"
        >
          Deny
        </button>
      </div>
    </section>
  ),
)

const EscalationCardImpl = ({ approval, onDecision }: EscalationCardProps): JSX.Element => {
  const scope = approval.scopeContext
  if (scope === undefined) {
    return <PlainApproval approval={approval} onDecision={onDecision} />
  }
  const handle = buildDecisionHandler(approval.approvalId, onDecision)
  return (
    <section
      className="rounded-xl border border-warn/40 bg-warn/5 p-3"
      data-testid="approval-escalation"
      aria-label="skill scope escalation approval"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-warn">승인 필요</h3>
        <span className="text-[11px] text-ink-tertiary">
          스킬 '{scope.activeSkill}' 범위 밖 도구 요청
        </span>
      </header>
      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex items-center gap-2">
          <dt className="w-10 shrink-0 text-ink-tertiary">도구</dt>
          <dd className="flex items-center gap-2">
            <code className="rounded bg-surface-input px-1 py-0.5 font-mono text-ink">
              {scope.tool}
            </code>
            <RiskBadge risk={scope.risk} />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-10 shrink-0 text-ink-tertiary">이유</dt>
          <dd className="break-words text-ink-secondary">{scope.reason}</dd>
        </div>
        {scope.justification !== undefined && scope.justification.length > 0 ? (
          <div className="flex gap-2">
            <dt className="w-10 shrink-0 text-ink-tertiary">근거</dt>
            <dd className="break-words text-ink-secondary">{scope.justification}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {ESCALATION_BUTTONS.map((btn) => (
          <button
            key={btn.option}
            type="button"
            onClick={() => handle(btn.option)}
            className={
              btn.tone === "approve"
                ? "rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg hover:bg-accent-muted"
                : "rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-secondary hover:bg-black/[0.05] hover:text-ink"
            }
          >
            {btn.label}
          </button>
        ))}
      </div>
    </section>
  )
}

/** Memoized export. Test seams (`escalationDecisionFor` / `buildDecisionHandler`)
 *  are hung off the function object so the pure verb→decision contract is
 *  exercisable in a node test without a DOM renderer. */
export const EscalationCard = Object.assign(memo(EscalationCardImpl), {
  escalationDecisionFor,
  buildDecisionHandler,
})
