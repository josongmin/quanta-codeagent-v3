/**
 * Localization typed pass (jul-5, SOTA++ P5) barrel — Symptom→Candidate→Exclusion→PatchTarget
 * typed state. Pure slice (no @/llm/@/tool); consumes P1 EvidenceCard ids via evidenceRefs.
 * DEFAULT-OFF / inert until wired (see docs/plans/jul-5-sota-runtime-kernel).
 */
export type {
  Candidate,
  CandidateInput,
  CandidateKind,
  Exclusion,
  LocalizationPass,
  PatchTarget,
} from "./types"
export { createLocalizationTracker, type LocalizationTracker } from "./pass"
