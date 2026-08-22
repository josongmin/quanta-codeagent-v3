/**
 * ADR-0320 — `src/memory/typed-event/` barrel.
 *
 * Sibling slice to `src/memory/stage1-store/`. Exposes the closed port
 * `TypedHistoryEventStore`, the 8-variant `TypedHistoryEvent` union
 * (5 variants from ADR-0320 + `compaction_event` added by ADR-0324 +
 * `plugin_activation` / `app_activation` added by ADR-0335), and the
 * default in-memory factory.
 *
 * **Not re-exported from `@/memory`** — this slice is default-OFF
 * until ADR-0321 wires a producer in `@/agent`. Callers reach it via
 * the explicit `@/memory/typed-event` path.
 *
 * Closed-port pattern: the `InMemoryTypedHistoryEventStore` class is
 * intentionally NOT exported — only the `createInMemory...` factory
 * and the port type. Alternate adapters live in sibling files.
 */

export { createInMemoryTypedHistoryEventStore } from "./in-memory-store"
export type { TypedHistoryEventStore } from "./port"
export type {
  AppActivationEvent,
  AppActivationSurface,
  AppActivationTrigger,
  CompactionEventReason,
  CompactionEventTrigger,
  CompactionEventVariant,
  ContextUpdateEvent,
  ContextUpdateField,
  ModeChangeEvent,
  PluginActivationEvent,
  PluginActivationTrigger,
  PluginCapability,
  ReasoningEchoEvent,
  RepoRulesChangeEvent,
  SkillActivationEvent,
  SkillActivationTrigger,
  TypedHistoryEvent,
  TypedHistoryEventKind,
} from "./types"
