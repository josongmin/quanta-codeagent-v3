/**
 * ADR-0409 — microcompact slice barrel.
 *
 * Re-exports the port shape + the factory. The slice imports ONLY
 * `@/agent/recovery-reason` (sibling leaf) — no `@/agent/loop`,
 * `@/agent/dispatch`, or `@/agent/compaction.ts`.
 */
export { createMicroCompactor } from "./compactor"
export type {
  MicroCompactInput,
  MicroCompactorOpts,
  MicroCompactPort,
  MicroCompactResult,
} from "./types"
