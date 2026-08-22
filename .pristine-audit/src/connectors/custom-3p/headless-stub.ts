/**
 * Custom 3P Setup — headless stub (ADR-0245).
 *
 * No-op registry for surfaces that opt out of user-declared 3p
 * providers (bench / ci-bot / replay).
 *
 *   - `list()`      → []
 *   - `lifecycle()` → undefined
 *   - every mutator → throws `Custom3pError(unsupported)`
 *
 * The throw is load-bearing: it makes the absent capability honest at
 * the call site rather than silently silent.
 */

import type { Custom3pRegistry } from "./port"
import { Custom3pError } from "./types"

const unsupported = (op: string): never => {
  throw new Custom3pError(
    "unsupported",
    `custom-3p ${op}() not supported on this surface (headless stub)`,
  )
}

export const createHeadlessCustom3pRegistry = (): Custom3pRegistry => ({
  register: async () => unsupported("register"),
  update: async () => unsupported("update"),
  remove: async () => unsupported("remove"),
  health: async () => unsupported("health"),
  list: async () => Object.freeze([]),
  lifecycle: async () => undefined,
})
