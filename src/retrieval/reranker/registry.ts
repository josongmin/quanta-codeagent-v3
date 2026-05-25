/**
 * Env-driven {@link Reranker} factory (ADR-0262).
 *
 * `QUANTA_RERANKER` selects the provider:
 *   - absent or `"identity"` → identityReranker (default-OFF)
 *   - `"headless"`           → headlessReranker (deterministic, no network)
 *   - `"cohere"`             → createCohereReranker — REQUIRES `cohereApiKey`
 *                              (or `COHERE_API_KEY` env) AND `cohereHttp`
 *                              (or `defaultCohereHttp` if neither is given)
 *   - `"voyage"`             → createVoyageReranker — symmetric to cohere
 *   - any other value        → identityReranker (no silent vendor swap)
 *
 * The factory NEVER falls back from a configured provider to identity on
 * call failure — only on UNKNOWN env values does it pick identity. If the
 * operator typed `QUANTA_RERANKER=cohere` and the apiKey is missing, the
 * factory throws so the boundary fails loudly rather than silently
 * downgrading.
 */
import { type CohereHttp, createCohereReranker, defaultCohereHttp } from "./cohere-reranker"
import { headlessReranker } from "./headless-stub"
import { identityReranker } from "./identity-reranker"
import type { Reranker } from "./port"
import { createVoyageReranker, defaultVoyageHttp, type VoyageHttp } from "./voyage-reranker"

export interface RerankerFromEnvOptions<T> {
  readonly documentOf: (hit: T) => string
  readonly cohereApiKey?: string
  readonly cohereHttp?: CohereHttp
  readonly voyageApiKey?: string
  readonly voyageHttp?: VoyageHttp
  /**
   * Override the env source. Defaults to `process.env.QUANTA_RERANKER`.
   * Tests pass an explicit value to avoid touching the real environment.
   */
  readonly providerOverride?: string
}

export const createRerankerFromEnv = <T = unknown>(
  opts: RerankerFromEnvOptions<T>,
): Reranker<T> => {
  const provider = opts.providerOverride ?? process.env.QUANTA_RERANKER ?? "identity"
  switch (provider) {
    case "identity":
      return identityReranker<T>()
    case "headless":
      return headlessReranker<T>({ documentOf: opts.documentOf })
    case "cohere": {
      const apiKey = opts.cohereApiKey ?? process.env.COHERE_API_KEY
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error("QUANTA_RERANKER=cohere requires cohereApiKey or COHERE_API_KEY env")
      }
      const http = opts.cohereHttp ?? defaultCohereHttp({ apiKey })
      return createCohereReranker<T>({ apiKey, http, documentOf: opts.documentOf })
    }
    case "voyage": {
      const apiKey = opts.voyageApiKey ?? process.env.VOYAGE_API_KEY
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error("QUANTA_RERANKER=voyage requires voyageApiKey or VOYAGE_API_KEY env")
      }
      const http = opts.voyageHttp ?? defaultVoyageHttp({ apiKey })
      return createVoyageReranker<T>({ apiKey, http, documentOf: opts.documentOf })
    }
    default:
      // Unknown value — pick identity (NEVER silently pick a paid vendor).
      return identityReranker<T>()
  }
}
