/**
 * Tier-1 per-subsystem builder: USER-INPUT tool block (ADR-0095 draft,
 * ADR-0086 sister).
 *
 * Registers `request_user_input` ONLY when a `userInputPort` is wired. The
 * dispatch seam builds `ctx.requestUserInput` from the port; absent ⇒ tool
 * NOT in registry.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: neither `config.userInputPort` NOR `config.questionBroker` wired
 * ⇒ this builder returns `undefined` (byte-identical, RFC §1.2).
 *
 * RFC-01 A3: the attention `questionBroker` is an ALTERNATE producer for the
 * SAME tool — when it is wired (gate ON) the dispatch seam routes
 * `request_user_input` through the broker (`resolveRequestUserInput`), so the
 * tool must be REGISTERED for a broker-only config too (a spawned child inherits
 * the broker, not the legacy port). Absent both ⇒ still unregistered (OFF
 * byte-identical).
 */

import { requestUserInputTool, type Tool } from "@/tool"
import { questionAvailability } from "../dispatch-guard"
import { resolveCollaborationMode } from "../mode"
import type { AgentConfig } from "../types"

/** Build the user-input tool when EITHER the legacy `userInputPort` OR the
 *  attention `questionBroker` (RFC-01 A3) is wired. Registration no longer
 *  depends on the question posture — the tool is ALWAYS on the registry when a
 *  producer is wired, and the LIVE posture drives its model-SPEC visibility
 *  per request via the tool's `getSpec` arm (RFC-05 E5b).
 *
 *  RFC-05 E5b — model-SPEC projection is now PER REQUEST, not frozen at build.
 *  Before E5b this builder ran ONCE at session build and returned `undefined`
 *  when the posture denied — freezing the model's spec at that instant. Two
 *  failure modes followed: (a) FALSE-INVISIBLE — a session that STARTED in a
 *  denying posture hid the tool PERMANENTLY, even on a later plan-mode turn the
 *  live posture would admit; (b) false-visible — a spec built while admitting
 *  stayed visible after a later deny. E5b closes both by giving the tool a
 *  `getSpec` arm that consults the SAME `questionAvailability(config.questionGuard,
 *  resolveCollaborationMode(config))` predicate the pre-dispatch consult
 *  (`consultQuestionAvailability`) resolves through — evaluated by
 *  `ToolRegistry.specs()` on EVERY model request, so spec-visibility and
 *  dispatch-admission can never diverge.
 *
 *  Default-OFF: no `questionGuard` bound ⇒ NO `getSpec` arm is threaded, so the
 *  tool is a plain static tool whose spec bytes + prompt-cache are byte-identical
 *  to the pre-E5 surface — present whenever a producer is wired, exactly as
 *  before. The dispatch consult stays the enforcement backstop unchanged. */
export const buildUserInputBlock = (config: AgentConfig): Tool | undefined => {
  if (config.userInputPort === undefined && config.questionBroker === undefined) return undefined
  const guard = config.questionGuard
  // Default-OFF byte-identity: no guard ⇒ plain static tool (no dynamic arm).
  if (guard === undefined) return requestUserInputTool() as Tool
  // Guard wired ⇒ thread the LIVE availability predicate into the tool's
  // `getSpec`; both `guard.askOutsidePlan()` and `resolveCollaborationMode(config)`
  // are re-read on each `getSpec()` call, so the answer tracks the current posture.
  return requestUserInputTool({
    available: () => questionAvailability(guard, resolveCollaborationMode(config)).available,
  }) as Tool
}
