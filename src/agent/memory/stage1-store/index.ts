/**
 * ADR-0216 — Stage1Store agent-side slice barrel.
 *
 * Re-exports the closed port + 2 adapters. The barrel is the only allowed
 * import path from `@/agent/memory/stage1-store`.
 *
 * Default-OFF: importing this barrel does NOT open a SQLite handle / mutate
 * any process state. The host wires an adapter at composition time.
 */

export { inMemoryStage1Store } from "./in-memory"
export type {
  Stage1ErrorResult,
  Stage1Record,
  Stage1Result,
  Stage1StorePortV2,
  WriteInput,
} from "./port"

export { sqliteStage1Store } from "./sqlite"
