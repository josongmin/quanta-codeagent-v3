/**
 * Posture injection seam (jun-22 v5 Wave-1 skeleton). See `knob-module.ts` for
 * the composition primitive and `capability-profiles.ts` for the detachable
 * capability catalog + v5 action map.
 */

export {
  type AdaptiveAction,
  CLEAN_SELECTOR,
  CLOSURE_GROUNDING,
  CLOSURE_SELECT_CLEAN_MODULES,
  DEEPER_LOCALIZE_MODULES,
  FULL_EXEC,
  GATED_MODULES,
  PHASE_MODULES,
  PROOF_CLEAN_MODULES,
  PROOF_REQUIRED,
  REPAIR_BOUNDED,
  REPRO_EXEC,
  REPRO_RAILS_MODULES,
  RISK_GATE,
  SELECT_EARLY_ACCEPT,
  SELECT_MODULES,
  SELECT_N,
  SELECT_REPRO_OFF,
  SELECT_REPRO_POSITIVE,
  WIDE_CONCURRENCY,
} from "./capability-profiles"
export {
  derivePhasePosture,
  type KnobModule,
  rejectedModuleKnobs,
  unknownModuleKnobs,
  withKnobModules,
} from "./knob-module"
