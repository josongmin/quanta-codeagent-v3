/**
 * ADR-0161 Phase D — Model reroute.
 *
 * `chooseModel({preference, fallbacks, availability})` returns the first
 * available model from `[preference, ...fallbacks]`, OR a clear
 * `"all-unavailable"` signal so the runtime can transition the automation
 * to `error` deterministically.
 *
 * Codex pattern (`localConversation.modelRerouted.*` warnings): when a
 * preferred model is unavailable, the runtime probes the fallback chain in
 * order and emits a warning naming which fallback was used. We surface the
 * same information as a structured return — the caller (runtime) decides
 * whether to log / surface.
 *
 * Pure: no clock, no I/O, no env (the `availability.isAvailable` port is the
 * only effectful seam). A throwing probe is treated as "unavailable" — no
 * exception leak to the caller.
 */

import type { ModelAvailabilityPort } from "./types"

/** Reason arm — closed set. Caller branches deterministically. */
export type ModelRerouteReason = "preference-available" | "fallback" | "all-unavailable"

export interface ChooseModelOpts {
  readonly preference: string
  readonly fallbacks: ReadonlyArray<string>
  readonly availability: ModelAvailabilityPort
}

export interface ChooseModelResult {
  readonly chosen: string
  readonly reason: ModelRerouteReason
  /** When `reason === "fallback"`, the 0-based index into `fallbacks` of the
   *  chosen model. Absent on the other two arms. */
  readonly fallbackIndex?: number
}

/**
 * Probe preference + fallbacks in order. Dedupes (a model appearing in both
 * preference and fallbacks is probed only once). Returns the first available
 * model OR `"all-unavailable"` (with `chosen: preference` so the caller can
 * preserve user intent in the error path).
 *
 * Empty preference (`""`) is treated as a sentinel: no probe is performed,
 * and the result is `"all-unavailable"`. This is the "no preference set"
 * path — caller must surface this as an error since the automation has no
 * model to use.
 */
export const chooseModel = async (opts: ChooseModelOpts): Promise<ChooseModelResult> => {
  if (opts.preference.length === 0) {
    return { chosen: "", reason: "all-unavailable" }
  }
  const seen = new Set<string>()
  const candidates: ReadonlyArray<string> = dedupeKeep([opts.preference, ...opts.fallbacks])
  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i]
    if (model === undefined || model.length === 0) continue
    if (seen.has(model)) continue
    seen.add(model)
    const available = await safeProbe(opts.availability, model)
    if (available) {
      if (i === 0) {
        return { chosen: model, reason: "preference-available" }
      }
      // Find the index in the ORIGINAL fallbacks array (not in candidates,
      // because dedupeKeep preserves the preference at index 0).
      const fallbackIdx = opts.fallbacks.indexOf(model)
      const result: ChooseModelResult = {
        chosen: model,
        reason: "fallback",
        ...(fallbackIdx >= 0 ? { fallbackIndex: fallbackIdx } : {}),
      }
      return result
    }
  }
  return { chosen: opts.preference, reason: "all-unavailable" }
}

/** Run the availability probe. A thrown / rejected promise is treated as
 *  unavailable (NO-THROW propagation to caller). */
const safeProbe = async (port: ModelAvailabilityPort, model: string): Promise<boolean> => {
  try {
    return await port.isAvailable(model)
  } catch {
    return false
  }
}

/** Keep-first dedupe. Preserves insertion order; later duplicates dropped. */
const dedupeKeep = (items: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}
