/**
 * ADR-0139 / ADR-0172 — provider registry. Pure resolution:
 * `(explicit?, env?) → ProviderId` + `(id → factory)` mapping. No I/O, no
 * SDK touches at module load.
 *
 * Selection precedence (deterministic, byte-stable):
 *
 *   1. Explicit `id` arg (caller wins).
 *   2. `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,MANTLE}` truthy → that
 *      transport (ADR-0163 Phase A, delegated to `@/llm/provider-router`'s
 *      `detectClaudeUseEnv` — the quartet SSOT). TWO truthy keys at once throw
 *      a typed `ProviderConflictError` (ADR-0163 negative invariant 1: never
 *      "pick bedrock because alphabetical"). Per ADR-0163 this layer BEATS the
 *      `ANTHROPIC_*_BASE_URL` keys below.
 *   3. `ANTHROPIC_BEDROCK_BASE_URL` → `bedrock`.
 *   4. `ANTHROPIC_VERTEX_BASE_URL`  → `vertex`.
 *   5. `ANTHROPIC_FOUNDRY_BASE_URL` OR `ANTHROPIC_FOUNDRY_RESOURCE` OR
 *      `QUANTA_USE_FOUNDRY=1` → `foundry`.
 *      The Foundry signal expanded in ADR-0172 — the SDK accepts EITHER a
 *      `resource` name (synthesises the URL) or a full `baseURL`, so either
 *      env triggers selection. `QUANTA_USE_FOUNDRY` is the quanta-native
 *      spelling; the Claude-CLI `CLAUDE_CODE_USE_FOUNDRY` mirror is handled
 *      at layer 2 above.
 *   6. Fallback → `default` (= public `api.anthropic.com`).
 *
 * Unknown ids do NOT throw at `resolveProvider()` time — instead we return a
 * factory that throws `provider-unsupported` lazily on first call. This lets
 * downstream code build a fallback chain (or display the bad id in a status
 * panel) without forcing an unrelated try/catch around the resolver.
 *
 * Plane-clean: imports the port + the 4 sibling adapters only. No `@/agent`,
 * no `process.env` access — the env is passed in by the caller (mirrors
 * `@/llm/factory`'s `EnvLike` SSOT discipline).
 */

import { isTruthyEnv } from "../provider-metadata"
import { detectClaudeUseEnv } from "../provider-router"
import { BedrockProviderAdapter } from "./bedrock-adapter"
import { DefaultProviderAdapter } from "./default-adapter"
import { FoundryProviderAdapter } from "./foundry-adapter"
import { MantleProviderAdapter } from "./mantle-adapter"
import type { LlmProvider, ProviderConfig, ProviderFactory, ProviderId } from "./provider-port"
import { ProviderError } from "./provider-port"
import { VertexProviderAdapter } from "./vertex-adapter"

/** Read-only env shape — exactly the slice the resolver needs. Caller hands
 *  it in so the registry never depends on `process.env` (test parity). */
export type ProviderEnv = Record<string, string | undefined>

/** Map from {@link ProviderId} to the concrete factory. Closed registry — adding
 *  a provider = one entry here + one entry in the {@link ProviderId} union.
 *  No if-chain editing (OCP). */
const FACTORIES: Record<ProviderId, ProviderFactory> = {
  default: (config) => new DefaultProviderAdapter(config),
  bedrock: (config) => new BedrockProviderAdapter(config),
  vertex: (config) => new VertexProviderAdapter(config),
  foundry: (config) => new FoundryProviderAdapter(config),
  // ADR-0163 Phase B — Mantle is a Phase-1 stub (throws provider-unsupported
  // at first stream call). Wired here so the registry's closed-union OCP
  // discipline is satisfied; Phase 2 swaps the adapter implementation with
  // zero registry churn.
  mantle: (config) => new MantleProviderAdapter(config),
}

/** Env-var keys watched by the resolver. Exported so callers wiring CLI flags
 *  can surface the canonical names in `--help` output without re-typing them.
 *  `foundry` retains `ANTHROPIC_FOUNDRY_BASE_URL` as its canonical key (the
 *  ADR-0139 contract); ADR-0172 adds three OPTIONAL extras read by
 *  {@link FOUNDRY_EXTRA_ENV_KEYS} below so the precedence ladder accepts both
 *  resource-style and boolean-switch operator conventions. */
export const PROVIDER_ENV_KEYS = {
  bedrock: "ANTHROPIC_BEDROCK_BASE_URL",
  vertex: "ANTHROPIC_VERTEX_BASE_URL",
  foundry: "ANTHROPIC_FOUNDRY_BASE_URL",
  mantle: "ANTHROPIC_MANTLE_BASE_URL",
} as const

/** Additional env signals that select `foundry` (ADR-0172). Any of these,
 *  set non-empty (or truthy for the `*_USE_*` flags), routes to Foundry —
 *  same precedence layer as `ANTHROPIC_FOUNDRY_BASE_URL`. Kept separate from
 *  {@link PROVIDER_ENV_KEYS} so the type stays a 1:1 transport→key map for
 *  consumers that iterate it. */
export const FOUNDRY_EXTRA_ENV_KEYS = {
  /** Resource-name auth path — SDK synthesises the URL from this. */
  resource: "ANTHROPIC_FOUNDRY_RESOURCE",
  /** quanta-native boolean switch. */
  quantaUse: "QUANTA_USE_FOUNDRY",
  /** Claude-CLI mirror — Refugee path; same value space ("1" / "true" / "yes").
   *  Consumed at the ladder's layer 2 via the router's `detectClaudeUseEnv`
   *  (the quartet SSOT), not by the foundry layer below. */
  claudeUse: "CLAUDE_CODE_USE_FOUNDRY",
} as const

/** Additional env signals that select `mantle` (ADR-0172 W12). Mirrors the
 *  Foundry expansion: a non-empty `ANTHROPIC_MANTLE_BASE_URL` (the canonical
 *  key, in {@link PROVIDER_ENV_KEYS}) OR a truthy `CLAUDE_CODE_USE_MANTLE` /
 *  `QUANTA_USE_MANTLE` switch routes to Mantle. Lowest of the env layers so a
 *  more-specific transport (bedrock/vertex/foundry) still wins. */
export const MANTLE_EXTRA_ENV_KEYS = {
  /** quanta-native boolean switch. */
  quantaUse: "QUANTA_USE_MANTLE",
  /** Claude-CLI mirror — same value space ("1" / "true" / "yes"). Consumed at
   *  the ladder's layer 2 via the router's `detectClaudeUseEnv` (the quartet
   *  SSOT), not by the mantle layer below. */
  claudeUse: "CLAUDE_CODE_USE_MANTLE",
} as const

/** Resolution result. The `factory` is always callable (unknown id ⇒ lazy-throw
 *  factory); the `id` echoes back the resolved transport so the caller can
 *  log / surface the decision without re-running the precedence ladder. */
export interface ResolvedProvider {
  readonly id: ProviderId | string
  readonly factory: ProviderFactory
}

/** Lazy factory for an unknown provider id. Throws at FIRST CALL (not at
 *  resolution) so a status panel can still display "you asked for X, X is not
 *  a known provider" without forcing a try/catch around the resolver. */
const unsupportedFactory = (id: string): ProviderFactory => {
  return (_config: ProviderConfig): LlmProvider => {
    throw new ProviderError(
      "provider-unsupported",
      `Unknown provider id: "${id}" (known: default | bedrock | vertex | foundry | mantle)`,
    )
  }
}

const resolvedProvider = (id: ProviderId): ResolvedProvider => ({ id, factory: FACTORIES[id] })

const resolveExplicitProvider = (explicit: string | undefined): ResolvedProvider | undefined => {
  if (explicit === undefined || explicit.length === 0) return undefined
  const trimmed = explicit.trim()
  if (trimmed in FACTORIES) return resolvedProvider(trimmed as ProviderId)
  return { id: trimmed, factory: unsupportedFactory(trimmed) }
}

const hasEnvValue = (env: ProviderEnv, key: string): boolean => {
  const value = env[key]
  return value !== undefined && value.length > 0
}

/** ADR-0172: URL, resource name, or quanta-native switch selects Foundry.
 * The Claude-CLI mirror is consumed earlier by detectClaudeUseEnv. */
const foundrySelected = (env: ProviderEnv): boolean =>
  hasEnvValue(env, PROVIDER_ENV_KEYS.foundry) ||
  hasEnvValue(env, FOUNDRY_EXTRA_ENV_KEYS.resource) ||
  isTruthyEnv(env[FOUNDRY_EXTRA_ENV_KEYS.quantaUse])

const mantleSelected = (env: ProviderEnv): boolean =>
  hasEnvValue(env, PROVIDER_ENV_KEYS.mantle) || isTruthyEnv(env[MANTLE_EXTRA_ENV_KEYS.quantaUse])

/** Fixed env precedence, isolated from explicit and Claude-use resolution so
 * each layer remains independently readable and below the complexity gate. */
const providerFromTransportEnv = (env: ProviderEnv): ProviderId => {
  if (hasEnvValue(env, PROVIDER_ENV_KEYS.bedrock)) return "bedrock"
  if (hasEnvValue(env, PROVIDER_ENV_KEYS.vertex)) return "vertex"
  if (foundrySelected(env)) return "foundry"
  if (mantleSelected(env)) return "mantle"
  return "default"
}

/**
 * Resolve which provider transport to use. Pure function — no I/O, no SDK
 * touches. Precedence order is documented in the file header.
 *
 * @param explicit Caller-supplied id; wins over env. Pass `undefined` to fall
 *                 through to the env ladder. Empty string is treated as
 *                 "not supplied" (typical CLI parse output for absent flags).
 * @param env      Read-only env slice. Defaults to an empty object so the
 *                 registry stays unit-testable without `process.env` mocks.
 */
export const resolveProvider = (explicit?: string, env: ProviderEnv = {}): ResolvedProvider => {
  // Layer 1 — caller wins. Trim+normalize so " bedrock " from a flag parse
  // does not slip past the closed-union check.
  const explicitProvider = resolveExplicitProvider(explicit)
  if (explicitProvider !== undefined) return explicitProvider

  // Layer 2 — CLAUDE_CODE_USE_* quartet (ADR-0163 Phase A). Delegated to the
  // provider router's `detectClaudeUseEnv` — the quartet SSOT — so the truthy
  // grammar AND the provider-conflict policy live in ONE place. Two truthy
  // keys throw `ProviderConflictError` (never a silent alphabetical pick).
  // Per ADR-0163 precedence this layer beats the `ANTHROPIC_*_BASE_URL` keys.
  const claudeUse = detectClaudeUseEnv(env)
  if (claudeUse !== undefined && claudeUse in FACTORIES) {
    return resolvedProvider(claudeUse as ProviderId)
  }

  // Remaining env precedence is fixed (bedrock → vertex → foundry → mantle).
  // Presence (non-empty string), not value, gates selection — the actual
  // URL is consumed by the adapter SDK, not by us.
  // The concrete checks live in providerFromTransportEnv. Keeping this layer
  // as one ordered selection prevents the top-level resolver from regrowing a
  // branch-heavy precedence ladder.
  return resolvedProvider(providerFromTransportEnv(env))
}
