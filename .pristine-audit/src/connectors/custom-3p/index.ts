/**
 * Custom 3P Setup — public barrel (ADR-0245).
 *
 * **Default-OFF**: `src/connectors/index.ts` deliberately does NOT
 * re-export this barrel. Callers that opt in import
 * `@/connectors/custom-3p` directly. This keeps the bundle byte-identical
 * for surfaces that do not wire a `Custom3pRegistry`.
 */

export { createHeadlessCustom3pRegistry } from "./headless-stub"
export { createHealthProbe, type HealthProbeDeps } from "./health-probe"
export {
  createInMemoryCustom3pRegistry,
  type InMemoryCustom3pRegistry,
  type InMemoryRegistryConfig,
} from "./in-memory-registry"
export { createJsonlCustom3pRegistry, type JsonlRegistryConfig } from "./jsonl-store"
export type { Custom3pRegistry, HealthProbe } from "./port"
export {
  asProviderId,
  assertNever,
  Custom3pError,
  type Custom3pErrorCode,
  type HealthResult,
  type HealthVerdict,
  type LifecycleState,
  type ProviderAuth,
  type ProviderId,
  type ProviderKind,
  type ProviderSpec,
} from "./types"
