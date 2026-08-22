/**
 * ADR-0395 — Run Ledger slice barrel.
 *
 * The ONLY allowed import path from `@/agent/run-ledger`. Re-exports the closed
 * port, the state model types, and the in-memory store factory.
 *
 * Default-OFF & self-contained: importing this barrel does NOT touch process
 * state and pulls in zero peer slices. This wave is MODEL-ONLY — wave 2 adapts
 * bash/subagent/mcp to report INTO the ledger; nothing here calls into them.
 */

export { createRunLedger } from "./store"
export type {
  RunArtifact,
  RunEntry,
  RunKind,
  RunLedgerPort,
  RunLedgerSnapshot,
  RunStatus,
  WaitingOn,
} from "./types"
