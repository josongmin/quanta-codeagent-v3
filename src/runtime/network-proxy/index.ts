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
  EXFIL_SCOUTING_ENV,
  exfilScoutingEnabled,
} from "./exfil-scouting-gate"
export {
  type ApplyHeaderRulesResult,
  applyHeaderRules,
  CROSS_ORIGIN_STRIP_HEADERS,
  FORBIDDEN_FRAMING,
  FORBIDDEN_INJECT,
  type HeaderRule,
  type HeaderRuleAudit,
  type MutableHeaders,
  shouldStripOnRedirect,
} from "./header-rules"
export {
  type EgressProxyContext,
  type EgressProxyDeps,
  openSessionEgressProxy,
  type SessionEgressProxy,
  withEgressProxy,
} from "./lifecycle"
export {
  type CappedBody,
  type DialTarget,
  LoopbackEgressProxy,
  type ResolvePeerHost,
  readCappedBody,
} from "./loopback-proxy"
export type { MitmConfig, MitmFailMode } from "./mitm"
export {
  type CertAuthority,
  type KeyPair,
  type KeyPairSource,
  type LeafCert,
  MitmCertAuthority,
  type MitmCertValidity,
  nodeKeyPairSource,
  type SerialSource,
} from "./mitm-cert"
export {
  isBunRuntime,
  type ManualParseState,
  type MitmTlsChannel,
  type OpenMitmChannel,
  type ParsedTlsRequest,
  parseHttpRequestBuffer,
} from "./mitm-channel"
export { openBunMitmChannel } from "./mitm-channel-bun"
export { makeNodeMitmChannelOpener } from "./mitm-channel-node"
export {
  TLS_MITM_ACK_ENV,
  TLS_MITM_ACK_PHRASE,
  TLS_MITM_ENV,
  tlsMitmAuthorized,
} from "./mitm-gate"
export type { NetworkProxyPort } from "./port"
export {
  type DetectScoutingOpts,
  detectScouting,
  type ScoutingSignal,
} from "./scouting"
export {
  decideEgressScan,
  EGRESS_REDACTION_MASK,
  type EgressScanDisposition,
  egressDenyReason,
  fullyRedactable,
  redactDeclared,
  type SecretEgressConfig,
  type SecretEgressMode,
  type SecretEgressVerdict,
  scanEgressText,
} from "./secret-egress"
export {
  SECRET_EGRESS_ENV,
  SECRET_EGRESS_MAX_BODY_ENV,
  secretEgressMode,
} from "./secret-egress-gate"
export { METADATA_IPV4 } from "./ssrf"
export type {
  DecisionLogEntry,
  NetworkProxyConfig,
  ProxyAddress,
  ProxyDecisionKind,
} from "./types"
