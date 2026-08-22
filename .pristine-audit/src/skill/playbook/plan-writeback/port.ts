/**
 * Plan-writeback port (ADR-0259).
 *
 * Single closed port — three small methods so a running skill can record a
 * typed finding against the active plan WITHOUT mutating the plan object
 * itself. The host drains the side-queue on its own re-render boundary.
 *
 * The port returns a typed Result rather than throwing on operational failure;
 * the only failure modes (`plan-not-found` / `empty-text` / `skill-id-empty`)
 * are author-visible programming or wiring errors, not exceptions.
 *
 * Slice posture: leaf port. Types-only import (`./types`). No adapter, no
 * runtime, no `@/agent`, no `@/tool`, no `@/permission`. Default-OFF: the
 * loop never constructs a PlanWriteback; callers wire one explicitly.
 */

import type { Finding, PlanUpdate, Result, WritebackError } from "./types"

/**
 * The plan-writeback port. Implementations bind to ONE active planId at
 * construction (`createDefaultWriteback({ planId })`) and reject record calls
 * whose `planId` argument differs.
 */
export interface PlanWriteback {
  /**
   * Record a typed finding against the active plan.
   *
   * @param skillId  Identifier of the skill emitting the finding. Non-empty
   *                 (whitespace-only rejected as `skill-id-empty`).
   * @param finding  Typed payload — kind + non-empty text + severity.
   * @returns Frozen `PlanUpdate` envelope on success, or a typed
   *          `WritebackError` on operational failure. NEVER throws.
   */
  readonly recordFinding: (skillId: string, finding: Finding) => Result<PlanUpdate, WritebackError>

  /**
   * Read all updates recorded so far against the given planId. Returns an
   * `Object.freeze`-d array of `Object.freeze`-d `PlanUpdate` objects; for a
   * planId other than the one this instance was bound to, returns an
   * `Object.freeze`-d empty array.
   *
   * Caller MUST NOT attempt mutation — the slice contract is read-only access.
   */
  readonly getUpdates: (planId: string) => readonly PlanUpdate[]

  /**
   * Drain all recorded updates for the given planId. Idempotent; calling
   * for an unknown planId is a no-op. NEVER throws.
   */
  readonly clearUpdates: (planId: string) => void
}
