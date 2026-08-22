/**
 * Plan-writeback slice barrel (ADR-0259 — bidirectional skill ↔ plan sync).
 *
 * Slice posture: SELF-CONTAINED. This barrel re-exports the closed port,
 * the data shapes, and the default Map-backed adapter. It does NOT re-export
 * anything from `@/agent`, `@/tool`, or `@/permission`, and the file itself
 * imports nothing outside `./` — fully leaf.
 *
 * Default-OFF wire: nothing here is invoked unless a host calls
 * `createDefaultWriteback`. A SKILL.md whose host never wires plan-writeback
 * is byte-identical to the pre-0259 playbook path — verified by
 * `tests/unit/skill/playbook/plan-writeback-hellgate.test.ts:HELL-PW-08`.
 *
 * Consumption order for the host:
 *   1. `const wb = createDefaultWriteback({ planId, knownPlanIds })`
 *   2. Pass `wb` into the skill execution context.
 *   3. Skill calls `wb.recordFinding(skillId, { kind, text, severity })`
 *      on each discovery / blocker / opportunity it surfaces.
 *   4. Plan re-renderer reads `wb.getUpdates(planId)`, integrates the
 *      deltas into the next plan render, then `wb.clearUpdates(planId)`.
 */

export { createDefaultWriteback, type DefaultWritebackSpec } from "./default-writeback"
export type { PlanWriteback } from "./port"
export type { Finding, PlanUpdate, Result, WritebackError } from "./types"
