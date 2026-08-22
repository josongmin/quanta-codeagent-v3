/**
 * Child-process env injection for the egress proxy (ADR-0428).
 *
 * The enforcement mechanism: a spawned child (gh / curl / npm / git) honors the
 * de-facto `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars. Pointing them at
 * the loopback proxy funnels the child's OWN sockets through our allowlist —
 * closing the bypass where a subprocess opens a socket the tool-arg guard never
 * sees.
 *
 * DEFAULT-OFF / byte-identical: {@link withProxyEnv} returns the base env
 * UNCHANGED (same reference) when no proxy address is supplied. A caller wires
 * it only when `config.networkProxy.enabled` produced a live proxy. Tests prove
 * the absent path is byte-identical (same keys, same values, same reference).
 *
 * Both lower- and UPPER-case variants are set: some tools read only one casing.
 */

import type { ProxyAddress } from "./types"

/** Env-key pairs touched by proxy injection. Exported so the byte-identical
 *  test can assert none of these appear when the proxy is absent. */
export const PROXY_ENV_KEYS = Object.freeze([
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
])

export interface ProxyEnvInput {
  /** Bound proxy address. Absent ⇒ no injection (byte-identical). */
  readonly address?: ProxyAddress
  /** Hosts that bypass the proxy. Defaults to loopback names so local dev
   *  servers stay reachable. Joined into `NO_PROXY`. */
  readonly noProxy?: readonly string[]
}

const DEFAULT_NO_PROXY: readonly string[] = ["localhost", "127.0.0.1", "::1"]

/**
 * Return a child env with proxy vars injected, or the SAME base env reference
 * (untouched) when no proxy address is supplied.
 *
 * Never mutates `base` — a fresh object is allocated only on the inject path.
 */
export const withProxyEnv = (
  base: NodeJS.ProcessEnv,
  input: ProxyEnvInput = {},
): NodeJS.ProcessEnv => {
  if (input.address === undefined) return base // byte-identical: same reference
  const { host, port } = input.address
  const proxyUrl = `http://${host}:${port}`
  const noProxy = (input.noProxy ?? DEFAULT_NO_PROXY).join(",")
  return {
    ...base,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}
