/**
 * Evidence layer (jul-5, SOTA++ P1) barrel — typed observation → evidence substrate.
 * Pure data + logic slice (no `@/llm`/`@/tool`); the ingest wiring at the edge maps
 * parsed tool output into this layer. DEFAULT-OFF: no consumer until an entry point
 * opts in behind a knob, so the raw-append path stays byte-identical.
 */

export { ingestRawObservation, ingestTestFrames, type ParsedTestFrame } from "./ingest"
export { createEvidenceLedger } from "./ledger"
export { renderEvidenceDigest } from "./reducer"
export type {
  EvidenceCard,
  EvidenceCardInput,
  EvidenceConfidence,
  EvidenceLedger,
  EvidenceLedgerSnapshot,
  EvidenceLocation,
  EvidenceSource,
} from "./types"
