/**
 * `MultiModalEmbedder` port — ADR-0276.
 *
 * Closed-port abstraction over text + image + audio embedding providers.
 * Sibling of `Embedder` (ADR-0261). Single-input-per-call: managed
 * vendors charge per-item and shape one request per item, so batching
 * is a downstream concern.
 */
import type { Result } from "@/shared"
import type { EmbedResult, MMCapabilities, MMEmbedError, MultiModalInput } from "./types"

export interface MultiModalEmbedder {
  /**
   * Embed exactly one `input` (text, image, or audio). The returned
   * `EmbedResult` always carries `vectors.length === 1`.
   *
   * Transport-level failures (HTTP 429, 5xx, network, abort) THROW; the
   * 6-arm `MMEmbedError` covers input/config domain failures only.
   */
  embed(
    input: MultiModalInput,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<Result<EmbedResult, MMEmbedError>>

  /** Static capabilities. Implementations may cache. */
  capabilities(): Promise<MMCapabilities>
}
