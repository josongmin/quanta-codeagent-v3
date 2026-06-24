/**
 * Posture injection seam (jun-22 v5 Wave-1 skeleton). See `knob-module.ts` for
 * the composition primitive and `capability-profiles.ts` for the detachable
 * capability catalog + v5 action map.
 */

export {
  type AdaptiveAction,
  CLEAN_SELECTOR,
  CLOSURE_GROUNDING,
  CLOSURE_REPAIR,
  CLOSURE_SELECT_CLEAN_MODULES,
  COUNTERFACTUAL,
  DEEPER_LOCALIZE_MODULES,
  FULL_EXEC,
  GATED_MODULES,
  LLM_RISK_GATE,
  LOCALIZATION_CORE,
  MULTI_AGENT,
  PATCH_HYGIENE,
  PHASE_MODULES,
  PROOF_CLEAN_EXECFULL_MODULES,
  PROOF_CLEAN_MODULES,
  PROOF_REQUIRED,
  REGRESSION,
  REPAIR_BOUNDED,
  REPRO_DOUBT,
  REPRO_EXEC,
  REPRO_RAILS_MODULES,
  REPRO_VOTE,
  RISK_GATE,
  ROUND0_MINIMAL,
  SELECT_EARLY_ACCEPT,
  SELECT_MODULES,
  SELECT_N,
  SELECT_REPRO_OFF,
  SELECT_REPRO_POSITIVE,
  STEER_OFF,
  THIN_BASE,
  THIN_STRICT_BASE,
  WIDE_CONCURRENCY,
} from "./capability-profiles"
export {
  derivePhasePosture,
  type KnobModule,
  rejectedModuleKnobs,
  unknownModuleKnobs,
  withKnobModules,
} from "./knob-module"
