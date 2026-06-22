/**
 * Adaptive-escalation controller skeleton (jun-22 v5 Wave-1). The router CONTRACT
 * (closed-schema decision + fail-closed parser) lives in `decision-schema.ts`;
 * the bounded transition rules in `transitions.ts`. The LLM call and live driver
 * wiring are deferred to Wave 3 (gate on a measured oracle, never on n=1).
 */

export {
  type AdaptiveControllerArgs,
  type AdaptiveExecutorInput,
  type AdaptiveOutcome,
  type AdaptiveRouterInput,
  type AdaptiveRunResult,
  runAdaptiveEscalation,
} from "./controller"
export {
  ADAPTIVE_ACTIONS,
  ADAPTIVE_DECISION_JSON_SCHEMA,
  type AdaptiveAction,
  type AdaptiveDecision,
  type AdaptiveParse,
  EVIDENCE_GAPS,
  type EvidenceGap,
  parseAdaptiveDecision,
} from "./decision-schema"
export {
  ACTION_DESCRIPTIONS,
  buildRouterInstruction,
  buildRouterPrompt,
  EVIDENCE_GAP_DESCRIPTIONS,
  ROUTER_RULES,
} from "./router-prompt"
export {
  type ActionClass,
  type AdaptiveLimits,
  type Admission,
  admitNextStep,
  classifyAction,
  DEFAULT_ADAPTIVE_LIMITS,
  isExpensiveAction,
  isRerouteAction,
  isTerminalAction,
  type StopReason,
  terminalStopReason,
} from "./transitions"
