/**
 * Voyage AI embedder adapter — ADR-0261.
 *
 *   POST https://api.voyageai.com/v1/embeddings
 *   Headers: Authorization: Bearer ${VOYAGE_API_KEY}
 *   Body:    { model, input: string[] }
 *   Resp:    { data: [{ embedding: number[] }], usage?: { total_tokens } }
 */
import { err, ok, type Result } from "@/shared"
import { checkInputBytes, type FetchFn, runEmbedRequest } from "./_http"
import type { Embedder } from "./port"
import type { EmbedderCapabilities, EmbedError, EmbedResult } from "./types"

export type { FetchFn } from "./_http"

export interface VoyageEmbedderOptions {
  readonly apiKey?: string | undefined
  readonly model?: string
  readonly baseURL?: string
  readonly dim?: number
  readonly batchSize?: number
  readonly maxInputBytes?: number
  readonly fetchImpl?: FetchFn
}

const DEFAULT_MODEL = "voyage-3"
const DEFAULT_BASE = "https://api.voyageai.com/v1"
const DEFAULT_DIM = 1024
const DEFAULT_BATCH = 128
const DEFAULT_MAX_BYTES = 16 * 1024

interface VoyageResp {
  readonly data?: ReadonlyArray<{ readonly embedding?: readonly number[] }>
  readonly usage?: { readonly total_tokens?: number }
}

const decodeVoyage = (parsed: VoyageResp, expectedLen: number): Result<number[][], EmbedError> => {
  const data = parsed.data
  if (data === undefined || !Array.isArray(data) || data.length !== expectedLen) {
    return err({ kind: "invalid-response", detail: "missing/length-mismatch data[]" })
  }
  const vectors: number[][] = []
  for (const d of data) {
    const v = d.embedding
    if (v === undefined || !Array.isArray(v)) {
      return err({ kind: "invalid-response", detail: "missing embedding" })
    }
    vectors.push([...v])
  }
  return ok(vectors)
}

export const createVoyageEmbedder = (opts: VoyageEmbedderOptions): Embedder => {
  const model = opts.model ?? DEFAULT_MODEL
  const baseURL = opts.baseURL ?? DEFAULT_BASE
  const dim = opts.dim ?? DEFAULT_DIM
  const batchSize = opts.batchSize ?? DEFAULT_BATCH
  const maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_BYTES
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const modelTag = `voyage:${model}`

  const caps: EmbedderCapabilities = { dim, maxInputBytes, batchSize, modelTag }

  return {
    async embed(
      input: string | readonly string[],
      callOpts?: { readonly signal?: AbortSignal },
    ): Promise<Result<EmbedResult, EmbedError>> {
      if (callOpts?.signal?.aborted === true) return err({ kind: "aborted" })
      const apiKey = opts.apiKey
      if (apiKey === undefined || apiKey === "") {
        return err({ kind: "missing-api-key", provider: "voyage" })
      }
      const items = typeof input === "string" ? [input] : input
      const tooLarge = checkInputBytes(items, maxInputBytes)
      if (tooLarge !== null) return err(tooLarge)
      const parsed = await runEmbedRequest<VoyageResp>(
        `${baseURL}/embeddings`,
        { model, input: items },
        { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        callOpts?.signal,
        fetchImpl,
      )
      if (!parsed.ok) return parsed
      const decoded = decodeVoyage(parsed.value, items.length)
      if (!decoded.ok) return decoded
      const tokenCount = parsed.value.usage?.total_tokens
      return ok(
        tokenCount === undefined
          ? { vectors: decoded.value, modelTag }
          : { vectors: decoded.value, modelTag, tokenCount },
      )
    },
    async capabilities(): Promise<EmbedderCapabilities> {
      return caps
    },
  }
}
