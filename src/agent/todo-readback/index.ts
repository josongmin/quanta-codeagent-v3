/**
 * Cross-subagent todo readback slice barrel (ADR-0255).
 *
 * Roo absorption — bidirectional extension of ADR-0219 focus chain.
 * Closed surface for parent ↔ child todo state with explicit
 * propagation. Default-OFF: the loop never constructs a store;
 * callers (apps / tier1 builders) opt in by wiring through
 * AgentConfig. Voice match: ADR-0219 — types + factory the host
 * composes.
 */

export {
  type DefaultStoreOpts,
  defaultTodoReadbackStore,
} from "./default-store"
export type {
  SnapshotCallback,
  SubscribeOpts,
  Subscription,
  TodoReadback,
  TodoUpdate,
} from "./port"
export type {
  TodoItem,
  TodoSnapshot,
  TodoStatus,
  UpdateError,
} from "./types"
