/** Keystone — Evidence Packet Builder. Default-OFF (QUANTA_EVIDENCE); fuses
 *  run_tests (failure) + LSP (static) + DAP (runtime) + git (repo) into ONE
 *  unified packet for the LLM. */
export { type BuildEvidenceOptions, buildEvidence, type EvidenceSources } from "./builder"
export { defaultRuntimePort } from "./runtime"
export { collectEvidenceTool, type EvidenceToolDeps, makeCollectEvidenceTool } from "./tool"
export type {
  EvidenceDiagnostic,
  EvidenceLocation,
  EvidencePacket,
  FailureEvidence,
  PatchConstraints,
  RuntimeEvidence,
  RuntimeFrame,
  RuntimeVar,
  StaticEvidence,
} from "./types"
