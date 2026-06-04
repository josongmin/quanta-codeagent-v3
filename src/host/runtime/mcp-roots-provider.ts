/** H19 host roots provider — the composition-root source for inbound MCP
 *  `roots/list` (server → client).
 *
 *  `@/mcp` deliberately knows nothing about "the workspace" (slice isolation):
 *  it only owns the {@link RootsProviderPort} seam. The HOST is the only layer
 *  that knows the session cwd, so it builds the concrete provider here and
 *  injects it into the `McpClient`, mirroring how {@link buildSamplingWiring}
 *  injects the inbound-sampling handler and {@link buildMcpOAuthWiring} injects
 *  the OAuth provider.
 *
 *  ## Advertise-iff-able (same rule as B1 sampling)
 *
 *  A wired provider is the SINGLE signal that authorizes advertising `roots`.
 *  {@link buildRootsWiring} returns the provider and the advertise flag from the
 *  SAME branch so they can never drift: with the knob off (`QUANTA_MCP_ROOTS`)
 *  the provider is `undefined` AND `advertise` is `false` — byte-identical
 *  negotiation (no `roots` cap) and an inbound `roots/list` is still answered
 *  with an empty list by the client's built-in default (never a raw `-32601`).
 */

import type { McpRoot, RootsProviderPort } from "@/mcp"

/** Turn a filesystem path into a spec `file://` URI. Absolute POSIX paths map
 *  to `file://<path>`; we percent-encode nothing beyond what is structurally
 *  required (spaces) so the round-trip stays human-legible in the rare case a
 *  server echoes it back. A path that is already a `file://` URI is returned
 *  unchanged (idempotent), so a caller that pre-normalized is not double-wrapped. */
const toFileUri = (path: string): string => {
  if (path.startsWith("file://")) return path
  // Encode each segment so spaces / unsafe chars do not break the URI, while
  // preserving the `/` separators that give the URI its path structure.
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
  // An absolute path already starts with `/`, yielding `file:///abs/path`
  // (triple slash = empty authority + absolute path, per RFC 8089). A relative
  // path yields `file://rel/path`; we keep it rather than guess a base.
  return `file://${encoded}`
}

/** Build the concrete {@link RootsProviderPort} for the session workspace. At
 *  minimum it reports the session `cwd` as a single `file://` root labelled
 *  `"workspace"`. The returned list is frozen + rebuilt fresh per call (the port
 *  contract is sync + total) so no caller can mutate a shared array, and the
 *  cwd is captured ONCE at construction (the root is stable for the session).
 *
 *  Additional roots (e.g. extra workspace folders) can be appended by passing
 *  `extraRoots`; each is normalized to a `file://` URI the same way. */
export const workspaceRootsProvider = (
  cwd: string,
  extraRoots: ReadonlyArray<McpRoot> = [],
): RootsProviderPort => {
  // Capture the normalized roots ONCE; `listRoots` hands back a fresh shallow
  // copy each call so the client's sanitizer can never see a mutated source.
  const roots: ReadonlyArray<McpRoot> = [
    { uri: toFileUri(cwd), name: "workspace" },
    ...extraRoots.map((r) => ({
      uri: toFileUri(r.uri),
      ...(r.name !== undefined ? { name: r.name } : {}),
    })),
  ]
  return {
    listRoots: () => roots.slice(),
  }
}

/** The single artifact a deployment needs to enable inbound `roots/list`: the
 *  provider to inject into each `McpClient` (present IFF the knob is ON) and the
 *  matching `advertise` flag to feed `pickMcpNegotiator(env, { roots })`. Decided
 *  TOGETHER so they can never drift — the structural mirror of
 *  {@link SamplingWiring}. */
export interface RootsWiring {
  /** Pass straight to `pickMcpNegotiator(env, { roots })` — advertise IFF a
   *  provider is wired. */
  readonly advertise: boolean
  /** The `rootsProvider` to pass to the `McpClient`. `undefined` when not
   *  enabled (the client answers `roots/list` with an empty list — the
   *  advertise-iff-able default). */
  readonly provider: RootsProviderPort | undefined
}

/** The single decision point for the advertise-iff-provider invariant. Returns
 *  `{ advertise:true, provider }` ONLY when the knob is ON; otherwise
 *  `{ advertise:false, provider:undefined }` (byte-identical to the unwired
 *  default — no `roots` advertisement, an inbound `roots/list` answered empty).
 *
 *  Because the advertisement flag and the provider come from the SAME branch, a
 *  caller cannot advertise `roots` without a provider, or wire a provider without
 *  advertising — the honesty rule H19 demands. */
export const buildRootsWiring = (enabled: boolean, cwd: string): RootsWiring => {
  if (!enabled) return { advertise: false, provider: undefined }
  return { advertise: true, provider: workspaceRootsProvider(cwd) }
}
