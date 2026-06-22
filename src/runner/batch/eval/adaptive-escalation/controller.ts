/**
 * Adaptive-escalation controller orchestrator (jun-22 v5 Wave-1 skeleton, group
 * D — the spine that ties the pieces together).
 *
 * Composes the three Wave-1 skeletons into one BOUNDED run loop:
 *   route (LLM port) → parse fail-closed (decision-schema) → admit (transitions)
 *   → map action to posture modules (PHASE_MODULES) → execute (driver port) →
 *   re-route or finalize.
 *
 * Both side-effecting steps are INJECTED PORTS so the loop is hermetically
 * testable with fakes and free of any LLM / driver / hot-file dependency:
 *   - `router`   — Wave 3 wires the real LLM StructuredOutput call.
 *   - `executor` — Wave 3 wires the real per-phase driver run (using
 *                  `derivePhasePosture(base, modules)` to materialize the posture).
 * The orchestration itself (fail-closed gating, bounded transitions, typed stop
 * classification, action→module mapping) is deterministic and proven here.
 *
 * Generic over the packet type `P` so the controller never couples to the real
 * evidence-packet shape (deferred to Wave 3 / the blocked packet SSOT): it only
 * needs each packet's citable evidence ids, supplied by `citableIds`.
 */

import { PHASE_MODULES } from "../posture"
import {
  type AdaptiveAction,
  type AdaptiveDecision,
  parseAdaptiveDecision,
} from "./decision-schema"
import {
  type AdaptiveLimits,
  admitNextStep,
  classifyAction,
  DEFAULT_ADAPTIVE_LIMITS,
  isTerminalAction,
  type StopReason,
  terminalStopReason,
} from "./transitions"

/** What the loop produced. `escalate_needs_human` is the FAIL-CLOSED outcome for
 *  any invalid/unparseable router output — it never coincides with a submit. */
export type AdaptiveOutcome = "finalize" | "stop" | "escalate_needs_human"

export interface AdaptiveRunResult {
  readonly outcome: AdaptiveOutcome
  /** Typed stop reason (transitions.StopReason) or a parser rejection reason. */
  readonly reason?: StopReason | string
  /** Actions actually EXECUTED, in order (terminal/denied steps are not here). */
  readonly steps: readonly AdaptiveAction[]
  /** The decision that ended the loop (terminal or finalize_after), if any. */
  readonly finalDecision?: AdaptiveDecision
}

export interface AdaptiveRouterInput<P> {
  readonly packet: P
  readonly citableIds: ReadonlySet<string>
}

export interface AdaptiveExecutorInput<P> {
  readonly action: AdaptiveAction
  readonly modules: (typeof PHASE_MODULES)[AdaptiveAction]
  readonly packet: P
}

export interface AdaptiveControllerArgs<P> {
  readonly initialPacket: P
  /** Extract the citable evidence ids the router may reference for a packet. */
  readonly citableIds: (packet: P) => ReadonlySet<string>
  /** LLM route port — returns RAW model output (validated by the loop). */
  readonly router: (input: AdaptiveRouterInput<P>) => Promise<unknown>
  /** Phase-execution port — runs the mapped posture and returns a FRESH packet. */
  readonly executor: (input: AdaptiveExecutorInput<P>) => Promise<{ readonly packet: P }>
  readonly limits?: AdaptiveLimits
}

/**
 * Drive the bounded adaptive loop. Terminates on: a terminal action
 * (`accept_thin` → finalize, `stop_infra_or_budget` → stop), a `finalize_after`
 * action (after one execution), a budget denial (typed stop), or an invalid
 * router output (escalate-needs-human). The total-steps ceiling guarantees
 * termination even if the router keeps re-routing.
 */
export const runAdaptiveEscalation = async <P>(
  args: AdaptiveControllerArgs<P>,
): Promise<AdaptiveRunResult> => {
  const limits = args.limits ?? DEFAULT_ADAPTIVE_LIMITS
  const steps: AdaptiveAction[] = []
  let packet = args.initialPacket

  while (true) {
    // Pre-route ceiling: never spend another router call past the step budget.
    if (steps.length >= limits.maxTotalSteps)
      return { outcome: "stop", reason: "max_steps_exhausted", steps }

    const citableIds = args.citableIds(packet)
    const raw = await args.router({ packet, citableIds })
    const parsed = parseAdaptiveDecision(raw, citableIds)
    // FAIL-CLOSED: invalid output never submits — escalate for a human/typed stop.
    if (!parsed.ok) return { outcome: "escalate_needs_human", reason: parsed.reason, steps }

    const { action } = parsed.decision
    if (isTerminalAction(action)) {
      const reason = terminalStopReason(action)
      return {
        outcome: action === "accept_thin" ? "finalize" : "stop",
        ...(reason !== undefined ? { reason } : {}),
        steps,
        finalDecision: parsed.decision,
      }
    }

    const admission = admitNextStep(steps, action, limits)
    if (!admission.admit) return { outcome: "stop", reason: admission.stopReason, steps }

    const { packet: nextPacket } = await args.executor({
      action,
      modules: PHASE_MODULES[action],
      packet,
    })
    steps.push(action)

    if (classifyAction(action) === "finalize_after")
      return { outcome: "finalize", steps, finalDecision: parsed.decision }

    // reroute: rebuild evidence and route again (bounded by the caps above).
    packet = nextPacket
  }
}
