/**
 * Default role-model resolver (ADR-0256).
 *
 * Map-backed in-memory implementation of {@link RoleModelResolver}. Pure:
 * no IO, no clock, no global mutable state. Each constructed instance
 * carries its OWN backing Map so a stale closure or shared module
 * instance cannot leak between sessions in test harnesses (each test
 * constructs its own resolver).
 *
 * Persistence is out of scope by design — see ADR-0256 §Consequences.
 * If a future ADR wants fs-backed role overrides, it extends this
 * slice with a sibling `fsBackedRoleModelStore` that satisfies the
 * same port; the sticky-model slice's two-impl pattern (default-store
 * + fs-backed-store) is the template.
 */

import type { RoleModelResolver } from "./port"
import { type ModelId, OverrideError, type Role, type SetOverrideResult } from "./types"

/** Construct a default {@link RoleModelResolver}. `seed` is an optional
 *  initial map of overrides — useful for tests / CLI re-hydration from
 *  a snapshot. The seed is copied (not aliased) so caller mutation
 *  cannot poison the resolver's internal Map. Empty-string values in
 *  the seed are SILENTLY dropped (consistent with {@link setOverride}'s
 *  empty rejection — no silent poisoning at construction either). */
export const defaultRoleModelResolver = (
  seed?: Readonly<Record<string, ModelId>>,
): RoleModelResolver => {
  const data = new Map<string, ModelId>()
  if (seed !== undefined) {
    for (const [k, v] of Object.entries(seed)) {
      if (typeof v === "string" && v.length > 0) data.set(k, v)
    }
  }
  return {
    resolve(role: Role, defaultModel: ModelId): ModelId {
      const override = data.get(role)
      if (override !== undefined && override.length > 0) return override
      return defaultModel
    },
    setOverride(role: Role, modelId: ModelId): SetOverrideResult {
      if (modelId.length === 0) {
        return {
          ok: false,
          error: new OverrideError(
            "empty-model",
            `role "${role}" cannot be assigned an empty modelId`,
          ),
        }
      }
      data.set(role, modelId)
      return { ok: true }
    },
    clearOverride(role: Role): void {
      data.delete(role)
    },
    listOverrides(): Readonly<Record<string, ModelId>> {
      const snapshot: Record<string, ModelId> = {}
      for (const [k, v] of data.entries()) snapshot[k] = v
      return Object.freeze(snapshot)
    },
  }
}
