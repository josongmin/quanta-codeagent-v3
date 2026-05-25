/**
 * Knob registry — module-level singleton populated at import time.
 *
 * `registerKnob` is the ONE write seam. Reads are exposed as `ReadonlyMap`
 * so callers can iterate but cannot mutate. Collisions throw at register-
 * time (developer error — caught on first load).
 *
 * `__resetRegistry` is test-only and refuses to run when NODE_ENV is
 * "production", so a stray import in production code cannot wipe state.
 */

import { type AnyKnob, asAnyKnob, type Knob, type Surface } from "./types"

const REGISTRY = new Map<string, AnyKnob>()

/** Register a knob. Throws if the id is already taken. Generic in the
 *  knob's value type — under `exactOptionalPropertyTypes`, a `Knob<boolean>`
 *  is NOT assignable to `Knob<unknown>` because the optional `default` makes
 *  T invariant. `asAnyKnob` performs the explicit widening; the registry
 *  only ever READS via the `Knob` interface so no `any` is introduced. */
export const registerKnob = <T>(k: Knob<T>): void => {
  if (REGISTRY.has(k.id)) {
    throw new Error(`knob id collision: "${k.id}"`)
  }
  REGISTRY.set(k.id, asAnyKnob(k))
}

/** Read-only view of the full registry. */
export const allKnobs = (): ReadonlyMap<string, AnyKnob> => REGISTRY

/** Filter the registry by surface. New Map per call — caller may freeze. */
export const knobsForSurface = (s: Surface): ReadonlyMap<string, AnyKnob> => {
  const out = new Map<string, AnyKnob>()
  for (const [id, k] of REGISTRY) {
    if (k.surfaces.includes(s)) out.set(id, k)
  }
  return out
}

/**
 * Test-only escape hatch — clears the registry so each test file starts
 * from a known empty state. Refuses to run in production.
 */
export const __resetRegistry = (): void => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("registry reset forbidden in prod")
  }
  REGISTRY.clear()
}
