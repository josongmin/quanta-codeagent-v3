/**
 * Budget slice barrel (RFC may-22-unified-agent-runtime / Phase 1).
 *
 * `@/agent/budget` is a pure state-machine slice; the meter has NO I/O,
 * NO clock side-effects, and depends only on `@/shared` (none today). See
 * `./types.ts`, `./meter.ts`, `./events.ts`.
 */
export { asDials, isBudgetEvent, makeClampEvent, } from "./events";
export { BudgetMeter } from "./meter";
