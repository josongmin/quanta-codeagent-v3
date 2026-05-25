/**
 * ADR-0282 — `src/memory/cross-session/` barrel.
 *
 * Sibling slice to `src/memory/auto-trigger/`. Exposes the closed
 * `CrossSessionInjector` port + default impl + the prompt-section
 * renderer + the `InjectOpts` / `MemorySystemBlock` shapes.
 *
 * No `@/memory` re-export until a future ADR — composition root
 * imports from this file directly (default-OFF until then).
 */

export {
  DefaultCrossSessionInjector,
  type DefaultCrossSessionInjectorOpts,
} from "./default-injector"
export type { CrossSessionInjector } from "./port"
export { renderMemorySection } from "./prompt-section"
export {
  DEFAULT_INJECT_MAX_BYTES,
  type InjectOpts,
  MEMORY_SECTION_HEADER,
  type MemorySystemBlock,
} from "./types"
