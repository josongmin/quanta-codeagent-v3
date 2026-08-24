/**
 * ADR-0281 — resolved session-end promotion policy.
 *
 * ADR-0556 RETIRED the promotion gate this policy tuned: the session-end
 * consolidator no longer scores a distilled summary against its siblings, and
 * no session-start injector reads the result. The two fields below are DEAD
 * in effect — nothing in `src/` reads them any more — and the two env knobs
 * that used to set them (the `QUANTA_MEMORY_` threshold / min-usage pair)
 * were removed from the parser. The shape survives ONLY because
 * `src/runner/assemble/memory-factory.ts` (another lane, ADR-0555) still
 * destructures it into its `autoTrigger` slot; delete this file's fields and
 * that slot together.
 *
 * No I/O, no clock, no LLM — just the resolved policy shape.
 */

/**
 * Policy the memory-auto slot carries. Both fields are constants now
 * (see the file header).
 *
 * @deprecated ADR-0556 — dead in effect; pending removal with
 *   `memory-factory.ts#resolveAutoTrigger`.
 */
export interface TriggerPolicy {
  readonly promoteThreshold: number
  readonly minUsageCount: number
}

/** Default policy — the only value {@link TriggerPolicy} takes since ADR-0556. */
export const DEFAULT_TRIGGER_POLICY: TriggerPolicy = Object.freeze({
  promoteThreshold: 0.7,
  minUsageCount: 1,
})
