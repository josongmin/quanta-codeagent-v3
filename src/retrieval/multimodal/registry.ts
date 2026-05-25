/**
 * Multi-modal embedder registry — env-driven swap (ADR-0276).
 *
 *   QUANTA_MM_EMBED ∈ { voyage, clip, headless }
 *
 * `createMultiModalEmbedderFromEnv(env)` returns the chosen
 * `MultiModalEmbedder` or `null` when the env var is unset / unknown.
 * **Default-OFF**: no module auto-runs this — call sites opt in by
 * invoking it at composition root.
 */

import { createClipRestEmbedder } from "./clip-rest"
import { createHeadlessMmEmbedder } from "./headless-stub"
import type { MultiModalEmbedder } from "./port"
import { createVoyageMultiModalEmbedder } from "./voyage-multimodal"

export const MM_EMBED_PROVIDERS = ["voyage", "clip", "headless"] as const
export type MmEmbedProvider = (typeof MM_EMBED_PROVIDERS)[number]

export const isMmEmbedProvider = (s: string | undefined): s is MmEmbedProvider =>
  s !== undefined && (MM_EMBED_PROVIDERS as readonly string[]).includes(s)

export interface MmEmbedderEnv {
  readonly QUANTA_MM_EMBED?: string
  readonly VOYAGE_API_KEY?: string
  readonly QUANTA_CLIP_ENDPOINT?: string
}

/**
 * Construct a `MultiModalEmbedder` from env. Returns `null` when the
 * provider env is absent or unrecognised — caller decides whether to
 * fall back.
 */
export const createMultiModalEmbedderFromEnv = (env: MmEmbedderEnv): MultiModalEmbedder | null => {
  const provider = env.QUANTA_MM_EMBED
  if (!isMmEmbedProvider(provider)) return null
  switch (provider) {
    case "voyage":
      return createVoyageMultiModalEmbedder({ apiKey: env.VOYAGE_API_KEY })
    case "clip":
      return createClipRestEmbedder({ endpoint: env.QUANTA_CLIP_ENDPOINT })
    case "headless":
      return createHeadlessMmEmbedder()
  }
}
