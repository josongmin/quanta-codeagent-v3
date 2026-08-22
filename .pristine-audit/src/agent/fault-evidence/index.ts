/**
 * T-201 — FaultEvidencePacket public barrel. Re-exports the builder + types so
 * callers import `@/agent/fault-evidence` (consistent with sibling artifact
 * modules: verification-plan, primary-rail) without reaching into `./build`.
 */
export { buildFaultEvidencePacket } from "./build"
export type { FaultCandidate, FaultEvidenceInput, FaultEvidencePacket } from "./types"
