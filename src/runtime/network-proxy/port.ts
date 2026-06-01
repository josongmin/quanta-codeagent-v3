/**
 * Network proxy port (ADR-0428) — hexagonal boundary.
 *
 * The composition root depends on this interface, not on the concrete Node
 * `http`/`net` adapter. A test can substitute an in-memory fake; the real
 * adapter (`./loopback-proxy.ts`) binds an actual loopback socket.
 *
 * Lifecycle: `listen()` → (children run with env injected) → `close()`. The
 * proxy exposes its bound `address()` (post-`listen`) so the env-injection
 * helper can point `HTTP_PROXY`/`HTTPS_PROXY` at it, and the append-only
 * `decisionLog()` for audit.
 *
 * Plane-clean: imports ONLY sibling `./types` + `./amendment`.
 */

import type { NetworkPolicyAmendment } from "./amendment"
import type { DecisionLogEntry, ProxyAddress } from "./types"

export interface NetworkProxyPort {
  /** Bind the proxy. Resolves once the socket is accepting connections. */
  listen(): Promise<ProxyAddress>
  /** The bound address. Throws if called before `listen` resolves. */
  address(): ProxyAddress
  /** The live amend-set this proxy consults (post-denial approvals). */
  readonly amendments: NetworkPolicyAmendment
  /** Append-only per-connection decision log (audit). */
  decisionLog(): readonly DecisionLogEntry[]
  /** Stop accepting connections and release the socket. Idempotent. */
  close(): Promise<void>
}
