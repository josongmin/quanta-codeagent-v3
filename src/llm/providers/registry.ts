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

  // Layer 2 — CLAUDE_CODE_USE_* quartet (ADR-0163 Phase A). Delegated to the
  // provider router's `detectClaudeUseEnv` — the quartet SSOT — so the truthy
  // grammar AND the provider-conflict policy live in ONE place. Two truthy
  // keys throw `ProviderConflictError` (never a silent alphabetical pick).
  // Per ADR-0163 precedence this layer beats the `ANTHROPIC_*_BASE_URL` keys.
  const claudeUse = detectClaudeUseEnv(env)
  if (claudeUse !== undefined && claudeUse in FACTORIES) {
    const id = claudeUse as ProviderId
    return { id, factory: FACTORIES[id] }
  }

  // Layer 3-5 — env precedence. Order is fixed (bedrock → vertex → foundry).
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
  // Foundry signal — ADR-0172 expanded from one URL key to four. Any of:
  //   - `ANTHROPIC_FOUNDRY_BASE_URL`     non-empty  (ADR-0139 legacy)
  //   - `ANTHROPIC_FOUNDRY_RESOURCE`     non-empty  (SDK resource-name path)
  //   - `QUANTA_USE_FOUNDRY`             truthy     (quanta-native switch)
  // routes to Foundry. (The Claude-CLI `CLAUDE_CODE_USE_FOUNDRY` mirror is
  // caught at layer 2 above by the router delegation — reading it here again
  // would be a second, drift-prone consumer of the same key.) The boolean
  // switch uses the canonical truthy grammar consumed via `isTruthyEnv` — the
  // SSOT in `provider-metadata.ts` (which owns the accepted-spelling set;
  // audit L6 M11). The registry no longer hand-rolls a local copy;
  // `provider-metadata` is a plane-clean leaf (it imports only
  // `provider-types`), so importing it does not create a cycle nor drag a
  // transitive dependency.
  const foundryUrl = env[PROVIDER_ENV_KEYS.foundry]
  const foundryResource = env[FOUNDRY_EXTRA_ENV_KEYS.resource]
  const foundryQuantaUse = env[FOUNDRY_EXTRA_ENV_KEYS.quantaUse]
  if (
    (foundryUrl !== undefined && foundryUrl.length > 0) ||
    (foundryResource !== undefined && foundryResource.length > 0) ||
    isTruthyEnv(foundryQuantaUse)
  ) {
    return { id: "foundry", factory: FACTORIES.foundry }
  }

  // Mantle signal (ADR-0172 W12) — mirrors the Foundry expansion. Any of:
  //   - `ANTHROPIC_MANTLE_BASE_URL`  non-empty  (canonical key)
  //   - `QUANTA_USE_MANTLE`          truthy     (quanta-native switch)
  // routes to Mantle (the `CLAUDE_CODE_USE_MANTLE` mirror is layer 2 above).
  // Placed AFTER foundry so a more-specific transport wins.
  const mantleUrl = env[PROVIDER_ENV_KEYS.mantle]
  const mantleQuantaUse = env[MANTLE_EXTRA_ENV_KEYS.quantaUse]
  if ((mantleUrl !== undefined && mantleUrl.length > 0) || isTruthyEnv(mantleQuantaUse)) {
    return { id: "mantle", factory: FACTORIES.mantle }
  }

  // Layer 6 — fallback to the public api.anthropic.com path.
  return { id: "default", factory: FACTORIES.default }
}
