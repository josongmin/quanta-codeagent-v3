/** Repair-breadth fanout sampling schedule (Agentless `repair.py` parity).
 *
 *  Agentless generates repair candidates with ONE greedy pass (no temperature)
 *  followed by N temperature-0.8 samples to diversify the candidate pool. This
 *  pure leaf is the SSOT for that per-candidate temperature schedule: it maps a
 *  candidate index onto the sampling temperature the LLM stream should use.
 *
 *  No I/O, no env, no clock — a total function of the index. The seam owner
 *  (repair-breadth wiring) calls it once per candidate and threads the result
 *  through {@link withTemperature} / `StreamInput.temperature`.
 */

/** The greedy lead candidate runs with NO temperature override — the model's
 *  own default sampling (deterministic-ish). Modeled as `undefined` so the
 *  adapter OMITS the wire `temperature` key (byte-identical to a plain call). */
export const GREEDY: undefined = undefined

/** The diversity tail samples at temperature 0.8 (Agentless `repair.py` exact
 *  value), the only non-greedy temperature in the schedule. */
export const TEMPERATURE_SAMPLE = 0.8

/**
 * Resolve the sampling temperature for repair candidate `index`.
 *
 *   - index 0  ⇒ {@link GREEDY} (`undefined`): the greedy lead pass. Returning
 *     `undefined` means "do not override" — the adapter omits the wire key.
 *   - index ≥1 ⇒ {@link TEMPERATURE_SAMPLE} (0.8): a diversity sample.
 *
 * Deterministic and side-effect-free. Negative indices are treated as the
 * greedy lead (defensive: index 0 is the only greedy slot, anything below it is
 * not a sampling slot either).
 */
export const sampleTemperatureForCandidate = (index: number): number | undefined =>
  index >= 1 ? TEMPERATURE_SAMPLE : GREEDY
