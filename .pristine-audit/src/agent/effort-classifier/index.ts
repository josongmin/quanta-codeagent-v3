/** Effort-classifier slice barrel (ADR-0417, absorption gap A1). */
export {
  DEFAULT_KEYWORD_RULES,
  detectKeywords,
  EFFORT_INTENSITY,
  maxLevel,
} from "./keyword-detector"
export { createEffortClassifier } from "./store"
export type {
  EffortClassifierOptions,
  EffortClassifierPort,
  EffortLevel,
  EffortRecommendation,
  EscalationSignal,
  KeywordRule,
} from "./types"
