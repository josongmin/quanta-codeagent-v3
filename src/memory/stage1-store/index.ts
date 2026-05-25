/**
 * ADR-0207 — `src/memory/stage1-store/` barrel.
 *
 * Sibling slice to `src/memory/consolidate/`. Exposes the closed
 * port `Stage1OutputsStore`, two default-impl adapters, and the
 * `Stage1Entry` shape. No `@/memory` re-export until a future ADR
 * wires a caller in `@/agent` (default-OFF until then).
 */

export { InMemoryStage1Store, type InMemoryStage1StoreOpts } from "./in-memory"
export { JsonlFileStage1Store, type JsonlFileStage1StoreOpts } from "./jsonl-file"
export type {
  Stage1ListFilter,
  Stage1OutputsStore,
  Stage1PruneOpts,
} from "./port"
export type { Stage1Entry } from "./types"
