/**
 * SearchPipeline port surface (ADR-0265).
 *
 * Separate file so callers that only want the contract (not the union of
 * concrete `Stage` shapes) can `import type { SearchPipeline } from
 * "@/retrieval/pipeline/port"` without pulling the rest. Both `port.ts` and
 * `types.ts` are public — pipelines themselves are leaf primitives.
 */

export type { SearchPipeline } from "./types"
