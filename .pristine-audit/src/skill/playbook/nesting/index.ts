/**
 * Playbook nesting slice barrel (ADR-0258 — bounded recursive call chain).
 *
 * Slice posture: SELF-CONTAINED. This barrel re-exports the closed port,
 * the default executor factory, the pure cycle-detector helper, and the
 * public types. NO re-export from `@/agent`, `@/tool`, `@/permission`, or
 * any other peer slice.
 *
 * Default-OFF wire: nothing here is invoked unless a host calls
 * {@link createDefaultNestedExecutor} and threads the resulting
 * {@link NestedPlaybookExecutor} through a procedure-step dispatcher.
 * A SKILL.md whose procedure does not reference a child playbook is
 * byte-identical to the pre-0258 slice — verified by
 * `tests/unit/skill/playbook/nesting-hellgate.test.ts:HELL-PN-10`.
 */

export { type CycleCheck, checkCycle } from "./cycle-detector"
export { createDefaultNestedExecutor } from "./default-executor"
export type { ChildLookup, NestedPlaybookExecutor } from "./port"
export {
  DEFAULT_MAX_DEPTH,
  type NestError,
  type NestedExecutorOpts,
  type NestedResult,
  type Result,
} from "./types"
