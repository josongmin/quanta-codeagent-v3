/**
 * Custom 3P Setup — registry port (ADR-0245).
 *
 * The 5 MVP methods: register / update / remove / health / list.
 * Plus a lifecycle accessor for inspection (does NOT mutate state).
 *
 * Every impl (in-memory / jsonl-backed / headless stub) shares this
 * surface. Mutators throw `Custom3pError` with a closed `code` arm so
 * callers branch without string parsing.
 */

import type { HealthResult, LifecycleState, ProviderId, ProviderSpec } from "./types"

/**
 * The registry of user-declared 3p providers.
 *
 * Semantics:
 *   - `register(spec)` throws `duplicate-id` if `spec.id` already exists.
 *     Lands the row at `LifecycleState = "draft"`.
 *   - `update(id, patch)` throws `unknown-id` if `id` is absent.
 *     Advances draft → configured. Other states unchanged.
 *   - `remove(id)` throws `unknown-id` if `id` is absent.
 *     Drops the row + its lifecycle.
 *   - `health(id)` throws `unknown-id` if `id` is absent. Advances
 *     lifecycle → healthy | failing based on the probe verdict.
 *   - `list()` returns a frozen snapshot — caller mutation cannot leak in.
 *   - `lifecycle(id)` returns the last-known state, or `undefined` for
 *     absent ids (does NOT throw — this is the read-only inspection path).
 */
export interface Custom3pRegistry {
  register(spec: ProviderSpec): Promise<void>
  update(id: ProviderId, patch: Partial<Omit<ProviderSpec, "id">>): Promise<void>
  remove(id: ProviderId): Promise<void>
  health(id: ProviderId): Promise<HealthResult>
  list(): Promise<ReadonlyArray<ProviderSpec>>
  lifecycle(id: ProviderId): Promise<LifecycleState | undefined>
}

// ────────────────────────────────────────────────────────────────────────────
// Health-probe injection — pure function shape.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Health-probe contract. Pure: caller injects ports (fetch / dns /
 * clock) so the function has no top-level side-effect import. The
 * registry impls call this on every `health(id)`.
 */
export type HealthProbe = (spec: ProviderSpec) => Promise<HealthResult>
