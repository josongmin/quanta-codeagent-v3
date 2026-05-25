/**
 * `Embedder` port — ADR-0261.
 *
 * Closed-port abstraction over every embedding provider (openai/voyage/
 * cohere/ollama/headless). All adapters return `Result<EmbedResult,
 * EmbedError>` so failure surfaces are exhaustively typed — never a
 * thrown vendor-specific class.
 */
import type { Result } from "@/shared"
import type { EmbedderCapabilities, EmbedError, EmbedResult } from "./types"

export interface Embedder {
  /**
   * Embed `input` (a single string or batch). Output `vectors[i]`
   * corresponds to the input at index `i`. Single-string input → 1-vector
   * output. Empty array → 0-vector output (still ok).
   */
  embed(
    input: string | readonly string[],
    opts?: { readonly signal?: AbortSignal },
  ): Promise<Result<EmbedResult, EmbedError>>

  /** Static capabilities. Implementations may cache. */
  capabilities(): Promise<EmbedderCapabilities>
}
