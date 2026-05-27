/**
 * ADR-0336 — `src/agent/app-catalog/` barrel.
 *
 * quanta surface model (CLI / Web-Tauri / CLI-embedded browser) ↔
 * `@@app` mention resolution. Closed-port surface — descriptor type,
 * catalog port, in-memory adapter, default 3-surface catalog.
 *
 * Default-OFF: this barrel is NOT re-exported from `@/agent`. Callers
 * reach the slice via the explicit `@/agent/app-catalog` path from
 * the composition root that builds the `MentionResolverPort` (see
 * `@/agent/plugin-app-resolver`).
 *
 * Closed surface:
 *   - `DEFAULT_APP_CATALOG`               — static 3-entry list.
 *   - `defaultAppCatalog`                 — port wrapping the above.
 *   - `createInMemoryAppCatalog(list)`    — pure adapter.
 *   - `AppDescriptor` / `AppSurface`      — types.
 *   - `AppCatalogPort`                    — closed port.
 */

export { DEFAULT_APP_CATALOG } from "./default-catalog"
export { createInMemoryAppCatalog, defaultAppCatalog } from "./in-memory-catalog"
export type { AppCatalogPort, AppDescriptor, AppSurface } from "./types"
