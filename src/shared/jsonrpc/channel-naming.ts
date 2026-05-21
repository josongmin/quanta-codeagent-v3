/**
 * Channel triple naming.
 *
 * Codex pattern (memory: codex-jsonrpc-protocol-pattern) — every async method
 * has THREE related channels:
 *   - `{name}-request`   client → server
 *   - `{name}-response`  server → client (success or non-timeout error)
 *   - `{name}-timeout`   server → client (specifically the -32000 timeout case)
 *
 * The triple is generated from a single base `name` so name drift between the
 * three is impossible.
 */

export type ChannelKind = "request" | "response" | "timeout"

export interface ChannelTriple {
  readonly request: string
  readonly response: string
  readonly timeout: string
}

const SUFFIXES: Readonly<Record<ChannelKind, string>> = Object.freeze({
  request: "-request",
  response: "-response",
  timeout: "-timeout",
})

/** Base names must match the JSON-RPC method-name shape: a non-empty lowercase
 *  identifier with optional `.`-delimited namespaces (`agent.run`,
 *  `tools/call`, `sandbox.exec`). We allow `[a-zA-Z0-9_./-]+` but DISALLOW the
 *  exact suffixes `-request`, `-response`, `-timeout` to prevent
 *  `foo-request` becoming `foo-request-request`. */
const VALID_BASE = /^[A-Za-z0-9_./]+$/

const isReservedSuffix = (name: string): boolean =>
  name.endsWith("-request") || name.endsWith("-response") || name.endsWith("-timeout")

/** Build the request/response/timeout triple for `name`.
 *  Throws on programmer error (empty, contains a reserved suffix, illegal
 *  chars). */
export const channelTriple = (name: string): ChannelTriple => {
  if (name.length === 0) {
    throw new Error("channelTriple: name must be non-empty")
  }
  if (!VALID_BASE.test(name)) {
    throw new Error(
      `channelTriple: name must match ${VALID_BASE.source} (got ${JSON.stringify(name)})`,
    )
  }
  if (isReservedSuffix(name)) {
    throw new Error(
      `channelTriple: name must not already end with -request/-response/-timeout (got "${name}")`,
    )
  }
  return Object.freeze({
    request: `${name}${SUFFIXES.request}`,
    response: `${name}${SUFFIXES.response}`,
    timeout: `${name}${SUFFIXES.timeout}`,
  })
}

/** Parse a channel name back into its kind. Returns `null` if the suffix is
 *  not one of the three known kinds. */
export const parseChannelKind = (channel: string): ChannelKind | null => {
  if (channel.endsWith(SUFFIXES.request)) return "request"
  if (channel.endsWith(SUFFIXES.response)) return "response"
  if (channel.endsWith(SUFFIXES.timeout)) return "timeout"
  return null
}

/** Round-trip helper — given a channel name, recover the base. Returns `null`
 *  if the channel doesn't have a recognised triple suffix. */
export const parseChannelBase = (channel: string): string | null => {
  const kind = parseChannelKind(channel)
  if (kind === null) return null
  return channel.slice(0, channel.length - SUFFIXES[kind].length)
}
