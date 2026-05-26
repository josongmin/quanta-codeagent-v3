/**
 * ADR-0319 — `src/memory/typed-event/` barrel.
 *
 * Sibling slice to `src/memory/stage1-store/`. Exposes the closed port
 * `TypedHistoryEventStore`, the 5-variant `TypedHistoryEvent` union,
 * and the default in-memory factory.
 *
 * **Not re-exported from `@/memory`** — this slice is default-OFF
 * until ADR-0301 wires a producer in `@/agent`. Callers reach it via
 * the explicit `@/memory/typed-event` path.
 *
 * Closed-port pattern: the `InMemoryTypedHistoryEventStore` class is
 * intentionally NOT exported — only the `createInMemory...` factory
 * and the port type. Alternate adapters live in sibling files.
 */

export { createInMemoryTypedHistoryEventStore } from "./in-memory-store"
export type { TypedHistoryEventStore } from "./port"
export type {
  ContextUpdateEvent,
  ContextUpdateField,
  ModeChangeEvent,
  ReasoningEchoEvent,
  RepoRulesChangeEvent,
  SkillActivationEvent,
  SkillActivationTrigger,
  TypedHistoryEvent,
  TypedHistoryEventKind,
} from "./types"
