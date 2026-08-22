/**
 * `@/retrieval/auto-hook` slice barrel — ADR-0273.
 *
 * Public surface:
 *   - Types  : `UnregisterAll`, `AutoHookError`
 *   - Ports  : `AutoHookRegistrar`, `AutoHookRegistrarOptions`,
 *              `CacheLike`, `StoreLike`
 *   - Default: `createDefaultRegistrar`
 *
 * Default-OFF: importing this barrel does nothing observable. The
 * composition root MUST construct a registrar, stage cache + store
 * targets, and call `installAll(invalidator)` for the slice to alter
 * behaviour. The disposal thunk returned from `installAll` is the
 * caller's responsibility — calling it twice is safe.
 *
 * The registrar's duck-typed `CacheLike` / `StoreLike` shapes mean this
 * slice imports NOTHING from `@/retrieval/cache` or
 * `@/retrieval/engines/store` — it stays a leaf so it can be installed
 * from any composition root without dragging the cache + engine surface
 * into the build graph.
 */

export { createDefaultRegistrar } from "./default-registrar"
export type {
  AutoHookRegistrar,
  AutoHookRegistrarOptions,
  CacheLike,
  StoreLike,
} from "./port"
export type { AutoHookError, UnregisterAll } from "./types"
