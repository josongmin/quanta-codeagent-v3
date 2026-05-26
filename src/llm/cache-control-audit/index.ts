/**
 * Cache-control thread-stability audit (ADR-0319).
 *
 * Barrel re-export. The slice is plane-clean: nothing here reaches into
 * `@/agent/prompt`, `@/llm/adapters/anthropic`, or
 * `@/observability/prompt-cache`. Future callers (a regression suite,
 * the bench replay recorder) import from this barrel.
 */
export { analyzePrefixStability } from "./analyzer"
export { sha256Hex } from "./hash"
export type {
  CachePrefixSnapshot,
  DriftFinding,
  DriftKind,
  PositionReport,
  StabilityReport,
} from "./types"
