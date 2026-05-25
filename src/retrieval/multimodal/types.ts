/**
 * Multi-modal embedder types — ADR-0276.
 *
 * Closed unions only. Sibling of `src/retrieval/engines/embedder/types.ts`
 * (ADR-0261, text-only). The older `Embedder` is unchanged and stays in
 * use by its call sites; this shape adds binary modalities (image, audio)
 * via a 3-arm discriminated input.
 *
 * ImageBlob / AudioBlob are duck-typed for compatibility with
 *   - ADR-0126 read_image tool output (mime + bytes)
 *   - ADR-0202 voice capture pipeline (mime + bytes)
 * No `import type` from those slices — keeps `@/retrieval` a leaf.
 */

/** Single-content embedding result — reused from ADR-0261 shape. */
export interface EmbedResult {
  readonly vectors: ReadonlyArray<readonly number[]>
  readonly modelTag: string
  readonly tokenCount?: number
}

export type Modality = "text" | "image" | "audio"

export const ALL_MODALITIES = ["text", "image", "audio"] as const satisfies ReadonlyArray<Modality>

/** Image blob — duck-typed to ADR-0126 read_image output. */
export interface ImageBlob {
  readonly mime: string
  readonly bytes: Uint8Array
}

/** Audio blob — duck-typed to ADR-0202 voice capture output. */
export interface AudioBlob {
  readonly mime: string
  readonly bytes: Uint8Array
}

/** 3-arm discriminated input — exactly one modality per call. */
export type MultiModalInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly blob: ImageBlob }
  | { readonly kind: "audio"; readonly blob: AudioBlob }

/** Static capabilities of a `MultiModalEmbedder`. */
export interface MMCapabilities {
  readonly dim: number
  readonly supportedModalities: readonly Modality[]
  readonly maxImageBytes: number
  readonly maxAudioBytes: number
  readonly modelTag: string
}

/**
 * Closed 6-arm input/config domain error union.
 *
 * Transport failures (4xx / 429 / 5xx / network / abort) are surfaced
 * either by folding into `missing-api-key` (for 4xx auth) or by throwing
 * a tagged `Error("rate-limited")` from the adapter for 429. Keeping the
 * 6-arm closed union restricted to input/config errors means every
 * caller can `switch` exhaustively over user-actionable failure modes
 * without seeing transient transport noise.
 */
export type MMEmbedError =
  | { readonly kind: "missing-api-key"; readonly provider: string }
  | { readonly kind: "endpoint-missing" }
  | { readonly kind: "unsupported-mime"; readonly mime: string }
  | { readonly kind: "image-too-large"; readonly bytes: number; readonly cap: number }
  | { readonly kind: "audio-too-large"; readonly bytes: number; readonly cap: number }
  | { readonly kind: "empty-input" }

/** The 6 arm tags, exported for exhaustive iteration in tests. */
export const MM_EMBED_ERROR_KINDS = [
  "missing-api-key",
  "endpoint-missing",
  "unsupported-mime",
  "image-too-large",
  "audio-too-large",
  "empty-input",
] as const satisfies ReadonlyArray<MMEmbedError["kind"]>
