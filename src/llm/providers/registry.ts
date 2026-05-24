/**
 * ADR-0139 — provider registry. Pure resolution: `(explicit?, env?) → ProviderId`
 * + `(id → factory)` mapping. No I/O, no SDK touches at module load.
 *
 * Selection precedence (deterministic, byte-stable):
 *
 *   1. Explicit `id` arg (caller wins).
 *   2. `ANTHROPIC_BEDROCK_BASE_URL` → `bedrock`.
 *   3. `ANTHROPIC_VERTEX_BASE_URL`  → `vertex`.
 *   4. `ANTHROPIC_FOUNDRY_BASE_URL` → `foundry`.
 *   5. Fallback → `default` (= public `api.anthropic.com`).
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
 *  can surface the canonical names in `--help` output without re-typing them. */
export const PROVIDER_ENV_KEYS = {
  bedrock: "ANTHROPIC_BEDROCK_BASE_URL",
  vertex: "ANTHROPIC_VERTEX_BASE_URL",
  foundry: "ANTHROPIC_FOUNDRY_BASE_URL",
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
  if (explicit !== undefined && explicit.length > 0) {
    const trimmed = explicit.trim()
    if (trimmed in FACTORIES) {
      const id = trimmed as ProviderId
      return { id, factory: FACTORIES[id] }
    }
    // Unknown explicit id ⇒ lazy-throw factory (see file header rationale).
    return { id: trimmed, factory: unsupportedFactory(trimmed) }
  }

  // Layer 2-4 — env precedence. Order is fixed (bedrock → vertex → foundry).
  // Presence (non-empty string), not value, gates selection — the actual
  // URL is consumed by the adapter SDK, not by us.
  const bedrockUrl = env[PROVIDER_ENV_KEYS.bedrock]
  if (bedrockUrl !== undefined && bedrockUrl.length > 0) {
    return { id: "bedrock", factory: FACTORIES.bedrock }
  }
  const vertexUrl = env[PROVIDER_ENV_KEYS.vertex]
  if (vertexUrl !== undefined && vertexUrl.length > 0) {
    return { id: "vertex", factory: FACTORIES.vertex }
  }
  const foundryUrl = env[PROVIDER_ENV_KEYS.foundry]
  if (foundryUrl !== undefined && foundryUrl.length > 0) {
    return { id: "foundry", factory: FACTORIES.foundry }
  }

  // Layer 5 — fallback to the public api.anthropic.com path.
  return { id: "default", factory: FACTORIES.default }
}
