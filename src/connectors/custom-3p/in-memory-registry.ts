/**
 * Custom 3P Setup — in-memory canonical registry (ADR-0245).
 *
 * The reference impl. `JsonlCustom3pRegistry` wraps an instance of this
 * and writes a snapshot to disk on every mutation; the headless stub
 * bypasses it entirely.
 *
 * Endpoint validation lives here so every wrapping impl shares contract.
 *
 * Single-flight in-process; no inter-process lock (caller's contract).
 */

import type { Custom3pRegistry, HealthProbe } from "./port"
import {
  assertNever,
  Custom3pError,
  type HealthResult,
  type LifecycleState,
  type ProviderId,
  type ProviderKind,
  type ProviderSpec,
} from "./types"

export interface InMemoryRegistryConfig {
  readonly healthProbe: HealthProbe
}

/**
 * Validate that `endpoint` matches the scheme contract for `kind`.
 *
 *   kind = "mcp" → ws:// | wss:// | stdio:
 *   kind = "llm" → http:// | https://
 *
 * Throws `Custom3pError(invalid-endpoint)` on mismatch.
 */
const validateEndpoint = (kind: ProviderKind, endpoint: string): void => {
  switch (kind) {
    case "mcp": {
      if (
        endpoint.startsWith("ws://") ||
        endpoint.startsWith("wss://") ||
        endpoint.startsWith("stdio:")
      ) {
        return
      }
      throw new Custom3pError(
        "invalid-endpoint",
        `mcp endpoint must be ws://, wss://, or stdio:; got ${endpoint}`,
      )
    }
    case "llm": {
      if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) return
      throw new Custom3pError(
        "invalid-endpoint",
        `llm endpoint must be http:// or https://; got ${endpoint}`,
      )
    }
    default: {
      assertNever(kind)
    }
  }
}

/**
 * Deep-freeze a spec so callers cannot mutate stored rows through the
 * reference returned from `list()`. `tags` is frozen too — the array is
 * the only nested mutable structure.
 */
const freezeSpec = (spec: ProviderSpec): ProviderSpec => {
  const tags = spec.tags === undefined ? undefined : Object.freeze([...spec.tags])
  const frozen: ProviderSpec =
    tags === undefined
      ? Object.freeze({
          id: spec.id,
          displayName: spec.displayName,
          kind: spec.kind,
          endpoint: spec.endpoint,
          auth: spec.auth,
        })
      : Object.freeze({
          id: spec.id,
          displayName: spec.displayName,
          kind: spec.kind,
          endpoint: spec.endpoint,
          auth: spec.auth,
          tags,
        })
  return frozen
}

/** Map a `HealthVerdict` to the lifecycle arm it advances to. */
const lifecycleFromHealth = (verdict: HealthResult["verdict"]): LifecycleState => {
  switch (verdict) {
    case "ok":
      return "healthy"
    case "dns-fail":
    case "http-fail":
    case "auth-fail":
    case "timeout":
      return "failing"
    default:
      return assertNever(verdict)
  }
}

export interface InMemoryCustom3pRegistry extends Custom3pRegistry {
  /** Internal snapshot accessor — used by jsonl-store wrapper. */
  readonly _snapshot: () => {
    readonly specs: ReadonlyArray<ProviderSpec>
    readonly lifecycles: ReadonlyMap<ProviderId, LifecycleState>
  }
  /** Internal seed loader — used by jsonl-store on first read. */
  readonly _seed: (
    specs: ReadonlyArray<ProviderSpec>,
    lifecycles: ReadonlyMap<ProviderId, LifecycleState>,
  ) => void
}

export const createInMemoryCustom3pRegistry = (
  config: InMemoryRegistryConfig,
): InMemoryCustom3pRegistry => {
  // Insertion-ordered Map preserves the order `list()` returns.
  const rows = new Map<ProviderId, ProviderSpec>()
  const states = new Map<ProviderId, LifecycleState>()

  const register = async (spec: ProviderSpec): Promise<void> => {
    if (rows.has(spec.id)) {
      throw new Custom3pError("duplicate-id", `provider already registered: ${spec.id}`)
    }
    validateEndpoint(spec.kind, spec.endpoint)
    rows.set(spec.id, freezeSpec(spec))
    states.set(spec.id, "draft")
  }

  const update = async (
    id: ProviderId,
    patch: Partial<Omit<ProviderSpec, "id">>,
  ): Promise<void> => {
    const existing = rows.get(id)
    if (existing === undefined) {
      throw new Custom3pError("unknown-id", `unknown provider id: ${id}`)
    }
    // Build the merged spec without spreading `undefined` (exactOptional).
    const mergedKind = patch.kind ?? existing.kind
    const mergedEndpoint = patch.endpoint ?? existing.endpoint
    validateEndpoint(mergedKind, mergedEndpoint)

    const mergedTags = patch.tags ?? existing.tags
    const merged: ProviderSpec =
      mergedTags === undefined
        ? {
            id,
            displayName: patch.displayName ?? existing.displayName,
            kind: mergedKind,
            endpoint: mergedEndpoint,
            auth: patch.auth ?? existing.auth,
          }
        : {
            id,
            displayName: patch.displayName ?? existing.displayName,
            kind: mergedKind,
            endpoint: mergedEndpoint,
            auth: patch.auth ?? existing.auth,
            tags: mergedTags,
          }
    rows.set(id, freezeSpec(merged))
    // draft → configured. Other states unchanged (mutation ≠ state change).
    const state = states.get(id)
    if (state === "draft") states.set(id, "configured")
  }

  const remove = async (id: ProviderId): Promise<void> => {
    if (!rows.has(id)) {
      throw new Custom3pError("unknown-id", `unknown provider id: ${id}`)
    }
    rows.delete(id)
    states.delete(id)
  }

  const health = async (id: ProviderId): Promise<HealthResult> => {
    const spec = rows.get(id)
    if (spec === undefined) {
      throw new Custom3pError("unknown-id", `unknown provider id: ${id}`)
    }
    const result = await config.healthProbe(spec)
    states.set(id, lifecycleFromHealth(result.verdict))
    return result
  }

  const list = async (): Promise<ReadonlyArray<ProviderSpec>> =>
    Object.freeze(Array.from(rows.values()))

  const lifecycle = async (id: ProviderId): Promise<LifecycleState | undefined> => states.get(id)

  return {
    register,
    update,
    remove,
    health,
    list,
    lifecycle,
    _snapshot: () => ({
      specs: Object.freeze(Array.from(rows.values())),
      lifecycles: new Map(states),
    }),
    _seed: (specs, lifecycles) => {
      rows.clear()
      states.clear()
      for (const s of specs) rows.set(s.id, freezeSpec(s))
      for (const [k, v] of lifecycles) states.set(k, v)
    },
  }
}
