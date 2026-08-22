/**
 * External-SOTA comparison glue (RFC jun-29 — SOTA++ in-house benchmark platform).
 *
 * An in-house Pro/Live resolve-rate is only credible NEXT TO the public SOTA. The
 * dashboard's runs view needs a tiny pure mapping from OUR `datasetFamily`
 * ("verified" | "pro" | "live") to the right external (dataset, set) coordinate and
 * then to a top-external label. This lives OUTSIDE server.ts because server.ts calls
 * `Bun.serve` at import (can't be unit-imported); the render-only string assembly stays
 * in server.ts, this stays here so it is unit-testable.
 */
import { type ExternalBaselines, type ExternalModelResult, sotaFor } from "./external-baselines"

/**
 * Our dataset family → the external (dataset, set) coordinate we measure it against.
 *   - verified ⇒ NO external comparison (the verified leaderboard is its own surface;
 *     R4 keeps it byte-identical, so this returns undefined and the caller renders nothing).
 *   - live     ⇒ live/verified, falling back to live/lite (the two published Live subsets).
 *   - pro      ⇒ pro/public-731 (the only open Pro subset).
 */
export const externalCoordFor = (
  family: string,
): { dataset: "pro" | "live"; sets: string[] } | undefined => {
  if (family === "pro") return { dataset: "pro", sets: ["public-731"] }
  if (family === "live") return { dataset: "live", sets: ["verified", "lite"] }
  return undefined // verified (and anything unknown) ⇒ no external comparison
}

/** The top external model for a family, picking the first `set` that has any external
 *  data (live tries verified then lite). undefined ⇒ no comparison to show ("—"). */
export const externalSotaFor = (
  family: string,
  baselines: ExternalBaselines | null | undefined,
): ExternalModelResult | undefined => {
  if (!baselines) return undefined
  const coord = externalCoordFor(family)
  if (!coord) return undefined
  for (const set of coord.sets) {
    const top = sotaFor(baselines, coord.dataset, set)
    if (top) return top
  }
  return undefined
}

/**
 * Structured label for the runs view: our rate beside the top external SOTA, or null
 * when there is no external match (caller shows "—"). The numbers are pre-formatted
 * percent strings; `extModel` / `set` are RAW external strings (the caller MUST esc()
 * them into HTML — they come from external JSON).
 */
export interface ExternalSotaLabel {
  oursPct: number // 0..100, rounded
  extPct: number // 0..100, rounded
  extModel: string // RAW (un-escaped) — esc() at the HTML boundary
  set: string // RAW (un-escaped)
}

export const externalSotaLabel = (
  family: string,
  ourResolved: number,
  ourTotal: number,
  baselines: ExternalBaselines | null | undefined,
): ExternalSotaLabel | null => {
  const top = externalSotaFor(family, baselines)
  if (!top) return null
  return {
    oursPct: ourTotal > 0 ? Math.round((100 * ourResolved) / ourTotal) : 0,
    extPct: Math.round(100 * top.rate),
    extModel: top.name,
    set: top.set,
  }
}
