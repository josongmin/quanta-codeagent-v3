/**
 * Network-egress proxy slice barrel (ADR-0428).
 *
 * Socket-level egress enforcement: a REAL loopback HTTP proxy (Node
 * `http`/`net`, plain-HTTP + CONNECT tunneling) that gates every child-process
 * connection through the SAME `isHostAllowed` decision the tool-arg dispatch
 * guard uses — closing the subprocess egress bypass.
 *
 * Default-OFF: nothing here runs unless a composition root constructs a proxy
 * (config.networkProxy.enabled) and injects its env. Absent ⇒ byte-identical.
 */

export { type AmendInput, type AmendmentRecord, NetworkPolicyAmendment } from "./amendment"
export { type DecideInput, decideEgress, type EgressDecision } from "./decision"
export { PROXY_ENV_KEYS, type ProxyEnvInput, withProxyEnv } from "./env"
export {
  type EgressProxyContext,
  type EgressProxyDeps,
  withEgressProxy,
} from "./lifecycle"
export { type DialTarget, LoopbackEgressProxy, type ResolvePeerHost } from "./loopback-proxy"
export type { NetworkProxyPort } from "./port"
export { METADATA_IPV4 } from "./ssrf"
export type {
  DecisionLogEntry,
  NetworkProxyConfig,
  ProxyAddress,
  ProxyDecisionKind,
} from "./types"
