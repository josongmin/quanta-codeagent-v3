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
 *  attention `questionBroker` (RFC-01 A3) is wired, AND the RFC-05 E5 question
 *  posture ADMITS it for this turn's collaboration mode.
 *
 *  RFC-05 E5 — model-SPEC projection: `questionAvailability(config.questionGuard,
 *  resolveCollaborationMode(config))` is the SAME reader/predicate the
 *  pre-dispatch consult (`consultQuestionAvailability`) resolves through, so the
 *  spec and the dispatch admission can never diverge. Default-OFF: no
 *  `questionGuard` bound ⇒ available (byte-identical — the tool is present
 *  whenever a producer is wired, exactly as before E5). */
export const buildUserInputBlock = (config: AgentConfig): Tool | undefined => {
  if (config.userInputPort === undefined && config.questionBroker === undefined) return undefined
  if (!questionAvailability(config.questionGuard, resolveCollaborationMode(config)).available) {
    return undefined
  }
  return requestUserInputTool() as Tool
}
