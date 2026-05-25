/**
 * Role-based model resolver port (ADR-0256).
 *
 * The closed-port surface for the per-role model override. A resolver
 * remembers the user's chosen `modelId` for each {@link Role} and falls
 * through to the caller-supplied `defaultModel` when no override exists.
 *
 * No-throw public surface:
 *   - `resolve` never throws — unknown roles fall through to default
 *     (type-erased boundaries like JSON-RPC may pass arbitrary strings).
 *   - `setOverride` never throws — empty modelId surfaces via the typed
 *     {@link SetOverrideResult.error} (symmetric with ADR-0212).
 *   - `clearOverride` never throws — clearing a non-existent role is a
 *     no-op.
 *
 * The composition with ADR-0212 sticky-model is documented on
 * {@link RoleModelResolver.resolve} — callers compose at the
 * composition root, NOT inside the resolver.
 */

import type { ModelId, Role, SetOverrideResult } from "./types"

/** The role-based model resolver port. Four methods: read, write, clear,
 *  enumerate. Sync (in-memory only); persistence is a separate concern
 *  (future ADR may add an `fsBackedRoleModelStore` that satisfies the
 *  same port). */
export interface RoleModelResolver {
  /** Resolve the effective `modelId` for `role`. Precedence:
   *    1. Explicit role override (set via {@link setOverride})
   *    2. `defaultModel` argument
   *
   *  `defaultModel` is REQUIRED — the resolver NEVER returns `undefined`.
   *  Unknown roles (passed as `string` from a type-erased boundary like
   *  JSON-RPC) fall through to `defaultModel` silently — they do NOT
   *  throw. The caller composes ADR-0212 sticky-model by passing the
   *  sticky modelId AS `defaultModel`:
   *
   *  ```ts
   *  const stickyId = await stickyResolver.resolve({ mode, globalDefault })
   *  const effective = roleResolver.resolve(role, stickyId)
   *  ```
   *
   *  When both sticky and role override are set, role override wins
   *  (sub-task autonomy beats workflow phase — locked by HELL-RM-14). */
  resolve(role: Role, defaultModel: ModelId): ModelId

  /** Record an override `modelId` for `role`. Empty modelId is REJECTED
   *  via {@link SetOverrideResult.error} — a silent accept would poison
   *  subsequent resolves with `""`. Idempotent: writing the same value
   *  twice is allowed. Overwrite: writing a different value replaces
   *  the prior pick (HELL-RM-07). */
  setOverride(role: Role, modelId: ModelId): SetOverrideResult

  /** Remove any override for `role`. No-op if no override exists — does
   *  NOT throw. After this call, `resolve(role, default)` returns
   *  `default` (HELL-RM-15). */
  clearOverride(role: Role): void

  /** Snapshot the current overrides as a plain frozen record. Used by
   *  `/status`, debug surfaces, and tests. The returned object is
   *  `Object.freeze`'d so callers cannot mutate the internal store by
   *  reference (HELL-RM-10). */
  listOverrides(): Readonly<Record<string, ModelId>>
}
