/**
 * Tier 3 — trajectory entry. Public surface: classify (label real sessions),
 * replay (re-execute a frozen fixture and diff streams), freeze (promote a
 * real session into the fixtures dir). All three honour the meta-sidecar
 * contract (no heuristic prompt inference).
 */
export {
  type ClassifyTrajectoryOpts,
  type ClassifyTrajectorySummary,
  classifyTrajectories,
} from "./classifier"
export { type DiffSummary, diffStreams, projectStream } from "./diff"
export { type FreezeOpts, type FreezeResult, freezeFixture } from "./freeze"
export { EVAL_META_SCHEMA, type EvalMeta, metaPathFor, readMeta, writeMeta } from "./meta"
export {
  exportRedactedCassette,
  type RedactedExportReceipt,
  type RedactedExportResult,
} from "./redacted-export"
export { type ReplayOpts, type ReplayResult, replayFixture } from "./replay"
export { listSessions, loadSession, producersOf, type SessionView } from "./source"
