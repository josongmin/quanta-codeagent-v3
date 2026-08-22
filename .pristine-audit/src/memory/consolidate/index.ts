/**
 * ADR-0068 — public barrel for the 2-Phase memory consolidator.
 *
 * Wave A scope: types (SSOT) + schema (idempotent migration) + store
 * (SQLite adapter) + runPhase1 (per-thread distill orchestrator) +
 * constants (caps/thresholds/OTel keys). Wave B (Phase 2 consolidator),
 * Wave C (writer), and Wave D (session-end wiring) ride this barrel.
 */
export * from "./constants"
export {
  type PreferenceSignal,
  parsePreferenceSignal,
} from "./grammar"
// ADR-0131 — preference phrase grammar + memory frontmatter lint + Phase 2
// promotion gate. All Wave-W1 additions are default-OFF (call-site opt-in).
export { type LintIssue, type LintReport, lintMemoryFrontmatter } from "./lint"
export { runPhase1 } from "./phase1"
export { runPhase2 } from "./phase2"
export { LlmPhase2Port } from "./phase2-llm"
export {
  type SelectForPhase2PromotionOpts,
  selectForPhase2Promotion,
} from "./phase2-promotion"
export { ensureConsolidateSchema } from "./schema"
export { Stage1Store } from "./store"
export type {
  MemoryDirPaths,
  MemoryOutcome,
  Phase1Input,
  Phase1Outcome,
  Phase1Port,
  Phase2Input,
  Phase2Outcome,
  Phase2Port,
  Phase2Summarizer,
  Stage1Output,
  Stage1StorePort,
  WatermarkState,
} from "./types"
export {
  isMemoryOutcome,
  MEMORY_OUTCOMES,
  MemoryWriteError,
  Phase1DistillError,
  Phase2ConsolidateError,
  RolloutTaintedError,
  WatermarkConflictError,
} from "./types"
export type {
  MemoryWriteContent,
  MemoryWriteResult,
  MemoryWriterOptions,
  NodeFsLike,
} from "./writer"
export { MemoryWriter } from "./writer"
