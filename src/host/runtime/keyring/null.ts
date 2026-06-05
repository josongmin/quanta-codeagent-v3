/** jun-06 — the null keyring: `available()===false`, every op is a no-op.
 *
 *  This is the headless / unsupported-platform / test default. With it injected
 *  `composeTokenStore` behaves byte-identically to the pure 0600 file store (the
 *  keyring branch is never taken because `available()` is always `false`), so
 *  nothing is constructed eagerly and a host with no keyring sees no change.
 */

import type { KeyringPort } from "./port"

export const createNullKeyring = (): KeyringPort => ({
  async available() {
    return false
  },
  async get() {
    return undefined
  },
  async set() {
    // no-op
  },
  async delete() {
    // no-op
  },
})
