/**
 * Embedder registry — env-driven swap (ADR-0261).
 *
 *   QUANTA_EMBED_PROVIDER ∈ { openai, voyage, cohere, ollama, headless }
 *
 * `createEmbedderFromEnv(env)` returns the chosen `Embedder` or `null` when
 * the env var is unset / unknown. **Default-OFF**: no module auto-runs
 * this — call sites opt in by invoking it at composition root.
 */

import { createCohereEmbedder } from "./cohere-embedder"
import { createHeadlessEmbedder } from "./headless-stub"
import { createOllamaEmbedder } from "./ollama-embedder"
import { createOpenAIEmbedder } from "./openai-embedder"
import type { Embedder } from "./port"
import { createVoyageEmbedder } from "./voyage-embedder"

export const EMBED_PROVIDERS = ["openai", "voyage", "cohere", "ollama", "headless"] as const
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number]

export const isEmbedProvider = (s: string | undefined): s is EmbedProvider =>
  s !== undefined && (EMBED_PROVIDERS as readonly string[]).includes(s)

export interface EmbedderEnv {
  readonly QUANTA_EMBED_PROVIDER?: string
  readonly OPENAI_API_KEY?: string
  readonly VOYAGE_API_KEY?: string
  readonly COHERE_API_KEY?: string
}

/**
 * Construct an `Embedder` from env. Returns `null` when the provider env
 * is absent or unrecognised — caller decides whether to fall back.
 */
export const createEmbedderFromEnv = (env: EmbedderEnv): Embedder | null => {
  const provider = env.QUANTA_EMBED_PROVIDER
  if (!isEmbedProvider(provider)) return null
  switch (provider) {
    case "openai":
      return createOpenAIEmbedder({ apiKey: env.OPENAI_API_KEY })
    case "voyage":
      return createVoyageEmbedder({ apiKey: env.VOYAGE_API_KEY })
    case "cohere":
      return createCohereEmbedder({ apiKey: env.COHERE_API_KEY })
    case "ollama":
      return createOllamaEmbedder()
    case "headless":
      return createHeadlessEmbedder()
  }
}
