/**
 * Connectors — public surface barrel (ADR-0160).
 *
 * Phases A–E ship: type model + ports + REST/in-memory registry + OAuth
 * discovery + dynamic registration + availability prober + token rotation.
 *
 * Default-OFF: this slice is additive. `src/mcp/` (stdio MCP) is UNCHANGED.
 * Wire-up into agent dispatch is a follow-up ADR.
 */

export type { AvailabilityCheckerPort, AvailabilityVerdict } from "./availability"
export { createAvailabilityProber } from "./availability-prober"
// §1.6 — connector marketplace V1 (DirectoryApp install lifecycle core; default-OFF).
export {
  type ConnectorMarketplace,
  createConnectorMarketplace,
  createInMemoryInstalledAppStore,
  type DirectoryApp,
  DirectoryAppSchema,
  type InstalledApp,
  type InstalledAppState,
  type InstalledAppStorePort,
  isConnectorMarketplaceEnabled,
  type LifecycleResult,
  type MarketplaceLifecycleError,
} from "./connector-marketplace"
export { createInMemoryConnectorRegistry } from "./in-memory-registry"
// N2 — MCP connector discovery / catalog (§7). Pure catalog model + the
// `toMcpServerConfig` install transform; the catalog SOURCE is injected.
export {
  BUNDLED_MCP_CONNECTORS,
  createMcpConnectorCatalog,
  type McpConnectorCatalogPort,
  type McpConnectorEntry,
  type McpConnectorTransport,
  type McpInstallError,
  type McpInstallResult,
  type McpServerConfigShape,
  toMcpServerConfig,
} from "./mcp-connector-catalog"
// §2.5 — marketplace.json install/auth policy gating (pure decision + gated entry).
export {
  checkMarketplaceSource,
  enforceMarketplacePolicy,
  type MarketplaceBlockReason,
  type MarketplacePolicy,
  type MarketplaceVerdict,
} from "./marketplace-policy"
export { discoverOAuthEndpoints, type OAuthEndpoints } from "./oauth-discovery"
export {
  type OAuthClientMetadata,
  type OAuthClientRegistration,
  registerOAuthClient,
} from "./oauth-registration"
// ADR-0160 wire-up — REST registry → installable MCP-connector catalog adapter
// (closes the rest-registry "built-not-wired" gap; REPORT-jun26 §4.4).
export {
  connectorsToEntries,
  connectorToMcpEntry,
  fetchCatalogFromRegistry,
  restRegistrySnapshotToCatalog,
} from "./rest-catalog-adapter"
export { createRestConnectorRegistry, type RestRegistryConfig } from "./rest-registry"
export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  createTokenRefreshScheduler,
  LEAD_MS,
  type TimerHandle,
  type TimerPort,
  type TokenRefreshScheduler,
  type TokenRefreshSchedulerConfig,
} from "./token-refresh-scheduler"
export { createTokenRotator, type TokenRotator, type TokenRotatorConfig } from "./token-rotation"
export type {
  CacheEntry,
  CachePort,
  ClockPort,
  Connector,
  ConnectorRegistryPort,
  DnsPort,
  FetchPort,
  FetchPortResponse,
  OAuthDiscoveryErrorCode,
  OAuthRegistrationErrorCode,
  RefreshOutcome,
  SupportedAuth,
  TokenRecord,
  TokenRotationErrorCode,
  TokenStorePort,
} from "./types"
export { OAuthDiscoveryError, OAuthRegistrationError, TokenRotationError } from "./types"
