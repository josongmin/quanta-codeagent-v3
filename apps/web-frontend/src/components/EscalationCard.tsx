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

import { memo, useRef, useState } from "react"
import type { ApprovalActor, ApprovalScopeContext } from "../types/protocol"

/** The minimal approval shape the card consumes — a subset of
 *  `PendingApprovalView` (the `requestedAt` field is irrelevant to rendering). */
export interface EscalationApproval {
  readonly approvalId: string
  readonly reason: string
  /** Present ⇒ the rich escalation card; absent ⇒ the plain approve/deny row. */
  readonly scopeContext?: ApprovalScopeContext
  /** RFC12-4 — present ⇒ a TEAM-BROKER (subagent) escalation; the card names the
   *  asking worker (parity with the CLI's `Subagent '<workerId>' asks …`).
   *  Absent ⇒ a main-agent approval ⇒ NO actor label (byte-identical). */
  readonly actor?: ApprovalActor
}

/** The session protocol decision sent back via `approval.respond`. ADR-0512 P3
 *  (jun-9) — the 4 escalation OPTIONS are now GENUINELY distinct on the wire:
 *  `decision` is the approve/deny verb, `scope` carries once-vs-session for an
 *  approve (`allow_once` ⇒ "once", no widen), and `steer` carries the corrective
 *  message for `deny_and_steer`. The host lease honours all three. */
export interface EscalationDecision {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
  readonly option: EscalationOption
  /** once-vs-session for an approve (allow_once ⇒ "once"). Absent on a deny. */
  readonly scope?: "once" | "session"
  /** corrective steer for deny_and_steer. Absent otherwise. */
  readonly steer?: string
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

/** Pure verb→decision map (ADR-0512 P3): the two approve buttons map to
 *  `approve` carrying `scope` (allow_once ⇒ "once" / allow_session ⇒ "session");
 *  the two deny buttons map to `deny`, and `deny_and_steer` carries the operator's
 *  `steer` text. Exposed for the unit contract. */
const escalationDecisionFor = (
  option: EscalationOption,
  steer?: string,
): { decision: "approve" | "deny"; option: EscalationOption; scope?: "once" | "session"; steer?: string } => {
  if (option === "allow_once") return { decision: "approve", option, scope: "once" }
  if (option === "allow_session") return { decision: "approve", option, scope: "session" }
  if (option === "deny_and_steer" && steer !== undefined && steer.trim().length > 0) {
    return { decision: "deny", option, steer: steer.trim() }
  }
  return { decision: "deny", option }
}

/** UUX-2-18 — the inline validation shown when "Deny + steer" is clicked with
 *  an empty steer box. Plain "Deny" stays the no-text escape hatch. */
const STEER_REQUIRED_MESSAGE = "steer text required (or choose Deny)"

/** UUX-2-18 — what ONE escalation-button click resolves to. The old shape let
 *  an empty-steer `deny_and_steer` silently degrade to a plain deny; here that
 *  case is a distinct `steer-required` arm the UI must surface (keep the user
 *  in the steer input), so the silent degrade is unrepresentable. */
export type EscalationClickResult =
  | { readonly kind: "dispatch"; readonly decision: EscalationDecision }
  | { readonly kind: "steer-required"; readonly message: string }

/** Pure click-resolution (exposed for the node-env unit contract). */
const resolveEscalationClick = (
  approvalId: string,
  option: EscalationOption,
  steer?: string,
): EscalationClickResult => {
  if (option === "deny_and_steer" && (steer === undefined || steer.trim().length === 0)) {
    return { kind: "steer-required", message: STEER_REQUIRED_MESSAGE }
  }
  return { kind: "dispatch", decision: { approvalId, ...escalationDecisionFor(option, steer) } }
}

/** Pure click-builder so the verb→`approval.respond` wiring is testable in a
 *  node env without a DOM. `onSteerRequired` is the UUX-2-18 arm: invoked (and
 *  `onDecision` NOT invoked) when `deny_and_steer` arrives with no steer text. */
const buildDecisionHandler =
  (
    approvalId: string,
    onDecision: (d: EscalationDecision) => void,
    onSteerRequired?: (message: string) => void,
  ) =>
  (option: EscalationOption, steer?: string): void => {
    const result = resolveEscalationClick(approvalId, option, steer)
    if (result.kind === "steer-required") {
      onSteerRequired?.(result.message)
      return
    }
    onDecision(result.decision)
  }

export interface EscalationCardProps {
  readonly approval: EscalationApproval
  readonly onDecision: (decision: EscalationDecision) => void
  /** SSR test seam (mirrors ThreadPicker's `initialSnapshot`): static markup
   *  cannot fire click handlers, so tests pin the steer-required rendering by
   *  seeding the error state. Production callers omit it. */
  readonly initialSteerError?: string
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

/** RFC12-4 — the "which subagent is asking" attribution, shown on BOTH the plain
 *  and rich cards when the approval was raised by a TEAM-BROKER worker (parity
 *  with the CLI's `Subagent '<workerId>' asks to run …`). Absent `actor` ⇒ this
 *  renders nothing ⇒ the card is byte-identical to a main-agent approval. The
 *  workerId comes straight off `approval.actor` (the daemon-projected
 *  `teamEscalation.workerId`), never hardcoded. */
const ActorBadge = ({ actor }: { actor: ApprovalActor | undefined }): JSX.Element | null => {
  if (actor === undefined) return null
  return (
    <div
      data-testid="approval-actor"
      className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-secondary"
    >
      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium tracking-wide text-accent">
        subagent
      </span>
      <span>
        <code className="font-mono text-ink">{actor.workerId}</code>
        {actor.scope !== undefined && actor.scope.length > 0 ? (
          <span className="text-ink-tertiary">
            {" "}
            asks to {actor.scope}
          </span>
        ) : (
          <span className="text-ink-tertiary"> is asking</span>
        )}
      </span>
    </div>
  )
}

/** The plain approve/deny affordance for a NON-escalation approval. No
 *  skill-scope chrome — keeps the surface byte-identical to pre-ADR-0512 (RFC12-4
 *  actor badge renders only when a subagent raised the ask). */
const PlainApproval = memo(
  ({ approval, onDecision }: EscalationCardProps): JSX.Element => (
    <section
      className="rounded-xl border border-line bg-surface-raised p-3"
      data-testid="approval-plain"
    >
      <div className="text-xs font-medium text-ink">{approval.reason}</div>
      <ActorBadge actor={approval.actor} />
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

const EscalationCardImpl = ({
  approval,
  onDecision,
  initialSteerError,
}: EscalationCardProps): JSX.Element => {
  const [steer, setSteer] = useState("")
  // UUX-2-18 — inline steer validation. Set when "Deny + steer" is clicked
  // with an empty box (the click does NOT dispatch); cleared on typing.
  const [steerError, setSteerError] = useState<string | null>(initialSteerError ?? null)
  const steerRef = useRef<HTMLTextAreaElement | null>(null)
  const scope = approval.scopeContext
  if (scope === undefined) {
    return <PlainApproval approval={approval} onDecision={onDecision} />
  }
  const handle = buildDecisionHandler(
    approval.approvalId,
    (decision) => {
      setSteerError(null)
      onDecision(decision)
    },
    (message) => {
      // Keep the user IN the steer flow: show the inline requirement and put
      // the caret back in the box instead of silently sending a plain deny.
      setSteerError(message)
      steerRef.current?.focus()
    },
  )
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
      <ActorBadge actor={approval.actor} />
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
      {/* ADR-0512 P3 — the steer box: filled before a `deny_and_steer` so the
          corrective message reaches the model (the "Deny + steer" button reads
          it). UUX-2-18: empty + "Deny + steer" ⇒ inline validation, NOT a
          silent plain deny (plain "Deny" is the no-text path). */}
      <textarea
        ref={steerRef}
        value={steer}
        onChange={(e) => {
          setSteer(e.target.value)
          setSteerError(null)
        }}
        placeholder="(선택) 대신 무엇을 하라고 안내할지 — Deny + steer 용"
        rows={2}
        aria-label="steer message"
        aria-invalid={steerError !== null ? true : undefined}
        {...(steerError !== null
          ? // approval-scoped id — several approval cards can be on screen.
            { "aria-describedby": `escalation-steer-error-${approval.approvalId}` }
          : {})}
        className="mt-2.5 w-full resize-none rounded-lg border border-line bg-surface-input px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-faint focus-visible:border-accent/50 focus-visible:outline-none"
      />
      {steerError !== null ? (
        <p
          id={`escalation-steer-error-${approval.approvalId}`}
          role="alert"
          className="mt-1 text-[11px] font-medium text-warn"
        >
          {steerError}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {ESCALATION_BUTTONS.map((btn) => (
          <button
            key={btn.option}
            type="button"
            onClick={() => handle(btn.option, btn.option === "deny_and_steer" ? steer : undefined)}
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

/** Memoized export. Test seams (`escalationDecisionFor` / `buildDecisionHandler`
 *  / `resolveEscalationClick`) are hung off the function object so the pure
 *  verb→decision contract (incl. the UUX-2-18 steer-required arm) is
 *  exercisable in a node test without a DOM renderer. */
export const EscalationCard = Object.assign(memo(EscalationCardImpl), {
  escalationDecisionFor,
  buildDecisionHandler,
  resolveEscalationClick,
})
