/**
 * ADR-0281 — `src/memory/auto-trigger/` barrel.
 *
 * Sibling slice to `src/memory/consolidate/` and `src/memory/stage1-store/`.
 * Exposes the closed `MemoryAutoTrigger` port + default lexical-Jaccard
 * scoring adapter + the `TriggerPolicy` / `TriggerError` shapes.
 *
 * No `@/memory` re-export until a future ADR wires a broader caller in
 * `@/agent` — composition root reaches this slice as
 * `src/memory/auto-trigger/index.ts` directly (default-OFF until then).
 */

export { DefaultMemoryAutoTrigger, type DefaultMemoryAutoTriggerOpts } from "./default-trigger"
export type {
  MemoryAutoTrigger,
  PromoteContext,
  SessionEndInput,
  SessionEndOutcome,
  SessionStartInput,
} from "./port"
export {
  DEFAULT_TRIGGER_POLICY,
  TriggerError,
  type TriggerErrorReason,
  type TriggerPolicy,
} from "./types"
export { assembleMemoryAuto, type MemoryAutoSlot } from "./wire"
