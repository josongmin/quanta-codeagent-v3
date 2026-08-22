/** H18 — the safe default {@link McpOAuthProviderPort}: it obtains NO token.
 *
 *  This is the byte-identical default for any deployment that has not wired a
 *  real (connectors-backed) provider. `tokenFor` resolves `undefined` (no
 *  bearer attached → the server answers 401 like any other unauthenticated
 *  request), and `invalidate` is a no-op. No discovery, no browser flow, no
 *  token store touched — exactly the pre-H18 behavior. */

import type { McpOAuthProviderPort } from "./port"

export const headlessOAuthRejecter: McpOAuthProviderPort = {
  tokenFor: async (): Promise<string | undefined> => undefined,
  invalidate: async (): Promise<void> => undefined,
}
