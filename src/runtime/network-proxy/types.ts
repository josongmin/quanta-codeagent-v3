/**
 * Network-egress proxy — shared types (ADR-0428).
 *
 * Socket-level egress enforcement. Today (jun-01) quanta gates egress only at
 * the TOOL-ARG layer (`src/agent/dispatch-guard/network-guard.ts` extracts a
 * host from a tool call). A subprocess that opens its OWN socket bypasses that
 * gate entirely. This slice closes the hole with a REAL loopback HTTP proxy
 * (Node `http`/`net`): child processes get `HTTP_PROXY`/`HTTPS_PROXY` pointed
 * at the proxy, so every outbound connection is funneled through the same
 * `isHostAllowed` decision used by the dispatch guard.
 *
 * Plane-clean: this file is pure types — no imports beyond the runtime stdlib
 * shape it mirrors. The allow decision is delegated to
 * `@/runtime/network-allowlist#isHostAllowed` (reused, not re-implemented).
 */

/** The three terminal decisions the proxy can reach for one connection. */
export type ProxyDecisionKind = "allow" | "deny" | "amended-allow"

/** Per-connection decision log entry. Append-only; the proxy never mutates a
 *  prior entry. `host` is the bare hostname the client asked for (CONNECT
 *  authority or the request URL host), lowercased. */
export interface DecisionLogEntry {
  readonly host: string
  readonly decision: ProxyDecisionKind
  /** Human-readable reason (denial cause / which rule allowed it). */
  readonly reason: string
  /** Wall-clock ms when the decision was reached (injected clock in tests). */
  readonly at: number
}

/**
 * Static configuration for the loopback proxy. The proxy is DEFAULT-OFF: a
 * composition root only constructs it when `enabled` is true. Absent config ⇒
 * no proxy, no env injection (byte-identical to the pre-slice path).
 */
export interface NetworkProxyConfig {
  /** Master switch. When false/absent the slice contributes nothing. */
  readonly enabled: boolean
  /** Base allow-set (exact host or `*.suffix`, reusing `isHostAllowed`
   *  semantics). Amendments are layered ON TOP of this at runtime. */
  readonly allowlist: readonly string[]
  /** Loopback bind host. Defaults to `127.0.0.1`. Never bind a routable
   *  interface — the proxy is for THIS host's children only. */
  readonly bindHost?: string
  /** Bind port. `0` (default) ⇒ an ephemeral port chosen by the OS; read the
   *  actual port back via {@link NetworkProxyPort.address} after `listen`. */
  readonly port?: number
  /** Hosts that bypass the proxy entirely (`NO_PROXY`). Defaults to
   *  `localhost,127.0.0.1` so loopback dev servers are reachable WITHOUT being
   *  routed through (and SSRF-blocked by) the proxy. */
  readonly noProxy?: readonly string[]
}

/** Address the proxy is bound to after `listen()` resolves. */
export interface ProxyAddress {
  readonly host: string
  readonly port: number
}
