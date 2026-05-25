/**
 * Embedder types — ADR-0261.
 *
 * Closed unions only. Every consumer must handle every `EmbedError` arm
 * (use `assertNever` in the default branch).
 *
 * Sibling to `src/retrieval/embedding-port.ts` (ADR-0254). The older
 * `EmbeddingPort` is unchanged and stays in use by its call sites; this
 * shape adds typed capabilities, typed errors, and a `Result`-returning
 * surface for new consumers.
 */

/** Result of an `embed()` call. */
export interface EmbedResult {
  readonly vectors: ReadonlyArray<readonly number[]>
  /** Provider-reported token count, when supplied. Absent for stubs / 어 vendors. */
  readonly tokenCount?: number
  /** A stable id for the model used (e.g. "openai:text-embedding-3-small"). */
  readonly modelTag: string
}

/** Static capabilities of an `Embedder` — dim, batch cap, max input bytes. */
export interface EmbedderCapabilities {
  readonly dim: number
  readonly maxInputBytes: number
  readonly batchSize: number
  readonly modelTag: string
}

/** Closed 7-arm error union. Every arm represents a distinct failure mode. */
export type EmbedError =
  | { readonly kind: "missing-api-key"; readonly provider: string }
  | { readonly kind: "http-error"; readonly status: number; readonly body: string }
  | { readonly kind: "rate-limited"; readonly retryAfterMs?: number }
  | { readonly kind: "invalid-response"; readonly detail: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "input-too-large"; readonly bytes: number; readonly cap: number }
  | { readonly kind: "network"; readonly detail: string }

/** The 7 arm tags, exported for exhaustive iteration in tests. */
export const EMBED_ERROR_KINDS = [
  "missing-api-key",
  "http-error",
  "rate-limited",
  "invalid-response",
  "aborted",
  "input-too-large",
  "network",
] as const satisfies ReadonlyArray<EmbedError["kind"]>
